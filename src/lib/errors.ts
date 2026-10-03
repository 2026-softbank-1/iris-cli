/** 사용자에게 그대로 보여 줄 메시지를 담는 오류. 스택 없이 한 줄로 출력하고 종료 코드로 끝낸다. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** 서버에 닿지 못한 실패. 스트림처럼 다시 시도해도 되는 호출이 구분하는 데 쓴다. */
export class ConnectionError extends CliError {
  constructor(baseUrl: string) {
    super(`서버에 연결할 수 없습니다: ${baseUrl}`);
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

/** 서버가 ApiResponse 봉투로 돌려준 실패. */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** `Retry-After` 헤더가 초 단위 숫자일 때 그 값. 429 에서 얼마나 쉴지 알려 준다. */
    readonly retryAfterSeconds?: number,
    /** 입력 검증 실패(422)일 때 어느 필드가 왜 틀렸는지 */
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}
