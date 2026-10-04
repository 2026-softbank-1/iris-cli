import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.likelion.uk";

export interface Credentials {
  apiUrl: string;
  token: string;
  /** `login` 으로 저장한 로그인 정보에만 있다. `LIKELION_TOKEN` 으로 쓸 때는 알 수 없다 */
  user?: { id: number; login: string };
}

function configDir(): string {
  if (process.env.LIKELION_CONFIG_DIR) return process.env.LIKELION_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "likelion");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export async function findCredentials(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8")) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 환경변수 `LIKELION_TOKEN`. 있으면 저장된 로그인보다 먼저 쓴다(CI·에이전트용). */
export function envToken(): string | undefined {
  return process.env.LIKELION_TOKEN?.trim() || undefined;
}

/**
 * 지금 쓸 인증 정보. `LIKELION_TOKEN` 이 있으면 그 토큰을(서버 주소는 `LIKELION_API_URL` 이나 기본값),
 * 없으면 `login` 으로 저장한 정보를 쓴다.
 */
export async function findActiveCredentials(): Promise<Credentials | null> {
  const token = envToken();
  if (token) return { apiUrl: resolveApiUrl(undefined), token };
  return findCredentials();
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** 저장된 자격 증명을 지운다. 있었으면 true. */
export async function deleteCredentials(): Promise<boolean> {
  const existed = (await findCredentials()) !== null;
  await rm(credentialsPath(), { force: true });
  return existed;
}

export function resolveApiUrl(option: string | undefined): string {
  const url = option ?? process.env.LIKELION_API_URL ?? DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
