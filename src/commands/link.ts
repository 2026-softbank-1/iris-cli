import type { FetchLike } from "../lib/api.js";
import { type Link, saveLink } from "../lib/link.js";
import { pickProject } from "../lib/project.js";
import { type Ask, pickOne } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import type { Service } from "../lib/types.js";

export interface LinkOptions {
  project?: string;
  service?: string;
}

export interface LinkDeps {
  fetchImpl?: FetchLike;
  ask?: Ask;
  cwd?: string;
  log?: (message: string) => void;
}

/** 프로젝트·서비스를 골라 현재 폴더에 연결 정보를 저장한다. */
export async function runLink(options: LinkOptions, deps: LinkDeps = {}): Promise<Link> {
  const log = deps.log ?? console.log;
  const { api, credentials } = await requireSession(deps.fetchImpl);
  const token = credentials.token;

  const project = await pickProject(api, token, options.project, deps.ask, log);

  const services = await api.request<Service[]>("GET", `/projects/${project.id}/services`, {
    token,
  });
  const service = await pickOne(services, {
    label: "서비스",
    flag: "--service",
    value: options.service,
    ask: deps.ask,
    log,
    emptyMessage: `'${project.name}' 프로젝트에 서비스가 없습니다. 서비스는 대시보드나 \`likelion services create --repo <GitHub 주소>\` 로 GitHub 레포를 연결해 만들며, 레포가 없으면 만들 수 없습니다. 서비스를 만든 뒤 다시 실행해 주세요.`,
  });

  const link: Link = {
    apiUrl: credentials.apiUrl,
    projectId: project.id,
    projectName: project.name,
    serviceId: service.id,
    serviceName: service.name,
  };
  const path = await saveLink(deps.cwd ?? process.cwd(), link);
  log(`${project.name} / ${service.name} 에 연결했습니다. (${path})`);
  return link;
}
