import { describe, expect, it, vi } from "vitest";
import { type LogsCommandOptions, runLogsCommand } from "../src/commands/logsCommand.js";
import {
  envelope,
  fakeFetch,
  linkTo,
  loginAs,
  logEntry,
  ns,
  queryOf,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const base: LogsCommandOptions = {
  follow: false,
  since: "1h",
  limit: "200",
  build: false,
  deploy: false,
  network: false,
  json: false,
};

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    timestampNs: ns(`2026-10-03T00:00:${String(10 + index).padStart(2, "0")}Z`),
    message: `line ${index + 1}`,
  }));
const buildPage = (entries: unknown[], isComplete = false) =>
  envelope({ entries, nextCursor: "c1", isComplete, buildStatus: "SUCCEEDED" });

async function setup(responses: (Response | Error)[]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  const log = vi.fn();
  const warn = vi.fn();
  const deps = { fetchImpl, cwd: cwd(), log, warn, now: () => Date.parse("2026-10-03T01:00:00Z") };
  const printed = () => log.mock.calls.map(([line]) => line as string);
  return { calls, warn, deps, printed };
}

describe("runLogsCommand --build 의 -n", () => {
  it("n_을_직접_주면_빌드_로그를_마지막_N줄로_줄인다", async () => {
    const t = await setup([buildPage(lines(5)), buildPage([], true)]);

    await runLogsCommand({ ...base, build: true, deployment: "12", limit: "2" }, "cli", t.deps);

    expect(t.printed()).toEqual(["2026-10-03T00:00:13.000Z line 4", "2026-10-03T00:00:14.000Z line 5"]);
  });

  it("n_을_주지_않으면_기본값_200_이_있어도_빌드_로그를_전부_보인다", async () => {
    const t = await setup([buildPage(lines(5)), buildPage([], true)]);

    await runLogsCommand({ ...base, build: true, deployment: "12" }, "default", t.deps);

    expect(t.printed()).toHaveLength(5);
  });

  it("n_이_범위를_벗어나면_사용법_오류다", async () => {
    const t = await setup([]);

    await expect(
      runLogsCommand({ ...base, build: true, deployment: "12", limit: "5000" }, "cli", t.deps),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(t.calls).toHaveLength(0);
  });
});

describe("runLogsCommand 분기", () => {
  it("플래그가_없으면_서비스_런타임_로그를_조회한다", async () => {
    const t = await setup([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1] }),
      envelope({ entries: [logEntry(ns("2026-10-03T00:30:00Z"), "hello")], isTruncated: false }),
    ]);

    await runLogsCommand({ ...base, limit: "50" }, "cli", t.deps);

    expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/logs");
    expect(queryOf(t.calls[1]).get("limit")).toBe("50");
    expect(t.printed()).toEqual(["2026-10-03T00:30:00.000Z hello"]);
  });

  it("deploy_는_n_을_줄_수_상한으로_보낸다", async () => {
    const t = await setup([envelope({ entries: [], isTruncated: false })]);

    await runLogsCommand({ ...base, deploy: true, deployment: "12", limit: "30" }, "cli", t.deps);

    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/deploy-logs");
    expect(queryOf(t.calls[0]).get("limit")).toBe("30");
  });

  it.each([
    [{ build: true, network: true }, "하나만"],
    [{ deployment: "12" }, "함께 써야"],
    [{ statusClass: "5xx" }, "함께 써야"],
  ] as const)("%o 는_사용법_오류다", async (extra, message) => {
    const t = await setup([]);

    const failure = runLogsCommand({ ...base, ...extra }, "default", t.deps);

    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(t.calls).toHaveLength(0);
  });
});
