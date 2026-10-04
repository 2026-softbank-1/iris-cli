import type { ApiErrorDetail } from "./errors.js";
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

/** 서버 이름 규칙. 서버(iris-was)가 판정하고 CLI 는 거절 사유를 풀어 알린다. */
export const SERVER_NAME_RULE =
  "앞뒤 공백을 뺀 1~63자, 영문·숫자·한글(가-힣)·`.`·`_`·`-` 만 쓰고 공백과 숫자만으로 된 이름은 쓸 수 없습니다";

// 서버가 422 details[].reason 으로 주는 영어 고정 문구(계약). 모르는 사유는 규칙 전체를 안내한다.
const SERVER_NAME_REASONS: Record<string, string> = {
  "must not be blank": "서버 이름을 입력해 주세요.",
  "must be at most 63 characters": "서버 이름은 63자 이하여야 합니다.",
  "must not be only digits":
    "서버 이름은 숫자만으로 정할 수 없습니다. `servers remove 1` 처럼 숫자는 id 로 먼저 읽기 때문에 글자를 하나 이상 넣어 주세요.",
  "must start with a letter, digit or Hangul syllable": "서버 이름은 영문·숫자·한글(가-힣)로 시작해야 합니다.",
  "may contain only letters, digits, Hangul syllables, '.', '_' and '-' (no spaces)":
    "서버 이름에는 영문·숫자·한글(가-힣)과 `.`·`_`·`-` 만 쓸 수 있고 공백은 쓸 수 없습니다.",
};

/** 서버가 이름을 거절(422)했을 때의 안내. 사유가 `name` 필드에 있으면 그에 맞는 문장을 쓴다. */
export function describeServerNameRejection(name: string, details: ApiErrorDetail[] | undefined): string {
  const reason = details?.find((detail) => detail.field === "name")?.reason;
  const known = reason === undefined ? undefined : SERVER_NAME_REASONS[reason];
  if (known) return `서버 이름을 쓸 수 없습니다: ${JSON.stringify(name)}. ${known}`;
  return `서버 이름을 쓸 수 없습니다: ${JSON.stringify(name)}. 이름 규칙: ${SERVER_NAME_RULE}.`;
}
