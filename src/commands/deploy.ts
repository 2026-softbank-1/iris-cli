import { randomUUID } from "node:crypto";
import type { FetchLike } from "../lib/api.js";
import { createBuildLogFollower } from "../lib/buildLogs.js";
import {
  parseDeploymentId,
  reportResult,
  resolveDeploymentId,
  waitForDeployment,
} from "../lib/deployment.js";
import { ApiError, CliError, explainApiError, UsageError } from "../lib/errors.js";
import { printJson, progressLog } from "../lib/output.js";
import { requireLinkedSession } from "../lib/session.js";
import type { Deployment } from "../lib/types.js";

export type DeployKind = "deploy" | "redeploy" | "rollback" | "restart";

export interface DeployOptions {
  kind: DeployKind;
  /** `deploy`: 이 커밋을 빌드한다. 생략하면 브랜치 최신 커밋 */
  sha?: string;
  /** `redeploy`·`rollback`: 원본 배포 번호. `redeploy` 는 생략하면 가장 최근 배포 */
  deployment?: string;
  /** 배포 요청만 보내고 끝까지 기다리지 않는다 */
  detach: boolean;
  /** 기다리는 동안 빌드 로그도 이어서 보여 준다 */
  logs?: boolean;
  /** 진행 안내는 stderr 로 보내고 stdout 에는 배포 결과 JSON 만 낸다 */
  json?: boolean;
}

export interface DeployDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 멱등성 키에 쓸 난수. 테스트에서 고정한다. */
  randomId?: () => string;
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const TITLES: Record<DeployKind, string> = {
  deploy: "배포",
  redeploy: "재배포",
  rollback: "롤백",
  restart: "재시작",
};

/**
 * 대시보드의 Deploy·Redeploy·Rollback·Restart 버튼과 같은 배포 요청(`MANUAL`·`REDEPLOY`·`ROLLBACK`·`RESTART`)을
 * 만들고, 끝날 때까지 상태를 보여 준다. 로컬 폴더를 올려 배포하는 `up` 과 달리 서버가 GitHub·이미 빌드한 이미지를 쓴다.
 */
export async function runDeploy(options: DeployOptions, deps: DeployDeps = {}): Promise<number> {
  const out = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const log = progressLog(options.json ?? false, out, warn);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const title = TITLES[options.kind];

  const { api, token, link } = await requireLinkedSession(deps.cwd ?? process.cwd(), deps.fetchImpl);
  const body = await buildBody();

  let deployment: Deployment;
  try {
    deployment = await api.request<Deployment>("POST", `/services/${link.serviceId}/deployments`, {
      token,
      body,
      headers: { "Idempotency-Key": `${options.kind}-${(deps.randomId ?? randomUUID)()}` },
    });
  } catch (error) {
    throw explain(error, options.kind);
  }
  log(`${title} 요청 #${deployment.id} (${deployment.status}, ${deployment.triggerType})`);

  if (options.detach) {
    log("기다리지 않고 끝냅니다. 진행 상황은 `likelion status` 로 확인하세요.");
    if (options.json) printJson(deployment, out);
    return deployment.id;
  }

  const onPoll = options.logs
    ? createBuildLogFollower(api, token, link.serviceId, deployment.id, log, warn)
    : undefined;
  const detail = await waitForDeployment(
    api,
    token,
    link.serviceId,
    deployment.id,
    { now, sleep, log, warn },
    { onPoll },
  );
  if (options.json) printJson(detail, out);
  await reportResult(api, token, link.serviceId, detail, log);
  return deployment.id;

  async function buildBody(): Promise<Record<string, unknown>> {
    switch (options.kind) {
      case "deploy": {
        if (options.sha === undefined) return { triggerType: "MANUAL" };
        if (!SHA_PATTERN.test(options.sha)) {
          throw new UsageError(`커밋 SHA 형식이 올바르지 않습니다: ${options.sha} (7~64자리 16진수)`);
        }
        return { triggerType: "MANUAL", sourceSha: options.sha };
      }
      case "restart":
        return { triggerType: "RESTART" };
      case "rollback": {
        if (options.deployment === undefined) {
          throw new UsageError(
            "되돌릴 배포 번호가 필요합니다: `likelion rollback <배포 번호>`. 번호는 `likelion deployments` 로 확인하세요.",
          );
        }
        return {
          triggerType: "ROLLBACK",
          sourceDeploymentId: parseDeploymentId(options.deployment),
        };
      }
      case "redeploy": {
        const id = await resolveDeploymentId(api, token, link.serviceId, options.deployment);
        return { triggerType: "REDEPLOY", sourceDeploymentId: id };
      }
    }
  }
}

/** 서버가 거절한 배포 요청 중 흔한 것을 다음에 할 일과 함께 알린다. 그 밖은 서버 메시지 그대로다. */
function explain(error: unknown, kind: DeployKind): unknown {
  if (!(error instanceof ApiError)) return error;
  switch (error.code) {
    case "DEPLOYMENT_IN_PROGRESS":
      return explainApiError(
        error,
        "진행 중인 배포가 있어 새로 요청할 수 없습니다. 끝난 뒤 다시 실행하세요. 상태는 `likelion deployments` 로 확인합니다.",
      );
    case "NO_SUCCEEDED_DEPLOYMENT":
      return explainApiError(
        error,
        `성공한 배포가 없어 ${TITLES[kind]}할 수 없습니다. \`likelion up\` 이나 \`likelion deploy\` 로 먼저 배포하세요.`,
      );
    case "TARGET_NOT_CONNECTED":
      return explainApiError(
        error,
        "배포 타깃 서버가 연결되지 않아 배포할 수 없습니다. 대시보드에서 서버 연결 상태를 확인하세요.",
      );
    case "DEPLOYMENT_REQUEST_NOT_FOUND":
      return explainApiError(error, "그 번호의 배포를 찾을 수 없습니다. `likelion deployments` 로 번호를 확인하세요.");
    default:
      return error;
  }
}
