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

/** 서버가 ApiResponse 봉투로 돌려준 실패. */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
