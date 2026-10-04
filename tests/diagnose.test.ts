import { describe, expect, it, vi } from "vitest";
import { type DiagnoseDeps, type DiagnoseOptions, runDiagnose } from "../src/commands/diagnose.js";
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

const analysis = {
  analysisStatus: "diagnosed",
  summary: "PORT 환경변수를 읽지 않아 헬스체크가 실패했다",
  hypotheses: [
    { id: "h1", category: "port_binding", supportLevel: "direct", statement: "앱이 3000 포트에 고정으로 바인딩한다", evidenceIds: ["e1"], uncertainty: "다른 포트를 쓰는 설정이 있을 수 있다" },
    { id: "h2", category: "start_command", supportLevel: "supported", statement: "시작 명령이 잘못됐을 수 있다" },
  ],
  nextChecks: [{ target: "package.json", method: "scripts.start 확인", purpose: "시작 명령 검증" }],
  missingInformation: [{ requestedData: "Dockerfile", reason: "EXPOSE 확인" }],
  limitations: ["로그가 100줄에서 잘렸다"],
  remediation: {
    status: "proposed",
    reason: "코드 수정으로 해결 가능",
    plans: [
      {
        id: "p1",
        title: "PORT 환경변수를 읽도록 수정",
        applyWhen: ["앱이 Express 일 때"],
        changes: [{ kind: "code", target: "src/server.js", instruction: "listen 포트를 바꾼다", snippet: "app.listen(process.env.PORT ?? {{DEFAULT_PORT}});" }],
        verification: [{ instruction: "재배포 후 헬스체크 확인", expectedResult: "200 응답" }],
        rollback: ["이전 커밋으로 revert"],
        risks: ["로컬 포트가 바뀐다"],
      },
    ],
  },
};

const diagnosis = (status: string, extra: Record<string, unknown> = {}) =>
  envelope({
    id: 5,
    deploymentId: 12,
    status,
    createdAt: "2026-10-03T00:00:00Z",
    ...(status === "SUCCEEDED" ? { analysis, evidence: [{ id: "e1", sourceId: "pod-1", stage: "runtime", text: "Listening on 3000" }] } : {}),
    ...extra,
  });
const notFound = () => errorEnvelope(404, "DIAGNOSIS_NOT_FOUND", "no diagnosis");
const started = (status = "RUNNING") => {
  const response = diagnosis(status);
  return status === "RUNNING" ? new Response(response.body, { status: 202, headers: response.headers }) : response;
};

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
  const deps: DiagnoseDeps = { fetchImpl, cwd: cwd(), log, warn, sleep, now: () => clock };
  const lines = () => log.mock.calls.map(([line]) => line as string);
  const run = (options: Partial<DiagnoseOptions> = {}) =>
    runDiagnose({ deployment: "12", refresh: false, wait: true, evidence: false, ...options }, deps);
  return { calls, log, warn, sleep, lines, run };
}

describe("runDiagnose", () => {
  it("성공한_진단이_있으면_새로_돌리지_않고_원인과_해결책을_보여_준다", async () => {
    const t = await setup([diagnosis("SUCCEEDED")]);

    await t.run();

    expect(t.calls).toHaveLength(1);
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/diagnosis");
    const text = t.lines().join("\n");
    expect(text).toContain("진단 #5 (배포 #12)  SUCCEEDED");
    expect(text).toContain("요약  PORT 환경변수를 읽지 않아 헬스체크가 실패했다");
    expect(text).toContain("1. [로그에 직접 나옴] 앱이 3000 포트에 고정으로 바인딩한다");
    expect(text).toContain("불확실한 점: 다른 포트를 쓰는 설정이 있을 수 있다");
    expect(text).toContain("2. [근거로 추정] 시작 명령이 잘못됐을 수 있다");
    expect(text).toContain("1. PORT 환경변수를 읽도록 수정");
    expect(text).toContain("- [code] src/server.js: listen 포트를 바꾼다");
    expect(text).toContain("app.listen(process.env.PORT ?? {{DEFAULT_PORT}});");
    expect(text).toContain("수정 예시는 템플릿입니다");
    expect(text).toContain("확인: 재배포 후 헬스체크 확인 → 200 응답");
    expect(text).toContain("package.json: scripts.start 확인 (시작 명령 검증)");
    expect(text).toContain("Dockerfile — EXPOSE 확인");
    expect(text).toContain("로그가 100줄에서 잘렸다");
    expect(text).toContain("근거 로그 1줄은 --evidence 로 볼 수 있습니다.");
    expect(text).toContain("likelion fix 12");
    expect(text).not.toContain("Listening on 3000");
  });

  it("evidence_면_근거_로그_줄도_보여_준다", async () => {
    const t = await setup([diagnosis("SUCCEEDED")]);

    await t.run({ evidence: true });

    expect(t.lines()).toContain("  e1 [runtime] Listening on 3000");
  });

  it("진단이_없으면_시작하고_끝날_때까지_기다린다", async () => {
    const t = await setup([notFound(), started(), diagnosis("RUNNING"), diagnosis("SUCCEEDED")]);

    const result = await t.run();

    expect(result.status).toBe("SUCCEEDED");
    expect(t.calls.map((call) => call.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12/diagnose");
    expect(queryOf(t.calls[1]).get("refresh")).toBeNull();
    expect(t.sleep.mock.calls.map(([ms]) => ms)).toEqual([2500, 2500]);
  });

  it("서버가_이미_자동_진단을_돌리고_있으면_그_진단을_따라간다", async () => {
    const t = await setup([
      notFound(),
      errorEnvelope(409, "DIAGNOSIS_IN_PROGRESS", "running"),
      diagnosis("RUNNING"),
      diagnosis("SUCCEEDED"),
    ]);

    const result = await t.run();

    expect(result.status).toBe("SUCCEEDED");
  });

  it("refresh_는_조회_없이_refresh_로_새_진단을_시작한다", async () => {
    const t = await setup([started("SUCCEEDED")]);

    await t.run({ refresh: true });

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.method).toBe("POST");
    expect(queryOf(t.calls[0]).get("refresh")).toBe("true");
  });

  it("직전_진단이_실패했으면_다시_시작한다", async () => {
    const t = await setup([diagnosis("FAILED", { errorCode: "MODEL_TIMEOUT" }), started("SUCCEEDED")]);

    const result = await t.run();

    expect(result.status).toBe("SUCCEEDED");
    expect(t.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("실패한_배포가_아니면_이유와_다음_할_일을_알린다", async () => {
    const t = await setup([notFound(), errorEnvelope(409, "DEPLOYMENT_NOT_FAILED", "not failed")]);

    await expect(t.run()).rejects.toThrow("실패한 배포만 진단할 수 있습니다");
  });

  it("no_wait_이면_진행_중이라고_알리고_기다리지_않는다", async () => {
    const t = await setup([diagnosis("RUNNING")]);

    await t.run({ wait: false });

    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines()[0]).toContain("진행 중");
  });

  it("진단이_끝내_실패하면_코드와_다시_시도_방법을_담아_오류로_끝낸다", async () => {
    const t = await setup([diagnosis("RUNNING"), diagnosis("FAILED", { errorCode: "DIAGNOSIS_LOGS_UNAVAILABLE" })]);

    const failure = t.run();

    await expect(failure).rejects.toThrow("DIAGNOSIS_LOGS_UNAVAILABLE");
    await expect(failure).rejects.toThrow("likelion diagnose 12 --refresh");
    await expect(failure).rejects.toMatchObject({ exitCode: 4, code: "DIAGNOSIS_LOGS_UNAVAILABLE" });
  });

  it("4분_안에_끝나지_않으면_기다리기를_멈춘다", async () => {
    const t = await setup([diagnosis("RUNNING"), ...Array.from({ length: 120 }, () => diagnosis("RUNNING"))]);

    await expect(t.run()).rejects.toThrow("4분 안에");
  });

  it("조회가_연속으로_실패하면_멈춘다", async () => {
    const t = await setup([
      diagnosis("RUNNING"),
      errorEnvelope(502, "BAD_GATEWAY", "x"),
      errorEnvelope(502, "BAD_GATEWAY", "x"),
      errorEnvelope(502, "BAD_GATEWAY", "x"),
    ]);

    await expect(t.run()).rejects.toThrow("연속 3회");
  });

  it("json_이면_진단_JSON_만_stdout_으로_낸다", async () => {
    const t = await setup([diagnosis("SUCCEEDED")]);

    await t.run({ json: true });

    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lines()[0] ?? "")).toMatchObject({ id: 5, status: "SUCCEEDED", analysis: { summary: expect.any(String) } });
  });
});
