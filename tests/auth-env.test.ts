import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLogout } from "../src/commands/logout.js";
import { runWhoami } from "../src/commands/whoami.js";
import { findActiveCredentials, saveCredentials } from "../src/lib/config.js";
import { isInteractive } from "../src/lib/prompt.js";
import { requireSession } from "../src/lib/session.js";
import { API_URL, envelope, errorEnvelope, fakeFetch, loginAs, useTempConfigDir } from "./helpers.js";

useTempConfigDir();

beforeEach(() => {
  delete process.env.LIKELION_TOKEN;
  delete process.env.LIKELION_API_URL;
});
afterEach(() => {
  delete process.env.LIKELION_TOKEN;
  delete process.env.LIKELION_API_URL;
});

describe("LIKELION_TOKEN", () => {
  it("저장된_로그인이_없어도_환경변수_토큰으로_인증한다", async () => {
    process.env.LIKELION_TOKEN = "env-token";
    process.env.LIKELION_API_URL = "https://api.ci.test/";
    const { fetchImpl, calls } = fakeFetch([envelope({ id: 7, login: "octocat" })]);

    await runWhoami({}, { fetchImpl, log: vi.fn() });

    expect(calls[0]?.url).toBe("https://api.ci.test/api/v1/me");
    expect(calls[0]?.headers.Authorization).toBe("Bearer env-token");
  });

  it("저장된_로그인보다_환경변수_토큰이_먼저다", async () => {
    await loginAs();
    process.env.LIKELION_TOKEN = " env-token \n";

    const credentials = await findActiveCredentials();

    expect(credentials?.token).toBe("env-token");
    expect(credentials?.apiUrl).toBe("https://api.likelion.uk");
  });

  it("환경변수가_없으면_저장된_로그인을_쓴다", async () => {
    await loginAs();

    expect((await findActiveCredentials())?.token).toBe("jwt-1");
    expect((await findActiveCredentials())?.apiUrl).toBe(API_URL);
  });

  it("서버가_환경변수_토큰을_거절하면_LIKELION_TOKEN_을_알리고_인증_오류_3_으로_끝낸다", async () => {
    process.env.LIKELION_TOKEN = "bad";
    const { fetchImpl } = fakeFetch([errorEnvelope(401, "UNAUTHORIZED", "x")]);

    const failure = runWhoami({}, { fetchImpl, log: vi.fn() });

    await expect(failure).rejects.toThrow("LIKELION_TOKEN");
    await expect(failure).rejects.toMatchObject({ exitCode: 3, code: "UNAUTHENTICATED" });
  });

  it("저장된_세션이_거절되면_다시_로그인하라고_안내하고_종료_코드는_3_이다", async () => {
    await loginAs();
    const { fetchImpl } = fakeFetch([errorEnvelope(401, "UNAUTHORIZED", "x")]);

    const failure = runWhoami({}, { fetchImpl, log: vi.fn() });

    await expect(failure).rejects.toThrow("likelion login");
    await expect(failure).rejects.toMatchObject({ exitCode: 3 });
  });

  it("로그인도_토큰도_없으면_두_방법을_안내하고_종료_코드는_3_이다", async () => {
    const failure = requireSession();

    await expect(failure).rejects.toThrow("LIKELION_TOKEN");
    await expect(failure).rejects.toMatchObject({ exitCode: 3 });
  });

  it("logout_은_환경변수_토큰이_남아_있다고_알린다", async () => {
    await saveCredentials({ apiUrl: API_URL, token: "t" });
    process.env.LIKELION_TOKEN = "env-token";
    const log = vi.fn();

    await runLogout(log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("LIKELION_TOKEN"));
  });

  it("whoami_json_은_계정과_서버_주소를_JSON_으로_낸다", async () => {
    await loginAs();
    const { fetchImpl } = fakeFetch([envelope({ id: 7, login: "octocat" })]);
    const log = vi.fn();

    await runWhoami({ json: true }, { fetchImpl, log });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({ id: 7, login: "octocat", apiUrl: API_URL });
  });
});

describe("isInteractive", () => {
  it("터미널이고_CI_도_에이전트도_아니면_대화형이다", () => {
    expect(isInteractive({}, true)).toBe(true);
  });

  it.each([
    [{}, false],
    [{ CI: "true" }, true],
    [{ LIKELION_NON_INTERACTIVE: "1" }, true],
    [{ CLAUDECODE: "1" }, true],
    [{ AI_AGENT: "codex" }, true],
    [{ AGENT: "goose" }, true],
  ])("%o (TTY=%s_로_해석) 는_대화형이_아니다", (env, tty) => {
    // 첫 케이스는 TTY 가 없는 경우, 나머지는 TTY 인데 환경변수 때문에 막히는 경우다.
    expect(isInteractive(env, tty)).toBe(false);
  });

  it("값이_0_이거나_false_이면_설정하지_않은_것으로_본다", () => {
    expect(isInteractive({ CI: "false", CLAUDECODE: "0", LIKELION_NON_INTERACTIVE: "" }, true)).toBe(true);
  });
});
