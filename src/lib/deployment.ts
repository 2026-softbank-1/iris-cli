import type { ApiClient } from "./api.js";
import {
  CliError,
  describeTransientFailure,
  isTransientFailure,
  ResultError,
  UsageError,
} from "./errors.js";
import { formatSeconds, shortSha } from "./format.js";
import type { DeploymentDetail, DeploymentStage, Service, ServiceDomain } from "./types.js";

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 20 * 60_000;
// 연속으로 이만큼까지는 다시 확인하고, 넘으면 멈춘다. 쉬는 시간은 실패가 이어질수록 늘린다.
const MAX_POLL_FAILURES = 5;
const RETRY_DELAYS_MS = [2000, 3000, 4000, 5000, 5000];

export const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ROLLED_BACK",
  "MANUAL_INTERVENTION",
  "SUPERSEDED",
]);

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface WaitOptions {
  /** 상태를 받을 때마다(끝난 상태 포함) 부른다. 빌드 로그를 이어 보여 주는 데 쓴다. */
  onPoll?: (detail: DeploymentDetail) => Promise<void>;
}

/** 배포가 끝날 때까지 2초마다 상태를 확인한다. 상태가 바뀔 때만 한 줄씩 보여 준다. */
export async function waitForDeployment(
  api: ApiClient,
  token: string,
  serviceId: number,
  deploymentId: number,
  clock: Clock,
  options: WaitOptions = {},
): Promise<DeploymentDetail> {
  const startedAt = clock.now();
  let lastStatus = "";
  let failures = 0;
  for (;;) {
    let detail: DeploymentDetail | undefined;
    try {
      detail = await api.request<DeploymentDetail>(
        "GET",
        `/services/${serviceId}/deployments/${deploymentId}`,
        { token },
      );
      failures = 0;
    } catch (error) {
      // 배포 요청은 이미 서버에 있다. 일시적인 실패(5xx·연결 끊김)만 다시 확인하고, 4xx 같은 나머지는 바로 끝낸다.
      if (!isTransientFailure(error)) throw error;
      failures += 1;
      if (failures > MAX_POLL_FAILURES) {
        throw new CliError(
          `배포 #${deploymentId} 의 상태를 연속 ${failures}회 확인하지 못해 기다리기를 멈춥니다 (마지막 오류: ${error.message}). 배포는 계속 진행 중일 수 있습니다. \`likelion status\` 로 확인해 주세요.`,
        );
      }
      clock.warn(`${describeTransientFailure(error)} 다시 확인합니다 (${failures}/${MAX_POLL_FAILURES}).`);
    }

    if (detail) {
      if (detail.status !== lastStatus) {
        const elapsed = Math.round((clock.now() - startedAt) / 1000);
        clock.log(`  ${detail.status} (+${elapsed}s)`);
        lastStatus = detail.status;
      }
      await options.onPoll?.(detail);
      if (TERMINAL_STATUSES.has(detail.status)) return detail;
    }

    if (clock.now() - startedAt >= MAX_WAIT_MS) {
      throw new CliError(
        "배포가 20분 안에 끝나지 않아 기다리기를 멈춥니다. `likelion status` 로 확인해 주세요.",
      );
    }
    await clock.sleep(failures > 0 ? (RETRY_DELAYS_MS[failures - 1] ?? POLL_INTERVAL_MS) : POLL_INTERVAL_MS);
  }
}

/** 끝난 배포의 결과를 알린다. 성공이면 주소를 보여 주고, 아니면 원인을 볼 명령과 함께 실패로 끝낸다. */
export async function reportResult(
  api: ApiClient,
  token: string,
  serviceId: number,
  detail: DeploymentDetail,
  log: (message: string) => void,
): Promise<void> {
  switch (detail.status) {
    case "SUCCEEDED": {
      log("배포가 완료되었습니다.");
      const domains = await api.request<ServiceDomain[]>("GET", `/services/${serviceId}/domains`, {
        token,
      });
      for (const domain of domains) {
        if (domain.isConnected && domain.url) log(`주소  ${domain.url} (${domain.targetName})`);
      }
      return;
    }
    case "FAILED":
      throw new ResultError(
        `배포가 실패했습니다 (${detail.failureCode ?? "원인 미상"}). \`likelion status\` 로 단계를 확인해 주세요. 원인은 \`likelion logs --build --deployment ${detail.id}\` 로 보거나 \`likelion diagnose ${detail.id}\` 로 AI 진단을 받을 수 있습니다.`,
        "DEPLOYMENT_FAILED",
      );
    case "ROLLED_BACK":
      throw new ResultError(
        `배포가 실패해 이전 버전으로 되돌렸습니다. \`likelion status\` 로 확인해 주세요. 원인은 \`likelion diagnose ${detail.id}\` 로 볼 수 있습니다.`,
        "DEPLOYMENT_ROLLED_BACK",
      );
    case "MANUAL_INTERVENTION":
      throw new ResultError(
        "운영자 확인이 필요한 상태입니다. `likelion status` 로 확인해 주세요.",
        "DEPLOYMENT_MANUAL_INTERVENTION",
      );
    default:
      throw new ResultError("더 새로운 배포 요청이 대신해 이 배포는 중단되었습니다.", "DEPLOYMENT_SUPERSEDED");
  }
}

// 끝난 상태의 단계에는 종료 시각이 없어 소요 시간도 없다. 진행 중으로 읽히지 않게 상태만 보여 준다.
export function describeStage(stage: DeploymentStage): string {
  if (stage.durationSeconds !== undefined) {
    return `${stage.status} ${formatSeconds(stage.durationSeconds)}`;
  }
  return TERMINAL_STATUSES.has(stage.status) ? stage.status : `${stage.status} 진행 중`;
}

/** `12`·`#12` 형태의 배포 번호를 읽는다. */
export function parseDeploymentId(text: string): number {
  const match = /^#?(\d+)$/.exec(text.trim());
  if (!match?.[1] || Number(match[1]) < 1) {
    throw new UsageError(`배포 번호가 올바르지 않습니다: ${text} (예: 12)`);
  }
  return Number(match[1]);
}

/** 배포 한 줄 요약에 쓰는 소스 표기. */
export function describeSource(deployment: { sourceSha: string; sourceCommitMessage?: string }): string {
  const message = deployment.sourceCommitMessage ? `  ${deployment.sourceCommitMessage.split("\n")[0]}` : "";
  return `${shortSha(deployment.sourceSha)}${message}`;
}

/** 배포 번호를 정한다. 지정하지 않으면 서비스의 가장 최근 배포다. */
export async function resolveDeploymentId(
  api: ApiClient,
  token: string,
  serviceId: number,
  option: string | undefined,
): Promise<number> {
  if (option !== undefined) return parseDeploymentId(option);
  const service = await api.request<Service>("GET", `/services/${serviceId}`, { token });
  if (!service.latestDeployment) {
    throw new CliError("배포 이력이 없습니다. `likelion up` 이나 `likelion deploy` 로 먼저 배포하세요.");
  }
  return service.latestDeployment.id;
}
