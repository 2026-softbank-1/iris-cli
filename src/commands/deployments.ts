import type { FetchLike } from "../lib/api.js";
import { describeSource, describeStage, resolveDeploymentId } from "../lib/deployment.js";
import { UsageError } from "../lib/errors.js";
import { formatTable } from "../lib/format.js";
import { printJson } from "../lib/output.js";
import { requireLinkedSession } from "../lib/session.js";
import type { Deployment, DeploymentDetail, Page } from "../lib/types.js";

const MAX_LIMIT = 100;

export interface DeploymentsDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
}

export interface DeploymentsListOptions {
  limit: number;
  json?: boolean;
}

/** 연결된 서비스의 배포 이력을 최신순으로 보여 준다. */
export async function runDeploymentsList(
  options: DeploymentsListOptions,
  deps: DeploymentsDeps = {},
): Promise<Page<Deployment>> {
  const log = deps.log ?? console.log;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw new UsageError(`--limit 은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.`);
  }
  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);

  const page = await api.request<Page<Deployment>>("GET", `/services/${link.serviceId}/deployments`, {
    token,
    query: { page: 0, size: options.limit },
  });
  if (options.json) {
    printJson(page, log);
    return page;
  }
  if (page.items.length === 0) {
    log("배포 이력이 없습니다. `likelion up` 이나 `likelion deploy` 로 배포하세요.");
    return page;
  }

  const rows = page.items.map((deployment) => [
    String(deployment.id),
    deployment.status,
    describeTrigger(deployment),
    deployment.createdAt,
    describeSource(deployment),
  ]);
  for (const line of formatTable([["ID", "상태", "요청", "시각", "커밋"], ...rows])) log(line);
  if (page.total > page.items.length) {
    log(`전체 ${page.total}건 중 최근 ${page.items.length}건입니다. --limit 으로 더 볼 수 있습니다.`);
  }
  return page;
}

export interface DeploymentsShowOptions {
  /** 배포 번호. 생략하면 가장 최근 배포 */
  deployment?: string;
  json?: boolean;
}

/** 배포 하나의 상태·소스·빌드·단계·반영 결과를 보여 준다. */
export async function runDeploymentsShow(
  options: DeploymentsShowOptions,
  deps: DeploymentsDeps = {},
): Promise<DeploymentDetail> {
  const log = deps.log ?? console.log;
  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);

  const id = await resolveDeploymentId(api, token, link.serviceId, options.deployment);
  const detail = await api.request<DeploymentDetail>(
    "GET",
    `/services/${link.serviceId}/deployments/${id}`,
    { token },
  );
  if (options.json) {
    printJson(detail, log);
    return detail;
  }

  log(`배포 #${detail.id}  ${detail.status}`);
  if (detail.failureCode) log(`사유  ${detail.failureCode}`);
  log(`요청  ${describeTrigger(detail)}, ${detail.createdAt}`);
  log(`커밋  ${describeSource(detail)}`);
  if (detail.source) log(`소스  ${detail.source.repository} (${detail.source.branch})`);
  if (detail.deploymentStrategy) log(`방식  ${describeStrategy(detail)}`);
  if (detail.build) {
    const image = detail.build.imageDigest ? `, 이미지 ${detail.build.imageDigest.slice(0, 19)}` : "";
    const code = detail.build.failureCode ? `, ${detail.build.failureCode}` : "";
    log(`빌드  ${detail.build.status}${detail.build.builder ? ` (${detail.build.builder})` : ""}${image}${code}`);
  }
  if (detail.stages.length > 0) log(`단계  ${detail.stages.map(describeStage).join(" → ")}`);
  for (const release of detail.releases ?? []) {
    const argo = [release.argoSyncStatus, release.argoHealthStatus].filter(Boolean).join(" / ");
    log(`반영  타깃 ${release.targetId}: ${release.status}${argo ? ` (${argo})` : ""}${release.failureCode ? `, ${release.failureCode}` : ""}`);
  }
  if (detail.replacedBy) log(`대체  #${detail.replacedBy.deploymentId} (${detail.replacedBy.at})`);
  return detail;
}

function describeTrigger(deployment: { triggerType: string; sourceDeploymentId?: number }): string {
  return deployment.sourceDeploymentId !== undefined
    ? `${deployment.triggerType} (#${deployment.sourceDeploymentId})`
    : deployment.triggerType;
}

function describeStrategy(detail: DeploymentDetail): string {
  const actual = detail.deploymentStrategy ?? "";
  const requested = detail.requestedDeploymentStrategy;
  return requested && requested !== actual ? `${actual} (요청 ${requested}, 조건이 안 맞아 대체됨)` : actual;
}
