import { deleteCredentials } from "../lib/config.js";

/**
 * 저장된 토큰만 지운다. 세션은 서명된 JWT 라 서버에 폐기할 상태가 없다.
 */
export async function runLogout(log: (message: string) => void = console.log): Promise<boolean> {
  const existed = await deleteCredentials();
  log(existed ? "로그아웃했습니다." : "이미 로그아웃된 상태입니다.");
  return existed;
}
