import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runUp, type UpDeps } from "../src/commands/up.js";
import {
  envelope,
  errorEnvelope,
  fakeFetch,
  linkTo,
  loginAs,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const upload = () => envelope({ uploadId: "up-1", sizeBytes: 100, sha256: "abc" }, { status: 201 });
const created = () => envelope({ id: 12, serviceId: 3, status: "QUEUED", triggerType: "CLI" }, { status: 201 });
const detail = (status: string, extra: Record<string, unknown> = {}) =>
  envelope({
    id: 12,
    serviceId: 3,
    status,
    sourceSha: "up-abc",
    triggerType: "CLI",
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    stages: [],
    ...extra,
  });
const domains = () =>
  envelope([{ targetId: 1, targetName: "aws", isConnected: true, url: "https://web-3.likelion.uk" }]);

async function setup(responses: (Response | Error)[]) {
  await loginAs();
  await linkTo(cwd());
  await mkdir(join(cwd(), "src"), { recursive: true });
  await writeFile(join(cwd(), "src", "index.js"), "console.log('hi')");
  const { fetchImpl, calls } = fakeFetch(responses);
  let clock = 0;
  const log = vi.fn();
  const warn = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: UpDeps = { fetchImpl, cwd: cwd(), log, warn, sleep, now: () => clock };
  const lines = () => log.mock.calls.map(([line]) => line);
  return { calls, log, warn, sleep, deps, lines };
}

describe("runUp", () => {
  it("묶어_올리고_CLI_배포를_만든_뒤_끝까지_상태를_보여_준다", async () => {
    const t = await setup([
      upload(),
      created(),
      detail("QUEUED"),
      detail("BUILDING"),
      detail("DEPLOYING"),
      detail("SUCCEEDED"),
      domains(),
    ]);

    const deploymentId = await runUp({ detach: false }, t.deps);

    expect(deploymentId).toBe(12);
    const [uploadCall, createCall] = t.calls;
    expect(uploadCall?.method).toBe("POST");
    expect(new URL(uploadCall?.url ?? "").pathname).toBe("/api/v1/services/3/uploads");
    expect(uploadCall?.headers["Content-Type"]).toBe("application/gzip");
    expect(uploadCall?.headers.Authorization).toBe("Bearer jwt-1");
    expect(Number(uploadCall?.headers["Content-Length"])).toBe(uploadCall?.rawBody?.length);
    expect([uploadCall?.rawBody?.[0], uploadCall?.rawBody?.[1]]).toEqual([0x1f, 0x8b]);
    expect(new URL(createCall?.url ?? "").pathname).toBe("/api/v1/services/3/deployments");
    expect(createCall?.body).toEqual({ triggerType: "CLI", uploadId: "up-1" });
    expect(createCall?.headers["Idempotency-Key"]).toBe("up-up-1");

    const lines = t.lines();
    expect(lines).toContain("배포 요청 #12 (QUEUED)");
    expect(lines.filter((line) => line.includes("BUILDING"))).toHaveLength(1);
    expect(lines).toContain("  DEPLOYING (+4s)");
    expect(lines).toContain("  SUCCEEDED (+6s)");
    expect(lines).toContain("배포가 완료되었습니다.");
    expect(lines).toContain("주소  https://web-3.likelion.uk (aws)");
  });

  it("detach_이면_배포_요청만_보내고_기다리지_않는다", async () => {
    const t = await setup([upload(), created()]);

    await runUp({ detach: true }, t.deps);

    expect(t.calls).toHaveLength(2);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines().at(-1)).toContain("likelion status");
  });

  it("배포가_실패하면_사유와_함께_오류로_끝낸다", async () => {
    const t = await setup([
      upload(),
      created(),
      detail("BUILDING"),
      detail("FAILED", { failureCode: "BUILD_FAILED" }),
    ]);

    await expect(runUp({ detach: false }, t.deps)).rejects.toThrow("BUILD_FAILED");
  });

  it("롤백된_배포도_오류로_끝낸다", async () => {
    const t = await setup([upload(), created(), detail("ROLLED_BACK")]);

    await expect(runUp({ detach: false }, t.deps)).rejects.toThrow("되돌렸습니다");
  });

  it("서버가_업로드를_거절하면_배포를_만들지_않는다", async () => {
    const t = await setup([errorEnvelope(413, "UPLOAD_TOO_LARGE", "업로드가 너무 큽니다")]);

    await expect(runUp({ detach: false }, t.deps)).rejects.toThrow("업로드가 너무 큽니다");
    expect(t.calls).toHaveLength(1);
  });

  it("묶음이_한도를_넘으면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);
    await writeFile(join(cwd(), "big.txt"), "z".repeat(200_000));

    await expect(runUp({ detach: false }, { ...t.deps, maxArchiveBytes: 50 })).rejects.toThrow(
      "한도",
    );
    expect(t.calls).toHaveLength(0);
  });

  it("폴링_중_연결이_잠깐_끊겨도_다시_시도한다", async () => {
    const t = await setup([
      upload(),
      created(),
      new Error("blip"),
      detail("SUCCEEDED"),
      domains(),
    ]);

    await runUp({ detach: false }, t.deps);

    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("다시 확인"));
    expect(t.lines()).toContain("배포가 완료되었습니다.");
  });

  it("연결되지_않은_폴더면_link_안내", async () => {
    await loginAs();

    await expect(runUp({ detach: false }, { cwd: cwd(), log: vi.fn() })).rejects.toThrow(
      "likelion link",
    );
  });
});
