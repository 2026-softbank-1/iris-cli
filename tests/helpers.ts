import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { saveCredentials } from "../src/lib/config.js";
import { type Link, saveLink } from "../src/lib/link.js";

export const API_URL = "https://api.example.test";

/** 테스트마다 빈 설정 디렉터리를 쓰게 한다. 실제 ~/.config 는 건드리지 않는다. */
export function useTempConfigDir(): void {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "likelion-test-"));
    process.env.LIKELION_CONFIG_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.LIKELION_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  });
}

/** 테스트마다 빈 작업 폴더를 만든다. 경로는 호출 시점에 읽는다. */
export function useTempCwd(): () => string {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "likelion-cwd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export async function loginAs(login = "octocat"): Promise<void> {
  await saveCredentials({ apiUrl: API_URL, token: "jwt-1", user: { id: 7, login } });
}

export async function linkTo(cwd: string, overrides: Partial<Link> = {}): Promise<Link> {
  const link: Link = {
    apiUrl: API_URL,
    projectId: 1,
    projectName: "demo",
    serviceId: 3,
    serviceName: "web",
    ...overrides,
  };
  await saveLink(cwd, link);
  return link;
}

export function envelope(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

export function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** SSE 응답. 프레임 문자열을 순서대로 흘리고 연결을 닫는다. */
export function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function logsFrame(id: string, entries: unknown[]): string {
  return `id: ${id}\nevent: logs\ndata: ${JSON.stringify(entries)}\n\n`;
}

export function logEntry(timestampNs: string, message: string, pod = "app-1") {
  return { timestampNs, message, pod, container: "app" };
}

/** ISO 시각의 나노초 문자열 */
export function ns(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** 응답(또는 던질 오류)을 순서대로 돌려주고 호출을 기록하는 fetch 대역. */
export function fakeFetch(responses: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: 준비된 응답이 없습니다");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function queryOf(call: RecordedCall | undefined): URLSearchParams {
  if (!call) throw new Error("호출이 없습니다");
  return new URL(call.url).searchParams;
}
