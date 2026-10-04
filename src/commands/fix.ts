import { randomUUID } from "node:crypto";
import type { ApiClient, FetchLike } from "../lib/api.js";
import { reportResult, resolveDeploymentId, waitForDeployment } from "../lib/deployment.js";
import {
  ApiError,
  CliError,
  describeTransientFailure,
  explainApiError,
  isTransientFailure,
  ResultError,
  UsageError,
} from "../lib/errors.js";
import { printJson, progressLog } from "../lib/output.js";
import { type Ask, confirm } from "../lib/prompt.js";
import { requireLinkedSession } from "../lib/session.js";
import type { Diagnosis, Repair, RepairAccess, Service } from "../lib/types.js";

const POLL_INTERVAL_MS = 2500;
// 서버의 자동 수정 마감(30분)에 맞춘다.
const MAX_WAIT_MS = 35 * 60_000;
const MAX_POLL_FAILURES = 5;
// 이 게시 상태에 오면 서버가 할 일이 끝났다.
const SETTLED_PUBLICATION = ["REDEPLOY_REQUESTED", "MERGED", "ERROR", "SKIPPED"];

export interface FixOptions {
  /** 배포 번호. 생략하면 가장 최근 배포 */
  deployment?: string;
  /** 묻지 않고 진행한다. AI 수정은 핫픽스 PR 생성부터 main 머지·재배포까지 이어지므로 확인을 거친다 */
  yes: boolean;
  /** 수정 요청만 보내고 끝까지 기다리지 않는다. 같은 명령을 다시 실행하면 이어서 본다 */
  detach: boolean;
  json?: boolean;
}

export interface FixDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ask?: Ask;
  randomId?: () => string;
}

/**
 * 실패한 배포를 AI 가 고치게 한다(대시보드의 `AI 수정·재배포`). 서버가 수정 후보를 만들어 핫픽스 PR 을 올리고
 * main 에 머지한 뒤 재배포한다(GitHub 보호 규칙은 그대로 적용된다). 이미 진행 중인 수정이 있으면 새로 만들지 않고 이어 본다.
 */
export async function runFix(options: FixOptions, deps: FixDeps = {}): Promise<Repair | undefined> {
  const out = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const log = progressLog(options.json ?? false, out, warn);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);
  const serviceId = link.serviceId;
  const deploymentId = await resolveDeploymentId(api, token, serviceId, options.deployment);
  const deploymentPath = `/services/${serviceId}/deployments/${deploymentId}`;

  if (!options.yes) {
    if (!deps.ask) {
      throw new UsageError(
        "AI 수정은 핫픽스 PR 을 올려 main 에 머지하고 재배포합니다. 대화형 터미널이 아니라 확인할 수 없으니 --yes 를 붙여 다시 실행해 주세요.",
      );
    }
    const service = await api.request<Service>("GET", `/services/${serviceId}`, { token });
    const isConfirmed = await confirm(
      deps.ask,
      `AI 가 ${service.sourceRepositoryUrl} 의 ${service.sourceBranch} 를 고치는 핫픽스 PR 을 올리고 main 에 머지한 뒤 재배포합니다. 계속할까요?`,
      false,
    );
    if (!isConfirmed) {
      log("수정하지 않았습니다.");
      return undefined;
    }
  }

  const diagnosis = await findSucceededDiagnosis(api, token, deploymentPath);
  let repair = await startOrResume(api, token, serviceId, deploymentId, deploymentPath, diagnosis, deps.randomId ?? randomUUID);
  log(`AI 수정 #${repair.id} (${describeState(repair)})`);

  if (options.detach) {
    log(`기다리지 않고 끝냅니다. \`likelion fix ${deploymentId} --yes\` 를 다시 실행하면 이어서 봅니다.`);
    if (options.json) printJson({ repair }, out);
    return repair;
  }

  repair = await waitForRepair(api, token, serviceId, repair, { now, sleep, log, warn });
  const publication = repair.publication;

  if (repair.status === "FAILED") {
    if (options.json) printJson({ repair }, out);
    throw new ResultError(
      `AI 수정이 실패했습니다${repair.errorCode ? ` (${repair.errorCode})` : ""}. \`likelion diagnose ${deploymentId}\` 로 원인을 다시 확인하세요.`,
      repair.errorCode ?? "REPAIR_FAILED",
    );
  }
  if (publication?.status === "ERROR") {
    if (options.json) printJson({ repair }, out);
    throw new ResultError(
      describePublicationError(publication.errorCode, publication.pullUrl),
      publication.errorCode ?? "REPAIR_PUBLICATION_FAILED",
    );
  }
  if (publication?.status === "SKIPPED") {
    if (options.json) printJson({ repair }, out);
    log("AI 가 코드를 바꾸지 않고 끝냈습니다. 환경변수 값이 필요한 실패라면 `likelion env set` 후 `likelion redeploy` 하세요.");
    return repair;
  }

  if (publication?.pullUrl) log(`핫픽스 PR  ${publication.pullUrl}`);
  if (publication?.mergeCommitSha) log(`머지  ${publication.mergeCommitSha.slice(0, 7)}`);

  const redeploymentId = publication?.redeploymentId;
  if (redeploymentId === undefined) {
    log("main 에 머지했습니다. 새 배포가 시작되면 `likelion deployments` 로 확인하세요.");
    if (options.json) printJson({ repair }, out);
    return repair;
  }

  log(`재배포 #${redeploymentId} 가 요청되었습니다.`);
  const detail = await waitForDeployment(api, token, serviceId, redeploymentId, { now, sleep, log, warn });
  if (options.json) printJson({ repair, redeployment: detail }, out);
  await reportResult(api, token, serviceId, detail, log);
  return repair;
}

async function findSucceededDiagnosis(
  api: ApiClient,
  token: string,
  deploymentPath: string,
): Promise<Diagnosis | undefined> {
  try {
    const diagnosis = await api.request<Diagnosis>("GET", `${deploymentPath}/diagnosis`, { token });
    return diagnosis.status === "SUCCEEDED" ? diagnosis : undefined;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

/** 이 진단의 기존 수정이 있으면 이어 가고, 없거나 실패했으면 새로 시작한다(대시보드와 같은 규칙). */
async function startOrResume(
  api: ApiClient,
  token: string,
  serviceId: number,
  deploymentId: number,
  deploymentPath: string,
  diagnosis: Diagnosis | undefined,
  randomId: () => string,
): Promise<Repair> {
  const latest = diagnosis ? await findLatestRepair(api, token, deploymentPath, diagnosis.id) : undefined;
  try {
    if (latest?.autoMerge && (isPending(latest) || latest.publication?.status === "MERGED")) return latest;
    if (latest && latest.status !== "FAILED") {
      return await api.request<Repair>("POST", `/services/${serviceId}/repairs/${latest.id}/auto`, { token });
    }
    return await api.request<Repair>("POST", `${deploymentPath}/auto-repair`, {
      token,
      body: diagnosis ? { diagnosisId: diagnosis.id } : {},
      headers: { "Idempotency-Key": `fix-${randomId()}` },
    });
  } catch (error) {
    throw await explainStartError(error, api, token, serviceId, deploymentId);
  }
}

async function findLatestRepair(
  api: ApiClient,
  token: string,
  deploymentPath: string,
  diagnosisId: number,
): Promise<Repair | undefined> {
  try {
    return await api.request<Repair>("GET", `${deploymentPath}/repairs/latest`, {
      token,
      query: { diagnosisId },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

/** 서버가 아직 할 일이 남았는지. 대시보드의 `isAutomaticRepairPending` 과 같다. */
function isPending(repair: Repair): boolean {
  const publication = repair.publication?.status ?? "";
  if (repair.autoRedeploy && publication === "MERGED" && !repair.publication?.redeploymentId) return true;
  if (repair.autoMerge && SETTLED_PUBLICATION.includes(publication)) return false;
  return repair.status === "RUNNING" || repair.status === "UNKNOWN_OUTCOME" || (!!repair.autoMerge && repair.status !== "FAILED");
}

function describeState(repair: Repair): string {
  return repair.publication ? `${repair.status}, 게시 ${repair.publication.status}` : repair.status;
}

interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

async function waitForRepair(
  api: ApiClient,
  token: string,
  serviceId: number,
  started: Repair,
  clock: PollClock,
): Promise<Repair> {
  const startedAt = clock.now();
  let repair = started;
  let lastState = describeState(repair);
  let failures = 0;
  while (isPending(repair)) {
    if (clock.now() - startedAt >= MAX_WAIT_MS) {
      throw new CliError(
        `AI 수정이 35분 안에 끝나지 않아 기다리기를 멈춥니다. \`likelion fix --yes\` 를 다시 실행하면 이어서 봅니다.`,
      );
    }
    await clock.sleep(POLL_INTERVAL_MS);
    try {
      repair = await api.request<Repair>("GET", `/services/${serviceId}/repairs/${repair.id}`, { token });
      failures = 0;
    } catch (error) {
      if (!isTransientFailure(error)) throw error;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new CliError(
          `AI 수정 상태를 연속 ${failures}회 확인하지 못했습니다 (마지막 오류: ${error.message}). 수정은 서버에서 계속됩니다. \`likelion fix --yes\` 로 이어서 확인하세요.`,
        );
      }
      clock.warn(`${describeTransientFailure(error)} 다시 확인합니다 (${failures}/${MAX_POLL_FAILURES}).`);
      continue;
    }
    const state = describeState(repair);
    if (state !== lastState) {
      clock.log(`  ${state}`);
      lastState = state;
    }
  }
  return repair;
}

function describePublicationError(code: string | undefined, pullUrl: string | undefined): string {
  const pr = pullUrl ? ` PR: ${pullUrl}` : "";
  switch (code) {
    case "MERGE_BLOCKED":
      return `GitHub 보호 규칙(필수 검사·승인)이 머지를 막았습니다. 서버는 규칙을 우회하지 않습니다.${pr}`;
    case "SOURCE_HEAD_CHANGED":
      return "저장소 main 이 실패한 시점 이후 바뀌어 수정을 중단했습니다. 최신 배포를 확인한 뒤 다시 시도하세요.";
    default:
      return `핫픽스를 올리지 못했습니다${code ? ` (${code})` : ""}.${pr}`;
  }
}

async function explainStartError(
  error: unknown,
  api: ApiClient,
  token: string,
  serviceId: number,
  deploymentId: number,
): Promise<unknown> {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "CONFIGURATION_VALUES_REQUIRED") {
    const names = (error.details ?? []).map((detail) => detail.field).join(", ");
    return explainApiError(
      error,
      `코드가 아니라 환경변수 값이 필요한 실패입니다${names ? `: ${names}` : ""}. \`likelion env set ${names ? `${names.split(", ")[0]}=<값>` : "KEY=<값>"}\` 로 넣은 뒤 \`likelion redeploy\` 하세요.`,
    );
  }
  if (error.code === "SOURCE_HEAD_CHANGED") {
    return explainApiError(error, "저장소 main 이 실패한 시점 이후 바뀌었습니다. 최신 배포를 확인한 뒤 다시 시도하세요.");
  }
  if (error.code === "DEPLOYMENT_NOT_FAILED") {
    return explainApiError(
      error,
      `실패한 배포만 고칠 수 있습니다. 배포 #${deploymentId} 는 대상이 아닙니다. \`likelion deployments\` 로 번호를 확인하세요.`,
    );
  }
  if (error.status === 403) {
    const access = await api
      .request<RepairAccess>("GET", `/services/${serviceId}/repair-access`, { token })
      .catch(() => undefined);
    const install = access?.installationUrl ? ` GitHub App 권한을 승인하세요: ${access.installationUrl}` : "";
    return explainApiError(error, `AI 수정에 필요한 GitHub 쓰기 권한(Contents·Pull requests)이 없습니다.${install}`);
  }
  return error;
}
