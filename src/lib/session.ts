import { ApiClient, type FetchLike } from "./api.js";
import { type Credentials, findActiveCredentials } from "./config.js";
import { AuthError } from "./errors.js";
import { type Link, requireLink } from "./link.js";

export const NOT_LOGGED_IN_MESSAGE =
  "로그인되어 있지 않습니다. `likelion login` 을 실행해 주세요 (브라우저가 없으면 `--no-browser`, CI 에서는 환경변수 LIKELION_TOKEN).";

export interface Session {
  api: ApiClient;
  credentials: Credentials;
}

/** 저장된 로그인 정보로 API 클라이언트를 만든다. 로그인 전이면 안내하고 끝낸다. */
export async function requireSession(fetchImpl?: FetchLike): Promise<Session> {
  const credentials = await findActiveCredentials();
  if (!credentials) throw new AuthError(NOT_LOGGED_IN_MESSAGE);
  return { api: new ApiClient(credentials.apiUrl, fetchImpl), credentials };
}

export interface LinkedSession extends Session {
  token: string;
  link: Link;
}

/** 로그인과 현재 폴더의 서비스 연결을 함께 확인한다. 연결된 서비스를 다루는 명령이 쓴다. */
export async function requireLinkedSession(
  cwd: string,
  fetchImpl?: FetchLike,
): Promise<LinkedSession> {
  const session = await requireSession(fetchImpl);
  const link = await requireLink(cwd, session.credentials);
  return { ...session, token: session.credentials.token, link };
}
