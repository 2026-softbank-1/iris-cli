/** `--json` 출력. 서버 응답의 `data` 를 봉투 없이 그대로, 들여써서 한 번에 낸다. */
export function printJson(value: unknown, log: (message: string) => void): void {
  log(JSON.stringify(value, null, 2));
}

/** `--json` 이면 사람용 진행 안내를 stderr 로 돌려 stdout 에는 JSON 만 남긴다. */
export function progressLog(
  json: boolean,
  log: (message: string) => void,
  warn: (message: string) => void,
): (message: string) => void {
  return json ? warn : log;
}
