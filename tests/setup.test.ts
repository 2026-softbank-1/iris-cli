import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import { runSetupAgent, type SetupAgentOptions } from "../src/commands/setup.js";
import { readSkill } from "../src/lib/skill.js";
import { useTempCwd } from "./helpers.js";

const cwd = useTempCwd();
const base: SetupAgentOptions = { print: false, global: false, force: false };

describe("runSetupAgent", () => {
  it("print_는_파일을_쓰지_않고_스킬_내용을_낸다", async () => {
    const log = vi.fn();

    const result = await runSetupAgent({ ...base, print: true }, { cwd: cwd(), log });

    expect(result).toBeUndefined();
    expect(log.mock.calls[0]?.[0]).toBe((await readSkill()).trimEnd());
    await expect(stat(join(cwd(), ".claude"))).rejects.toThrow();
  });

  it("기본은_현재_폴더의_claude_skills_에_설치한다", async () => {
    const log = vi.fn();

    const result = await runSetupAgent(base, { cwd: cwd(), log });

    const path = join(cwd(), ".claude", "skills", "likelion", "SKILL.md");
    expect(result).toEqual({ path, status: "created" });
    expect(await readFile(path, "utf8")).toBe(await readSkill());
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("설치했습니다");
  });

  it("global_은_홈의_claude_skills_에_설치한다", async () => {
    const result = await runSetupAgent({ ...base, global: true }, { cwd: cwd(), home: join(cwd(), "home"), log: vi.fn() });

    expect(result?.path).toBe(join(cwd(), "home", ".claude", "skills", "likelion", "SKILL.md"));
  });

  it("dir_로_다른_에이전트의_스킬_폴더를_고른다", async () => {
    const result = await runSetupAgent({ ...base, dir: ".agents/skills" }, { cwd: cwd(), log: vi.fn() });

    expect(result?.path).toBe(join(cwd(), ".agents", "skills", "likelion", "SKILL.md"));
  });

  it("같은_내용이면_그대로_두고_다르면_force_없이는_덮어쓰지_않는다", async () => {
    await runSetupAgent(base, { cwd: cwd(), log: vi.fn() });
    expect((await runSetupAgent(base, { cwd: cwd(), log: vi.fn() }))?.status).toBe("unchanged");

    const path = join(cwd(), ".claude", "skills", "likelion", "SKILL.md");
    await writeFile(path, "내가 고친 내용");
    await expect(runSetupAgent(base, { cwd: cwd(), log: vi.fn() })).rejects.toThrow("--force");
    expect(await readFile(path, "utf8")).toBe("내가 고친 내용");

    const forced = await runSetupAgent({ ...base, force: true }, { cwd: cwd(), log: vi.fn() });
    expect(forced?.status).toBe("updated");
    expect(await readFile(path, "utf8")).toBe(await readSkill());
  });

  it("json_이면_결과를_JSON_으로_낸다", async () => {
    const log = vi.fn();

    await runSetupAgent({ ...base, json: true }, { cwd: cwd(), log });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({ status: "created" });
  });

  it("다른_폴더가_이미_있어도_만들어_쓴다", async () => {
    await mkdir(join(cwd(), ".claude", "skills", "other"), { recursive: true });

    const result = await runSetupAgent(base, { cwd: cwd(), log: vi.fn() });

    expect(result?.status).toBe("created");
  });
});

describe("skills/likelion/SKILL.md", () => {
  it("에이전트_스킬_규격의_frontmatter_와_길이_제한을_지킨다", async () => {
    const skill = await readSkill();

    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(match).not.toBeNull();
    const frontmatter = match?.[1] ?? "";
    const name = /^name: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(name).toBe("likelion");
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });

  it("CLI_의_모든_최상위_명령을_언급한다", async () => {
    const skill = await readSkill();
    const names = buildProgram().commands.map((command) => command.name());

    const missing = names.filter((name) => !skill.includes(name));

    expect(missing).toEqual([]);
  });

  it("본문과_표에_적은_명령은_모두_실제_명령이다", async () => {
    const skill = await readSkill();
    const names = new Set(buildProgram().commands.map((command) => command.name()));
    // `likelion <명령>` 으로 적은 곳(본문·코드 블록·표)과 표 첫 열의 `<명령> …` 을 모은다.
    const mentioned = [
      ...[...skill.matchAll(/likelion ([a-z][a-z-]*)/g)].map((match) => match[1]),
      ...[...skill.matchAll(/^\| `([a-z][a-z-]*)[ `|]/gm)].map((match) => match[1]),
    ].filter((name): name is string => name !== undefined);

    const unknown = [...new Set(mentioned)].filter((name) => !names.has(name));

    expect(unknown).toEqual([]);
  });

  it("문서에_적은_명령과_옵션이_실제로_있다", async () => {
    const skill = await readSkill();
    const program = buildProgram();
    const top = new Map(program.commands.map((command) => [command.name(), command]));
    // 코드 블록·표에서 `likelion <명령> …` 으로 시작하는 예시를 모아 명령이 존재하는지 본다.
    const invoked = [...skill.matchAll(/^\s*likelion ([a-z]+)(?: ([a-z]+))?/gm)];
    const unknown = invoked
      .filter(([, name]) => !top.has(name ?? ""))
      .map(([line]) => line.trim());

    expect(unknown).toEqual([]);
    // 옵션은 해당 명령에 실제로 정의된 것만 적는다.
    const flags = [...skill.matchAll(/^\s*likelion ([a-z]+)[^\n#]*?(--[a-z-]+)/gm)];
    const undefinedFlags = flags
      .filter(([, name, flag]) => {
        const command = top.get(name ?? "");
        if (!command) return false;
        const known = [command, ...command.commands].flatMap((c) => c.options.map((option) => option.long));
        return !known.includes(flag);
      })
      .map(([line]) => line.trim());

    expect(undefinedFlags).toEqual([]);
  });
});

describe("buildProgram 오류 연결", () => {
  const parse = (...args: string[]) =>
    buildProgram({ quietParseErrors: true }).parseAsync(["node", "likelion", ...args]);

  it("빠진_인자와_모르는_옵션은_commander_오류로_던져_종료_코드를_정할_수_있다", async () => {
    await expect(parse("rollback")).rejects.toMatchObject({ code: "commander.missingArgument", exitCode: 1 });
    await expect(parse("status", "--nope")).rejects.toMatchObject({ code: "commander.unknownOption" });
  });

  it("help_는_종료_코드_0_으로_던진다", async () => {
    const program = buildProgram({ quietParseErrors: true }).configureOutput({ writeOut: () => {}, writeErr: () => {} });

    await expect(program.parseAsync(["node", "likelion", "--help"])).rejects.toMatchObject({ exitCode: 0 });
  });
});
