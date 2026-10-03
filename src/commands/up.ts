import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ApiClient, FetchLike } from "../lib/api.js";
import { createArchive } from "../lib/archive.js";
import { ApiError, CliError, ConnectionError } from "../lib/errors.js";
import { formatBytes } from "../lib/format.js";
import { requireLinkLocation } from "../lib/link.js";
import { requireSession } from "../lib/session.js";
import type { DeploymentDetail, ServiceDomain } from "../lib/types.js";

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 20 * 60_000;
// 연속으로 이만큼까지는 다시 확인하고, 넘으면 멈춘다. 쉬는 시간은 실패가 이어질수록 늘린다.
const MAX_POLL_FAILURES = 5;
const RETRY_DELAYS_MS = [2000, 3000, 4000, 5000, 5000];
const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ROLLED_BACK",
  "MANUAL_INTERVENTION",
  "SUPERSEDED",
]);

interface UploadResult {
  uploadId: string;
  sizeBytes: number;
  sha256: string;
}

interface DeploymentRequest {
  id: number;
  status: string;
}

export interface UpOptions {
  /** 배포 요청만 보내고 끝까지 기다리지 않는다 */
  detach: boolean;
}

export interface UpDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxArchiveBytes?: number;
}

/**
 * 연결된 폴더를 tar.gz 로 묶어 올리고 `CLI` 배포 요청을 만든 뒤, 끝날 때까지 상태를 보여 준다.
 * 서버 계약은 docs/up-contract.md.
 */
export async function runUp(options: UpOptions, deps: UpDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const { api, credentials } = await requireSession(deps.fetchImpl);
  const { link, dir } = await requireLinkLocation(deps.cwd ?? process.cwd(), credentials);
  const token = credentials.token;

  log(`${link.projectName} / ${link.serviceName} 에 올릴 소스를 묶는 중...`);
  const archive = await createArchive(dir, { maxBytes: deps.maxArchiveBytes });
  try {
    log(`묶음: 파일 ${archive.fileCount}개, ${formatBytes(archive.sizeBytes)}`);
    for (const skipped of archive.skippedSymlinks) {
      warn(`폴더 밖을 가리키는 심볼릭 링크라 뺐습니다: ${skipped}`);
    }

    log("업로드 중...");
    const upload = await api.request<UploadResult>("POST", `/services/${link.serviceId}/uploads`, {
      token,
      stream: {
        body: Readable.toWeb(createReadStream(archive.path)) as ReadableStream<Uint8Array>,
        contentType: "application/gzip",
        contentLength: archive.sizeBytes,
      },
    });

    const deployment = await api.request<DeploymentRequest>(
      "POST",
      `/services/${link.serviceId}/deployments`,
      {
        token,
        body: { triggerType: "CLI", uploadId: upload.uploadId },
        headers: { "Idempotency-Key": `up-${upload.uploadId}` },
      },
    );
    log(`배포 요청 #${deployment.id} (${deployment.status})`);
    if (options.detach) {
      log("기다리지 않고 끝냅니다. 진행 상황은 `likelion status` 로 확인하세요.");
      return deployment.id;
    }

    const detail = await waitForDeployment(api, token, link.serviceId, deployment.id, {
      now,
      sleep,
      log,
      warn,
    });
    await reportResult(api, token, link.serviceId, detail, log);
    return deployment.id;
  } finally {
    await archive.cleanup();
  }
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

async function waitForDeployment(
  api: ApiClient,
  token: string,
  serviceId: number,
  deploymentId: number,
  clock: Clock,
): Promise<DeploymentDetail> {
  const startedAt = clock.now();
  let lastStatus = "";
  let failures = 0;
  for (;;) {
    try {
      const detail = await api.request<DeploymentDetail>(
        "GET",
        `/services/${serviceId}/deployments/${deploymentId}`,
        { token },
      );
      failures = 0;
      if (detail.status !== lastStatus) {
        const elapsed = Math.round((clock.now() - startedAt) / 1000);
        clock.log(`  ${detail.status} (+${elapsed}s)`);
        if (detail.status === "BUILDING") {
          clock.log("  빌드 로그는 아직 지원하지 않아 진행 상태만 보여 줍니다.");
        }
        lastStatus = detail.status;
      }
      if (TERMINAL_STATUSES.has(detail.status)) return detail;
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
    if (clock.now() - startedAt >= MAX_WAIT_MS) {
      throw new CliError(
        "배포가 20분 안에 끝나지 않아 기다리기를 멈춥니다. `likelion status` 로 확인해 주세요.",
      );
    }
    await clock.sleep(failures > 0 ? (RETRY_DELAYS_MS[failures - 1] ?? POLL_INTERVAL_MS) : POLL_INTERVAL_MS);
  }
}

function isTransientFailure(error: unknown): error is ConnectionError | ApiError {
  return error instanceof ConnectionError || (error instanceof ApiError && error.status >= 500);
}

function describeTransientFailure(error: ConnectionError | ApiError): string {
  return error instanceof ApiError
    ? `서버가 일시적으로 응답하지 못했습니다 (HTTP ${error.status}).`
    : "서버에 닿지 못했습니다.";
}

async function reportResult(
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
      throw new CliError(
        `배포가 실패했습니다 (${detail.failureCode ?? "원인 미상"}). \`likelion status\` 로 단계를 확인해 주세요.`,
      );
    case "ROLLED_BACK":
      throw new CliError("배포가 실패해 이전 버전으로 되돌렸습니다. `likelion status` 로 확인해 주세요.");
    case "MANUAL_INTERVENTION":
      throw new CliError("운영자 확인이 필요한 상태입니다. `likelion status` 로 확인해 주세요.");
    default:
      throw new CliError("더 새로운 배포 요청이 대신해 이 배포는 중단되었습니다.");
  }
}
