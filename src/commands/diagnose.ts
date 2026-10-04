import type { ApiClient, FetchLike } from "../lib/api.js";
import { resolveDeploymentId } from "../lib/deployment.js";
import {
  ApiError,
  CliError,
  describeTransientFailure,
  explainApiError,
  isTransientFailure,
  ResultError,
} from "../lib/errors.js";
import { printJson, progressLog } from "../lib/output.js";
import { requireLinkedSession } from "../lib/session.js";
import type { Diagnosis } from "../lib/types.js";

const POLL_INTERVAL_MS = 2500;
// 서버가 진단을 시작한 지 이만큼 지나도 끝나지 않으면 죽은 것으로 본다(대시보드와 같다).
const MAX_WAIT_MS = 4 * 60_000;
const MAX_POLL_FAILURES = 3;

export interface DiagnoseOptions {
  /** 배포 번호. 생략하면 가장 최근 배포 */
  deployment?: string;
  /** 성공한 진단이 있어도 새로 진단한다(모델 비용이 든다) */
  refresh: boolean;
  /** 진단이 끝날 때까지 기다린다. false 면 지금 상태만 알린다 */
  wait: boolean;
  /** 진단이 근거로 쓴 로그 줄도 보여 준다 */
  evidence: boolean;
  json?: boolean;
}

export interface DiagnoseDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 실패한 배포의 AI 진단(원인·해결책)을 보여 준다. 진단이 없으면 시작하고, 진행 중이면 끝날 때까지 기다린다.
 * 서버는 해결책을 제안만 하고 실행하지 않는다. 고치려면 `likelion fix` 다.
 */
export async function runDiagnose(options: DiagnoseOptions, deps: DiagnoseDeps = {}): Promise<Diagnosis> {
  const out = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const log = progressLog(options.json ?? false, out, warn);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);
  const deploymentId = await resolveDeploymentId(api, token, link.serviceId, options.deployment);
  const path = `/services/${link.serviceId}/deployments/${deploymentId}`;

  let diagnosis = options.refresh ? undefined : await findDiagnosis(api, token, path);
  if (!diagnosis || diagnosis.status === "FAILED") {
    log(options.refresh ? "새로 진단을 시작합니다..." : "진단을 시작합니다...");
    diagnosis = await startDiagnosis(api, token, path, deploymentId, options.refresh);
  }

  if (diagnosis.status === "RUNNING") {
    if (!options.wait) {
      log(`진단 #${diagnosis.id} 이 진행 중입니다. \`likelion diagnose ${deploymentId}\` 로 결과를 확인하세요.`);
      if (options.json) printJson(diagnosis, out);
      return diagnosis;
    }
    log("진단 중... (최대 2분 남짓 걸립니다)");
    diagnosis = await waitForDiagnosis(api, token, path, deploymentId, diagnosis, { now, sleep, warn });
  }

  if (options.json) printJson(diagnosis, out);
  else printDiagnosis(diagnosis, deploymentId, options.evidence, out);

  if (diagnosis.status === "FAILED") {
    throw new ResultError(describeFailure(diagnosis, deploymentId), diagnosis.errorCode ?? "DIAGNOSIS_FAILED");
  }
  return diagnosis;
}

async function findDiagnosis(api: ApiClient, token: string, path: string): Promise<Diagnosis | undefined> {
  try {
    return await api.request<Diagnosis>("GET", `${path}/diagnosis`, { token });
  } catch (error) {
    if (error instanceof ApiError && error.code === "DIAGNOSIS_NOT_FOUND") return undefined;
    throw error;
  }
}

async function startDiagnosis(
  api: ApiClient,
  token: string,
  path: string,
  deploymentId: number,
  refresh: boolean,
): Promise<Diagnosis> {
  try {
    return await api.request<Diagnosis>("POST", `${path}/diagnose`, {
      token,
      query: { refresh: refresh ? "true" : undefined },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "DIAGNOSIS_IN_PROGRESS") {
      // 서버가 자동으로 시작한 진단이 이미 돌고 있다. 그 진단을 따라간다.
      const running = await findDiagnosis(api, token, path);
      if (running) return running;
    }
    if (error instanceof ApiError && error.code === "DEPLOYMENT_NOT_FAILED") {
      throw explainApiError(
        error,
        `실패한 배포만 진단할 수 있습니다. 배포 #${deploymentId} 는 진단 대상이 아닙니다(실패·롤백됨·운영자 확인 필요 상태만 가능). \`likelion deployments\` 로 번호를 확인하세요.`,
      );
    }
    throw error;
  }
}

async function waitForDiagnosis(
  api: ApiClient,
  token: string,
  path: string,
  deploymentId: number,
  started: Diagnosis,
  clock: { now: () => number; sleep: (ms: number) => Promise<void>; warn: (message: string) => void },
): Promise<Diagnosis> {
  const startedAt = clock.now();
  let failures = 0;
  let diagnosis = started;
  while (diagnosis.status === "RUNNING") {
    if (clock.now() - startedAt >= MAX_WAIT_MS) {
      throw new CliError(
        `진단이 4분 안에 끝나지 않아 기다리기를 멈춥니다. \`likelion diagnose ${deploymentId} --refresh\` 로 다시 시작할 수 있습니다.`,
      );
    }
    await clock.sleep(POLL_INTERVAL_MS);
    try {
      diagnosis = await api.request<Diagnosis>("GET", `${path}/diagnosis`, { token });
      failures = 0;
    } catch (error) {
      if (!isTransientFailure(error)) throw error;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new CliError(
          `진단 상태를 연속 ${failures}회 확인하지 못했습니다 (마지막 오류: ${error.message}). \`likelion diagnose ${deploymentId}\` 로 다시 확인하세요.`,
        );
      }
      clock.warn(`${describeTransientFailure(error)} 다시 확인합니다 (${failures}/${MAX_POLL_FAILURES}).`);
    }
  }
  return diagnosis;
}

const FAILURE_REASONS: Record<string, string> = {
  DIAGNOSIS_LOGS_UNAVAILABLE: "진단에 쓸 빌드·배포 로그를 가져오지 못했습니다.",
};

function describeFailure(diagnosis: Diagnosis, deploymentId: number): string {
  const reason = FAILURE_REASONS[diagnosis.errorCode ?? ""] ?? "진단이 끝나지 못했습니다.";
  const code = diagnosis.errorCode ? ` (${diagnosis.errorCode})` : "";
  return `${reason}${code} 로그는 \`likelion logs --build --deployment ${deploymentId}\` 로 직접 볼 수 있고, \`likelion diagnose ${deploymentId} --refresh\` 로 다시 진단할 수 있습니다.`;
}

const SUPPORT_LEVELS: Record<string, string> = { direct: "로그에 직접 나옴", supported: "근거로 추정" };

function printDiagnosis(
  diagnosis: Diagnosis,
  deploymentId: number,
  showEvidence: boolean,
  log: (message: string) => void,
): void {
  log(`진단 #${diagnosis.id} (배포 #${deploymentId})  ${diagnosis.status}`);
  const analysis = diagnosis.analysis;
  if (!analysis) return;

  log(`요약  ${analysis.summary}`);
  if (analysis.analysisStatus !== "diagnosed") {
    log(`      (${analysis.analysisStatus === "insufficient_evidence" ? "근거가 부족해 원인을 단정하지 못했습니다" : "로그에서 실패 흔적을 찾지 못했습니다"})`);
  }

  const hypotheses = analysis.hypotheses ?? [];
  if (hypotheses.length > 0) {
    log("");
    log(`원인 ${hypotheses.length}개`);
    hypotheses.forEach((hypothesis, index) => {
      log(`  ${index + 1}. [${SUPPORT_LEVELS[hypothesis.supportLevel] ?? hypothesis.supportLevel}] ${hypothesis.statement}`);
      if (hypothesis.uncertainty) log(`     불확실한 점: ${hypothesis.uncertainty}`);
      if (hypothesis.evidenceIds?.length) log(`     근거: ${hypothesis.evidenceIds.join(", ")}`);
    });
  }

  const plans = analysis.remediation?.plans ?? [];
  if (plans.length > 0) {
    log("");
    log(`해결책 ${plans.length}개 (제안일 뿐 서버가 실행하지 않습니다)`);
    plans.forEach((plan, index) => {
      log(`  ${index + 1}. ${plan.title}`);
      if (plan.applyWhen?.length) log(`     적용 조건: ${plan.applyWhen.join("; ")}`);
      for (const change of plan.changes ?? []) {
        log(`     - [${change.kind}] ${change.target}: ${change.instruction}`);
        if (change.snippet) {
          for (const line of change.snippet.split("\n")) log(`         ${line}`);
        }
      }
      for (const check of plan.verification ?? []) log(`     확인: ${check.instruction} → ${check.expectedResult}`);
      if (plan.rollback?.length) log(`     되돌리기: ${plan.rollback.join("; ")}`);
      if (plan.risks?.length) log(`     주의: ${plan.risks.join("; ")}`);
    });
    if (plans.some((plan) => plan.changes?.some((change) => change.snippet?.includes("{{")))) {
      log("  * 수정 예시는 템플릿입니다. {{이름}} 자리표시자를 채워서 쓰세요.");
    }
    log(`  AI 로 고치려면: \`likelion fix ${deploymentId}\` (핫픽스 PR 을 만들어 main 에 머지하고 재배포합니다)`);
  } else if (analysis.remediation?.reason) {
    log("");
    log(`해결책  ${analysis.remediation.reason}`);
  }

  if (analysis.nextChecks?.length) {
    log("");
    log("더 확인할 것");
    for (const check of analysis.nextChecks) log(`  - ${check.target}: ${check.method} (${check.purpose})`);
  }
  if (analysis.missingInformation?.length) {
    log("");
    log("더 필요한 정보");
    for (const info of analysis.missingInformation) log(`  - ${info.requestedData} — ${info.reason}`);
  }

  const findings = diagnosis.sourceAnalysis?.findings ?? [];
  if (findings.length > 0) {
    log("");
    log("소스 분석");
    for (const finding of findings) {
      log(`  - ${finding.path}:${finding.startLine}-${finding.endLine} ${finding.explanation}`);
    }
  }

  const limitations = [...(analysis.limitations ?? []), ...(diagnosis.inputLimitations ?? [])];
  if (limitations.length > 0) {
    log("");
    log("한계");
    for (const limitation of limitations) log(`  - ${limitation}`);
  }

  const evidence = diagnosis.evidence ?? [];
  if (evidence.length > 0) {
    log("");
    if (showEvidence) {
      log(`근거 로그 ${evidence.length}줄`);
      for (const line of evidence) log(`  ${line.id} [${line.stage}] ${line.text}`);
    } else {
      log(`근거 로그 ${evidence.length}줄은 --evidence 로 볼 수 있습니다.`);
    }
  }
}
