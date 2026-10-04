import type { ApiClient, FetchLike } from "../lib/api.js";
import { BuildLogReader, formatBuildLogLine, MAX_BUILD_LOG_LINES } from "../lib/buildLogs.js";
import { resolveDeploymentId, TERMINAL_STATUSES } from "../lib/deployment.js";
import { ApiError, CliError, EXIT, explainApiError, UsageError } from "../lib/errors.js";
import { formatBytes, formatSeconds, formatTimestampNs } from "../lib/format.js";
import { requireLinkedSession } from "../lib/session.js";
import type {
  BuildLogEntry,
  DeploymentDetail,
  DeployLogsPage,
  NetworkLogEntry,
  NetworkLogsPage,
} from "../lib/types.js";
import { resolveTargetId } from "./logs.js";

const MAX_LIMIT = 1000;
const FOLLOW_INTERVAL_MS = 3000;
const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"];

export type DeploymentLogKind = "build" | "deploy" | "network";

export interface DeploymentLogsOptions {
  kind: DeploymentLogKind;
  /** 배포 번호. 생략하면 가장 최근 배포 */
  deployment?: string;
  /** `build` 만: 빌드가 끝날 때까지 새 로그를 계속 따라간다 */
  follow: boolean;
  /** `deploy`·`network`: 최대 줄 수 (1~1000) */
  limit: number;
  /** `build` 만: 이만큼의 마지막 줄만 보여 준다(1~1000). 없으면 전부 */
  tail?: number;
  /** `deploy` 만: 이 문자열이 든 줄만 본다 (대소문자 구분) */
  search?: string;
  /** `deploy`·`network`: 배포 타깃 (타깃이 여러 개일 때) */
  target?: string;
  /** `network` 만: 응답 코드 범위 */
  statusClass?: string;
  /** 줄마다 서버가 준 항목을 JSON 한 줄로 낸다(JSON Lines) */
  json?: boolean;
}

export interface DeploymentLogsDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** 배포 하나의 빌드(CodeBuild)·런타임(이 배포의 release 로 거름)·네트워크(ALB 접근) 로그를 보여 준다. */
export async function runDeploymentLogs(
  options: DeploymentLogsOptions,
  deps: DeploymentLogsDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  validate(options);

  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);
  const deploymentId = await resolveDeploymentId(api, token, link.serviceId, options.deployment);
  const base = `/services/${link.serviceId}/deployments/${deploymentId}`;
  const emit = (line: string, entry: unknown) => log(options.json ? JSON.stringify(entry) : line);

  switch (options.kind) {
    case "build":
      await showBuildLogs({
        api,
        token,
        serviceId: link.serviceId,
        deploymentId,
        follow: options.follow,
        tail: options.tail,
        print: (entry) => emit(formatBuildLogLine(entry), entry),
        warn,
        sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      });
      return;
    case "deploy": {
      const targetId = await optionalTargetId(api, token, link.serviceId, options.target);
      let page: DeployLogsPage;
      try {
        page = await api.request<DeployLogsPage>("GET", `${base}/deploy-logs`, {
          token,
          query: { targetId, limit: options.limit, search: options.search },
        });
      } catch (error) {
        // 내 서버 타깃의 런타임 로그는 서버가 Argo CD 로 읽는다. 그 설정이 없으면 503 이다.
        if (error instanceof ApiError && error.code === "NOT_CONFIGURED" && isOnpremOnly(await deploymentTargets(api, token, base, targetId))) {
          throw explainApiError(
            error,
            "내 서버(온프레미스) 타깃의 런타임 로그를 읽는 설정이 서버에 아직 없습니다. 운영자에게 문의해 주세요.",
          );
        }
        throw error;
      }
      for (const entry of page.entries) {
        emit(`${formatTimestampNs(entry.timestampNs)} ${entry.message}`, entry);
      }
      if (page.entries.length === 0) {
        warn(
          hasOnprem(await deploymentTargets(api, token, base, targetId))
            ? "내 서버(온프레미스) 타깃은 지금 떠 있는 Pod 의 로그만 보여 줍니다. 이 배포의 Pod 가 재시작·교체·중지돼 지금 없으면 로그도 비어 있습니다."
            : "이 배포의 런타임 로그가 없습니다. 성공하지 못한 배포이거나 로그가 아직 수집되지 않았습니다.",
        );
      }
      if (page.isTruncated) warn(`최근 ${options.limit}줄만 보여 줬습니다. --limit 으로 늘릴 수 있습니다.`);
      return;
    }
    case "network": {
      const targetId = await optionalTargetId(api, token, link.serviceId, options.target);
      let page: NetworkLogsPage;
      try {
        page = await api.request<NetworkLogsPage>("GET", `${base}/network-logs`, {
          token,
          query: { targetId, limit: options.limit, statusClass: options.statusClass },
        });
      } catch (error) {
        // 내 서버 타깃은 네트워크(ALB) 로그를 수집하지 않아 서버가 항상 503 NOT_CONFIGURED 를 준다.
        // 기다려도 나아지지 않으니 다시 시도하라는 오류(5)가 아니라 지원하지 않는다는 오류(1)로 알린다.
        if (error instanceof ApiError && error.code === "NOT_CONFIGURED" && isOnpremOnly(await deploymentTargets(api, token, base, targetId))) {
          throw new CliError(
            "내 서버(온프레미스) 타깃은 네트워크 로그를 지원하지 않습니다. 런타임 로그는 `likelion logs --deploy` 로 볼 수 있습니다.",
            EXIT.FAILURE,
            "NOT_SUPPORTED",
          );
        }
        throw error;
      }
      for (const entry of page.entries) emit(formatNetworkEntry(entry), entry);
      if (page.entries.length === 0) {
        warn(
          hasOnprem(await deploymentTargets(api, token, base, targetId))
            ? "내 서버(온프레미스) 타깃은 네트워크(ALB) 로그가 없습니다."
            : "이 배포의 네트워크 로그가 없습니다. 성공하지 못한 배포이거나, ALB 가 로그를 올리는 데 몇 분 걸려 아직 없을 수 있습니다.",
        );
      }
      if (page.isTruncated) warn(`최근 ${options.limit}줄만 보여 줬습니다. --limit 으로 늘릴 수 있습니다.`);
      return;
    }
  }
}

type DeployTarget = { id: number; name: string; kind?: string };

/**
 * 이 배포가 올라간 타깃. `targetId` 를 골랐으면 그 타깃만 본다. 로그가 비었거나 서버가 거절했을 때
 * 이유를 가르는 데만 쓰므로 조회에 실패하면 빈 목록(모른다)을 돌려 일반 안내로 물러난다.
 */
async function deploymentTargets(
  api: ApiClient,
  token: string,
  deploymentPath: string,
  targetId: number | undefined,
): Promise<DeployTarget[]> {
  try {
    const detail = await api.request<DeploymentDetail>("GET", deploymentPath, { token });
    const targets = detail.configuration?.deploy?.targets ?? [];
    return targetId === undefined ? targets : targets.filter((target) => target.id === targetId);
  } catch {
    return [];
  }
}

const isOnprem = (target: DeployTarget): boolean => target.kind === "ONPREM";
const hasOnprem = (targets: DeployTarget[]): boolean => targets.some(isOnprem);
/** 서버의 오류를 내 서버 탓으로 돌리려면 공용 타깃이 섞여 있지 않아야 한다. */
const isOnpremOnly = (targets: DeployTarget[]): boolean => targets.length > 0 && targets.every(isOnprem);

function validate(options: DeploymentLogsOptions): void {
  if (options.follow && options.kind !== "build") {
    throw new UsageError("--follow 는 빌드 로그(--build)에서만 쓸 수 있습니다. 런타임 로그는 `likelion logs -f` 입니다.");
  }
  const count = options.kind === "build" ? options.tail : options.limit;
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_LIMIT)) {
    throw new UsageError(`--limit 은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.`);
  }
  if (options.search !== undefined && options.kind !== "deploy") {
    throw new UsageError("--search 는 --deploy 에서만 쓸 수 있습니다.");
  }
  if (options.statusClass !== undefined) {
    if (options.kind !== "network") throw new UsageError("--status-class 는 --network 에서만 쓸 수 있습니다.");
    if (!STATUS_CLASSES.includes(options.statusClass)) {
      throw new UsageError(`--status-class 는 ${STATUS_CLASSES.join("·")} 중 하나여야 합니다.`);
    }
  }
  if (options.target !== undefined && options.kind === "build") {
    throw new UsageError("--target 은 --deploy·--network 에서만 쓸 수 있습니다.");
  }
}

/** 타깃을 지정했을 때만 id 로 바꾼다. 아니면 서버가 이 배포가 반영된 첫 타깃을 고른다. */
async function optionalTargetId(
  api: ApiClient,
  token: string,
  serviceId: number,
  target: string | undefined,
): Promise<number | undefined> {
  return target === undefined ? undefined : resolveTargetId(api, token, serviceId, target);
}

interface BuildLogParams {
  api: ApiClient;
  token: string;
  serviceId: number;
  deploymentId: number;
  follow: boolean;
  tail: number | undefined;
  print: (entry: BuildLogEntry) => void;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

async function showBuildLogs(params: BuildLogParams): Promise<void> {
  const { api, token, serviceId, deploymentId, follow, tail, print, warn, sleep } = params;
  const reader = new BuildLogReader(api, token, serviceId, deploymentId);
  let lines = 0;
  let loggedDeploymentId: number | undefined;
  let buildStatus: string | undefined;
  // tail 이면 처음 읽는 로그(이미 쌓인 것)는 모았다가 마지막 N줄만 보이고, 그 뒤 새 로그는 바로 보인다.
  let isBuffering = tail !== undefined;
  const backlog: BuildLogEntry[] = [];
  const onEntries = (entries: BuildLogEntry[]) => {
    lines += entries.length;
    if (!isBuffering) {
      for (const entry of entries) print(entry);
      return;
    }
    backlog.push(...entries);
    if (tail !== undefined && backlog.length > tail) backlog.splice(0, backlog.length - tail);
  };
  const flushBacklog = () => {
    if (!isBuffering) return;
    isBuffering = false;
    for (const entry of backlog) print(entry);
    if (lines > backlog.length) {
      warn(`마지막 ${backlog.length}줄만 보여 줬습니다 (전체 ${lines}줄). -n 으로 늘릴 수 있습니다.`);
    }
  };

  for (;;) {
    const page = await reader.drain(onEntries);
    flushBacklog();
    loggedDeploymentId = page?.loggedDeploymentId ?? loggedDeploymentId;
    buildStatus = page?.buildStatus ?? buildStatus;
    if (page?.isPartial) {
      warn("빌드 로그의 앞부분이 빠져 있습니다 (끝부분만 받았습니다).");
      break;
    }
    if (reader.isLimitReached) {
      warn(`${MAX_BUILD_LOG_LINES}줄에서 읽기를 멈췄습니다. 전체는 대시보드에서 확인하세요.`);
      break;
    }
    if (!follow || page?.isComplete) break;

    // 빌드가 끝나지 않았으면 기다린다. 배포가 끝났는데 빌드 로그가 없으면(빌드 전에 실패) 더 기다릴 게 없다.
    const detail = await api.request<DeploymentDetail>(
      "GET",
      `/services/${serviceId}/deployments/${deploymentId}`,
      { token },
    );
    if (TERMINAL_STATUSES.has(detail.status)) {
      await reader.drain(onEntries);
      break;
    }
    await sleep(FOLLOW_INTERVAL_MS);
  }

  if (loggedDeploymentId !== undefined && loggedDeploymentId !== deploymentId) {
    warn(`이 배포는 새로 빌드하지 않아 배포 #${loggedDeploymentId} 의 빌드 로그입니다.`);
  }
  if (lines === 0) {
    warn(
      buildStatus
        ? `서버가 이 빌드(상태 ${buildStatus})의 로그를 돌려주지 않았습니다. 로그가 수집되지 않았거나 보관 기간이 지났을 수 있습니다.`
        : "빌드 로그가 없습니다. 빌드가 아직 시작하지 않았거나 빌드 전에 끝난 배포입니다.",
    );
  }
}

function formatNetworkEntry(entry: NetworkLogEntry): string {
  const target = entry.targetStatus !== undefined ? `서비스 ${entry.targetStatus}` : "서비스 응답 없음";
  const time = entry.responseTimeSeconds !== undefined ? formatDuration(entry.responseTimeSeconds) : "-";
  return `${formatTimestampNs(entry.timestampNs)} ${entry.status} (${target}) 수신 ${formatBytes(entry.receivedBytes)} 송신 ${formatBytes(entry.sentBytes)} 응답 ${time}`;
}

function formatDuration(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : formatSeconds(seconds);
}
