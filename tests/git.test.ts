import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findGitOrigin } from "../src/lib/git.js";
import { useTempCwd } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cwd = useTempCwd();

describe("findGitOrigin", () => {
  it("git_저장소의_origin_주소를_돌려준다", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: cwd() });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/octocat/hello.git"], { cwd: cwd() });

    expect(await findGitOrigin(cwd())).toBe("https://github.com/octocat/hello.git");
  });

  it("git_저장소가_아니면_undefined", async () => {
    expect(await findGitOrigin(cwd())).toBeUndefined();
  });
});
