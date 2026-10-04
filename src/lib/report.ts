import type { CommanderError } from "commander";
import { type ApiErrorDetail, ApiError, CliError, EXIT } from "./errors.js";

/** `--json` 일 때 stderr 에 한 줄로 내는 오류. `{"error": ErrorReport}` 형태다. */
export interface ErrorReport {
  /** 서버가 준 코드(`DEPLOYMENT_IN_PROGRESS` 등)나 이 CLI 의 코드(`USAGE`·`UNAUTHENTICATED`…) */
  code: string;
  message: string;
  exitCode: number;
  /** 그대로 다시 시도해도 되는지 */
  retryable: boolean;
  /** 서버가 거절한 오류의 HTTP 상태 */
  status?: number;
  retryAfterSeconds?: number;
  details?: ApiErrorDetail[];
}

const DEFAULT_CODES: Record<number, string> = {
  [EXIT.FAILURE]: "ERROR",
  [EXIT.USAGE]: "USAGE",
  [EXIT.AUTH]: "UNAUTHENTICATED",
  [EXIT.RESULT_FAILED]: "FAILED",
  [EXIT.RETRYABLE]: "UNAVAILABLE",
};

/** `--json` 이 인자에 있는지. 옵션 파싱 전에(파싱 오류를 보고할 때) 알아야 해서 argv 를 직접 본다. */
export function wantsJson(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes("--json");
}

export function describeError(error: CliError): ErrorReport {
  const report: ErrorReport = {
    code: error.code ?? DEFAULT_CODES[error.exitCode] ?? "ERROR",
    message: error.message,
    exitCode: error.exitCode,
    retryable: error.exitCode === EXIT.RETRYABLE,
  };
  if (error instanceof ApiError) {
    report.status = error.status;
    if (error.retryAfterSeconds !== undefined) report.retryAfterSeconds = error.retryAfterSeconds;
    if (error.details?.length) report.details = error.details;
  }
  return report;
}

export interface ReportOptions {
  json: boolean;
  write?: (line: string) => void;
}

/**
 * 오류를 알리고 종료 코드를 돌려준다. `--json` 이면 `{"error": …}` 한 줄을, 아니면 메시지 한 줄을 stderr 로 낸다.
 * CLI 가 아는 오류가 아니면(버그) 텍스트 모드에서는 undefined 를 돌려 호출한 쪽이 스택과 함께 던지게 한다.
 */
export function reportError(error: unknown, options: ReportOptions): number | undefined {
  const write = options.write ?? console.error;
  if (error instanceof CliError) {
    write(options.json ? JSON.stringify({ error: describeError(error) }) : error.message);
    return error.exitCode;
  }
  if (!options.json) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  write(JSON.stringify({ error: { code: "INTERNAL", message, exitCode: EXIT.FAILURE, retryable: false } }));
  return EXIT.FAILURE;
}

/** commander 가 던진 파싱 오류(모르는 옵션·빠진 인자). 도움말·버전 출력은 정상 종료다. */
export function reportCommanderError(error: CommanderError, options: ReportOptions): number {
  if (error.exitCode === 0) return 0;
  if (options.json) {
    const write = options.write ?? console.error;
    // 파싱 오류의 텍스트는 json 일 때 commander 가 쓰지 못하게 막아 두었으니 여기서 한 번만 낸다.
    const message = error.message.replace(/^error: /, "");
    write(JSON.stringify({ error: { code: "USAGE", message, exitCode: EXIT.USAGE, retryable: false } }));
  }
  return EXIT.USAGE;
}
