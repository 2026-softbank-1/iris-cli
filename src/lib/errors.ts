/**
 * 종료 코드. 사람과 에이전트가 "무엇을 해야 하는지"를 코드만으로 가를 수 있게 나눈다.
 * - 1: 그 밖의 실패(서버가 거절·없음·충돌 등). 메시지를 읽고 고친다.
 * - 2: 사용법 오류. 인자·옵션을 고쳐서 다시 실행한다.
 * - 3: 인증이 필요하다. 로그인하거나 `LIKELION_TOKEN` 을 바로잡는다.
 * - 4: 명령은 실행됐지만 결과가 실패다(배포 실패·롤백됨·AI 수정 실패). 원인을 조사한다.
 * - 5: 일시적 오류(서버에 닿지 못함·5xx·429). 그대로 다시 시도해도 된다.
 */
export const EXIT = {
  FAILURE: 1,
  USAGE: 2,
  AUTH: 3,
  RESULT_FAILED: 4,
  RETRYABLE: 5,
} as const;

/** 사용자에게 그대로 보여 줄 메시지를 담는 오류. 스택 없이 한 줄로 출력하고 종료 코드로 끝낸다. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.FAILURE,
    /** 기계가 읽는 오류 코드. 서버가 준 코드(`DEPLOYMENT_IN_PROGRESS` 등)나 이 CLI 의 코드 */
    readonly code?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** 인자·옵션이 잘못됐다. 서버를 부르기 전에 알 수 있는 오류다. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE, "USAGE");
    this.name = "UsageError";
  }
}

/** 로그인하지 않았거나 토큰이 거절됐다. */
export class AuthError extends CliError {
  constructor(message: string) {
    super(message, EXIT.AUTH, "UNAUTHENTICATED");
    this.name = "AuthError";
  }
}

/** 명령은 제대로 실행됐지만 배포·수정·진단의 결과가 실패다. */
export class ResultError extends CliError {
  constructor(message: string, code: string) {
    super(message, EXIT.RESULT_FAILED, code);
    this.name = "ResultError";
  }
}

/** 서버에 닿지 못한 실패. 스트림처럼 다시 시도해도 되는 호출이 구분하는 데 쓴다. */
export class ConnectionError extends CliError {
  constructor(baseUrl: string) {
    super(`서버에 연결할 수 없습니다: ${baseUrl}`, EXIT.RETRYABLE, "CONNECTION_FAILED");
    this.name = "ConnectionError";
  }
}

/** 다시 확인해도 되는 일시적인 실패(서버에 닿지 못함·5xx). 4xx 는 다시 해도 같은 결과다. */
export function isTransientFailure(error: unknown): error is ConnectionError | ApiError {
  return error instanceof ConnectionError || (error instanceof ApiError && error.status >= 500);
}

export function describeTransientFailure(error: ConnectionError | ApiError): string {
  return error instanceof ApiError
    ? `서버가 일시적으로 응답하지 못했습니다 (HTTP ${error.status}).`
    : "서버에 닿지 못했습니다.";
}

/** 검증 실패 응답의 필드별 사유. field 는 camelCase 필드 경로다. */
export interface ApiErrorDetail {
  field: string;
  reason: string;
}

function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT.AUTH;
  if (status === 429 || status >= 500) return EXIT.RETRYABLE;
  return EXIT.FAILURE;
}

/** 서버가 ApiResponse 봉투로 돌려준 실패. 종료 코드는 HTTP 상태로 정한다. */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    code?: string,
    /** `Retry-After` 헤더가 초 단위 숫자일 때 그 값. 429 에서 얼마나 쉴지 알려 준다. */
    readonly retryAfterSeconds?: number,
    /** 입력 검증 실패(422)일 때 어느 필드가 왜 틀렸는지 */
    readonly details?: ApiErrorDetail[],
  ) {
    super(message, exitCodeForStatus(status), code);
    this.name = "ApiError";
  }
}

/** 서버 오류를 사람이 읽을 안내로 바꾸되 상태·코드·종료 코드(재시도 가능 여부)·검증 사유는 그대로 둔다. */
export function explainApiError(error: ApiError, message: string): ApiError {
  return new ApiError(message, error.status, error.code, error.retryAfterSeconds, error.details);
}
