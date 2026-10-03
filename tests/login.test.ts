import { describe, expect, it, vi } from "vitest";
import { runLogin } from "../src/commands/login.js";
import { findCredentials } from "../src/lib/config.js";
import { envelope, errorEnvelope, fakeFetch, useTempConfigDir } from "./helpers.js";

useTempConfigDir();

const session = {
  sessionId: "sess-1",
  pollSecret: "secret-1",
  verificationUrl: "https://api.example.test/api/v1/auth/cli/sessions/sess-1/authorize",
  expiresIn: 600,
  interval: 2,
};

function deps(responses: Response[]) {
  const { fetchImpl, calls } = fakeFetch(responses);
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const openBrowser = vi.fn(async () => undefined);
  const log = vi.fn();
  return { calls, sleep, openBrowser, log, deps: { fetchImpl, sleep, openBrowser, log, now: () => clock } };
}

describe("runLogin", () => {
  it("승인되면_토큰으로_내_정보를_확인하고_저장한다", async () => {
    const t = deps([
      envelope(session),
      envelope({ status: "PENDING" }),
      envelope({ status: "APPROVED", accessToken: "jwt-1" }),
      envelope({ id: 7, githubId: 99, login: "octocat" }),
    ]);

    const credentials = await runLogin({ apiUrl: "https://api.example.test", browser: true }, t.deps);

    expect(credentials).toEqual({
      apiUrl: "https://api.example.test",
      token: "jwt-1",
      user: { id: 7, login: "octocat" },
    });
    expect(await findCredentials()).toEqual(credentials);
    expect(t.openBrowser).toHaveBeenCalledWith(session.verificationUrl);
    expect(t.sleep).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledWith(2000);
    expect(t.calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.example.test/api/v1/auth/cli/sessions/sess-1/token",
      body: { pollSecret: "secret-1" },
    });
    expect(t.calls[3]?.headers.Authorization).toBe("Bearer jwt-1");
  });

  it("no-browser_이면_브라우저를_열지_않고_주소만_출력한다", async () => {
    const t = deps([
      envelope(session),
      envelope({ status: "APPROVED", accessToken: "jwt-1" }),
      envelope({ id: 7, githubId: 99, login: "octocat" }),
    ]);

    await runLogin({ apiUrl: "https://api.example.test", browser: false }, t.deps);

    expect(t.openBrowser).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(`  ${session.verificationUrl}`);
  });

  it("거절되면_오류를_내고_아무것도_저장하지_않는다", async () => {
    const t = deps([envelope(session), envelope({ status: "DENIED" })]);

    await expect(
      runLogin({ apiUrl: "https://api.example.test", browser: false }, t.deps),
    ).rejects.toThrow("거절");
    expect(await findCredentials()).toBeNull();
  });

  it("만료_시간까지_승인이_없으면_시간_초과", async () => {
    const t = deps([
      envelope({ ...session, expiresIn: 4 }),
      envelope({ status: "PENDING" }),
      envelope({ status: "PENDING" }),
    ]);

    await expect(
      runLogin({ apiUrl: "https://api.example.test", browser: false }, t.deps),
    ).rejects.toThrow("시간이 초과");
  });

  it("서버_오류는_메시지를_그대로_전한다", async () => {
    const t = deps([errorEnvelope(503, "NOT_CONFIGURED", "로그인 설정이 없습니다")]);

    await expect(
      runLogin({ apiUrl: "https://api.example.test", browser: false }, t.deps),
    ).rejects.toThrow("로그인 설정이 없습니다");
  });
});
