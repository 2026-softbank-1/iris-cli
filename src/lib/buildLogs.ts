import type { ApiClient } from "./api.js";
import { formatTimestampNs } from "./format.js";
import type { BuildLogEntry, BuildLogsPage, DeploymentDetail } from "./types.js";

const PAGE_LIMIT = 1000;
// 화면(대시보드)과 같이 이만큼에서 읽기를 멈춘다.
export const MAX_BUILD_LOG_LINES = 10_000;
// 폴링 한 번에 이어 읽을 수 있는 최대 쪽 수. 끝난 빌드가 길어도 한 번에 따라잡는다.
const MAX_PAGES_PER_POLL = MAX_BUILD_LOG_LINES / PAGE_LIMIT;

export function formatBuildLogLine(entry: BuildLogEntry): string {
  return `${formatTimestampNs(entry.timestampNs)} ${entry.message}`;
}

/** 빌드 로그를 `nextCursor` 로 이어 읽는 커서. */
export class BuildLogReader {
  private cursor: string | undefined;
  private lines = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly token: string,
    private readonly serviceId: number,
    private readonly deploymentId: number,
  ) {}

  get isLimitReached(): boolean {
    return this.lines >= MAX_BUILD_LOG_LINES;
  }

  /** 지금까지 읽은 다음부터 한 쪽(최대 1000줄)을 읽는다. */
  async readPage(): Promise<BuildLogsPage> {
    const page = await this.api.request<BuildLogsPage>(
      "GET",
      `/services/${this.serviceId}/deployments/${this.deploymentId}/build-logs`,
      { token: this.token, query: { cursor: this.cursor, limit: PAGE_LIMIT } },
    );
    if (page.nextCursor) this.cursor = page.nextCursor;
    this.lines += page.entries.length;
    return page;
  }

  /** 지금 있는 로그를 읽은 줄이 없는 쪽이 나올 때까지 이어 읽는다. */
  async drain(onEntries: (entries: BuildLogEntry[]) => void): Promise<BuildLogsPage | undefined> {
    let last: BuildLogsPage | undefined;
    for (let pages = 0; pages < MAX_PAGES_PER_POLL; pages += 1) {
      const page = await this.readPage();
      last = page;
      if (page.entries.length > 0) onEntries(page.entries);
      if (page.entries.length === 0 || page.isPartial || this.isLimitReached) break;
    }
    return last;
  }
}

/**
 * 배포를 기다리는 동안 빌드 로그를 이어 보여 주는 `onPoll` 훅을 만든다.
 * 로그는 부가 정보라서 읽지 못해도 배포 기다리기를 멈추지 않고 한 번만 알린 뒤 그만 읽는다.
 */
export function createBuildLogFollower(
  api: ApiClient,
  token: string,
  serviceId: number,
  deploymentId: number,
  print: (line: string) => void,
  warn: (message: string) => void,
): (detail: DeploymentDetail) => Promise<void> {
  const reader = new BuildLogReader(api, token, serviceId, deploymentId);
  let isDisabled = false;
  let hasWarnedPartial = false;

  return async (detail) => {
    if (isDisabled || detail.status === "QUEUED") return;
    try {
      const page = await reader.drain((entries) => {
        for (const entry of entries) print(formatBuildLogLine(entry));
      });
      if (page?.isPartial && !hasWarnedPartial) {
        hasWarnedPartial = true;
        warn("빌드 로그의 앞부분이 빠져 있습니다 (끝부분만 받았습니다).");
      }
      if (reader.isLimitReached) {
        isDisabled = true;
        warn(`빌드 로그가 ${MAX_BUILD_LOG_LINES}줄을 넘어 더 읽지 않습니다. 전체는 대시보드에서 확인하세요.`);
      }
    } catch (error) {
      isDisabled = true;
      const reason = error instanceof Error ? error.message : String(error);
      warn(`빌드 로그를 읽지 못해 상태만 보여 줍니다 (${reason}).`);
    }
  };
}
