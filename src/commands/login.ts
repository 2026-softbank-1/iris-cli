import open from "open";
import { ApiClient, type FetchLike } from "../lib/api.js";
import { type Credentials, saveCredentials } from "../lib/config.js";
import { CliError } from "../lib/errors.js";

interface CliLoginSession {
  sessionId: string;
  pollSecret: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

interface CliLoginToken {
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  accessToken?: string;
}

interface Me {
  id: number;
  login: string;
}

export interface LoginDeps {
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface LoginOptions {
  apiUrl: string;
  browser: boolean;
}

/**
 * 브라우저에서 GitHub 로그인을 승인하면 CLI 가 폴링으로 토큰을 받는다.
 * 서버 계약은 docs/login-contract.md.
 */
export async function runLogin(options: LoginOptions, deps: LoginDeps = {}): Promise<Credentials> {
  const openBrowser = deps.openBrowser ?? open;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const api = new ApiClient(options.apiUrl, deps.fetchImpl);

  const session = await api.request<CliLoginSession>("POST", "/auth/cli/sessions");
  log("브라우저에서 GitHub 로그인을 승인해 주세요.");
  log(`  ${session.verificationUrl}`);
  if (options.browser) {
    await openBrowser(session.verificationUrl).catch(() => {
      log("브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 열어 주세요.");
    });
  }

  const accessToken = await waitForApproval(api, session, { sleep, now });
  const me = await api.request<Me>("GET", "/me", { token: accessToken });
  const credentials: Credentials = {
    apiUrl: options.apiUrl,
    token: accessToken,
    user: { id: me.id, login: me.login },
  };
  await saveCredentials(credentials);
  log(`${me.login} 계정으로 로그인했습니다.`);
  return credentials;
}

async function waitForApproval(
  api: ApiClient,
  session: CliLoginSession,
  clock: { sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<string> {
  const deadline = clock.now() + session.expiresIn * 1000;
  while (clock.now() < deadline) {
    await clock.sleep(session.interval * 1000);
    const result = await api.request<CliLoginToken>(
      "POST",
      `/auth/cli/sessions/${encodeURIComponent(session.sessionId)}/token`,
      { body: { pollSecret: session.pollSecret } },
    );
    switch (result.status) {
      case "APPROVED":
        if (!result.accessToken) throw new CliError("서버가 토큰 없이 승인 응답을 보냈습니다.");
        return result.accessToken;
      case "DENIED":
        throw new CliError("로그인이 거절되었습니다.");
      case "EXPIRED":
        throw new CliError("로그인 요청이 만료되었습니다. 다시 시도해 주세요.");
      case "PENDING":
        break;
    }
  }
  throw new CliError("로그인 시간이 초과되었습니다. 다시 시도해 주세요.");
}
