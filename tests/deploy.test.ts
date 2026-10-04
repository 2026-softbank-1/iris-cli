import { describe, expect, it, vi } from "vitest";
import { type DeployDeps, type DeployOptions, runDeploy } from "../src/commands/deploy.js";
import {
  envelope,
  errorEnvelope,
  fakeFetch,
  linkTo,
  loginAs,
  ns,
  queryOf,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const created = (status = "QUEUED", triggerType = "MANUAL") =>
  envelope({ id: 12, serviceId: 3, status, triggerType, sourceSha: "446917d0123", isActive: true }, { status: 201 });
const detail = (status: string, extra: Record<string, unknown> = {}) =>
  envelope({
    id: 12,
    serviceId: 3,
    status,
    sourceSha: "446917d0123",
    triggerType: "MANUAL",
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    stages: [],
    ...extra,
  });
const domains = () =>
  envelope([{ targetId: 1, targetName: "aws", isConnected: true, url: "https://web-3.likelion.uk" }]);
const buildLogs = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  envelope({ entries, nextCursor: "c1", isComplete: false, ...extra });

async function setup(responses: (Response | Error)[]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  let clock = 0;
  const log = vi.fn();
  const warn = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: DeployDeps = { fetchImpl, cwd: cwd(), log, warn, sleep, now: () => clock, randomId: () => "r1" };
  const lines = () => log.mock.calls.map(([line]) => line as string);
  const run = (options: Partial<DeployOptions> & Pick<DeployOptions, "kind">) =>
    runDeploy({ detach: false, ...options }, deps);
  return { calls, log, warn, sleep, lines, run };
}

describe("runDeploy deploy", () => {
  it("MANUAL_배포_요청을_만들고_끝까지_상태를_보여_준다", async () => {
    const t = await setup([created(), detail("QUEUED"), detail("BUILDING"), detail("SUCCEEDED"), domains()]);

    const id = await t.run({ kind: "deploy" });

    expect(id).toBe(12);
    const [post] = t.calls;
    expect(post?.method).toBe("POST");
    expect(new URL(post?.url ?? "").pathname).toBe("/api/v1/services/3/deployments");
    expect(post?.body).toEqual({ triggerType: "MANUAL" });
    expect(post?.headers["Idempotency-Key"]).toBe("deploy-r1");
    expect(post?.headers.Authorization).toBe("Bearer jwt-1");
    expect(t.lines()).toEqual([
      "배포 요청 #12 (QUEUED, MANUAL)",
      "  QUEUED (+0s)",
      "  BUILDING (+2s)",
      "  SUCCEEDED (+4s)",
      "배포가 완료되었습니다.",
      "주소  https://web-3.likelion.uk (aws)",
    ]);
  });

  it("sha_를_주면_그_커밋으로_요청한다", async () => {
    const t = await setup([created(), detail("SUCCEEDED"), domains()]);

    await t.run({ kind: "deploy", sha: "9f2c1ab" });

    expect(t.calls[0]?.body).toEqual({ triggerType: "MANUAL", sourceSha: "9f2c1ab" });
  });

  it("sha_형식이_틀리면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(t.run({ kind: "deploy", sha: "not-a-sha" })).rejects.toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(t.calls).toHaveLength(0);
  });

  it("실패한_배포는_원인을_볼_명령과_함께_오류로_끝낸다", async () => {
    const t = await setup([created(), detail("FAILED", { failureCode: "BUILD_FAILED" })]);

    const failure = t.run({ kind: "deploy" });

    await expect(failure).rejects.toThrow("BUILD_FAILED");
    await expect(failure).rejects.toThrow("likelion logs --build --deployment 12");
    await expect(failure).rejects.toThrow("likelion diagnose 12");
    // 명령은 제대로 실행됐지만 결과가 실패라서 종료 코드 4 다.
    await expect(failure).rejects.toMatchObject({ exitCode: 4, code: "DEPLOYMENT_FAILED" });
  });

  it("롤백됨_운영자_확인_대체됨도_결과_실패로_분류한다", async () => {
    for (const [status, code] of [
      ["ROLLED_BACK", "DEPLOYMENT_ROLLED_BACK"],
      ["MANUAL_INTERVENTION", "DEPLOYMENT_MANUAL_INTERVENTION"],
      ["SUPERSEDED", "DEPLOYMENT_SUPERSEDED"],
    ] as const) {
      const t = await setup([created(), detail(status)]);

      await expect(t.run({ kind: "deploy" })).rejects.toMatchObject({ exitCode: 4, code });
    }
  });

  it("진행_중인_배포가_있으면_다음에_할_일을_알린다", async () => {
    const t = await setup([errorEnvelope(409, "DEPLOYMENT_IN_PROGRESS", "in progress")]);

    const failure = t.run({ kind: "deploy" });

    await expect(failure).rejects.toThrow("진행 중인 배포가 있어");
    // 서버 코드는 그대로 두고 재시도 불가(1)로 분류한다.
    await expect(failure).rejects.toMatchObject({ exitCode: 1, code: "DEPLOYMENT_IN_PROGRESS" });
    expect(t.calls).toHaveLength(1);
  });

  it("detach_이면_요청만_보내고_기다리지_않는다", async () => {
    const t = await setup([created()]);

    await t.run({ kind: "deploy", detach: true });

    expect(t.calls).toHaveLength(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines().at(-1)).toContain("likelion status");
  });
});

describe("runDeploy redeploy·rollback·restart", () => {
  it("redeploy_는_번호를_생략하면_가장_최근_배포를_원본으로_쓴다", async () => {
    const t = await setup([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1], latestDeployment: { id: 9, status: "FAILED" } }),
      created("QUEUED", "REDEPLOY"),
      detail("SUCCEEDED"),
      domains(),
    ]);

    await t.run({ kind: "redeploy" });

    expect(t.calls[1]?.body).toEqual({ triggerType: "REDEPLOY", sourceDeploymentId: 9 });
    expect(t.calls[1]?.headers["Idempotency-Key"]).toBe("redeploy-r1");
  });

  it("redeploy_는_번호를_주면_그_배포를_원본으로_쓴다", async () => {
    const t = await setup([created("QUEUED", "REDEPLOY"), detail("SUCCEEDED"), domains()]);

    await t.run({ kind: "redeploy", deployment: "#7" });

    expect(t.calls[0]?.body).toEqual({ triggerType: "REDEPLOY", sourceDeploymentId: 7 });
  });

  it("rollback_은_번호가_없으면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(t.run({ kind: "rollback" })).rejects.toThrow("likelion deployments");
    expect(t.calls).toHaveLength(0);
  });

  it("rollback_은_원본_배포를_가리켜_요청한다", async () => {
    const t = await setup([created("DEPLOYING", "ROLLBACK"), detail("SUCCEEDED"), domains()]);

    await t.run({ kind: "rollback", deployment: "9" });

    expect(t.calls[0]?.body).toEqual({ triggerType: "ROLLBACK", sourceDeploymentId: 9 });
  });

  it("restart_는_원본_없이_요청하고_성공한_배포가_없으면_안내한다", async () => {
    const t = await setup([errorEnvelope(409, "NO_SUCCEEDED_DEPLOYMENT", "none")]);

    await expect(t.run({ kind: "restart" })).rejects.toThrow("재시작할 수 없습니다");
    expect(t.calls[0]?.body).toEqual({ triggerType: "RESTART" });
  });

  it("타깃_서버가_연결되지_않았으면_servers_를_안내한다", async () => {
    const t = await setup([errorEnvelope(409, "TARGET_NOT_CONNECTED", "x")]);

    await expect(t.run({ kind: "deploy" })).rejects.toThrow("likelion servers");
  });
});

describe("runDeploy 출력 옵션", () => {
  it("json_이면_진행_안내는_stderr_로_보내고_stdout_에는_상세_JSON_만_낸다", async () => {
    const t = await setup([created(), detail("SUCCEEDED"), domains()]);

    await t.run({ kind: "deploy", json: true });

    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lines()[0] ?? "")).toMatchObject({ id: 12, status: "SUCCEEDED" });
    expect(t.warn.mock.calls.map(([line]) => line)).toContain("배포가 완료되었습니다.");
  });

  it("logs_이면_기다리는_동안_새_빌드_로그를_이어_보여_준다", async () => {
    const T1 = ns("2026-10-03T00:00:10Z");
    const T2 = ns("2026-10-03T00:00:20Z");
    const t = await setup([
      created(),
      detail("QUEUED"),
      detail("BUILDING"),
      buildLogs([{ timestampNs: T1, message: "[Container] npm ci" }]),
      buildLogs([], { nextCursor: "c1" }),
      detail("SUCCEEDED"),
      buildLogs([{ timestampNs: T2, message: "[Container] done" }]),
      buildLogs([], { isComplete: true }),
      domains(),
    ]);

    await t.run({ kind: "deploy", logs: true });

    const lines = t.lines();
    expect(lines).toContain("2026-10-03T00:00:10.000Z [Container] npm ci");
    expect(lines).toContain("2026-10-03T00:00:20.000Z [Container] done");
    expect(queryOf(t.calls[3]).get("cursor")).toBeNull();
    expect(queryOf(t.calls[4]).get("cursor")).toBe("c1");
    expect(new URL(t.calls[3]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/build-logs");
    // QUEUED 에서는 빌드 로그를 부르지 않는다.
    expect(t.calls.filter((call) => call.url.includes("build-logs"))).toHaveLength(4);
  });

  it("빌드_로그를_읽지_못해도_배포_기다리기는_계속한다", async () => {
    const t = await setup([
      created(),
      detail("BUILDING"),
      errorEnvelope(503, "NOT_CONFIGURED", "CloudWatch 미설정"),
      detail("SUCCEEDED"),
      domains(),
    ]);

    await t.run({ kind: "deploy", logs: true });

    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("빌드 로그를 읽지 못해"));
    expect(t.lines()).toContain("배포가 완료되었습니다.");
  });
});
