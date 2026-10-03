import { createInterface } from "node:readline/promises";
import { CliError } from "./errors.js";

export interface Choice {
  id: number;
  name: string;
}

export type Ask = (question: string) => Promise<string>;

/** 대화형 터미널일 때만 질문할 수 있다. 파이프·CI 에서는 undefined. */
export function createAsk(): Ask | undefined {
  if (!process.stdin.isTTY) return undefined;
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

export interface PickOneOptions<T> extends PickOptions {
  /** 번호 목록에 보여 줄 한 줄. 없으면 `이름 (id)` */
  describeItem?: (item: T) => string;
}

/** 옵션이 있으면 그 값으로, 하나뿐이면 자동으로, 아니면 번호를 물어 고른다. */
export async function pickOne<T extends Choice>(
  items: T[],
  options: PickOneOptions<T>,
): Promise<T> {
  const { label, flag, value, ask, log, emptyMessage, describeItem } = options;
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
    throw new CliError(
      `대화형 터미널이 아니라 ${label} 을 고를 수 없습니다. ${flag} 로 지정해 주세요. 가능한 값: ${describe(items)}`,
    );
  }
  items.forEach((item, index) =>
    log(`  ${index + 1}) ${describeItem ? describeItem(item) : `${item.name} (${item.id})`}`),
  );
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
