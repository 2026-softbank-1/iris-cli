import { describe, expect, it, vi } from "vitest";
import { runStatus } from "../src/commands/status.js";
import { envelope, fakeFetch, linkTo, loginAs, useTempConfigDir, useTempCwd } from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const latest = {
  id: 9,
  status: "SUCCEEDED",
  sourceSha: "446917d0123456789",
  sourceCommitMessage: "push test",
  triggerType: "PUSH",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:01:30Z",
};

const domains = envelope([
  { targetId: 1, targetName: "aws", isConnected: true, host: "web-3.likelion.uk", url: "https://web-3.likelion.uk" },
  { targetId: 2, targetName: "local", isConnected: false },
]);

describe("runStatus", () => {
  it("최근_배포의_상태_커밋_단계별_소요_시간과_주소를_보여_준다", async () => {
    await loginAs();
    await linkTo(cwd());
    const { fetchImpl, calls } = fakeFetch([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1], latestDeployment: latest }),
      domains,
      envelope({
        ...latest,
        stages: [
          { status: "QUEUED", startedAt: "2026-10-03T00:00:00Z", durationSeconds: 3.6 },
          { status: "BUILDING", startedAt: "2026-10-03T00:00:04Z", durationSeconds: 70 },
          { status: "DEPLOYING", startedAt: "2026-10-03T00:01:14Z" },
        ],
      }),
    ]);
    const log = vi.fn();

    await runStatus({ fetchImpl, cwd: cwd(), log });

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "web (서비스 3, 프로젝트 demo)",
      "상태  SUCCEEDED",
      "커밋  446917d  push test",
      "요청  PUSH, 2026-10-03T00:00:00Z",
      "단계  QUEUED 3.6s → BUILDING 1m10s → DEPLOYING 진행 중",
      "주소  https://web-3.likelion.uk (aws)",
    ]);
    expect(new URL(calls[2]?.url ?? "").pathname).toBe("/api/v1/services/3/deployments/9");
  });

  it("실패한_배포는_사유를_함께_보여_준다", async () => {
    await loginAs();
    await linkTo(cwd());
    const failed = { ...latest, status: "FAILED", failureCode: "BUILD_FAILED" };
    const { fetchImpl } = fakeFetch([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1], latestDeployment: failed }),
      envelope([]),
      envelope({ ...failed, stages: [] }),
    ]);
    const log = vi.fn();

    await runStatus({ fetchImpl, cwd: cwd(), log });

    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toContain("상태  FAILED");
    expect(lines).toContain("사유  BUILD_FAILED");
  });

  it("배포_이력이_없으면_그렇다고_알려_준다", async () => {
    await loginAs();
    await linkTo(cwd());
    const { fetchImpl, calls } = fakeFetch([
      envelope({ id: 3, projectId: 1, name: "web", targetIds: [1] }),
      envelope([]),
    ]);
    const log = vi.fn();

    await runStatus({ fetchImpl, cwd: cwd(), log });

    expect(log).toHaveBeenCalledWith("배포 이력이 없습니다.");
    expect(calls).toHaveLength(2);
  });

  it("연결되지_않은_폴더면_link_안내", async () => {
    await loginAs();

    await expect(runStatus({ cwd: cwd(), log: vi.fn() })).rejects.toThrow("likelion link");
  });
});
