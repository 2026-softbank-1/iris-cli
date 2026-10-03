import { ApiClient, type FetchLike } from "../lib/api.js";
import { findCredentials } from "../lib/config.js";
import { ApiError, CliError } from "../lib/errors.js";

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
  const credentials = await findCredentials();
  if (!credentials) {
    throw new CliError("로그인되어 있지 않습니다. `anydeploy login` 을 실행해 주세요.");
  }

  const api = new ApiClient(credentials.apiUrl, deps.fetchImpl);
  try {
    const me = await api.request<Me>("GET", "/me", { token: credentials.token });
    log(me.login);
    log(`API: ${credentials.apiUrl}`);
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new CliError("세션이 만료되었습니다. `anydeploy login` 을 다시 실행해 주세요.");
    }
    throw error;
  }
}
