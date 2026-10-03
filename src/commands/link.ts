import type { FetchLike } from "../lib/api.js";
import { type Link, saveLink } from "../lib/link.js";
import { type Ask, pickOne } from "../lib/prompt.js";
import { requireSession } from "../lib/session.js";
import type { Page, Project, Service } from "../lib/types.js";

const PROJECT_PAGE_SIZE = 100;

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

  const projects = await api.request<Page<Project>>("GET", "/projects", {
    token,
    query: { page: 0, size: PROJECT_PAGE_SIZE },
  });
  const project = await pickOne(projects.items, {
    label: "프로젝트",
    flag: "--project",
    value: options.project,
    ask: deps.ask,
    log,
  });

  const services = await api.request<Service[]>("GET", `/projects/${project.id}/services`, {
    token,
  });
  const service = await pickOne(services, {
    label: "서비스",
    flag: "--service",
    value: options.service,
    ask: deps.ask,
    log,
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
