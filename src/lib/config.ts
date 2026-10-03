import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.likelion.uk";

export interface Credentials {
  apiUrl: string;
  token: string;
  user: { id: number; login: string };
}

function configDir(): string {
  if (process.env.ANYDEPLOY_CONFIG_DIR) return process.env.ANYDEPLOY_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "anydeploy");
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
  const url = option ?? process.env.ANYDEPLOY_API_URL ?? DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
