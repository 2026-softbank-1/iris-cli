import type { FetchLike } from "../lib/api.js";
import { formatSeconds, shortSha } from "../lib/format.js";
import { requireLink } from "../lib/link.js";
import { requireSession } from "../lib/session.js";
import type { DeploymentDetail, DeploymentStage, Service, ServiceDomain } from "../lib/types.js";

export interface StatusDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
}

/** 연결된 서비스의 최근 배포 상태·단계별 소요 시간·접속 주소를 보여 준다. */
export async function runStatus(deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const link = await requireLink(deps.cwd ?? process.cwd(), credentials);
  const token = credentials.token;

  const [service, domains] = await Promise.all([
    api.request<Service>("GET", `/services/${link.serviceId}`, { token }),
    api.request<ServiceDomain[]>("GET", `/services/${link.serviceId}/domains`, { token }),
  ]);

  log(`${service.name} (서비스 ${service.id}, 프로젝트 ${link.projectName})`);
  const latest = service.latestDeployment;
  if (latest) {
    const detail = await api.request<DeploymentDetail>(
      "GET",
      `/services/${service.id}/deployments/${latest.id}`,
      { token },
    );
    log(`상태  ${detail.status}`);
    if (detail.failureCode) log(`사유  ${detail.failureCode}`);
    const message = detail.sourceCommitMessage ? `  ${detail.sourceCommitMessage}` : "";
    log(`커밋  ${shortSha(detail.sourceSha)}${message}`);
    log(`요청  ${detail.triggerType}, ${detail.createdAt}`);
    if (detail.stages.length > 0) log(`단계  ${detail.stages.map(describeStage).join(" → ")}`);
  } else {
    log("배포 이력이 없습니다.");
  }

  for (const domain of domains) {
    if (domain.isConnected && domain.url) log(`주소  ${domain.url} (${domain.targetName})`);
  }
}

// 끝난 상태의 단계에는 종료 시각이 없어 소요 시간도 없다. 진행 중으로 읽히지 않게 상태만 보여 준다.
const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ROLLED_BACK",
  "MANUAL_INTERVENTION",
  "SUPERSEDED",
]);

function describeStage(stage: DeploymentStage): string {
  if (stage.durationSeconds !== undefined) {
    return `${stage.status} ${formatSeconds(stage.durationSeconds)}`;
  }
  return TERMINAL_STATUSES.has(stage.status) ? stage.status : `${stage.status} 진행 중`;
}
