import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 폴더의 git `origin` 주소. git 이 없거나 저장소가 아니거나 origin 이 없으면 undefined. */
export async function findGitOrigin(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
