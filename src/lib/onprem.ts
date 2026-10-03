import type { OnpremServerRegistration, OnpremServerStatus } from "./types.js";

const STATUS_LABELS: Record<OnpremServerStatus, string> = {
  PENDING: "대기",
  REGISTERING: "연결 중",
  CONNECTED: "연결됨",
  FAILED: "실패",
};

/** 서버 연결 상태의 한글 이름. 모르는 값은 그대로 보여 준다. */
export function serverStatusLabel(status: string): string {
  return STATUS_LABELS[status as OnpremServerStatus] ?? status;
}

/** 서버 등록·토큰 재발급 뒤 설치 명령과 안내를 찍는다. 토큰은 설치 명령 안에서만 보여 준다. */
export function printInstallCommand(
  registration: OnpremServerRegistration,
  log: (message: string) => void,
): void {
  const { server } = registration;
  log("");
  log("서버에서 실행하세요 (Ubuntu 22.04/24.04, sudo):");
  log("");
  log(`  ${registration.installCommand}`);
  log("");
  const expiry = server.registrationExpiresAt ? `${server.registrationExpiresAt} 까지` : "정해진 시간 동안만";
  log(`이 명령의 토큰은 ${expiry} 유효하고 지금 한 번만 보여 줍니다.`);
  log(`만료되면 \`likelion servers token ${server.name}\` 으로 다시 발급하세요.`);
}
