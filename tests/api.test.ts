import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/lib/api.js";
import { ApiError } from "../src/lib/errors.js";
import { errorEnvelope, fakeFetch, tooManyRequests } from "./helpers.js";

async function failureOf(response: Response): Promise<ApiError> {
  const { fetchImpl } = fakeFetch([response]);
  const error = await new ApiClient("https://api.example.test", fetchImpl)
    .request("GET", "/anything")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("ApiClient 의 Retry-After", () => {
  it("초_단위_숫자를_오류에_담는다", async () => {
    const error = await failureOf(tooManyRequests("7"));

    expect(error.status).toBe(429);
    expect(error.code).toBe("TOO_MANY_REQUESTS");
    expect(error.retryAfterSeconds).toBe(7);
  });

  it.each([["없으면", undefined], ["날짜_형식이면", "Wed, 21 Oct 2026 07:28:00 GMT"], ["숫자가_아니면", "soon"]])(
    "%s_비워_둔다",
    async (_name, header) => {
      const error = await failureOf(tooManyRequests(header));

      expect(error.retryAfterSeconds).toBeUndefined();
    },
  );

  it("429_가_아닌_실패에는_헤더가_없으므로_비어_있다", async () => {
    const error = await failureOf(errorEnvelope(503, "NOT_CONFIGURED", "설정 없음"));

    expect(error.retryAfterSeconds).toBeUndefined();
  });
});

describe("ApiClient 의 본문 없는 응답과 검증 실패", () => {
  it("204_는_봉투_없이_성공으로_본다", async () => {
    const { fetchImpl } = fakeFetch([new Response(null, { status: 204 })]);

    await expect(new ApiClient("https://api.example.test", fetchImpl).request("DELETE", "/x")).resolves.toBeUndefined();
  });

  it("검증_실패의_details_를_오류에_담는다", async () => {
    const error = await failureOf(
      new Response(
        JSON.stringify({
          success: false,
          code: "VALIDATION_ERROR",
          message: "request validation failed",
          details: [{ field: "name", reason: "too long" }],
        }),
        { status: 422 },
      ),
    );

    expect(error.details).toEqual([{ field: "name", reason: "too long" }]);
  });
});
