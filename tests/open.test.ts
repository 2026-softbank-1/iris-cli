import { describe, expect, it, vi } from "vitest";
import { runOpen } from "../src/commands/open.js";
import { envelope, fakeFetch, linkTo, loginAs, useTempConfigDir, useTempCwd } from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const aws = { targetId: 1, targetName: "aws", isConnected: true, url: "https://web-3.likelion.uk" };
const local = { targetId: 2, targetName: "local", isConnected: true, url: "https://web-3.local.test" };
const idle = { targetId: 3, targetName: "idle", isConnected: false };

async function setup(domains: unknown[]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch([envelope(domains)]);
  return { fetchImpl, calls, log: vi.fn(), openBrowser: vi.fn(async () => undefined) };
}

describe("runOpen", () => {
  it("연결된_도메인을_출력하고_브라우저로_연다", async () => {
    const t = await setup([idle, aws]);

    const url = await runOpen({ browser: true }, { ...t, cwd: cwd() });

    expect(url).toBe("https://web-3.likelion.uk");
    expect(t.log).toHaveBeenCalledWith("https://web-3.likelion.uk");
    expect(t.openBrowser).toHaveBeenCalledWith("https://web-3.likelion.uk");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/domains");
  });

  it("no_browser_이면_주소만_출력한다", async () => {
    const t = await setup([aws]);

    await runOpen({ browser: false }, { ...t, cwd: cwd() });

    expect(t.openBrowser).not.toHaveBeenCalled();
  });

  it("타깃이_여러_개면_target_으로_고르고_안_고르면_첫_번째를_연다", async () => {
    const picked = await setup([aws, local]);
    expect(await runOpen({ browser: false, target: "local" }, { ...picked, cwd: cwd() })).toBe(
      "https://web-3.local.test",
    );

    const first = await setup([aws, local]);
    expect(await runOpen({ browser: false }, { ...first, cwd: cwd() })).toBe(
      "https://web-3.likelion.uk",
    );
    expect(first.log).toHaveBeenCalledWith(expect.stringContaining("--target"));
  });

  it("없는_타깃이면_가능한_값을_알려_준다", async () => {
    const t = await setup([aws, local]);

    await expect(runOpen({ browser: false, target: "nope" }, { ...t, cwd: cwd() })).rejects.toThrow(
      "aws(1), local(2)",
    );
  });

  it("연결된_도메인이_없으면_status_를_안내한다", async () => {
    const t = await setup([idle]);

    await expect(runOpen({ browser: true }, { ...t, cwd: cwd() })).rejects.toThrow(
      "likelion status",
    );
    expect(t.openBrowser).not.toHaveBeenCalled();
  });

  it("json_이면_브라우저를_열지_않고_주소_목록을_JSON_으로_낸다", async () => {
    const t = await setup([aws, local]);

    await runOpen({ browser: true, json: true }, { ...t, cwd: cwd() });

    expect(t.openBrowser).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.log.mock.calls[0]?.[0] as string)).toEqual({
      url: "https://web-3.likelion.uk",
      target: "aws",
      targets: [
        { id: 1, name: "aws", url: "https://web-3.likelion.uk" },
        { id: 2, name: "local", url: "https://web-3.local.test" },
      ],
    });
  });
});
