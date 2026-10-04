import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const SKILL_NAME = "likelion";

/**
 * 에이전트용 스킬 파일(`skills/likelion/SKILL.md`)의 내용. 저장소의 이 파일이 유일한 원본이라
 * `npx skills add 2026-softbank-1/iris-cli` 와 `likelion setup agent` 가 같은 내용을 설치한다.
 * 이 모듈에서 위로 올라가며 찾으므로 설치된 패키지(`dist/`)와 개발 중(`src/lib/`) 모두 된다.
 */
export async function readSkill(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      return await readFile(join(dir, "skills", SKILL_NAME, "SKILL.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CliError("스킬 파일(skills/likelion/SKILL.md)을 찾을 수 없습니다. 설치가 손상되었습니다. 다시 설치해 주세요.");
    }
    dir = parent;
  }
}
