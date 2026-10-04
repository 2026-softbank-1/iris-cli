import type { ApiClient, FetchLike } from "../lib/api.js";
import { ApiError, CliError, explainApiError } from "../lib/errors.js";
import { findGitOrigin } from "../lib/git.js";
import { type Link, saveLink } from "../lib/link.js";
import { printJson, progressLog } from "../lib/output.js";
import { serverStatusLabel } from "../lib/onprem.js";
import { pickProject } from "../lib/project.js";
import { type Ask, confirm, matchByIdOrName, pickOne } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import type { OnpremServer, Project, Service, Target } from "../lib/types.js";

export interface ServicesCreateOptions {
  /** 프로젝트 이름 또는 id. 없으면 목록에서 고른다 */
  project?: string;
  /** 서비스 이름. 없으면 서버가 저장소 이름으로 정한다 */
  name?: string;
  /** GitHub 저장소 주소. 없으면 현재 폴더의 git origin 을 쓴다 */
  repo?: string;
  /** 배포할 브랜치. 없으면 서버가 저장소 기본 브랜치로 정한다 */
  branch?: string;
  rootDir?: string;
  /** 공용 타깃 이름(`aws`) 또는 내 서버 이름, 타깃 id. 없으면 고르거나 서버 기본(`aws`) */
  target?: string;
  /** 만든 뒤 현재 폴더를 연결할지. 없으면 대화형 터미널에서만 묻는다 */
  link?: boolean;
  /** 진행 안내는 stderr 로 보내고 stdout 에는 만든 서비스 JSON 만 낸다 */
  json?: boolean;
}

export interface ServicesCreateDeps {
  fetchImpl?: FetchLike;
  ask?: Ask;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  findRepository?: (cwd: string) => Promise<string | undefined>;
}

/** 목록에 보여 줄 타깃. 내 서버의 타깃은 타깃 이름(`onprem-<키>`) 대신 서버 이름으로 보여 준다. */
interface TargetChoice {
  id: number;
  name: string;
  target: Target;
}

// 서버의 InvalidInputError 메시지는 계약이라 그대로 비교한다.
const INVALID_INPUT_MESSAGES: Record<string, string> = {
  "not a github repository url":
    "GitHub 저장소 주소가 아닙니다. https://github.com/<owner>/<repo> 형식으로 지정해 주세요.",
  "branch not found in repository": "저장소에 그 브랜치가 없습니다. --branch 를 확인해 주세요.",
  "service name must be lowercase letters, digits and hyphens":
    "서비스 이름은 영문 소문자·숫자·하이픈만 쓸 수 있습니다. --name 을 확인해 주세요.",
  "root directory must stay inside the repository": "--root-dir 은 저장소 안의 경로여야 합니다.",
  "unknown target": "그 타깃은 쓸 수 없습니다. 공용 타깃이나 내 서버만 고를 수 있습니다.",
  "exactly one target is required": "타깃은 하나만 고를 수 있습니다.",
};

/** GitHub 저장소를 연결해 서비스를 만들고, 원하면 현재 폴더를 그 서비스에 연결한다. */
export async function runServicesCreate(
  options: ServicesCreateOptions,
  deps: ServicesCreateDeps = {},
): Promise<Service> {
  const out = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const log = progressLog(options.json ?? false, out, warn);
  const cwd = deps.cwd ?? process.cwd();
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const token = credentials.token;

  const project = await pickProject(api, token, options.project, deps.ask, log);
  const repositoryUrl = await resolveRepository(options.repo, cwd, deps, log);
  const choice = await pickTarget(api, token, options.target, deps.ask, log);
  if (choice) warnIfNotConnected(choice, warn);

  let service: Service;
  try {
    service = await api.request<Service>("POST", `/projects/${project.id}/services`, {
      token,
      body: {
        repositoryUrl,
        name: options.name,
        branch: options.branch,
        rootDirectory: options.rootDir,
        targetIds: choice ? [choice.id] : undefined,
      },
    });
  } catch (error) {
    throw (error instanceof ApiError && describeCreateFailure(error, project)) || error;
  }

  const targetName = choice?.name ?? "aws (기본)";
  log(
    `서비스를 만들었습니다: ${project.name} / ${service.name} (서비스 ${service.id}, 브랜치 ${service.sourceBranch}, 타깃 ${targetName})`,
  );
  await offerLink(project, service, { option: options.link, ask: deps.ask, cwd, apiUrl: credentials.apiUrl, log });
  if (options.json) printJson(service, out);
  return service;
}

async function resolveRepository(
  option: string | undefined,
  cwd: string,
  deps: ServicesCreateDeps,
  log: (message: string) => void,
): Promise<string> {
  if (option?.trim()) return option.trim();
  const detected = await (deps.findRepository ?? findGitOrigin)(cwd);
  if (deps.ask) {
    const question = detected
      ? `GitHub 저장소 주소 (Enter 면 ${detected}): `
      : "GitHub 저장소 주소 (예: https://github.com/owner/repo): ";
    const answer = (await deps.ask(question)).trim() || detected;
    if (!answer) throw new CliError("저장소 주소가 필요합니다. --repo 로 지정해 주세요.");
    return answer;
  }
  if (!detected) {
    throw new CliError(
      "저장소 주소가 필요합니다. --repo 로 GitHub 저장소 주소를 지정해 주세요 (예: https://github.com/owner/repo).",
    );
  }
  log(`저장소: ${detected} (현재 폴더의 git origin)`);
  return detected;
}

/**
 * 공용 타깃과 내 서버의 타깃 중 하나를 고른다. 옵션도 없고 물을 수도 없으면 undefined 를 돌려
 * 서버 기본(`aws`)을 쓰게 한다.
 */
async function pickTarget(
  api: ApiClient,
  token: string,
  value: string | undefined,
  ask: Ask | undefined,
  log: (message: string) => void,
): Promise<TargetChoice | undefined> {
  if (value === undefined && !ask) return undefined;

  const targets = await api.request<Target[]>("GET", "/targets", { token });
  // 서버 이름이 응답에 없는 서버 타깃이 있을 때만 서버 목록을 부른다.
  const isNameMissing = targets.some(
    (target) => target.onpremServerId != null && target.onpremServerName == null,
  );
  const servers = isNameMissing
    ? await api.request<OnpremServer[]>("GET", "/onprem-servers", { token })
    : [];
  const serverNameById = new Map(servers.map((server) => [server.id, server.name]));
  const choices: TargetChoice[] = targets.map((target) => ({
    id: target.id,
    name:
      target.onpremServerId == null
        ? target.name
        : (target.onpremServerName ?? serverNameById.get(target.onpremServerId) ?? target.name),
    target,
  }));

  if (value !== undefined) {
    // 서버 이름 말고 타깃 이름(`onprem-<키>`)으로 지정해도 찾는다.
    const found =
      matchByIdOrName(choices, value) ?? choices.find((choice) => choice.target.name === value);
    if (!found) {
      const names = choices.map((choice) => choice.name).join(", ");
      throw new CliError(`찾을 수 없습니다: 타깃 '${value}'. 가능한 값: ${names}`);
    }
    return found;
  }
  return pickOne(choices, {
    label: "타깃",
    flag: "--target",
    value: undefined,
    ask,
    log,
    emptyMessage: "고를 수 있는 배포 타깃이 없습니다.",
    describeItem: describeChoice,
  });
}

function describeChoice(choice: TargetChoice): string {
  const status = choice.target.connectionStatus;
  return status == null
    ? `${choice.name} (공용)`
    : `${choice.name} (내 서버, ${serverStatusLabel(status)})`;
}

function warnIfNotConnected(choice: TargetChoice, warn: (message: string) => void): void {
  const status = choice.target.connectionStatus;
  if (status == null || status === "CONNECTED") return;
  const state =
    status === "DISCONNECTED"
      ? `서버 ${choice.name} 의 연결이 끊겨 있습니다`
      : `서버 ${choice.name} 은 아직 연결되지 않았습니다 (${serverStatusLabel(status)})`;
  warn(
    `${state}. 서비스는 만들지만 연결되기 전에는 배포할 수 없습니다. \`likelion servers\` 로 상태를 확인하세요.`,
  );
}

function describeCreateFailure(error: ApiError, project: Project): ApiError | undefined {
  switch (error.code) {
    case "SERVICE_NAME_CONFLICT":
      return explainApiError(
        error,
        `'${project.name}' 프로젝트에 같은 이름의 서비스가 이미 있습니다. --name 으로 다른 이름을 정해 주세요.`,
      );
    case "REPOSITORY_NOT_ACCESSIBLE":
      return explainApiError(
        error,
        "저장소에 접근할 수 없습니다. GitHub App 이 이 저장소에 설치돼 있고 접근 권한이 있는지 확인해 주세요.",
      );
    case "INVALID_INPUT":
      return explainApiError(
        error,
        INVALID_INPUT_MESSAGES[error.message] ?? `입력이 올바르지 않습니다: ${error.message}`,
      );
    case "VALIDATION_ERROR": {
      const fields = (error.details ?? []).map((detail) => `${detail.field}: ${detail.reason}`);
      return explainApiError(
        error,
        `입력이 올바르지 않습니다${fields.length > 0 ? ` (${fields.join(", ")})` : "."}`,
      );
    }
    default:
      return undefined;
  }
}

interface LinkOffer {
  option: boolean | undefined;
  ask: Ask | undefined;
  cwd: string;
  apiUrl: string;
  log: (message: string) => void;
}

async function offerLink(project: Project, service: Service, offer: LinkOffer): Promise<void> {
  const { option, ask, cwd, apiUrl, log } = offer;
  const shouldLink =
    option ?? (ask ? await confirm(ask, `현재 폴더(${cwd})를 이 서비스에 연결할까요?`, true) : false);
  if (!shouldLink) {
    log(
      `배포할 폴더에서 \`likelion link --project ${project.name} --service ${service.name}\` 로 연결하세요.`,
    );
    return;
  }
  const link: Link = {
    apiUrl,
    projectId: project.id,
    projectName: project.name,
    serviceId: service.id,
    serviceName: service.name,
  };
  const path = await saveLink(cwd, link);
  log(`현재 폴더를 연결했습니다 (${path}). \`likelion up\` 으로 배포하세요.`);
}
