import { describe, expect, it, vi } from "vitest";
import {
  type DeploymentLogsDeps,
  type DeploymentLogsOptions,
  runDeploymentLogs,
} from "../src/commands/deploymentLogs.js";
import {
  envelope,
  errorEnvelope,
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

const T1 = ns("2026-10-03T00:00:10Z");
const T2 = ns("2026-10-03T00:00:20Z");
const base: Omit<DeploymentLogsOptions, "kind"> = { deployment: "12", follow: false, limit: 200 };

const page = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  envelope({ entries, nextCursor: "c1", isComplete: false, buildStatus: "SUCCEEDED", ...extra });
const detail = (status: string) =>
  envelope({ id: 12, status, sourceSha: "abc", triggerType: "MANUAL", createdAt: "x", updatedAt: "x", stages: [] });

async function setup(responses: (Response | Error)[]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  const log = vi.fn();
  const warn = vi.fn();
  const sleep = vi.fn(async () => {});
  const deps: DeploymentLogsDeps = { fetchImpl, cwd: cwd(), log, warn, sleep };
  const lines = () => log.mock.calls.map(([line]) => line as string);
  return {
    calls,
    log,
    warn,
    sleep,
    lines,
    run: (options: Partial<DeploymentLogsOptions> & Pick<DeploymentLogsOptions, "kind">) =>
      runDeploymentLogs({ ...base, ...options }, deps),
  };
}

describe("runDeploymentLogs --build", () => {
  it("읽은_줄이_없는_쪽이_나올_때까지_nextCursor_로_이어_읽는다", async () => {
    const t = await setup([
      page([{ timestampNs: T1, message: "a" }, { timestampNs: T2, message: "b" }], { nextCursor: "c1" }),
      page([{ timestampNs: T2, message: "c" }], { nextCursor: "c2" }),
      page([], { nextCursor: "c2", isComplete: true }),
    ]);

    await t.run({ kind: "build" });

    expect(t.lines()).toEqual([
      "2026-10-03T00:00:10.000Z a",
      "2026-10-03T00:00:20.000Z b",
      "2026-10-03T00:00:20.000Z c",
    ]);
    expect(t.calls.map((call) => queryOf(call).get("cursor"))).toEqual([null, "c1", "c2"]);
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/build-logs");
  });

  it("롤백처럼_다른_배포의_로그면_그_배포를_알려_준다", async () => {
    const t = await setup([
      page([{ timestampNs: T1, message: "a" }], { loggedDeploymentId: 9 }),
      page([], { isComplete: true, loggedDeploymentId: 9 }),
    ]);

    await t.run({ kind: "build" });

    expect(t.warn).toHaveBeenCalledWith("이 배포는 새로 빌드하지 않아 배포 #9 의 빌드 로그입니다.");
  });

  it("앞부분이_빠진_끝부분만_받으면_그_사실을_알린다", async () => {
    const t = await setup([page([{ timestampNs: T1, message: "tail" }], { isPartial: true })]);

    await t.run({ kind: "build" });

    expect(t.lines()).toEqual(["2026-10-03T00:00:10.000Z tail"]);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("앞부분이 빠져"));
    expect(t.calls).toHaveLength(1);
  });

  it("빌드_상태가_없는_배포는_빌드_전에_끝났다고_안내한다", async () => {
    const t = await setup([page([], { isComplete: true, buildStatus: undefined })]);

    await t.run({ kind: "build" });

    expect(t.lines()).toEqual([]);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("빌드 전에 끝난 배포"));
  });

  it("빌드는_했는데_서버가_로그를_안_주면_빌드_상태와_함께_그렇게_알린다", async () => {
    const t = await setup([page([], { isComplete: true, buildStatus: "FAILED" })]);

    await t.run({ kind: "build" });

    expect(t.lines()).toEqual([]);
    const message = t.warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("상태 FAILED");
    expect(message).not.toContain("시작하지 않았");
  });

  it("follow_는_빌드가_끝나_읽을_줄이_없다고_할_때까지_기다리며_이어_읽는다", async () => {
    const t = await setup([
      page([{ timestampNs: T1, message: "a" }]),
      page([]),
      detail("BUILDING"),
      page([{ timestampNs: T2, message: "b" }]),
      page([], { isComplete: true }),
    ]);

    await t.run({ kind: "build", follow: true });

    expect(t.lines()).toEqual(["2026-10-03T00:00:10.000Z a", "2026-10-03T00:00:20.000Z b"]);
    expect(t.sleep).toHaveBeenCalledTimes(1);
  });

  it("follow_중_배포가_빌드_없이_끝나면_멈춘다", async () => {
    const t = await setup([page([], { buildStatus: undefined }), detail("FAILED"), page([], { buildStatus: undefined })]);

    await t.run({ kind: "build", follow: true });

    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("빌드 로그가 없습니다"));
  });

  it("배포_번호를_생략하면_서비스의_가장_최근_배포를_본다", async () => {
    const t = await setup([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1], latestDeployment: { id: 15, status: "FAILED" } }),
      page([], { isComplete: true }),
    ]);

    await t.run({ kind: "build", deployment: undefined });

    expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/15/build-logs");
  });

  it("json_이면_줄마다_서버_항목을_JSON_한_줄로_낸다", async () => {
    const t = await setup([page([{ timestampNs: T1, message: "a" }]), page([], { isComplete: true })]);

    await t.run({ kind: "build", json: true });

    expect(t.lines()).toEqual([JSON.stringify({ timestampNs: T1, message: "a" })]);
  });
});

describe("runDeploymentLogs --build tail", () => {
  const entries = (...messages: string[]) => messages.map((message, index) => ({ timestampNs: ns(`2026-10-03T00:00:${String(10 + index).padStart(2, "0")}Z`), message }));

  it("tail_이면_여러_쪽을_읽어도_마지막_N줄만_보이고_전체_줄_수를_알린다", async () => {
    const t = await setup([
      page(entries("a", "b", "c"), { nextCursor: "c1" }),
      page(entries("d", "e"), { nextCursor: "c2" }),
      page([], { nextCursor: "c2", isComplete: true }),
    ]);

    await t.run({ kind: "build", tail: 2 });

    expect(t.lines()).toEqual(["2026-10-03T00:00:10.000Z d", "2026-10-03T00:00:11.000Z e"]);
    expect(t.warn).toHaveBeenCalledWith("마지막 2줄만 보여 줬습니다 (전체 5줄). -n 으로 늘릴 수 있습니다.");
  });

  it("tail_보다_로그가_적으면_전부_보이고_줄였다는_안내는_없다", async () => {
    const t = await setup([page(entries("a", "b")), page([], { isComplete: true })]);

    await t.run({ kind: "build", tail: 50 });

    expect(t.lines()).toHaveLength(2);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("tail_이_없으면_전부_보인다", async () => {
    const t = await setup([page(entries("a", "b", "c")), page([], { isComplete: true })]);

    await t.run({ kind: "build" });

    expect(t.lines()).toHaveLength(3);
  });

  it("follow_에서는_쌓여_있던_로그만_마지막_N줄로_줄이고_새_로그는_바로_보인다", async () => {
    const t = await setup([
      page(entries("a", "b", "c")),
      page([]),
      detail("BUILDING"),
      page(entries("d")),
      page([], { isComplete: true }),
    ]);

    await t.run({ kind: "build", follow: true, tail: 2 });

    expect(t.lines()).toEqual([
      "2026-10-03T00:00:11.000Z b",
      "2026-10-03T00:00:12.000Z c",
      "2026-10-03T00:00:10.000Z d",
    ]);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("전체 3줄"));
  });

  it.each([0, 1001, 1.5])("tail_%s_는_서버를_부르기_전에_멈춘다", async (tail) => {
    const t = await setup([]);

    await expect(t.run({ kind: "build", tail })).rejects.toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(t.calls).toHaveLength(0);
  });
});

describe("runDeploymentLogs --deploy · --network", () => {
  it("deploy_는_이_배포의_런타임_로그를_조건으로_조회한다", async () => {
    const t = await setup([
      envelope({ entries: [logEntry(T1, "hello"), logEntry(T2, "world")], isTruncated: true }),
    ]);

    await t.run({ kind: "deploy", limit: 50, search: "hello" });

    expect(t.lines()).toEqual(["2026-10-03T00:00:10.000Z hello", "2026-10-03T00:00:20.000Z world"]);
    const query = queryOf(t.calls[0]);
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/deploy-logs");
    expect([query.get("limit"), query.get("search"), query.get("targetId")]).toEqual(["50", "hello", null]);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("최근 50줄"));
  });

  it("deploy_의_타깃_이름은_서비스의_타깃에서_찾아_id_로_보낸다", async () => {
    const t = await setup([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1, 2] }),
      envelope([
        { id: 1, name: "aws" },
        { id: 2, name: "home-lab" },
      ]),
      envelope({ entries: [], isTruncated: false }),
    ]);

    await t.run({ kind: "deploy", target: "home-lab" });

    expect(queryOf(t.calls[2]).get("targetId")).toBe("2");
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("런타임 로그가 없습니다"));
  });

  describe("로그가_비었을_때_안내", () => {
    const service = () => envelope({ id: 3, projectId: 1, name: "web", targetIds: [1, 2] });
    const targetList = () =>
      envelope([
        { id: 1, name: "aws" },
        { id: 2, name: "home-lab" },
      ]);
    const deploymentOn = (...targets: { id: number; name: string; kind: string }[]) =>
      envelope({
        id: 12,
        status: "SUCCEEDED",
        sourceSha: "abc",
        triggerType: "MANUAL",
        createdAt: "x",
        updatedAt: "x",
        stages: [],
        configuration: { deploy: { targets } },
      });
    const AWS = { id: 1, name: "aws", kind: "AWS" };
    const HOME_LAB = { id: 2, name: "home-lab", kind: "ONPREM" };
    const empty = () => envelope({ entries: [], isTruncated: false });

    it("서버_타깃에_배포된_배포의_런타임_로그가_비면_지금_떠_있는_Pod_의_로그만_보인다고_알린다", async () => {
      const t = await setup([empty(), deploymentOn(HOME_LAB)]);

      await t.run({ kind: "deploy" });

      expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12");
      expect(t.warn).toHaveBeenCalledWith(
        "내 서버(온프레미스) 타깃은 지금 떠 있는 Pod 의 로그만 보여 줍니다. 이 배포의 Pod 가 재시작·교체·중지돼 지금 없으면 로그도 비어 있습니다.",
      );
      expect(t.warn).not.toHaveBeenCalledWith(expect.stringContaining("성공하지 못한 배포"));
      expect(t.warn).not.toHaveBeenCalledWith(expect.stringContaining("수집하지 않습니다"));
    });

    it("서버_타깃_배포의_네트워크_로그가_200_으로_비면_ALB_로그가_없다고_알린다", async () => {
      const t = await setup([empty(), deploymentOn(HOME_LAB)]);

      await t.run({ kind: "network" });

      expect(t.warn).toHaveBeenCalledWith("내 서버(온프레미스) 타깃은 네트워크(ALB) 로그가 없습니다.");
    });

    it("공용_타깃_배포는_기존_안내를_그대로_낸다", async () => {
      const t = await setup([empty(), deploymentOn(AWS)]);

      await t.run({ kind: "deploy" });

      expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("성공하지 못한 배포이거나 로그가 아직 수집되지 않았습니다"));
    });

    it("서버_타깃과_공용_타깃을_함께_쓰는_서비스에서_공용_타깃을_골랐으면_기존_안내를_낸다", async () => {
      const t = await setup([service(), targetList(), empty(), deploymentOn(AWS, HOME_LAB)]);

      await t.run({ kind: "deploy", target: "aws" });

      expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("성공하지 못한 배포"));
    });

    it("서버_타깃을_골랐으면_그_타깃이_서버일_때만_서버_안내를_낸다", async () => {
      const t = await setup([service(), targetList(), empty(), deploymentOn(AWS, HOME_LAB)]);

      await t.run({ kind: "deploy", target: "home-lab" });

      expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("내 서버(온프레미스) 타깃"));
    });

    it("배포_상세를_못_읽어도_로그_조회는_실패하지_않고_기존_안내를_낸다", async () => {
      const t = await setup([empty(), new Response("Not Found", { status: 404 })]);

      await t.run({ kind: "deploy" });

      expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("런타임 로그가 없습니다"));
    });

    describe("서버가_NOT_CONFIGURED_503_을_줄_때", () => {
      const notConfigured = () => errorEnvelope(503, "NOT_CONFIGURED", "observability is not configured");

      it("서버_타깃의_network_는_지원하지_않는다는_재시도_불가_오류다", async () => {
        const t = await setup([notConfigured(), deploymentOn(HOME_LAB)]);

        const failure = t.run({ kind: "network" });

        await expect(failure).rejects.toMatchObject({ code: "NOT_SUPPORTED", exitCode: 1 });
        await expect(failure).rejects.toThrow("내 서버(온프레미스) 타깃은 네트워크 로그를 지원하지 않습니다.");
        await expect(failure).rejects.toThrow("likelion logs --deploy");
        expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12");
      });

      it("서버_타깃의_deploy_는_서버_설정이_없다고_알리되_상태와_코드를_지킨다", async () => {
        const t = await setup([notConfigured(), deploymentOn(HOME_LAB)]);

        const failure = t.run({ kind: "deploy" });

        await expect(failure).rejects.toThrow("런타임 로그를 읽는 설정이 서버에 아직 없습니다");
        await expect(failure).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503, exitCode: 5 });
      });

      it("공용_타깃_배포의_503_은_고치지_않고_그대로_낸다", async () => {
        const t = await setup([notConfigured(), deploymentOn(AWS)]);

        const failure = t.run({ kind: "network" });

        await expect(failure).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503, exitCode: 5 });
        await expect(failure).rejects.not.toThrow("지원하지 않습니다");
      });

      it("공용_타깃이_섞여_있고_타깃을_고르지_않았으면_서버_탓으로_돌리지_않는다", async () => {
        const t = await setup([notConfigured(), deploymentOn(AWS, HOME_LAB)]);

        await expect(t.run({ kind: "network" })).rejects.toMatchObject({ code: "NOT_CONFIGURED", exitCode: 5 });
      });

      it("섞여_있어도_서버_타깃을_골랐으면_그_타깃만_보고_지원하지_않는다고_알린다", async () => {
        const t = await setup([service(), targetList(), notConfigured(), deploymentOn(AWS, HOME_LAB)]);

        await expect(t.run({ kind: "network", target: "home-lab" })).rejects.toMatchObject({
          code: "NOT_SUPPORTED",
          exitCode: 1,
        });
      });

      it("배포_상세를_못_읽으면_원래_오류를_그대로_낸다", async () => {
        const t = await setup([notConfigured(), new Response("Not Found", { status: 404 })]);

        await expect(t.run({ kind: "network" })).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503, exitCode: 5 });
      });

      it("다른_서버_오류는_배포_상세를_조회하지_않고_그대로_낸다", async () => {
        const t = await setup([errorEnvelope(502, "EXTERNAL_ERROR", "argocd failed")]);

        await expect(t.run({ kind: "deploy" })).rejects.toMatchObject({ code: "EXTERNAL_ERROR", status: 502 });
        expect(t.calls).toHaveLength(1);
      });
    });

    it("로그가_있으면_배포_상세를_조회하지_않는다", async () => {
      const t = await setup([envelope({ entries: [logEntry(T1, "hi")], isTruncated: false })]);

      await t.run({ kind: "deploy" });

      expect(t.calls).toHaveLength(1);
    });
  });

  it("network_는_응답_코드와_바이트와_응답_시간을_한_줄로_보여_준다", async () => {
    const t = await setup([
      envelope({
        entries: [
          { timestampNs: T1, status: 200, targetStatus: 200, receivedBytes: 512, sentBytes: 2048, responseTimeSeconds: 0.012 },
          { timestampNs: T2, status: 502, receivedBytes: 100, sentBytes: 0 },
        ],
        isTruncated: false,
      }),
    ]);

    await t.run({ kind: "network", statusClass: "5xx" });

    expect(t.lines()).toEqual([
      "2026-10-03T00:00:10.000Z 200 (서비스 200) 수신 512 B 송신 2.0 KB 응답 12ms",
      "2026-10-03T00:00:20.000Z 502 (서비스 응답 없음) 수신 100 B 송신 0 B 응답 -",
    ]);
    expect(queryOf(t.calls[0]).get("statusClass")).toBe("5xx");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/network-logs");
  });
});

describe("runDeploymentLogs 옵션 검사", () => {
  it.each([
    [{ kind: "deploy", follow: true }, "--follow"],
    [{ kind: "build", search: "x" }, "--search"],
    [{ kind: "deploy", statusClass: "5xx" }, "--status-class"],
    [{ kind: "network", statusClass: "6xx" }, "--status-class"],
    [{ kind: "build", target: "aws" }, "--target"],
    [{ kind: "deploy", limit: 5000 }, "--limit"],
  ] as const)("%o 는_서버를_부르기_전에_멈춘다", async (options, flag) => {
    const t = await setup([]);

    await expect(t.run({ ...options })).rejects.toThrow(flag);
    expect(t.calls).toHaveLength(0);
  });
});
