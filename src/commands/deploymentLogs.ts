import type { ApiClient, FetchLike } from "../lib/api.js";
import { BuildLogReader, formatBuildLogLine, MAX_BUILD_LOG_LINES } from "../lib/buildLogs.js";
import { resolveDeploymentId, TERMINAL_STATUSES } from "../lib/deployment.js";
import { UsageError } from "../lib/errors.js";
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
        print: (entry) => emit(formatBuildLogLine(entry), entry),
        warn,
        sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      });
      return;
    case "deploy": {
      const targetId = await optionalTargetId(api, token, link.serviceId, options.target);
      const page = await api.request<DeployLogsPage>("GET", `${base}/deploy-logs`, {
        token,
        query: { targetId, limit: options.limit, search: options.search },
      });
      for (const entry of page.entries) {
        emit(`${formatTimestampNs(entry.timestampNs)} ${entry.message}`, entry);
      }
      if (page.entries.length === 0) {
        warn("이 배포의 런타임 로그가 없습니다. 성공하지 못한 배포이거나 로그가 아직 수집되지 않았습니다.");
      }
      if (page.isTruncated) warn(`최근 ${options.limit}줄만 보여 줬습니다. --limit 으로 늘릴 수 있습니다.`);
      return;
    }
    case "network": {
      const targetId = await optionalTargetId(api, token, link.serviceId, options.target);
      const page = await api.request<NetworkLogsPage>("GET", `${base}/network-logs`, {
        token,
        query: { targetId, limit: options.limit, statusClass: options.statusClass },
      });
      for (const entry of page.entries) emit(formatNetworkEntry(entry), entry);
      if (page.entries.length === 0) {
        warn(
          "이 배포의 네트워크 로그가 없습니다. 성공하지 못한 배포이거나, ALB 가 로그를 올리는 데 몇 분 걸려 아직 없을 수 있습니다.",
        );
      }
      if (page.isTruncated) warn(`최근 ${options.limit}줄만 보여 줬습니다. --limit 으로 늘릴 수 있습니다.`);
      return;
    }
  }
}

function validate(options: DeploymentLogsOptions): void {
  if (options.follow && options.kind !== "build") {
    throw new UsageError("--follow 는 빌드 로그(--build)에서만 쓸 수 있습니다. 런타임 로그는 `likelion logs -f` 입니다.");
  }
  if (options.kind !== "build" && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT)) {
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
  print: (entry: BuildLogEntry) => void;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

async function showBuildLogs(params: BuildLogParams): Promise<void> {
  const { api, token, serviceId, deploymentId, follow, print, warn, sleep } = params;
  const reader = new BuildLogReader(api, token, serviceId, deploymentId);
  let lines = 0;
  let loggedDeploymentId: number | undefined;
  let buildStatus: string | undefined;
  const onEntries = (entries: BuildLogEntry[]) => {
    lines += entries.length;
    for (const entry of entries) print(entry);
  };

  for (;;) {
    const page = await reader.drain(onEntries);
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
