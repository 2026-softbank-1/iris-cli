import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../lib/errors.js";
import { printJson } from "../lib/output.js";
import { readSkill, SKILL_NAME } from "../lib/skill.js";

export interface SetupAgentOptions {
  /** 내용만 stdout 으로 낸다. 파일은 쓰지 않는다 */
  print: boolean;
  /** `~/.claude/skills` 에 설치한다. 아니면 현재 폴더의 `.claude/skills` */
  global: boolean;
  /** 스킬을 모아 두는 폴더. 지정하면 `<폴더>/likelion/SKILL.md` 에 쓴다 */
  dir?: string;
  /** 내용이 다른 파일을 덮어쓴다 */
  force: boolean;
  json?: boolean;
}

export interface SetupAgentDeps {
  cwd?: string;
  home?: string;
  log?: (message: string) => void;
}

export interface SetupAgentResult {
  path: string;
  status: "created" | "updated" | "unchanged";
}

/**
 * 에이전트(Claude Code 등)가 이 CLI 를 쓰는 법을 담은 `SKILL.md` 를 설치하거나(`--print` 면) 출력한다.
 * 파일은 `<스킬 폴더>/likelion/SKILL.md` 이고 스킬 폴더는 기본이 현재 폴더의 `.claude/skills` 다.
 */
export async function runSetupAgent(
  options: SetupAgentOptions,
  deps: SetupAgentDeps = {},
): Promise<SetupAgentResult | undefined> {
  const log = deps.log ?? console.log;
  const skill = await readSkill();
  if (options.print) {
    log(skill.trimEnd());
    return undefined;
  }

  const cwd = deps.cwd ?? process.cwd();
  const root = options.dir
    ? resolve(cwd, options.dir)
    : options.global
      ? join(deps.home ?? homedir(), ".claude", "skills")
      : join(cwd, ".claude", "skills");
  const path = join(root, SKILL_NAME, "SKILL.md");

  const existing = await readExisting(path);
  let result: SetupAgentResult;
  if (existing === skill) {
    result = { path, status: "unchanged" };
  } else if (existing !== undefined && !options.force) {
    throw new CliError(
      `이미 있고 내용이 다른 파일입니다: ${path}. 최신 내용으로 바꾸려면 --force 를 붙여 주세요.`,
    );
  } else {
    await mkdir(join(root, SKILL_NAME), { recursive: true });
    await writeFile(path, skill);
    result = { path, status: existing === undefined ? "created" : "updated" };
  }

  if (options.json) {
    printJson(result, log);
    return result;
  }
  log(
    result.status === "unchanged"
      ? `이미 최신입니다: ${path}`
      : `에이전트 스킬을 ${result.status === "created" ? "설치" : "갱신"}했습니다: ${path}`,
  );
  log("Claude Code 는 다음 세션부터 이 스킬을 씁니다. 다른 에이전트는 `--dir <스킬 폴더>` 로 설치하거나 `--print` 로 내용을 가져가세요.");
  return result;
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
