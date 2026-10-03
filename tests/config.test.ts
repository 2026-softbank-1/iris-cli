import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  credentialsPath,
  deleteCredentials,
  findCredentials,
  resolveApiUrl,
  saveCredentials,
} from "../src/lib/config.js";
import { useTempConfigDir } from "./helpers.js";

useTempConfigDir();

const credentials = {
  apiUrl: "https://api.example.test",
  token: "jwt-token",
  user: { id: 1, login: "octocat" },
};

describe("credentials", () => {
  it("find_저장된_값이_없으면_null", async () => {
    expect(await findCredentials()).toBeNull();
  });

  it("save_저장한_값을_그대로_읽고_파일은_본인만_읽는다", async () => {
    await saveCredentials(credentials);

    expect(await findCredentials()).toEqual(credentials);
    expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
  });

  it("delete_있었으면_true_없으면_false", async () => {
    await saveCredentials(credentials);

    expect(await deleteCredentials()).toBe(true);
    expect(await deleteCredentials()).toBe(false);
    expect(await findCredentials()).toBeNull();
  });
});

describe("resolveApiUrl", () => {
  it("옵션이_환경변수보다_우선하고_끝_슬래시는_뗀다", () => {
    process.env.ANYDEPLOY_API_URL = "https://from-env.test";
    try {
      expect(resolveApiUrl("https://from-option.test/")).toBe("https://from-option.test");
      expect(resolveApiUrl(undefined)).toBe("https://from-env.test");
    } finally {
      delete process.env.ANYDEPLOY_API_URL;
    }
  });

  it("아무것도_없으면_기본_주소", () => {
    expect(resolveApiUrl(undefined)).toBe("https://api.likelion.uk");
  });
});
