import type { FetchLike } from "../lib/api.js";
import { printJson } from "../lib/output.js";
import { requireSession } from "../lib/session.js";

interface Me {
  id: number;
  login: string;
}

export interface WhoamiOptions {
  json?: boolean;
}

export interface WhoamiDeps {
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
}

/** 인증 토큰(저장된 로그인 또는 `LIKELION_TOKEN`)으로 서버에 현재 사용자를 물어 GitHub 계정을 보여 준다. */
export async function runWhoami(options: WhoamiOptions = {}, deps: WhoamiDeps = {}): Promise<Me> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const me = await api.request<Me>("GET", "/me", { token: credentials.token });
  if (options.json) {
    printJson({ ...me, apiUrl: credentials.apiUrl }, log);
    return me;
  }
  log(me.login);
  log(`API: ${credentials.apiUrl}`);
  return me;
}
