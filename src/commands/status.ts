import type { FetchLike } from "../lib/api.js";
import { describeStage } from "../lib/deployment.js";
import { shortSha } from "../lib/format.js";
import { requireLink } from "../lib/link.js";
import { printJson } from "../lib/output.js";
import { requireSession } from "../lib/session.js";
import type { DeploymentDetail, Service, ServiceDomain } from "../lib/types.js";

export interface StatusOptions {
  json?: boolean;
}

export interface StatusDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
}

/** 연결된 서비스의 최근 배포 상태·단계별 소요 시간·접속 주소를 보여 준다. */
export async function runStatus(options: StatusOptions = {}, deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const link = await requireLink(deps.cwd ?? process.cwd(), credentials);
  const token = credentials.token;

  const [service, domains] = await Promise.all([
    api.request<Service>("GET", `/services/${link.serviceId}`, { token }),
    api.request<ServiceDomain[]>("GET", `/services/${link.serviceId}/domains`, { token }),
  ]);

  const latest = service.latestDeployment;
  const detail = latest
    ? await api.request<DeploymentDetail>("GET", `/services/${service.id}/deployments/${latest.id}`, {
        token,
      })
    : undefined;

  if (options.json) {
    printJson({ service, deployment: detail ?? null, domains }, log);
    return;
  }

  log(`${service.name} (서비스 ${service.id}, 프로젝트 ${link.projectName})`);
  if (detail) {
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
