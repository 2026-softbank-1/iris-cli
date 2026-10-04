import { describe, expect, it, vi } from "vitest";
import { runDeploymentsList, runDeploymentsShow } from "../src/commands/deployments.js";
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

const deployment = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  serviceId: 3,
  status: "SUCCEEDED",
  sourceSha: "446917d0123456789",
  sourceCommitMessage: "push test\n\n본문",
  triggerType: "MANUAL",
  isActive: false,
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:01:30Z",
  ...overrides,
});

async function setup(responses: (Response | Error)[]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  const log = vi.fn();
  const lines = () => log.mock.calls.map(([line]) => line as string);
  return { calls, log, lines, deps: { fetchImpl, cwd: cwd(), log } };
}

describe("runDeploymentsList", () => {
  it("배포_이력을_표로_보여_주고_더_있으면_안내한다", async () => {
    const t = await setup([
      envelope({
        items: [
          deployment(12, { status: "FAILED", triggerType: "REDEPLOY", sourceDeploymentId: 9 }),
          deployment(11, { sourceSha: "upload-46cce13380d1", triggerType: "CLI", sourceCommitMessage: undefined }),
        ],
        total: 30,
        page: 0,
        size: 2,
      }),
    ]);

    await runDeploymentsList({ limit: 2 }, t.deps);

    const lines = t.lines();
    expect(lines[0]).toMatch(/^ID\s+상태\s+요청\s+시각\s+커밋$/);
    expect(lines[1]).toMatch(/^12\s+FAILED\s+REDEPLOY \(#9\)\s+2026-10-03T00:00:00Z\s+446917d  push test$/);
    expect(lines[2]).toContain("upload-46cce13380d1");
    expect(lines.at(-1)).toBe("전체 30건 중 최근 2건입니다. --limit 으로 더 볼 수 있습니다.");
    const query = queryOf(t.calls[0]);
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments");
    expect([query.get("page"), query.get("size")]).toEqual(["0", "2"]);
  });

  it("json_이면_서버가_준_페이지를_그대로_낸다", async () => {
    const page = { items: [deployment(12)], total: 1, page: 0, size: 20 };
    const t = await setup([envelope(page)]);

    await runDeploymentsList({ limit: 20, json: true }, t.deps);

    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lines()[0] ?? "")).toEqual(page);
  });

  it("이력이_없으면_배포_방법을_안내한다", async () => {
    const t = await setup([envelope({ items: [], total: 0, page: 0, size: 20 })]);

    await runDeploymentsList({ limit: 20 }, t.deps);

    expect(t.lines()[0]).toContain("likelion up");
  });

  it("건수가_범위를_벗어나면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(runDeploymentsList({ limit: 101 }, t.deps)).rejects.toThrow("--limit");
    await expect(runDeploymentsList({ limit: Number.NaN }, t.deps)).rejects.toThrow("--limit");
    expect(t.calls).toHaveLength(0);
  });
});

describe("runDeploymentsShow", () => {
  const detail = deployment(12, {
    status: "FAILED",
    failureCode: "BUILD_FAILED",
    requestedDeploymentStrategy: "CANARY",
    deploymentStrategy: "ROLLING",
    source: { repository: "octocat/web", branch: "main" },
    build: { status: "FAILED", builder: "NIXPACKS", failureCode: "BUILD_FAILED" },
    stages: [
      { status: "QUEUED", startedAt: "2026-10-03T00:00:00Z", durationSeconds: 3.6 },
      { status: "BUILDING", startedAt: "2026-10-03T00:00:04Z" },
    ],
    releases: [{ id: 1, targetId: 1, status: "FAILED", argoSyncStatus: "OutOfSync", argoHealthStatus: "Degraded" }],
    replacedBy: { deploymentId: 14, at: "2026-10-03T01:00:00Z" },
  });

  it("지정한_배포의_상세를_보여_준다", async () => {
    const t = await setup([envelope(detail)]);

    await runDeploymentsShow({ deployment: "#12" }, t.deps);

    expect(t.lines()).toEqual([
      "배포 #12  FAILED",
      "사유  BUILD_FAILED",
      "요청  MANUAL, 2026-10-03T00:00:00Z",
      "커밋  446917d  push test",
      "소스  octocat/web (main)",
      "방식  ROLLING (요청 CANARY, 조건이 안 맞아 대체됨)",
      "빌드  FAILED (NIXPACKS), BUILD_FAILED",
      "단계  QUEUED 3.6s → BUILDING 진행 중",
      "반영  타깃 1: FAILED (OutOfSync / Degraded)",
      "대체  #14 (2026-10-03T01:00:00Z)",
    ]);
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/12");
  });

  it("번호를_생략하면_서비스의_가장_최근_배포를_본다", async () => {
    const t = await setup([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1], latestDeployment: deployment(15) }),
      envelope({ ...detail, id: 15, stages: [] }),
    ]);

    await runDeploymentsShow({}, t.deps);

    expect(new URL(t.calls[1]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/15");
  });

  it("배포_번호_형식이_틀리면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(runDeploymentsShow({ deployment: "abc" }, t.deps)).rejects.toThrow("배포 번호");
    expect(t.calls).toHaveLength(0);
  });

  it("없는_배포는_서버_메시지로_알린다", async () => {
    const t = await setup([errorEnvelope(404, "DEPLOYMENT_REQUEST_NOT_FOUND", "배포 요청을 찾을 수 없습니다")]);

    await expect(runDeploymentsShow({ deployment: "99" }, t.deps)).rejects.toThrow("찾을 수 없습니다");
  });

  it("json_이면_상세를_그대로_낸다", async () => {
    const t = await setup([envelope(detail)]);

    await runDeploymentsShow({ deployment: "12", json: true }, t.deps);

    expect(JSON.parse(t.lines()[0] ?? "")).toMatchObject({ id: 12, source: { repository: "octocat/web" } });
  });
});
