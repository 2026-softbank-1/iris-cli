import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Credentials } from "./config.js";
import { CliError } from "./errors.js";

const LINK_DIR = ".likelion";
const LINK_FILE = "link.json";

export interface Link {
  apiUrl: string;
  projectId: number;
  projectName: string;
  serviceId: number;
  serviceName: string;
}

export interface LinkLocation {
  link: Link;
  /** `.likelion` 이 들어 있는 폴더. `up` 이 이 폴더를 통째로 올린다. */
  dir: string;
}

/** 현재 폴더에서 위로 올라가며 연결 정보와 그 위치를 찾는다. 없으면 null. */
export async function findLinkLocation(startDir: string): Promise<LinkLocation | null> {
  let dir = resolve(startDir);
  for (;;) {
    const path = join(dir, LINK_DIR, LINK_FILE);
    try {
      return { link: JSON.parse(await readFile(path, "utf8")) as Link, dir };
    } catch (error) {
      if (error instanceof SyntaxError) throw new CliError(`연결 파일이 손상되었습니다: ${path}`);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 연결 정보를 저장한다. 폴더 안 `.gitignore` 로 커밋되지 않게 한다. */
export async function saveLink(dir: string, link: Link): Promise<string> {
  const folder = join(resolve(dir), LINK_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, ".gitignore"), "*\n");
  const path = join(folder, LINK_FILE);
  await writeFile(path, `${JSON.stringify(link, null, 2)}\n`);
  return path;
}

/** 현재 폴더에서 위로 올라가며 연결 정보를 찾는다. 없으면 null. */
export async function findLink(startDir: string): Promise<Link | null> {
  return (await findLinkLocation(startDir))?.link ?? null;
}

export async function requireLinkLocation(
  startDir: string,
  credentials: Credentials,
): Promise<LinkLocation> {
  const location = await findLinkLocation(startDir);
  if (!location) throw new CliError("연결된 서비스가 없습니다. `likelion link` 를 실행해 주세요.");
  if (location.link.apiUrl !== credentials.apiUrl) {
    throw new CliError(
      `이 폴더는 ${location.link.apiUrl} 에 연결돼 있는데 로그인은 ${credentials.apiUrl} 입니다. \`likelion link\` 를 다시 실행해 주세요.`,
    );
  }
  return location;
}

export async function requireLink(startDir: string, credentials: Credentials): Promise<Link> {
  return (await requireLinkLocation(startDir, credentials)).link;
}
