import { describe, expect, it, vi } from "vitest";
import { matchByIdOrName, pickOne } from "../src/lib/prompt.js";

const items = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
];

const base = { label: "프로젝트", flag: "--project", log: vi.fn() };

describe("matchByIdOrName", () => {
  it("숫자는_id_로_이름은_이름으로_찾는다", () => {
    expect(matchByIdOrName(items, "2")?.name).toBe("beta");
    expect(matchByIdOrName(items, "alpha")?.id).toBe(1);
    expect(matchByIdOrName(items, "9")).toBeUndefined();
  });

  it("숫자_이름도_id_가_없으면_이름으로_찾는다", () => {
    expect(matchByIdOrName([{ id: 1, name: "2024" }], "2024")?.id).toBe(1);
  });
});

describe("pickOne", () => {
  it("옵션_값으로_고른다", async () => {
    const picked = await pickOne(items, { ...base, value: "beta", ask: undefined });

    expect(picked.id).toBe(2);
  });

  it("옵션_값이_없는_항목이면_가능한_값을_알려_준다", async () => {
    await expect(pickOne(items, { ...base, value: "zeta", ask: undefined })).rejects.toThrow(
      "alpha(1), beta(2)",
    );
  });

  it("하나뿐이면_묻지_않고_고른다", async () => {
    const ask = vi.fn();

    const picked = await pickOne(items.slice(0, 1), { ...base, value: undefined, ask });

    expect(picked.name).toBe("alpha");
    expect(ask).not.toHaveBeenCalled();
  });

  it("여러_개면_번호를_물어_고른다", async () => {
    const ask = vi.fn(async () => "2");

    const picked = await pickOne(items, { ...base, value: undefined, ask });

    expect(picked.name).toBe("beta");
    expect(ask).toHaveBeenCalledWith("프로젝트 번호: ");
  });

  it("잘못된_번호는_오류", async () => {
    await expect(
      pickOne(items, { ...base, value: undefined, ask: async () => "7" }),
    ).rejects.toThrow("잘못된 선택");
  });

  it("대화형이_아니고_옵션도_없으면_옵션을_안내한다", async () => {
    await expect(pickOne(items, { ...base, value: undefined, ask: undefined })).rejects.toThrow(
      "--project",
    );
  });

  it("목록이_비어_있으면_오류", async () => {
    await expect(pickOne([], { ...base, value: undefined, ask: undefined })).rejects.toThrow(
      "비어 있습니다",
    );
  });
});
