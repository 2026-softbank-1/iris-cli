import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import ignore, { type Ignore } from "ignore";
import { create } from "tar";
import { CliError } from "./errors.js";
import { formatBytes } from "./format.js";

/** 서버의 소스 스냅샷 한도와 같다. */
export const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

// 시크릿이 든 .env 는 기본으로 뺀다. 필요하면 .likelionignore 에 `!.env` 로 다시 넣는다.
const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  ".likelion/",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
];

export interface Archive {
  /** 임시 폴더의 tar.gz 경로 */
  path: string;
  sizeBytes: number;
  sha256: string;
  fileCount: number;
  /** 아카이브 밖을 가리켜 뺀 심볼릭 링크 */
  skippedSymlinks: string[];
  /** 임시 파일을 지운다 */
  cleanup: () => Promise<void>;
}

/**
 * 폴더를 tar.gz 로 묶는다. 루트의 `.gitignore`·`.likelionignore` 를 따르고,
 * 아카이브 밖을 가리키는 심볼릭 링크는 빼며, 한도를 넘으면 묶는 도중에 멈춘다.
 */
export async function createArchive(
  root: string,
  options: { maxBytes?: number } = {},
): Promise<Archive> {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const matcher = await loadIgnore(root);
  const { files, skippedSymlinks } = await collectFiles(root, matcher);
  if (files.length === 0) {
    throw new CliError(
      "올릴 파일이 없습니다. .gitignore·.likelionignore 로 모두 제외된 것은 아닌지 확인해 주세요.",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "likelion-up-"));
  const path = join(dir, "source.tar.gz");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const pack = create({ gzip: true, cwd: root, portable: true }, files);
    pack.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        pack.destroy(
          new CliError(
            `압축한 소스가 한도(${formatBytes(maxBytes)})를 넘습니다. .likelionignore 로 큰 파일을 제외해 주세요.`,
          ),
        );
      }
    });
    await pipeline(pack, createWriteStream(path));
    return { path, sizeBytes, sha256: hash.digest("hex"), fileCount: files.length, skippedSymlinks, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function loadIgnore(root: string): Promise<Ignore> {
  const matcher = ignore().add(DEFAULT_IGNORES);
  for (const name of [".gitignore", ".likelionignore"]) {
    try {
      matcher.add(await readFile(join(root, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return matcher;
}

async function collectFiles(
  root: string,
  matcher: Ignore,
): Promise<{ files: string[]; skippedSymlinks: string[] }> {
  const files: string[] = [];
  const skippedSymlinks: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relativeDir ? posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        // git 처럼 제외된 폴더는 안으로 들어가지 않는다.
        if (!matcher.ignores(`${path}/`)) await walk(path);
      } else if (entry.isSymbolicLink()) {
        if (matcher.ignores(path)) continue;
        if (await staysInside(root, path)) files.push(path);
        else skippedSymlinks.push(path);
      } else if (entry.isFile() && !matcher.ignores(path)) {
        files.push(path);
      }
    }
  }

  await walk("");
  return { files, skippedSymlinks };
}

/** 링크가 상대 경로이고 루트 안에 머무는지. 절대 경로·루트 밖을 가리키면 false. */
async function staysInside(root: string, linkPath: string): Promise<boolean> {
  const target = await readlink(join(root, linkPath));
  if (isAbsolute(target)) return false;
  const outside = relative(root, resolve(root, dirname(linkPath), target));
  return outside !== ".." && !outside.startsWith(`..${sep}`) && !isAbsolute(outside);
}
