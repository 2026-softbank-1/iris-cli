import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  AuthError,
  CliError,
  ConnectionError,
  EXIT,
  explainApiError,
  ResultError,
  UsageError,
} from "../src/lib/errors.js";
import { describeError, reportCommanderError, reportError, wantsJson } from "../src/lib/report.js";

describe("종료 코드", () => {
  it.each([
    [400, EXIT.FAILURE],
    [401, EXIT.AUTH],
    [403, EXIT.FAILURE],
    [404, EXIT.FAILURE],
    [409, EXIT.FAILURE],
    [422, EXIT.FAILURE],
    [429, EXIT.RETRYABLE],
    [500, EXIT.RETRYABLE],
    [503, EXIT.RETRYABLE],
  ])("HTTP_%i_는_종료_코드_%i", (status, exitCode) => {
    expect(new ApiError("x", status).exitCode).toBe(exitCode);
  });

  it("각_오류_종류의_종료_코드와_코드가_정해져_있다", () => {
    expect(new UsageError("x")).toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(new AuthError("x")).toMatchObject({ exitCode: 3, code: "UNAUTHENTICATED" });
    expect(new ResultError("x", "DEPLOYMENT_FAILED")).toMatchObject({ exitCode: 4, code: "DEPLOYMENT_FAILED" });
    expect(new ConnectionError("https://x")).toMatchObject({ exitCode: 5, code: "CONNECTION_FAILED" });
    expect(new CliError("x")).toMatchObject({ exitCode: 1, code: undefined });
  });

  it("explainApiError_는_메시지만_바꾸고_서버_코드와_종료_코드는_지킨다", () => {
    const explained = explainApiError(new ApiError("raw", 503, "NOT_CONFIGURED"), "운영자에게 문의");

    expect(explained).toMatchObject({
      message: "운영자에게 문의",
      code: "NOT_CONFIGURED",
      exitCode: EXIT.RETRYABLE,
      status: 503,
    });
  });
});

describe("describeError", () => {
  it("서버_오류는_코드_상태_재시도_정보를_담는다", () => {
    const error = new ApiError("너무 빠름", 429, "TOO_MANY_REQUESTS", 3, [{ field: "x", reason: "y" }]);

    expect(describeError(error)).toEqual({
      code: "TOO_MANY_REQUESTS",
      message: "너무 빠름",
      exitCode: 5,
      retryable: true,
      status: 429,
      retryAfterSeconds: 3,
      details: [{ field: "x", reason: "y" }],
    });
  });

  it("코드가_없는_오류는_종료_코드의_기본_코드를_쓴다", () => {
    expect(describeError(new CliError("x")).code).toBe("ERROR");
    expect(describeError(new UsageError("x")).code).toBe("USAGE");
    expect(describeError(new ConnectionError("u")).retryable).toBe(true);
    expect(describeError(new ResultError("x", "DEPLOYMENT_FAILED")).retryable).toBe(false);
  });
});

describe("reportError", () => {
  it("텍스트_모드는_메시지_한_줄을_내고_종료_코드를_돌려준다", () => {
    const write = vi.fn();

    expect(reportError(new UsageError("옵션이 틀렸습니다"), { json: false, write })).toBe(2);
    expect(write).toHaveBeenCalledWith("옵션이 틀렸습니다");
  });

  it("json_모드는_error_객체_한_줄을_낸다", () => {
    const write = vi.fn();

    expect(reportError(new ApiError("충돌", 409, "DEPLOYMENT_IN_PROGRESS"), { json: true, write })).toBe(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toEqual({
      error: { code: "DEPLOYMENT_IN_PROGRESS", message: "충돌", exitCode: 1, retryable: false, status: 409 },
    });
  });

  it("CLI_가_모르는_오류는_텍스트_모드에서는_돌려주지_않고_json_모드에서는_INTERNAL_로_낸다", () => {
    const write = vi.fn();

    expect(reportError(new TypeError("boom"), { json: false, write })).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(reportError(new TypeError("boom"), { json: true, write })).toBe(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string).error).toMatchObject({ code: "INTERNAL", message: "boom" });
  });
});

describe("wantsJson", () => {
  it("인자에_json_이_있으면_true_이고_의_뒤는_보지_않는다", () => {
    expect(wantsJson(["deployments", "--json"])).toBe(true);
    expect(wantsJson(["env", "set", "A=1"])).toBe(false);
    expect(wantsJson(["env", "set", "--", "--json"])).toBe(false);
  });
});

describe("reportCommanderError", () => {
  const usage = new CommanderError(1, "commander.missingArgument", "error: missing required argument 'deployment'");

  it("파싱_오류는_사용법_오류_2_이고_도움말_출력은_0_이다", () => {
    expect(reportCommanderError(usage, { json: false, write: vi.fn() })).toBe(2);
    expect(reportCommanderError(new CommanderError(0, "commander.helpDisplayed", "(outputHelp)"), { json: true })).toBe(0);
  });

  it("json_이면_commander_가_쓰지_못하게_막았으니_여기서_오류_JSON_을_한_번_낸다", () => {
    const write = vi.fn();

    reportCommanderError(usage, { json: true, write });

    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toEqual({
      error: { code: "USAGE", message: "missing required argument 'deployment'", exitCode: 2, retryable: false },
    });
  });
});
