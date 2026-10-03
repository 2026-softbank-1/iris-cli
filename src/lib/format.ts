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

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
