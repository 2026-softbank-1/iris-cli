import { ApiClient, type FetchLike } from "./api.js";
import { type Credentials, findCredentials } from "./config.js";
import { CliError } from "./errors.js";

export const NOT_LOGGED_IN_MESSAGE = "로그인되어 있지 않습니다. `likelion login` 을 실행해 주세요.";

export interface Session {
  api: ApiClient;
  credentials: Credentials;
}

/** 저장된 로그인 정보로 API 클라이언트를 만든다. 로그인 전이면 안내하고 끝낸다. */
export async function requireSession(fetchImpl?: FetchLike): Promise<Session> {
  const credentials = await findCredentials();
  if (!credentials) throw new CliError(NOT_LOGGED_IN_MESSAGE);
  return { api: new ApiClient(credentials.apiUrl, fetchImpl), credentials };
}
