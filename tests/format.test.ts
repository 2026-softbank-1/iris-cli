import { describe, expect, it } from "vitest";
import {
  formatSeconds,
  formatTable,
  formatTimestampNs,
  parseDuration,
  shortSha,
} from "../src/lib/format.js";

describe("parseDuration", () => {
  it("단위별로_밀리초로_바꾼다", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
  });

  it("형식이_틀리면_예시와_함께_오류", () => {
    expect(() => parseDuration("1w")).toThrow("30m");
    expect(() => parseDuration("abc")).toThrow("기간 형식");
  });
});

describe("formatTimestampNs", () => {
  it("나노초를_UTC_ISO_로_바꾼다", () => {
    expect(formatTimestampNs("1790812800123456789")).toBe("2026-10-01T00:00:00.123Z");
  });
});

describe("formatSeconds", () => {
  it("크기에_따라_s_와_m_s_로_쓴다", () => {
    expect(formatSeconds(3.6)).toBe("3.6s");
    expect(formatSeconds(18)).toBe("18s");
    expect(formatSeconds(70)).toBe("1m10s");
  });
});

describe("shortSha", () => {
  it("앞_7자리만_남긴다", () => {
    expect(shortSha("446917d0123456789")).toBe("446917d");
  });

  it("Git_SHA_40자리는_앞_7자리만_남긴다", () => {
    expect(shortSha("446917d0123456789abcdef0123456789abcdef0")).toBe("446917d");
  });

  it("upload_로_시작하는_값은_전체를_보여_준다", () => {
    expect(shortSha("upload-46cce13380d1")).toBe("upload-46cce13380d1");
  });

  it("값이_없으면_빈_문자열_그대로", () => {
    expect(shortSha("")).toBe("");
  });
});

describe("formatTable", () => {
  it("한글을_두_칸으로_세어_열을_맞추고_마지막_열은_채우지_않는다", () => {
    expect(
      formatTable([
        ["이름", "상태", "키"],
        ["home-lab", "연결 중", "k3x9q2ma"],
        ["a", "대기", "-"],
      ]),
    ).toEqual(["이름      상태     키", "home-lab  연결 중  k3x9q2ma", "a         대기     -"]);
  });
});
