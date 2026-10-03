import { CliError } from "./errors.js";

const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`·`1h`·`2d` 같은 기간을 밀리초로 바꾼다. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text.trim());
  if (!match) throw new CliError(`기간 형식이 올바르지 않습니다: ${text} (예: 30m, 1h, 2d)`);
  const unit = match[2] as keyof typeof DURATION_UNIT_MS;
  return Number(match[1]) * DURATION_UNIT_MS[unit];
}

/** 나노초 타임스탬프 문자열을 UTC ISO 시각으로 바꾼다. */
export function formatTimestampNs(timestampNs: string): string {
  return new Date(Number(BigInt(timestampNs) / 1_000_000n)).toISOString();
}

export function formatSeconds(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}m${rounded % 60}s`;
}

const UPLOAD_SOURCE_PREFIX = "upload-";

/** Git SHA 는 앞 7자만 남긴다. `up` 으로 올린 배포의 `upload-…` 는 잘리면 뜻이 없어 그대로 둔다. */
export function shortSha(sha: string): string {
  return sha.startsWith(UPLOAD_SOURCE_PREFIX) ? sha : sha.slice(0, 7);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 한글처럼 터미널에서 두 칸을 차지하는 글자. 표의 열을 맞출 때만 쓴다.
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/** 첫 행을 머리글로 보고 열 너비를 맞춘 줄들을 돌려준다. 마지막 열은 채우지 않는다. */
export function formatTable(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell + " ".repeat((widths[index] ?? 0) - displayWidth(cell)),
      )
      .join("  ")
      .trimEnd(),
  );
}
