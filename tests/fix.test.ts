import { describe, expect, it, vi } from "vitest";
import { type FixDeps, type FixOptions, runFix } from "../src/commands/fix.js";
import {
  envelope,
  errorEnvelope,
  fakeFetch,
  linkTo,
  loginAs,
  queryOf,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const diagnosis = (status = "SUCCEEDED") =>
  envelope({ id: 5, deploymentId: 12, status, createdAt: "2026-10-03T00:00:00Z" });
const diagnosisNotFound = () => errorEnvelope(404, "DIAGNOSIS_NOT_FOUND", "none");
const repairNotFound = () => errorEnvelope(404, "NOT_FOUND", "none");
const repair = (overrides: Record<string, unknown> = {}) =>
  envelope(
    {
      id: 7,
      deploymentId: 12,
      diagnosisId: 5,
      status: "RUNNING",
      sourceSha: "abc",
      planIds: ["p1"],
      createdAt: "2026-10-03T00:00:00Z",
      autoMerge: true,
      autoRedeploy: true,
      ...overrides,
    },
    { status: 202 },
  );
const detail = (status: string) =>
  envelope({
    id: 20,
    serviceId: 3,
    status,
    sourceSha: "def",
    triggerType: "REDEPLOY",
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    stages: [],
  });
const domains = () =>
  envelope([{ targetId: 1, targetName: "aws", isConnected: true, url: "https://web-3.likelion.uk" }]);

async function setup(responses: (Response | Error)[], ask?: FixDeps["ask"]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  let clock = 0;
  const log = vi.fn();
  const warn = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: FixDeps = { fetchImpl, cwd: cwd(), log, warn, sleep, now: () => clock, ask, randomId: () => "r1" };
  const lines = () => log.mock.calls.map(([line]) => line as string);
  const run = (options: Partial<FixOptions> = {}) =>
    runFix({ deployment: "12", yes: true, detach: false, ...options }, deps);
  return { calls, log, warn, sleep, lines, run };
}

const paths = (calls: { method: string; url: string }[]) =>
  calls.map((call) => `${call.method} ${new URL(call.url).pathname.replace("/api/v1/services/3", "")}`);

describe("runFix", () => {
  it("진단을_찾아_AI_수정을_요청하고_PR_머지_재배포가_끝날_때까지_따라간다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      repair({ publication: { status: "QUEUED" } }),
      repair({ publication: { status: "PR_OPENED", pullUrl: "https://github.com/o/r/pull/9" } }),
      repair({
        status: "SUCCEEDED",
        publication: { status: "REDEPLOY_REQUESTED", pullUrl: "https://github.com/o/r/pull/9", mergeCommitSha: "1234567890", redeploymentId: 20 },
      }),
      detail("BUILDING"),
      detail("SUCCEEDED"),
      domains(),
    ]);

    await t.run();

    expect(paths(t.calls)).toEqual([
      "GET /deployments/12/diagnosis",
      "GET /deployments/12/repairs/latest",
      "POST /deployments/12/auto-repair",
      "GET /repairs/7",
      "GET /repairs/7",
      "GET /deployments/20",
      "GET /deployments/20",
      "GET /domains",
    ]);
    expect(queryOf(t.calls[1]).get("diagnosisId")).toBe("5");
    expect(t.calls[2]?.body).toEqual({ diagnosisId: 5 });
    expect(t.calls[2]?.headers["Idempotency-Key"]).toBe("fix-r1");
    expect(t.lines()).toEqual([
      "AI 수정 #7 (RUNNING, 게시 QUEUED)",
      "  RUNNING, 게시 PR_OPENED",
      "  SUCCEEDED, 게시 REDEPLOY_REQUESTED",
      "핫픽스 PR  https://github.com/o/r/pull/9",
      "머지  1234567",
      "재배포 #20 가 요청되었습니다.",
      "  BUILDING (+0s)",
      "  SUCCEEDED (+2s)",
      "배포가 완료되었습니다.",
      "주소  https://web-3.likelion.uk (aws)",
    ]);
  });

  it("성공한_진단이_없으면_diagnosisId_없이_요청해_서버가_진단부터_하게_한다", async () => {
    const t = await setup([
      diagnosisNotFound(),
      repair({ publication: { status: "DIAGNOSING" } }),
    ]);

    await t.run({ detach: true });

    expect(paths(t.calls)).toEqual(["GET /deployments/12/diagnosis", "POST /deployments/12/auto-repair"]);
    expect(t.calls[1]?.body).toEqual({});
  });

  it("이_진단의_수정이_이미_진행_중이면_새로_만들지_않고_이어서_본다", async () => {
    const t = await setup([
      diagnosis(),
      repair({ publication: { status: "WAITING_CHECKS" } }),
      repair({ status: "SUCCEEDED", publication: { status: "MERGED", mergeCommitSha: "abcdef0123" }, autoRedeploy: false }),
    ]);

    const result = await t.run();

    expect(paths(t.calls)).toEqual([
      "GET /deployments/12/diagnosis",
      "GET /deployments/12/repairs/latest",
      "GET /repairs/7",
    ]);
    expect(result?.publication?.status).toBe("MERGED");
    expect(t.lines()).toContain("main 에 머지했습니다. 새 배포가 시작되면 `likelion deployments` 로 확인하세요.");
  });

  it("후보만_만들어_둔_수정은_자동_게시를_재개한다", async () => {
    const t = await setup([
      diagnosis(),
      repair({ status: "SUCCEEDED", autoMerge: false, autoRedeploy: false }),
      repair({ status: "SUCCEEDED", publication: { status: "MERGED" }, autoRedeploy: false }),
    ]);

    await t.run({ detach: true });

    expect(paths(t.calls)).toEqual([
      "GET /deployments/12/diagnosis",
      "GET /deployments/12/repairs/latest",
      "POST /repairs/7/auto",
    ]);
  });

  it("이전_수정이_실패했으면_새로_요청한다", async () => {
    const t = await setup([
      diagnosis(),
      repair({ status: "FAILED", autoMerge: false }),
      repair({ publication: { status: "QUEUED" } }),
    ]);

    await t.run({ detach: true });

    expect(paths(t.calls).at(-1)).toBe("POST /deployments/12/auto-repair");
  });

  it("detach_이면_요청만_보내고_다시_실행하면_이어_본다고_알린다", async () => {
    const t = await setup([diagnosis(), repairNotFound(), repair()]);

    await t.run({ detach: true });

    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines().at(-1)).toContain("likelion fix 12 --yes");
  });

  it("main_머지는_GitHub_보호_규칙에_막히면_PR_주소와_함께_오류로_끝낸다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      repair(),
      repair({ publication: { status: "ERROR", errorCode: "MERGE_BLOCKED", pullUrl: "https://github.com/o/r/pull/9" } }),
    ]);

    const failure = t.run();

    await expect(failure).rejects.toThrow("보호 규칙");
    await expect(failure).rejects.toMatchObject({ exitCode: 4, code: "MERGE_BLOCKED" });
    await expect(failure).rejects.toThrow("https://github.com/o/r/pull/9");
  });

  it("수정_생성이_실패하면_오류_코드와_진단_안내로_끝낸다", async () => {
    const t = await setup([diagnosis(), repairNotFound(), repair({ status: "RUNNING", autoMerge: false }), repair({ status: "FAILED", autoMerge: false, errorCode: "MODEL_TIMEOUT" })]);

    await expect(t.run()).rejects.toThrow("MODEL_TIMEOUT");
  });

  it("코드_변경_없이_건너뛰면_환경변수를_안내하고_성공으로_끝낸다", async () => {
    const t = await setup([diagnosis(), repairNotFound(), repair(), repair({ status: "SUCCEEDED", publication: { status: "SKIPPED" } })]);

    await t.run();

    expect(t.lines().at(-1)).toContain("likelion env set");
  });

  it("환경변수_값이_필요한_실패면_변수_이름과_설정_방법을_알린다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      errorEnvelope(409, "CONFIGURATION_VALUES_REQUIRED", "need values", {}, [
        { field: "DATABASE_URL", reason: "required" },
        { field: "SESSION_SECRET", reason: "required" },
      ]),
    ]);

    const failure = t.run();

    await expect(failure).rejects.toThrow("DATABASE_URL, SESSION_SECRET");
    await expect(failure).rejects.toThrow("likelion env set DATABASE_URL=<값>");
  });

  it("GitHub_쓰기_권한이_없으면_승인_주소를_알린다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      errorEnvelope(403, "FORBIDDEN", "no write"),
      envelope({ repository: "o/r", canWrite: false, installationUrl: "https://github.com/apps/likelion/installations/1" }),
    ]);

    await expect(t.run()).rejects.toThrow("https://github.com/apps/likelion/installations/1");
  });

  it("실패한_배포가_아니면_대상이_아니라고_알린다", async () => {
    const t = await setup([diagnosisNotFound(), errorEnvelope(409, "DEPLOYMENT_NOT_FAILED", "x")]);

    await expect(t.run()).rejects.toThrow("실패한 배포만 고칠 수 있습니다");
  });

  it("상태_확인이_연속으로_실패하면_서버에서는_계속된다고_알리며_멈춘다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      repair(),
      ...Array.from({ length: 5 }, () => errorEnvelope(502, "BAD_GATEWAY", "x")),
    ]);

    await expect(t.run()).rejects.toThrow("서버에서 계속됩니다");
  });

  it("json_이면_수정과_재배포_결과를_JSON_하나로_낸다", async () => {
    const t = await setup([
      diagnosis(),
      repairNotFound(),
      repair(),
      repair({ status: "SUCCEEDED", publication: { status: "REDEPLOY_REQUESTED", redeploymentId: 20 } }),
      detail("SUCCEEDED"),
      domains(),
    ]);

    await t.run({ json: true });

    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lines()[0] ?? "")).toMatchObject({
      repair: { id: 7 },
      redeployment: { id: 20, status: "SUCCEEDED" },
    });
  });
});

describe("runFix 확인", () => {
  it("yes_도_ask_도_없으면_main_머지가_일어나므로_멈춘다", async () => {
    const t = await setup([]);

    await expect(t.run({ yes: false })).rejects.toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(t.calls).toHaveLength(0);
  });

  it("확인에서_아니라고_하면_수정을_요청하지_않는다", async () => {
    const ask = vi.fn(async () => "n");
    const t = await setup(
      [envelope({ id: 3, projectId: 1, name: "web", sourceRepositoryUrl: "https://github.com/o/r", sourceBranch: "main", targetIds: [1] })],
      ask,
    );

    const result = await t.run({ yes: false });

    expect(result).toBeUndefined();
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("https://github.com/o/r"));
    expect(t.calls).toHaveLength(1);
    expect(t.lines()).toContain("수정하지 않았습니다.");
  });
});
