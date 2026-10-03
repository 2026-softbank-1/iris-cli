import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { list } from "tar";
import { describe, expect, it } from "vitest";
import { createArchive } from "../src/lib/archive.js";
import { useTempCwd } from "./helpers.js";

const root = useTempCwd();

async function write(relativePath: string, content = "x"): Promise<void> {
  const path = join(root(), relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function entriesOf(archivePath: string): Promise<string[]> {
  const names: string[] = [];
  await list({ file: archivePath, onReadEntry: (entry) => void names.push(entry.path) });
  return names.sort();
}

describe("createArchive", () => {
  it("기본_제외_목록과_gitignore_likelionignore_를_따른다", async () => {
    await write("src/app.js");
    await write("README.md");
    await write("node_modules/dep/index.js");
    await write(".git/config");
    await write(".likelion/link.json");
    await write(".env", "SECRET=1");
    await write(".env.local", "SECRET=2");
    await write(".env.example", "SECRET=");
    await write("debug.log");
    await write("dist/out.js");
    await write(".gitignore", "*.log\n");
    await write(".likelionignore", "dist/\n");

    const archive = await createArchive(root());
    try {
      expect(await entriesOf(archive.path)).toEqual([
        ".env.example",
        ".gitignore",
        ".likelionignore",
        "README.md",
        "src/app.js",
      ]);
      expect(archive.fileCount).toBe(5);
    } finally {
      await archive.cleanup();
    }
  });

  it("likelionignore_의_부정_패턴으로_env_를_다시_넣을_수_있다", async () => {
    await write("app.js");
    await write(".env", "SECRET=1");
    await write(".likelionignore", "!.env\n");

    const archive = await createArchive(root());
    try {
      expect(await entriesOf(archive.path)).toContain(".env");
    } finally {
      await archive.cleanup();
    }
  });

  it("크기와_sha256_이_만든_파일과_일치하고_gzip_이다", async () => {
    await write("app.js", "console.log('hi')");

    const archive = await createArchive(root());
    try {
      const bytes = await readFile(archive.path);
      expect(archive.sizeBytes).toBe(bytes.length);
      expect(archive.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    } finally {
      await archive.cleanup();
    }
  });

  it("폴더_안을_가리키는_심볼릭_링크는_넣고_밖을_가리키면_뺀다", async () => {
    await write("real.txt");
    await symlink("real.txt", join(root(), "inside-link"));
    await symlink("/etc/hosts", join(root(), "absolute-link"));
    await symlink("../outside", join(root(), "escape-link"));

    const archive = await createArchive(root());
    try {
      expect(await entriesOf(archive.path)).toEqual(["inside-link", "real.txt"]);
      expect(archive.skippedSymlinks.sort()).toEqual(["absolute-link", "escape-link"]);
    } finally {
      await archive.cleanup();
    }
  });

  it("올릴_파일이_하나도_없으면_안내한다", async () => {
    await write("node_modules/dep/index.js");

    await expect(createArchive(root())).rejects.toThrow("올릴 파일이 없습니다");
  });

  it("한도를_넘으면_묶는_도중에_멈추고_임시_파일을_지운다", async () => {
    await write("big.bin", "a".repeat(200_000));
    await write("big2.bin", Array.from({ length: 50_000 }, (_, i) => String(i * 7919)).join(","));

    await expect(createArchive(root(), { maxBytes: 100 })).rejects.toThrow("한도");
  });

  it("cleanup_이_임시_파일을_지운다", async () => {
    await write("app.js");
    const archive = await createArchive(root());

    await archive.cleanup();

    await expect(stat(archive.path)).rejects.toThrow();
  });
});
