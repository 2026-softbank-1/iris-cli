import { describe, expect, it, vi } from "vitest";
import { type LogsDeps, type LogsOptions, runLogs } from "../src/commands/logs.js";
import {
  envelope,
  errorEnvelope,
  fakeFetch,
  linkTo,
  loginAs,
  logEntry,
  logsFrame,
  ns,
  queryOf,
  sseResponse,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const NOW = Date.parse("2026-10-03T01:00:00Z");
const T1 = ns("2026-10-03T00:30:00Z");
const T2 = ns("2026-10-03T00:40:00Z");
const options: LogsOptions = { follow: false, since: "1h", limit: 200 };

const service = (targetIds: number[]) =>
  envelope({ id: 3, projectId: 1, name: "web", targetIds });
const page = (entries: unknown[], isTruncated = false) => envelope({ entries, isTruncated });

async function setup(responses: (Response | Error)[], abortAfterSleeps = Number.POSITIVE_INFINITY) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  const controller = new AbortController();
  let sleeps = 0;
  const sleep = vi.fn(async () => {
    sleeps += 1;
    if (sleeps >= abortAfterSleeps) controller.abort();
  });
  const log = vi.fn();
  const warn = vi.fn();
  const deps: LogsDeps = {
    fetchImpl,
    cwd: cwd(),
    log,
    warn,
    sleep,
    now: () => NOW,
    signal: controller.signal,
  };
  const lines = () => log.mock.calls.map(([line]) => line);
  return { calls, log, warn, sleep, deps, lines };
}

describe("runLogs (과거 로그)", () => {
  it("기간과_조건으로_조회해_시간_오름차순으로_출력한다", async () => {
    const t = await setup([
      service([1]),
      page([logEntry(T1, "hello"), logEntry(T2, "world")]),
    ]);

    await runLogs({ ...options, search: "err" }, t.deps);

    expect(t.lines()).toEqual(["2026-10-03T00:30:00.000Z hello", "2026-10-03T00:40:00.000Z world"]);
    const query = queryOf(t.calls[1]);
    expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/logs");
    expect(query.get("targetId")).toBe("1");
    expect(query.get("start")).toBe("2026-10-03T00:00:00.000Z");
    expect(query.get("end")).toBe("2026-10-03T01:00:00.000Z");
    expect(query.get("limit")).toBe("200");
    expect(query.get("search")).toBe("err");
    expect(t.calls[1]?.headers.Authorization).toBe("Bearer jwt-1");
  });

  it("로그가_없으면_안내하고_잘렸으면_범위_조정을_안내한다", async () => {
    const empty = await setup([service([1]), page([])]);
    await runLogs(options, empty.deps);
    expect(empty.warn).toHaveBeenCalledWith("해당 기간에 로그가 없습니다.");

    const truncated = await setup([service([1]), page([logEntry(T1, "a")], true)]);
    await runLogs(options, truncated.deps);
    expect(truncated.warn).toHaveBeenCalledWith(expect.stringContaining("최근 200줄"));
  });

  it("타깃이_여러_개면_target_으로_고르게_한다", async () => {
    const targets = () =>
      envelope([
        { id: 1, name: "aws" },
        { id: 2, name: "local" },
        { id: 5, name: "other-service-target" },
      ]);
    const missing = await setup([service([1, 2]), targets()]);
    await expect(runLogs(options, missing.deps)).rejects.toThrow("aws(1), local(2)");

    const picked = await setup([service([1, 2]), targets(), page([])]);
    await runLogs({ ...options, target: "local" }, picked.deps);
    expect(queryOf(picked.calls[2]).get("targetId")).toBe("2");
  });

  it("범위를_벗어난_옵션은_서버를_부르기_전에_거절한다", async () => {
    const t = await setup([]);

    await expect(runLogs({ ...options, limit: 0 }, t.deps)).rejects.toThrow("--limit");
    await expect(runLogs({ ...options, since: "8d" }, t.deps)).rejects.toThrow("7일");
    await expect(runLogs({ ...options, since: "soon" }, t.deps)).rejects.toThrow("기간 형식");
    expect(t.calls).toHaveLength(0);
  });

  it("세션이_만료되면_login_을_안내한다", async () => {
    const t = await setup([service([1]), errorEnvelope(401, "UNAUTHORIZED", "로그인이 필요합니다")]);

    await expect(runLogs(options, t.deps)).rejects.toThrow("likelion login");
  });
});

describe("runLogs --follow", () => {
  it("과거_로그_뒤부터_스트림을_이어_받고_겹치는_줄은_한_번만_찍는다", async () => {
    const t = await setup(
      [
        service([1]),
        page([logEntry(T1, "first")]),
        sseResponse([logsFrame("900", [logEntry(T1, "first"), logEntry(T2, "second")])]),
      ],
      1,
    );

    await runLogs({ ...options, follow: true, search: "s" }, t.deps);

    expect(t.lines()).toEqual(["2026-10-03T00:30:00.000Z first", "2026-10-03T00:40:00.000Z second"]);
    const stream = t.calls[2];
    expect(new URL(stream?.url ?? "").pathname).toBe("/api/v1/services/3/logs/stream");
    expect(queryOf(stream).get("cursor")).toBe((BigInt(T1) + 1n).toString());
    expect(queryOf(stream).get("targetId")).toBe("1");
    expect(queryOf(stream).get("search")).toBe("s");
    expect(stream?.headers.Accept).toBe("text/event-stream");
    expect(stream?.headers.Authorization).toBe("Bearer jwt-1");
  });

  it("연결이_끝나면_마지막_id_부터_다시_연결한다", async () => {
    const t = await setup(
      [
        service([1]),
        page([]),
        sseResponse([logsFrame("100", [logEntry(T1, "one")])]),
        sseResponse([logsFrame("200", [logEntry(T2, "two")])]),
      ],
      2,
    );

    await runLogs({ ...options, follow: true }, t.deps);

    expect(t.lines()).toEqual(["2026-10-03T00:30:00.000Z one", "2026-10-03T00:40:00.000Z two"]);
    expect(queryOf(t.calls[2]).get("cursor")).toBeNull();
    expect(queryOf(t.calls[3]).get("cursor")).toBe("100");
    expect(t.sleep).toHaveBeenCalledWith(2000);
  });

  it("연결이_실패하면_알리고_다시_시도한다", async () => {
    const t = await setup(
      [
        service([1]),
        page([]),
        new Error("boom"),
        sseResponse([logsFrame("100", [logEntry(T1, "back")])]),
      ],
      2,
    );

    await runLogs({ ...options, follow: true }, t.deps);

    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("다시 연결"));
    expect(t.lines()).toEqual(["2026-10-03T00:30:00.000Z back"]);
  });

  it("연결이_계속_실패하면_포기한다", async () => {
    const failures = Array.from({ length: 6 }, () => new Error("down"));
    const t = await setup([service([1]), page([]), ...failures]);

    await expect(runLogs({ ...options, follow: true }, t.deps)).rejects.toThrow("계속 끊어져");
  });

  it("서버가_overflow_를_보내면_재시도하지_않고_끝낸다", async () => {
    const t = await setup([
      service([1]),
      page([]),
      sseResponse(['event: overflow\ndata: {"code":"LOG_STREAM_OVERFLOW"}\n\n']),
    ]);

    await expect(runLogs({ ...options, follow: true }, t.deps)).rejects.toThrow("너무 많아");
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it("서버가_error_이벤트를_보내면_코드와_함께_끝낸다", async () => {
    const t = await setup([
      service([1]),
      page([]),
      sseResponse(['event: error\ndata: {"code":"EXTERNAL_ERROR"}\n\n']),
    ]);

    await expect(runLogs({ ...options, follow: true }, t.deps)).rejects.toThrow("EXTERNAL_ERROR");
  });

  it("스트림을_열다_HTTP_오류가_나면_재시도하지_않는다", async () => {
    const t = await setup([
      service([1]),
      page([]),
      errorEnvelope(502, "EXTERNAL_ERROR", "Loki 조회에 실패했습니다"),
    ]);

    await expect(runLogs({ ...options, follow: true }, t.deps)).rejects.toThrow("Loki");
    expect(t.sleep).not.toHaveBeenCalled();
  });
});
