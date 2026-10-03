import type { ApiClient } from "./api.js";
import { type Ask, pickOne } from "./prompt.js";
import type { Page, Project } from "./types.js";

const PROJECT_PAGE_SIZE = 100;

/** 내 프로젝트 중 하나를 고른다. `value` 가 있으면 id·이름으로, 없으면 번호를 묻는다. */
export async function pickProject(
  api: ApiClient,
  token: string,
  value: string | undefined,
  ask: Ask | undefined,
  log: (message: string) => void,
): Promise<Project> {
  const projects = await api.request<Page<Project>>("GET", "/projects", {
    token,
    query: { page: 0, size: PROJECT_PAGE_SIZE },
  });
  return pickOne(projects.items, {
    label: "프로젝트",
    flag: "--project",
    value,
    ask,
    log,
    emptyMessage: "프로젝트가 없습니다. 대시보드에서 프로젝트를 먼저 만들어 주세요.",
  });
}
