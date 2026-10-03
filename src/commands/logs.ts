import type { ApiClient, FetchLike } from "../lib/api.js";
import { CliError, ConnectionError } from "../lib/errors.js";
import { formatTimestampNs, parseDuration } from "../lib/format.js";
import { requireLink } from "../lib/link.js";
import { matchByIdOrName } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import { parseSse, type SseMessage } from "../lib/sse.js";
import type { LogEntry, LogsPage, Service, Target } from "../lib/types.js";

const MAX_RANGE_MS = 7 * 86_400_000;
const MAX_LIMIT = 1000;
const SEEN_LIMIT = 2000;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_FAILURES = 5;

export interface LogsOptions {
  follow: boolean;
  since: string;
  limit: number;
  search?: string;
  target?: string;
}

export interface LogsDeps {
  fetchImpl?: FetchLike;
  cwd?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** 서버가 스트림을 끝내기로 한 경우. 다시 연결해도 같은 결과라 재시도하지 않는다. */
class StreamFatalError extends CliError {}

/**
 * 서비스 런타임 로그를 보여 준다. 먼저 과거 로그를 조회하고, `follow` 면 그 뒤부터 SSE 로 이어 받는다.
 * 빌드 로그는 서버 API 가 제공하지 않는다.
 */
export async function runLogs(options: LogsOptions, deps: LogsDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const now = deps.now ?? Date.now;

  const rangeMs = parseDuration(options.since);
  if (rangeMs > MAX_RANGE_MS) throw new CliError("조회 기간은 최대 7일(7d)입니다.");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw new CliError(`--limit 은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.`);
  }

  const { api, credentials } = await requireSession(deps.fetchImpl);
  const link = await requireLink(deps.cwd ?? process.cwd(), credentials);
  const token = credentials.token;
  const targetId = await resolveTargetId(api, token, link.serviceId, options.target);

  const end = now();
  const page = await api.request<LogsPage>("GET", `/services/${link.serviceId}/logs`, {
    token,
    query: {
      targetId,
      start: new Date(end - rangeMs).toISOString(),
      end: new Date(end).toISOString(),
      limit: options.limit,
      search: options.search,
    },
  });

  const print = createPrinter(log);
  print(page.entries);
  if (page.entries.length === 0) warn("해당 기간에 로그가 없습니다.");
  if (page.isTruncated && !options.follow) {
    warn(`최근 ${options.limit}줄만 보여 줬습니다. --limit 이나 --since 로 범위를 조정해 주세요.`);
  }
  if (!options.follow) return;

  const last = page.entries.at(-1);
  await followLogs({
    api,
    token,
    serviceId: link.serviceId,
    targetId,
    search: options.search,
    cursor: last ? (BigInt(last.timestampNs) + 1n).toString() : undefined,
    print,
    warn,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    signal: deps.signal,
  });
}

async function resolveTargetId(
  api: ApiClient,
  token: string,
  serviceId: number,
  option: string | undefined,
): Promise<number> {
  const service = await api.request<Service>("GET", `/services/${serviceId}`, { token });
  const [only] = service.targetIds;
  if (option === undefined && service.targetIds.length === 1 && only !== undefined) return only;
  if (service.targetIds.length === 0) throw new CliError("서비스에 연결된 타깃이 없습니다.");

  const all = await api.request<Target[]>("GET", "/targets", { token });
  const targets = all.filter((target) => service.targetIds.includes(target.id));
  const names = targets.map((target) => `${target.name}(${target.id})`).join(", ");
  if (option === undefined) {
    throw new CliError(`타깃이 여러 개입니다. --target 으로 고르세요. 가능한 값: ${names}`);
  }
  const found = matchByIdOrName(targets, option);
  if (!found) throw new CliError(`찾을 수 없습니다: 타깃 '${option}'. 가능한 값: ${names}`);
  return found.id;
}

/** 같은 로그를 두 번 찍지 않는다. 스트림은 재연결 때 겹치는 구간을 다시 보낼 수 있다. */
function createPrinter(log: (message: string) => void): (entries: LogEntry[]) => void {
  const seen = new Set<string>();
  return (entries) => {
    for (const entry of entries) {
      const key = `${entry.timestampNs}|${entry.pod}|${entry.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > SEEN_LIMIT) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      log(`${formatTimestampNs(entry.timestampNs)} ${entry.message}`);
    }
  };
}

interface FollowParams {
  api: ApiClient;
  token: string;
  serviceId: number;
  targetId: number;
  search: string | undefined;
  cursor: string | undefined;
  print: (entries: LogEntry[]) => void;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal | undefined;
}

async function followLogs(params: FollowParams): Promise<void> {
  const { api, token, serviceId, targetId, search, print, warn, sleep, signal } = params;
  let cursor = params.cursor;
  let failures = 0;

  while (!signal?.aborted) {
    try {
      const response = await api.openStream(`/services/${serviceId}/logs/stream`, {
        token,
        query: { targetId, search, cursor },
        signal,
      });
      failures = 0;
      if (!response.body) throw new ConnectionError(api.baseUrl);
      for await (const message of parseSse(response.body)) {
        if (message.id) cursor = message.id;
        handleMessage(message, print);
      }
    } catch (error) {
      if (signal?.aborted) return;
      const isRetriable = error instanceof ConnectionError || !(error instanceof CliError);
      if (!isRetriable) throw error;
      failures += 1;
      if (failures > MAX_RECONNECT_FAILURES) {
        throw new CliError("로그 스트림 연결이 계속 끊어져 종료합니다.");
      }
      warn("로그 스트림 연결이 끊겼습니다. 다시 연결합니다.");
    }
    // 서버는 5분마다 연결을 끝낸다. 끊긴 뒤 바로 붙어 서버를 두드리지 않게 잠깐 쉰다.
    await sleep(RECONNECT_DELAY_MS);
  }
}

function handleMessage(message: SseMessage, print: (entries: LogEntry[]) => void): void {
  switch (message.event) {
    case "logs":
      print(JSON.parse(message.data) as LogEntry[]);
      break;
    case "overflow":
      throw new StreamFatalError(
        "로그가 너무 많아 스트림을 종료했습니다. --since 로 범위를 좁혀 조회해 주세요.",
      );
    case "error":
      throw new StreamFatalError(`로그 스트림 오류: ${errorCode(message.data)}`);
  }
}

function errorCode(data: string): string {
  try {
    const parsed = JSON.parse(data) as { code?: string };
    return parsed.code ?? data;
  } catch {
    return data;
  }
}
