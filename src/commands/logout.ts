import { deleteCredentials, envToken } from "../lib/config.js";

/**
 * 저장된 토큰만 지운다. 세션은 서명된 JWT 라 서버에 폐기할 상태가 없다.
 */
export async function runLogout(log: (message: string) => void = console.log): Promise<boolean> {
  const existed = await deleteCredentials();
  log(existed ? "로그아웃했습니다." : "이미 로그아웃된 상태입니다.");
  if (envToken()) log("환경변수 LIKELION_TOKEN 이 설정돼 있어 계속 이 토큰으로 인증됩니다. 환경변수를 지워 주세요.");
  return existed;
}
