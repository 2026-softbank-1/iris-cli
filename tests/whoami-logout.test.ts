import { describe, expect, it, vi } from "vitest";
import { runLogout } from "../src/commands/logout.js";
import { runWhoami } from "../src/commands/whoami.js";
import { findCredentials, saveCredentials } from "../src/lib/config.js";
import { envelope, errorEnvelope, fakeFetch, useTempConfigDir } from "./helpers.js";

useTempConfigDir();

const credentials = {
  apiUrl: "https://api.example.test",
  token: "jwt-1",
  user: { id: 7, login: "octocat" },
};

describe("runWhoami", () => {
  it("로그인_정보가_없으면_login_안내", async () => {
    await expect(runWhoami({ log: vi.fn() })).rejects.toThrow("likelion login");
  });

  it("저장된_토큰으로_GitHub_계정을_출력한다", async () => {
    await saveCredentials(credentials);
    const { fetchImpl, calls } = fakeFetch([envelope({ id: 7, githubId: 99, login: "octocat" })]);
    const log = vi.fn();

    await runWhoami({ fetchImpl, log });

    expect(log).toHaveBeenCalledWith("octocat");
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.example.test/api/v1/me" });
    expect(calls[0]?.headers.Authorization).toBe("Bearer jwt-1");
  });

  it("401_이면_세션_만료로_안내한다", async () => {
    await saveCredentials(credentials);
    const { fetchImpl } = fakeFetch([errorEnvelope(401, "UNAUTHORIZED", "로그인이 필요합니다")]);

    await expect(runWhoami({ fetchImpl, log: vi.fn() })).rejects.toThrow("만료");
  });
});

describe("runLogout", () => {
  it("저장된_로그인_정보를_지운다", async () => {
    await saveCredentials(credentials);
    const log = vi.fn();

    expect(await runLogout(log)).toBe(true);

    expect(await findCredentials()).toBeNull();
    expect(log).toHaveBeenCalledWith("로그아웃했습니다.");
  });

  it("이미_로그아웃_상태여도_오류_없이_끝난다", async () => {
    const log = vi.fn();

    expect(await runLogout(log)).toBe(false);
    expect(log).toHaveBeenCalledWith("이미 로그아웃된 상태입니다.");
  });
});
