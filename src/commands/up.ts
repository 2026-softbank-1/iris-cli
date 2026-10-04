import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FetchLike } from "../lib/api.js";
import { createArchive } from "../lib/archive.js";
import { createBuildLogFollower } from "../lib/buildLogs.js";
import { reportResult, waitForDeployment } from "../lib/deployment.js";
import { formatBytes } from "../lib/format.js";
import { requireLinkLocation } from "../lib/link.js";
import { printJson, progressLog } from "../lib/output.js";
import { requireSession } from "../lib/session.js";

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
  /** 기다리는 동안 빌드 로그도 이어서 보여 준다 */
  logs?: boolean;
  /** 진행 안내는 stderr 로 보내고 stdout 에는 배포 결과 JSON 만 낸다 */
  json?: boolean;
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
  const out = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const log = progressLog(options.json ?? false, out, warn);
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
  } finally {
    await archive.cleanup();
  }
}
