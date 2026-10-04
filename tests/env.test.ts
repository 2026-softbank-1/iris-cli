import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type EnvDeps,
  formatEnvLine,
  runEnvList,
  runEnvPull,
  runEnvPush,
  runEnvSet,
  runEnvUnset,
} from "../src/commands/env.js";
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

const vars = (variables: { key: string; value: string }[], systemVariables: unknown[] = []) =>
  envelope({ variables, systemVariables });
const noContent = () => new Response(null, { status: 204 });

async function setup(responses: (Response | Error)[], ask?: EnvDeps["ask"]) {
  await loginAs();
  await linkTo(cwd());
  const { fetchImpl, calls } = fakeFetch(responses);
  const log = vi.fn();
  const warn = vi.fn();
  const deps: EnvDeps = { fetchImpl, cwd: cwd(), log, warn, ask };
  const lines = () => log.mock.calls.map(([line]) => line as string);
  return { calls, log, warn, lines, deps };
}

describe("formatEnvLine", () => {
  it("단순한_값은_그대로_두고_특수문자가_있으면_JSON_이스케이프로_감싼다", () => {
    expect(formatEnvLine("A", "plain-value_1.0")).toBe("A=plain-value_1.0");
    expect(formatEnvLine("A", "")).toBe("A=");
    expect(formatEnvLine("A", "a b")).toBe('A="a b"');
    expect(formatEnvLine("A", "line1\nline2")).toBe('A="line1\\nline2"');
    expect(formatEnvLine("A", 'say "hi"')).toBe('A="say \\"hi\\""');
    expect(formatEnvLine("A", "a=b")).toBe('A="a=b"');
  });
});

describe("runEnvList", () => {
  // Response 본문은 한 번만 읽을 수 있어 테스트마다 새로 만든다.
  const response = () =>
    vars(
      [
        { key: "DATABASE_URL", value: "postgres://secret" },
        { key: "EMPTY", value: "" },
      ],
      [{ key: "PORT", description: "앱이 들을 포트", value: "8080" }, { key: "IRIS_RELEASE_ID", description: "릴리스 id" }],
    );

  it("기본은_값을_숨기고_길이만_보여_준다", async () => {
    const t = await setup([response()]);

    await runEnvList({ showValues: false }, t.deps);

    expect(t.lines()).toEqual([
      "환경변수 2개 (값은 숨김, --show-values 로 보기)",
      "DATABASE_URL  (값 17자)",
      "EMPTY  (빈 값)",
      "",
      "플랫폼이 넣는 변수 (바꿀 수 없음)",
      "PORT=8080  앱이 들을 포트",
      "IRIS_RELEASE_ID  릴리스 id",
    ]);
    expect(t.lines().join("\n")).not.toContain("secret");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/api/v1/services/3/variables");
  });

  it("show_values_면_값까지_보여_준다", async () => {
    const t = await setup([response()]);

    await runEnvList({ showValues: true }, t.deps);

    expect(t.lines()[1]).toBe("DATABASE_URL=postgres://secret");
  });

  it("json_은_show_values_가_없으면_값을_빼고_있으면_포함한다", async () => {
    const hidden = await setup([response()]);
    await runEnvList({ showValues: false, json: true }, hidden.deps);
    expect(JSON.parse(hidden.lines()[0] ?? "").variables).toEqual([{ key: "DATABASE_URL" }, { key: "EMPTY" }]);
    expect(hidden.lines()[0]).not.toContain("secret");
  });

  it("json_에_show_values_를_주면_값을_포함한다", async () => {
    const shown = await setup([response()]);
    await runEnvList({ showValues: true, json: true }, shown.deps);
    expect(JSON.parse(shown.lines()[0] ?? "").variables[0]).toEqual({ key: "DATABASE_URL", value: "postgres://secret" });
  });

  it("변수가_없으면_set_을_안내한다", async () => {
    const t = await setup([vars([])]);

    await runEnvList({ showValues: false }, t.deps);

    expect(t.lines()[0]).toContain("likelion env set");
  });

  it("서버에_암호화_키가_없으면_운영자_문의를_안내한다", async () => {
    const t = await setup([errorEnvelope(503, "NOT_CONFIGURED", "no key")]);

    await expect(runEnvList({ showValues: false }, t.deps)).rejects.toThrow("암호화 키");
  });
});

describe("runEnvSet", () => {
  it("새_변수는_추가하고_이미_있으면_값을_수정한다", async () => {
    const t = await setup([
      envelope({ key: "A", value: "1" }, { status: 201 }),
      errorEnvelope(409, "VARIABLE_CONFLICT", "exists"),
      envelope({ key: "B", value: "x=y" }),
    ]);

    await runEnvSet({ assignments: ["A=1", "B=x=y"] }, t.deps);

    expect(t.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /api/v1/services/3/variables",
      "POST /api/v1/services/3/variables",
      "PUT /api/v1/services/3/variables/B",
    ]);
    expect(t.calls[0]?.body).toEqual({ key: "A", value: "1" });
    expect(t.calls[2]?.body).toEqual({ value: "x=y" });
    expect(t.lines()).toEqual(["추가: A", "수정: B", expect.stringContaining("likelion redeploy")]);
  });

  it("KEY=VALUE_형식이_아니면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(runEnvSet({ assignments: ["A=1", "NOVALUE"] }, t.deps)).rejects.toThrow("KEY=VALUE");
    await expect(runEnvSet({ assignments: ["=v"] }, t.deps)).rejects.toThrow("이름이 없음");
    expect(t.calls).toHaveLength(0);
  });

  it("서버가_예약어를_거절하면_사유를_보여_주고_값은_싣지_않는다", async () => {
    const reject = new Response(
      JSON.stringify({ success: false, code: "INVALID_INPUT", message: "invalid", details: [{ field: "key", reason: "reserved key PORT" }] }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
    const t = await setup([reject]);

    const failure = runEnvSet({ assignments: ["PORT=secret-value"] }, t.deps);

    await expect(failure).rejects.toThrow("reserved key PORT");
    await expect(failure).rejects.not.toThrow("secret-value");
  });

  it("중간에_실패하면_이미_적용된_변수를_알린다", async () => {
    const t = await setup([envelope({ key: "A", value: "1" }, { status: 201 }), errorEnvelope(500, "INTERNAL", "boom")]);

    await expect(runEnvSet({ assignments: ["A=1", "B=2"] }, t.deps)).rejects.toThrow("이미 적용된 변수: A");
  });
});

describe("runEnvUnset", () => {
  it("변수를_지우고_없는_이름이_있으면_나머지를_지운_뒤_실패로_끝낸다", async () => {
    const t = await setup([noContent(), errorEnvelope(404, "VARIABLE_NOT_FOUND", "none"), noContent()]);

    const failure = runEnvUnset({ keys: ["A", "NOPE", "B"] }, t.deps);

    await expect(failure).rejects.toThrow("없는 변수입니다: NOPE");
    await expect(failure).rejects.toThrow("나머지 2개는 삭제했습니다");
    expect(t.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "DELETE /api/v1/services/3/variables/A",
      "DELETE /api/v1/services/3/variables/NOPE",
      "DELETE /api/v1/services/3/variables/B",
    ]);
    expect(t.lines()).toEqual(["삭제: A", "삭제: B", expect.stringContaining("likelion restart")]);
  });
});

describe("runEnvPull", () => {
  it("변수를_파일로_저장하고_값은_화면에_찍지_않는다", async () => {
    const t = await setup([vars([{ key: "A", value: "1" }, { key: "B", value: "a b" }])]);

    const path = await runEnvPull({ force: false }, t.deps);

    expect(path).toBe(join(cwd(), ".env"));
    expect(await readFile(path, "utf8")).toBe('A=1\nB="a b"\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(t.lines().join("\n")).not.toContain("a b");
    expect(t.lines()[0]).toContain("2개");
  });

  it("이미_있는_파일은_force_없이_덮어쓰지_않고_서버도_부르지_않는다", async () => {
    const t = await setup([]);
    await writeFile(join(cwd(), ".env"), "KEEP=1\n");

    await expect(runEnvPull({ force: false }, t.deps)).rejects.toThrow("--force");
    expect(t.calls).toHaveLength(0);
    expect(await readFile(join(cwd(), ".env"), "utf8")).toBe("KEEP=1\n");
  });

  it("force_면_덮어쓰고_권한도_0600_으로_맞춘다", async () => {
    const t = await setup([vars([{ key: "A", value: "1" }])]);
    await mkdir(join(cwd(), "sub"));
    await writeFile(join(cwd(), "sub", "prod.env"), "OLD=1\n", { mode: 0o644 });

    await runEnvPull({ file: "sub/prod.env", force: true }, t.deps);

    expect(await readFile(join(cwd(), "sub", "prod.env"), "utf8")).toBe("A=1\n");
    expect((await stat(join(cwd(), "sub", "prod.env"))).mode & 0o777).toBe(0o600);
  });
});

describe("runEnvPush", () => {
  const before = () => vars([{ key: "KEEP", value: "1" }, { key: "OLD", value: "x" }, { key: "CHG", value: "a" }]);
  const after = () => vars([{ key: "KEEP", value: "1" }, { key: "CHG", value: "b" }, { key: "NEW", value: "n" }]);

  it("yes_면_파일_내용을_Raw_로_보내_전체를_교체하고_추가_변경_삭제를_알린다", async () => {
    const t = await setup([before(), after()]);
    await writeFile(join(cwd(), ".env"), 'KEEP=1\nCHG=b\nNEW=n\n');

    await runEnvPush({ yes: true }, t.deps);

    expect(t.calls[1]?.method).toBe("PUT");
    expect(t.calls[1]?.body).toEqual({ raw: "KEEP=1\nCHG=b\nNEW=n\n" });
    expect(t.lines()[0]).toBe("환경변수를 올렸습니다: 추가 1 · 변경 1 · 삭제 1 (총 3개)");
    expect(t.lines()).toContain("추가: NEW");
    expect(t.lines()).toContain("변경: CHG");
    expect(t.lines()).toContain("삭제: OLD");
    expect(t.warn).toHaveBeenCalledWith("파일에 없던 변수는 삭제되었습니다.");
  });

  it("yes_도_ask_도_없으면_전체_교체를_하지_않고_멈춘다", async () => {
    const t = await setup([before()]);
    await writeFile(join(cwd(), ".env"), "A=1\n");

    await expect(runEnvPush({ yes: false }, t.deps)).rejects.toMatchObject({ exitCode: 2, code: "USAGE" });
    expect(t.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("확인에서_아니라고_하면_올리지_않는다", async () => {
    const ask = vi.fn(async () => "n");
    const t = await setup([before()], ask);
    await writeFile(join(cwd(), ".env"), "A=1\n");

    await runEnvPush({ yes: false }, t.deps);

    expect(ask).toHaveBeenCalledWith(expect.stringContaining("3개를"));
    expect(t.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(t.lines()).toContain("올리지 않았습니다.");
  });

  it("파일이_없으면_서버를_부르기_전에_멈춘다", async () => {
    const t = await setup([]);

    await expect(runEnvPush({ yes: true }, t.deps)).rejects.toThrow("파일이 없습니다");
    expect(t.calls).toHaveLength(0);
  });

  it("서버가_형식을_거절하면_사유를_보여_준다", async () => {
    const reject = new Response(
      JSON.stringify({ success: false, code: "INVALID_INPUT", message: "invalid raw", details: [{ field: "raw", reason: "line 2: reserved key PORT" }] }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
    const t = await setup([before(), reject]);
    await writeFile(join(cwd(), ".env"), "A=1\nPORT=1\n");

    await expect(runEnvPush({ yes: true }, t.deps)).rejects.toThrow("line 2: reserved key PORT");
  });
});
