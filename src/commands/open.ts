import open from "open";
import type { FetchLike } from "../lib/api.js";
import { CliError } from "../lib/errors.js";
import { requireLink } from "../lib/link.js";
import { printJson } from "../lib/output.js";
import { matchByIdOrName } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import type { ServiceDomain } from "../lib/types.js";

export interface OpenOptions {
  target?: string;
  browser: boolean;
  /** 브라우저를 열지 않고 주소 목록을 JSON 으로 낸다 */
  json?: boolean;
}

export interface OpenDeps {
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => Promise<unknown>;
  cwd?: string;
  log?: (message: string) => void;
}

/** 연결된 서비스의 배포 도메인을 출력하고 브라우저로 연다. */
export async function runOpen(options: OpenOptions, deps: OpenDeps = {}): Promise<string> {
  const log = deps.log ?? console.log;
  const openBrowser = deps.openBrowser ?? open;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const link = await requireLink(deps.cwd ?? process.cwd(), credentials);

  const domains = await api.request<ServiceDomain[]>("GET", `/services/${link.serviceId}/domains`, {
    token: credentials.token,
  });
  const choices = domains.flatMap((domain) =>
    domain.isConnected && domain.url
      ? [{ id: domain.targetId, name: domain.targetName, url: domain.url }]
      : [],
  );
  const [first] = choices;
  if (!first) {
    throw new CliError(
      "접속할 수 있는 도메인이 없습니다. 배포가 끝났는지 `likelion status` 로 확인해 주세요.",
    );
  }

  const chosen = options.target === undefined ? first : matchByIdOrName(choices, options.target);
  if (!chosen) {
    const names = choices.map((choice) => `${choice.name}(${choice.id})`).join(", ");
    throw new CliError(`찾을 수 없습니다: 타깃 '${options.target}'. 가능한 값: ${names}`);
  }
  if (options.target === undefined && choices.length > 1 && !options.json) {
    log(`타깃이 ${choices.length}개라 ${chosen.name} 을 엽니다. 다른 타깃은 --target 으로 고르세요.`);
  }

  if (options.json) {
    printJson(
      {
        url: chosen.url,
        target: chosen.name,
        targets: choices.map((choice) => ({ id: choice.id, name: choice.name, url: choice.url })),
      },
      log,
    );
    return chosen.url;
  }
  log(chosen.url);
  if (options.browser) {
    await openBrowser(chosen.url).catch(() => {
      log("브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 열어 주세요.");
    });
  }
  return chosen.url;
}
