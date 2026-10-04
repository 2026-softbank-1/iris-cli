import { createInterface } from "node:readline/promises";
import { CliError, UsageError } from "./errors.js";

export interface Choice {
  id: number;
  name: string;
}

export type Ask = (question: string) => Promise<string>;

// 이 환경변수가 있으면 에이전트가 실행한 것으로 보고 질문하지 않는다(터미널 흉내를 내는 pty 에서도).
const AGENT_ENV_VARS = ["CLAUDECODE", "AI_AGENT", "AGENT"];

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** 사람이 답할 수 있는 대화형 실행인지. 파이프·CI·에이전트·`LIKELION_NON_INTERACTIVE` 면 아니다. */
export function isInteractive(
  env: Record<string, string | undefined> = process.env,
  stdinIsTTY: boolean | undefined = process.stdin.isTTY,
): boolean {
  if (!stdinIsTTY) return false;
  if (isSet(env.CI) || isSet(env.LIKELION_NON_INTERACTIVE)) return false;
  return !AGENT_ENV_VARS.some((name) => isSet(env[name]));
}

/** 대화형일 때만 질문할 수 있다. 아니면 undefined 이고 명령은 필요한 값을 옵션으로 받는다. */
export function createAsk(): Ask | undefined {
  if (!isInteractive()) return undefined;
  return async (question) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  };
}

/** 숫자면 id, 아니면 이름으로 찾는다. */
export function matchByIdOrName<T extends Choice>(items: T[], option: string): T | undefined {
  if (/^\d+$/.test(option)) {
    const byId = items.find((item) => item.id === Number(option));
    if (byId) return byId;
  }
  return items.find((item) => item.name === option);
}

function describe(items: Choice[]): string {
  return items.map((item) => `${item.name}(${item.id})`).join(", ");
}

export interface PickOptions {
  /** 목록 이름. 예: "프로젝트" */
  label: string;
  /** 직접 지정하는 옵션 이름. 예: "--project" */
  flag: string;
  /** 사용자가 옵션으로 준 값 */
  value: string | undefined;
  ask: Ask | undefined;
  log: (message: string) => void;
  /** 목록이 비었을 때 보여 줄 안내. 없으면 "목록이 비어 있습니다." 만 알린다. */
  emptyMessage?: string;
}

/** 옵션이 있으면 그 값으로, 하나뿐이면 자동으로, 아니면 번호를 물어 고른다. */
export async function pickOne<T extends Choice>(items: T[], options: PickOptions): Promise<T> {
  const { label, flag, value, ask, log, emptyMessage } = options;
  if (items.length === 0) throw new CliError(emptyMessage ?? `${label} 목록이 비어 있습니다.`);

  if (value !== undefined) {
    const found = matchByIdOrName(items, value);
    if (!found) {
      throw new CliError(`찾을 수 없습니다: ${label} '${value}'. 가능한 값: ${describe(items)}`);
    }
    return found;
  }

  const [only] = items;
  if (items.length === 1 && only) {
    log(`${label}: ${only.name} (하나뿐이라 자동 선택)`);
    return only;
  }

  if (!ask) {
    throw new UsageError(
      `대화형 터미널이 아니라 ${label} 을 고를 수 없습니다. ${flag} 로 지정해 주세요. 가능한 값: ${describe(items)}`,
    );
  }
  items.forEach((item, index) => log(`  ${index + 1}) ${item.name} (${item.id})`));
  const answer = Number((await ask(`${label} 번호: `)).trim());
  const picked = Number.isInteger(answer) ? items[answer - 1] : undefined;
  if (!picked) throw new CliError("잘못된 선택입니다.");
  return picked;
}

/** 예·아니오를 묻는다. 빈 답은 기본값이고, `y`·`yes` 만 예로 본다. */
export async function confirm(ask: Ask, question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? "(Y/n)" : "(y/N)"} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}
