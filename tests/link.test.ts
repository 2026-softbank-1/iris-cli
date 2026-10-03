import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runLink } from "../src/commands/link.js";
import { findLink, requireLink } from "../src/lib/link.js";
import {
  API_URL,
  envelope,
  fakeFetch,
  linkTo,
  loginAs,
  queryOf,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

// Response 본문은 한 번만 읽을 수 있어 테스트마다 새로 만든다.
const projects = () =>
  envelope({
    items: [
      { id: 1, name: "demo" },
      { id: 2, name: "other" },
    ],
    total: 2,
    page: 0,
    size: 100,
  });
const services = () =>
  envelope([
    { id: 3, projectId: 1, name: "web", targetIds: [1] },
    { id: 4, projectId: 1, name: "worker", targetIds: [1] },
  ]);

describe("runLink", () => {
  it("옵션으로_고른_프로젝트와_서비스를_현재_폴더에_저장한다", async () => {
    await loginAs();
    const { fetchImpl, calls } = fakeFetch([projects(), services()]);
    const log = vi.fn();

    const link = await runLink({ project: "demo", service: "worker" }, { fetchImpl, cwd: cwd(), log });

    expect(link).toEqual({
      apiUrl: API_URL,
      projectId: 1,
      projectName: "demo",
      serviceId: 4,
      serviceName: "worker",
    });
    expect(await findLink(cwd())).toEqual(link);
    expect(await readFile(join(cwd(), ".likelion", ".gitignore"), "utf8")).toBe("*\n");
    expect(queryOf(calls[0]).get("size")).toBe("100");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/api/v1/projects/1/services");
    expect(calls[0]?.headers.Authorization).toBe("Bearer jwt-1");
  });

  it("옵션이_없으면_번호를_물어_고른다", async () => {
    await loginAs();
    const { fetchImpl } = fakeFetch([projects(), services()]);
    const ask = vi.fn().mockResolvedValueOnce("2").mockResolvedValueOnce("1");

    const link = await runLink({}, { fetchImpl, cwd: cwd(), ask, log: vi.fn() });

    expect(link).toMatchObject({ projectName: "other", serviceName: "web" });
  });

  it("대화형이_아니고_옵션도_없으면_옵션을_안내하고_저장하지_않는다", async () => {
    await loginAs();
    const { fetchImpl } = fakeFetch([projects()]);

    await expect(runLink({}, { fetchImpl, cwd: cwd(), log: vi.fn() })).rejects.toThrow("--project");
    expect(await findLink(cwd())).toBeNull();
  });

  it("로그인_전이면_login_안내", async () => {
    await expect(runLink({}, { cwd: cwd(), log: vi.fn() })).rejects.toThrow("likelion login");
  });
});

describe("findLink · requireLink", () => {
  it("하위_폴더에서도_위쪽_연결_정보를_찾는다", async () => {
    const link = await linkTo(cwd());
    const nested = join(cwd(), "src", "deep");
    await mkdir(nested, { recursive: true });

    expect(await findLink(nested)).toEqual(link);
  });

  it("연결_정보가_없으면_link_안내", async () => {
    await loginAs();
    const credentials = { apiUrl: API_URL, token: "t", user: { id: 1, login: "a" } };

    await expect(requireLink(cwd(), credentials)).rejects.toThrow("likelion link");
  });

  it("다른_서버에_연결된_폴더면_다시_link_하라고_안내한다", async () => {
    await linkTo(cwd(), { apiUrl: "https://other.example.test" });
    const credentials = { apiUrl: API_URL, token: "t", user: { id: 1, login: "a" } };

    await expect(requireLink(cwd(), credentials)).rejects.toThrow("https://other.example.test");
  });
});
