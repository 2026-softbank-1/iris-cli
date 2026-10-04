import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApiClient, FetchLike } from "../lib/api.js";
import { ApiError, CliError, explainApiError, UsageError } from "../lib/errors.js";
import { printJson } from "../lib/output.js";
import { type Ask, confirm } from "../lib/prompt.js";
import { requireLinkedSession } from "../lib/session.js";
import type { ServiceVariables, Variable } from "../lib/types.js";

// 서버가 받는 Raw 본문의 상한(1 MiB). 넘으면 보내기 전에 알린다.
const MAX_RAW_BYTES = 1024 * 1024;
const DEFAULT_FILE = ".env";
const APPLY_NOTE =
  "실행 중인 앱은 그대로입니다. 다음 배포(`likelion redeploy`)나 `likelion restart` 부터 반영됩니다.";

export interface EnvDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** 대화형 터미널일 때만 있다. 없으면(파이프·CI) 확인이 필요한 명령은 `--yes` 를 요구한다. */
  ask?: Ask;
}

/** `.env` 한 줄. 값에 공백·따옴표·줄바꿈이 있으면 서버 Raw 규칙대로 큰따옴표 JSON 이스케이프로 쓴다. */
export function formatEnvLine(key: string, value: string): string {
  if (value === "") return `${key}=`;
  if (/^[A-Za-z0-9_@%+:,./-]+$/.test(value)) return `${key}=${value}`;
  return `${key}=${JSON.stringify(value)}`;
}

function variablesPath(serviceId: number): string {
  return `/services/${serviceId}/variables`;
}

export interface EnvListOptions {
  /** 값까지 보여 준다. 기본은 이름과 값의 길이만 보여 비밀이 화면·로그에 남지 않게 한다 */
  showValues: boolean;
  json?: boolean;
}

/** 서비스 환경변수와 플랫폼이 넣는 변수를 보여 준다. */
export async function runEnvList(options: EnvListOptions, deps: EnvDeps = {}): Promise<ServiceVariables> {
  const log = deps.log ?? console.log;
  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);
  const result = await fetchVariables(api, token, link.serviceId);

  if (options.json) {
    printJson(
      {
        variables: result.variables.map((variable) =>
          options.showValues ? variable : { key: variable.key },
        ),
        systemVariables: result.systemVariables,
      },
      log,
    );
    return result;
  }

  if (result.variables.length === 0) {
    log("등록한 환경변수가 없습니다. `likelion env set KEY=VALUE` 로 추가하세요.");
  } else {
    log(`환경변수 ${result.variables.length}개${options.showValues ? "" : " (값은 숨김, --show-values 로 보기)"}`);
    for (const variable of result.variables) {
      log(options.showValues ? formatEnvLine(variable.key, variable.value) : describeHidden(variable));
    }
  }
  if (result.systemVariables.length > 0) {
    log("");
    log("플랫폼이 넣는 변수 (바꿀 수 없음)");
    for (const variable of result.systemVariables) {
      log(`${variable.key}${variable.value !== undefined ? `=${variable.value}` : ""}  ${variable.description}`);
    }
  }
  return result;
}

function describeHidden(variable: Variable): string {
  return variable.value === "" ? `${variable.key}  (빈 값)` : `${variable.key}  (값 ${[...variable.value].length}자)`;
}

export interface EnvSetOptions {
  /** `KEY=VALUE` 목록 */
  assignments: string[];
  json?: boolean;
}

/** 변수를 추가하거나(이미 있으면) 값을 바꾼다. */
export async function runEnvSet(options: EnvSetOptions, deps: EnvDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const pairs = options.assignments.map(parseAssignment);
  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);

  const applied: { key: string; action: "추가" | "수정" }[] = [];
  for (const { key, value } of pairs) {
    try {
      try {
        await api.request<Variable>("POST", variablesPath(link.serviceId), { token, body: { key, value } });
        applied.push({ key, action: "추가" });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "VARIABLE_CONFLICT") throw error;
        await api.request<Variable>("PUT", `${variablesPath(link.serviceId)}/${encodeURIComponent(key)}`, {
          token,
          body: { value },
        });
        applied.push({ key, action: "수정" });
      }
    } catch (error) {
      throw explainVariableError(error, key, applied.map((item) => item.key));
    }
  }

  if (options.json) {
    printJson({ applied: applied.map(({ key, action }) => ({ key, action: action === "추가" ? "created" : "updated" })) }, log);
    return;
  }
  for (const { key, action } of applied) log(`${action}: ${key}`);
  log(APPLY_NOTE);
}

export interface EnvUnsetOptions {
  keys: string[];
  json?: boolean;
}

/** 변수를 지운다. 없는 이름이 하나라도 있으면 나머지를 지운 뒤 실패로 끝낸다. */
export async function runEnvUnset(options: EnvUnsetOptions, deps: EnvDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);

  const removed: string[] = [];
  const missing: string[] = [];
  for (const key of options.keys) {
    try {
      await api.request<void>("DELETE", `${variablesPath(link.serviceId)}/${encodeURIComponent(key)}`, { token });
      removed.push(key);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VARIABLE_NOT_FOUND") {
        missing.push(key);
        continue;
      }
      throw explainVariableError(error, key, removed);
    }
  }

  if (options.json) printJson({ removed, missing }, log);
  else {
    for (const key of removed) log(`삭제: ${key}`);
    if (removed.length > 0) log(APPLY_NOTE);
  }
  if (missing.length > 0) {
    throw new CliError(`없는 변수입니다: ${missing.join(", ")}${removed.length > 0 ? ` (나머지 ${removed.length}개는 삭제했습니다)` : ""}`);
  }
}

export interface EnvPullOptions {
  /** 저장할 파일. 기본은 현재 폴더의 `.env` */
  file?: string;
  /** 이미 있는 파일을 덮어쓴다 */
  force: boolean;
}

/** 서비스 환경변수를 `.env` 파일로 내려받는다. 비밀이 들어 있어 소유자만 읽게(0600) 쓴다. */
export async function runEnvPull(options: EnvPullOptions, deps: EnvDeps = {}): Promise<string> {
  const log = deps.log ?? console.log;
  const cwd = deps.cwd ?? process.cwd();
  const { api, token, link } = await requireLinkedSession(cwd, deps.fetchImpl);
  const path = resolve(cwd, options.file ?? DEFAULT_FILE);

  if (!options.force && (await exists(path))) {
    throw new CliError(`이미 있는 파일입니다: ${path}. 덮어쓰려면 --force 를 붙여 주세요.`);
  }
  const result = await fetchVariables(api, token, link.serviceId);
  const lines = result.variables.map((variable) => formatEnvLine(variable.key, variable.value));
  await writeFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  // 이미 있던 파일을 덮어쓸 때는 mode 가 적용되지 않는다.
  await chmod(path, 0o600);
  log(`환경변수 ${result.variables.length}개를 저장했습니다: ${path}`);
  log("이 파일에는 비밀 값이 들어 있습니다. 커밋하지 마세요. (`likelion up` 은 .env 를 올리지 않습니다)");
  return path;
}

export interface EnvPushOptions {
  /** 올릴 파일. 기본은 현재 폴더의 `.env` */
  file?: string;
  /** 묻지 않고 전체 교체한다 */
  yes: boolean;
  json?: boolean;
}

/** `.env` 파일 내용으로 서비스 환경변수 **전체를 교체**한다. 파일에 없는 변수는 지워진다. */
export async function runEnvPush(options: EnvPushOptions, deps: EnvDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const cwd = deps.cwd ?? process.cwd();
  const { api, token, link } = await requireLinkedSession(cwd, deps.fetchImpl);
  const path = resolve(cwd, options.file ?? DEFAULT_FILE);

  const raw = await readRaw(path);
  const before = await fetchVariables(api, token, link.serviceId);

  if (!options.yes) {
    if (!deps.ask) {
      throw new UsageError(
        "대화형 터미널이 아니라 확인할 수 없습니다. 변수 전체가 교체됩니다. --yes 를 붙여 다시 실행해 주세요.",
      );
    }
    const isConfirmed = await confirm(
      deps.ask,
      `${link.serviceName} 의 환경변수 ${before.variables.length}개를 ${path} 내용으로 전부 바꿉니다. 파일에 없는 변수는 삭제됩니다. 계속할까요?`,
      false,
    );
    if (!isConfirmed) {
      log("올리지 않았습니다.");
      return;
    }
  }

  let after: ServiceVariables;
  try {
    after = await api.request<ServiceVariables>("PUT", variablesPath(link.serviceId), {
      token,
      body: { raw },
    });
  } catch (error) {
    throw explainVariableError(error, undefined, []);
  }

  const diff = diffVariables(before.variables, after.variables);
  if (options.json) {
    printJson({ ...diff, total: after.variables.length }, log);
    return;
  }
  log(`환경변수를 올렸습니다: 추가 ${diff.added.length} · 변경 ${diff.changed.length} · 삭제 ${diff.removed.length} (총 ${after.variables.length}개)`);
  for (const [label, keys] of [["추가", diff.added], ["변경", diff.changed], ["삭제", diff.removed]] as const) {
    if (keys.length > 0) log(`${label}: ${keys.join(", ")}`);
  }
  if (diff.removed.length > 0) warn("파일에 없던 변수는 삭제되었습니다.");
  log(APPLY_NOTE);
}

async function fetchVariables(api: ApiClient, token: string, serviceId: number): Promise<ServiceVariables> {
  try {
    return await api.request<ServiceVariables>("GET", variablesPath(serviceId), { token });
  } catch (error) {
    throw explainVariableError(error, undefined, []);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRaw(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`파일이 없습니다: ${path}`);
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_RAW_BYTES) {
    throw new CliError(`파일이 너무 큽니다: ${path} (최대 1 MiB)`);
  }
  return text;
}

function parseAssignment(text: string): { key: string; value: string } {
  const at = text.indexOf("=");
  if (at < 1) {
    throw new UsageError(`KEY=VALUE 형식이어야 합니다: ${at === 0 ? "(이름이 없음)" : text.split("=")[0]}`);
  }
  return { key: text.slice(0, at), value: text.slice(at + 1) };
}

function diffVariables(
  before: Variable[],
  after: Variable[],
): { added: string[]; changed: string[]; removed: string[] } {
  const previous = new Map(before.map((variable) => [variable.key, variable.value]));
  const current = new Map(after.map((variable) => [variable.key, variable.value]));
  return {
    added: [...current.keys()].filter((key) => !previous.has(key)),
    changed: [...current].filter(([key, value]) => previous.has(key) && previous.get(key) !== value).map(([key]) => key),
    removed: [...previous.keys()].filter((key) => !current.has(key)),
  };
}

/** 환경변수 API 의 흔한 거절을 다음에 할 일과 함께 알린다. 값은 메시지에 싣지 않는다. */
function explainVariableError(error: unknown, key: string | undefined, applied: string[]): unknown {
  if (!(error instanceof ApiError)) return error;
  const done = applied.length > 0 ? ` (이미 적용된 변수: ${applied.join(", ")})` : "";
  if (error.code === "NOT_CONFIGURED") {
    return explainApiError(error, "서버에 환경변수 암호화 키가 설정되지 않아 환경변수를 쓸 수 없습니다. 운영자에게 문의해 주세요.");
  }
  if (error.status === 422) {
    const reasons = (error.details ?? []).map((detail) => `  ${detail.reason}`).join("\n");
    const subject = key ? ` (${key})` : "";
    return explainApiError(error, `환경변수를 저장할 수 없습니다${subject}: ${error.message}${reasons ? `\n${reasons}` : ""}${done}`);
  }
  if (done) return explainApiError(error, `${error.message}${done}`);
  return error;
}
