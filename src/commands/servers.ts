import type { ApiClient, FetchLike } from "../lib/api.js";
import {
  ApiError,
  CliError,
  describeTransientFailure,
  explainApiError,
  isTransientFailure,
  ResultError,
  UsageError,
} from "../lib/errors.js";
import { formatTable } from "../lib/format.js";
import { describeServerNameRejection, printInstallCommand, serverStatusLabel } from "../lib/onprem.js";
import { printJson } from "../lib/output.js";
import { type Ask, confirm, pickOne } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import type { OnpremServer, OnpremServerRegistration } from "../lib/types.js";

const POLL_INTERVAL_MS = 3000;
// 서버에서 설치를 마치는 데 넉넉한 시간. 넘으면 기다리기만 멈추고 등록은 둔다.
const MAX_WAIT_MS = 20 * 60_000;
// 연속으로 이만큼까지는 다시 확인하고, 넘으면 멈춘다. 쉬는 시간은 실패가 이어질수록 늘린다.
const MAX_POLL_FAILURES = 5;
const RETRY_DELAYS_MS = [3000, 4000, 5000, 5000, 5000];

const MAX_SERVERS = 5;
const NOT_CONFIGURED_MESSAGE =
  "서버 등록이 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하거나 운영자에게 문의해 주세요.";

const NO_SERVERS_MESSAGE = "등록한 서버가 없습니다. `likelion servers add <이름>` 으로 서버를 등록하세요.";

export interface ServersDeps {
  fetchImpl?: FetchLike;
  ask?: Ask;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Ctrl+C 로 연결 기다리기를 멈춘다. 서버 등록은 그대로 남는다. */
  signal?: AbortSignal;
  /** 대화형 터미널인지. 아니면(파이프·CI) 기본으로 연결을 기다리지 않는다 */
  isInteractive?: boolean;
}

export interface ServersListOptions {
  json?: boolean;
}

/** 내 서버 목록을 보여 준다. */
export async function runServersList(
  options: ServersListOptions = {},
  deps: ServersDeps = {},
): Promise<OnpremServer[]> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);

  const servers = await api.request<OnpremServer[]>("GET", "/onprem-servers", {
    token: credentials.token,
  });
  if (options.json) {
    printJson(servers, log);
    return servers;
  }
  if (servers.length === 0) {
    log(NO_SERVERS_MESSAGE);
    return servers;
  }
  const rows = servers.map((server) => [
    server.name,
    describeStatus(server),
    server.serverKey,
    server.tailnetFqdn ?? "-",
    server.connectedAt ?? "-",
  ]);
  for (const line of formatTable([["이름", "상태", "서버 키", "tailnet 주소", "연결 시각"], ...rows])) {
    log(line);
  }
  return servers;
}

export interface ServersAddOptions {
  name: string;
  /** 등록한 뒤 연결될 때까지 상태를 따라간다. 없으면 대화형 터미널에서만 기다린다 */
  wait?: boolean;
}

/** 서버를 등록하고 설치 명령을 보여 준 뒤, 기본으로는 연결될 때까지 상태를 따라간다. */
export async function runServersAdd(
  options: ServersAddOptions,
  deps: ServersDeps = {},
): Promise<OnpremServer> {
  const log = deps.log ?? console.log;
  const name = options.name.trim();
  if (!name) throw new UsageError("서버 이름을 입력해 주세요.");
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const token = credentials.token;

  let registration: OnpremServerRegistration;
  try {
    registration = await api.request<OnpremServerRegistration>("POST", "/onprem-servers", {
      token,
      body: { name },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "ONPREM_SERVER_NAME_CONFLICT") {
      throw explainApiError(error, `같은 이름의 서버가 이미 있습니다: ${name}. 다른 이름을 쓰거나 \`likelion servers\` 로 확인해 주세요.`);
    }
    if (error instanceof ApiError && error.code === "ONPREM_SERVER_LIMIT_EXCEEDED") {
      throw explainApiError(
        error,
        `서버는 한 사람당 ${MAX_SERVERS}대까지 등록할 수 있습니다. 쓰지 않는 서버를 \`likelion servers remove <이름>\` 으로 지운 뒤 다시 등록해 주세요.`,
      );
    }
    if (error instanceof ApiError && error.code === "NOT_CONFIGURED") throw explainApiError(error, NOT_CONFIGURED_MESSAGE);
    if (error instanceof ApiError && error.status === 409) {
      throw explainApiError(error, `서버를 등록할 수 없습니다 (${error.message}). \`likelion servers\` 로 확인해 주세요.`);
    }
    if (error instanceof ApiError && error.status === 422) {
      throw explainApiError(error, describeServerNameRejection(name, error.details));
    }
    throw error;
  }

  const { server } = registration;
  log(`서버를 등록했습니다: ${server.name} (서버 키 ${server.serverKey})`);
  printInstallCommand(registration, log);
  if (!shouldWait(options.wait, deps)) {
    log("연결 상태는 `likelion servers` 로 확인하세요.");
    return server;
  }
  return waitForConnection(api, token, server, deps);
}

export interface ServersTokenOptions {
  /** 서버 이름 또는 id */
  server: string;
  /** 연결될 때까지 상태를 따라간다. 없으면 대화형 터미널에서만 기다린다 */
  wait?: boolean;
}

/** 등록 토큰을 다시 발급해 새 설치 명령을 보여 준다. 연결된 서버는 안 되고, 다시 발급하면 상태는 대기로 돌아간다. */
export async function runServersToken(
  options: ServersTokenOptions,
  deps: ServersDeps = {},
): Promise<OnpremServer> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const token = credentials.token;
  const server = await findServer(api, token, options.server, log);

  let registration: OnpremServerRegistration;
  try {
    registration = await api.request<OnpremServerRegistration>(
      "POST",
      `/onprem-servers/${server.id}/registration-token`,
      { token },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw explainApiError(
        error,
        `${server.name} 은 지금 ${serverStatusLabel(server.status)} 상태라 토큰을 다시 발급할 수 없습니다. 대기·연결 중·실패 상태에서만 다시 발급합니다.`,
      );
    }
    if (error instanceof ApiError && error.code === "NOT_CONFIGURED") throw explainApiError(error, NOT_CONFIGURED_MESSAGE);
    throw error;
  }

  log(`새 등록 토큰을 발급했습니다: ${server.name}. 이전 명령은 더 이상 쓸 수 없습니다.`);
  printInstallCommand(registration, log);
  if (!shouldWait(options.wait, deps)) {
    log("연결 상태는 `likelion servers` 로 확인하세요.");
    return registration.server;
  }
  return waitForConnection(api, token, registration.server, deps);
}

export interface ServersRemoveOptions {
  /** 서버 이름 또는 id */
  server: string;
  /** 묻지 않고 삭제한다 */
  yes: boolean;
}

/** 서버를 삭제한다. 그 서버의 배포 타깃도 함께 사라진다. 지웠으면 true. */
export async function runServersRemove(
  options: ServersRemoveOptions,
  deps: ServersDeps = {},
): Promise<boolean> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const token = credentials.token;
  const server = await findServer(api, token, options.server, log);

  if (!options.yes) {
    if (!deps.ask) {
      throw new UsageError("대화형 터미널이 아니라 삭제를 확인할 수 없습니다. --yes 를 붙여 다시 실행해 주세요.");
    }
    const isConfirmed = await confirm(
      deps.ask,
      `서버 ${server.name} (${server.serverKey}) 를 삭제할까요? 이 서버의 배포 타깃도 함께 사라집니다.`,
      false,
    );
    if (!isConfirmed) {
      log("삭제하지 않았습니다.");
      return false;
    }
  }

  try {
    await api.request<void>("DELETE", `/onprem-servers/${server.id}`, { token });
  } catch (error) {
    if (error instanceof ApiError && error.code === "ONPREM_SERVER_IN_USE") {
      throw explainApiError(
        error,
        `이 서버에 배포하는 서비스가 있어 삭제할 수 없습니다: ${server.name}. 그 서비스를 먼저 삭제해 주세요.`,
      );
    }
    throw error;
  }
  log(`서버를 삭제했습니다: ${server.name}. 서버에 설치된 K3s·Tailscale 은 지우지 않으니 필요하면 서버에서 직접 지워 주세요.`);
  return true;
}

async function findServer(
  api: ApiClient,
  token: string,
  value: string,
  log: (message: string) => void,
): Promise<OnpremServer> {
  const servers = await api.request<OnpremServer[]>("GET", "/onprem-servers", { token });
  return pickOne(servers, {
    label: "서버",
    flag: "<이름|id>",
    value,
    ask: undefined,
    log,
    emptyMessage: NO_SERVERS_MESSAGE,
  });
}

function shouldWait(option: boolean | undefined, deps: ServersDeps): boolean {
  return option ?? deps.isInteractive ?? process.stdin.isTTY === true;
}

function describeStatus(server: OnpremServer): string {
  const label = serverStatusLabel(server.status);
  return server.failureCode ? `${label} (${server.failureCode})` : label;
}

/** 서버가 연결(CONNECTED)되거나 실패(FAILED)할 때까지 3초마다 상태를 확인한다. */
async function waitForConnection(
  api: ApiClient,
  token: string,
  initial: OnpremServer,
  deps: ServersDeps,
): Promise<OnpremServer> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const signal = deps.signal;
  const stopWaiting = (server: OnpremServer): OnpremServer => {
    log("기다리기를 멈춥니다. 서버 등록은 남아 있으니 연결 상태는 `likelion servers` 로 확인하세요.");
    return server;
  };

  log("");
  log("서버에서 명령을 실행하면 연결을 확인합니다. 기다리는 중... (Ctrl+C 로 멈춰도 등록은 남습니다)");
  const startedAt = now();
  let server = initial;
  let lastStatus = "";
  let failures = 0;
  for (;;) {
    if (server.status !== lastStatus) {
      const elapsed = Math.round((now() - startedAt) / 1000);
      log(`  ${serverStatusLabel(server.status)} (+${elapsed}s)`);
      lastStatus = server.status;
    }
    if (server.status === "CONNECTED") {
      const address = server.tailnetFqdn ? ` (${server.tailnetFqdn})` : "";
      log(`서버가 연결되었습니다: ${server.name}${address}`);
      log(`이 서버에 배포하려면 \`likelion services create --target ${server.name}\` 으로 서비스를 만드세요.`);
      return server;
    }
    if (server.status === "FAILED") {
      throw new ResultError(
        `서버 연결에 실패했습니다 (${server.failureCode ?? "원인 미상"}). \`likelion servers token ${server.name}\` 으로 토큰을 다시 받아 서버에서 명령을 다시 실행하세요.`,
        server.failureCode ?? "SERVER_CONNECT_FAILED",
      );
    }
    if (server.status === "PENDING" && isExpired(server, now())) {
      throw new ResultError(
        `등록 토큰이 만료되었습니다. \`likelion servers token ${server.name}\` 으로 다시 발급하세요.`,
        "REGISTRATION_TOKEN_EXPIRED",
      );
    }

    if (now() - startedAt >= MAX_WAIT_MS) {
      log("20분 동안 연결되지 않아 기다리기를 멈춥니다. 연결 확인은 `likelion servers` 로 계속할 수 있습니다.");
      return server;
    }
    if (signal?.aborted) return stopWaiting(server);
    await sleep(failures > 0 ? (RETRY_DELAYS_MS[failures - 1] ?? POLL_INTERVAL_MS) : POLL_INTERVAL_MS, signal);
    if (signal?.aborted) return stopWaiting(server);
    try {
      server = await api.request<OnpremServer>("GET", `/onprem-servers/${server.id}`, { token, signal });
      failures = 0;
    } catch (error) {
      if (signal?.aborted) return stopWaiting(server);
      if (!isTransientFailure(error)) throw error;
      failures += 1;
      if (failures > MAX_POLL_FAILURES) {
        throw new CliError(
          `서버 상태를 연속 ${failures}회 확인하지 못해 기다리기를 멈춥니다 (마지막 오류: ${error.message}). \`likelion servers\` 로 확인해 주세요.`,
        );
      }
      warn(`${describeTransientFailure(error)} 다시 확인합니다 (${failures}/${MAX_POLL_FAILURES}).`);
    }
  }
}

function isExpired(server: OnpremServer, nowMs: number): boolean {
  if (!server.registrationExpiresAt) return false;
  const expiresAt = Date.parse(server.registrationExpiresAt);
  return Number.isFinite(expiresAt) && nowMs >= expiresAt;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
