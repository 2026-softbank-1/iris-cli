import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

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

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** 응답을 순서대로 돌려주고 호출을 기록하는 fetch 대역. */
export function fakeFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
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
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}
