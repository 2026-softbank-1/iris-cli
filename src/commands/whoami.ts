import type { FetchLike } from "../lib/api.js";
import { requireSession } from "../lib/session.js";

interface Me {
  id: number;
  login: string;
}

export interface WhoamiDeps {
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
}

/** 저장된 토큰으로 서버에 현재 사용자를 물어 GitHub 계정을 보여 준다. */
export async function runWhoami(deps: WhoamiDeps = {}): Promise<Me> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const me = await api.request<Me>("GET", "/me", { token: credentials.token });
  log(me.login);
  log(`API: ${credentials.apiUrl}`);
  return me;
}
