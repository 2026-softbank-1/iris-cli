import { describe, expect, it, vi } from "vitest";
import { runServicesCreate, type ServicesCreateDeps } from "../src/commands/services.js";
import { findLink } from "../src/lib/link.js";
import {
  API_URL,
  envelope,
  errorEnvelope,
  fakeFetch,
  loginAs,
  useTempConfigDir,
  useTempCwd,
} from "./helpers.js";

useTempConfigDir();
const cwd = useTempCwd();

const REPO = "https://github.com/octocat/hello";

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
const targets = () =>
  envelope([
    { id: 1, name: "aws", kind: "AWS" },
    { id: 7, name: "onprem-k3x9q2ma", kind: "ONPREM", onpremServerId: 3, connectionStatus: "CONNECTED" },
    { id: 8, name: "onprem-p7m2x8qa", kind: "ONPREM", onpremServerId: 4, connectionStatus: "PENDING" },
  ]);
const servers = () =>
  envelope([
    { id: 3, name: "home-lab", serverKey: "k3x9q2ma", status: "CONNECTED", targetId: 7, createdAt: "2026-10-04T00:00:00Z" },
    { id: 4, name: "lab2", serverKey: "p7m2x8qa", status: "PENDING", targetId: 8, createdAt: "2026-10-04T00:00:00Z" },
  ]);
const created = (overrides: Record<string, unknown> = {}) =>
  envelope(
    {
      id: 12,
      projectId: 1,
      name: "hello",
      sourceRepositoryUrl: REPO,
      sourceBranch: "main",
      targetIds: [7],
      ...overrides,
    },
    { status: 201 },
  );

async function setup(responses: Response[], extra: Partial<ServicesCreateDeps> = {}) {
  await loginAs();
  const { fetchImpl, calls } = fakeFetch(responses);
  const log = vi.fn();
  const warn = vi.fn();
  const findRepository = vi.fn(async () => undefined as string | undefined);
  const deps: ServicesCreateDeps = { fetchImpl, cwd: cwd(), log, warn, findRepository, ...extra };
  const lines = () => log.mock.calls.map(([line]) => String(line));
  const pathOf = (index: number) => new URL(calls[index]?.url ?? "").pathname;
  return { calls, log, warn, deps, lines, pathOf, findRepository };
}

describe("runServicesCreate", () => {
  it("옵션으로_준_값과_내_서버_타깃으로_서비스를_만들고_link_옵션이면_현재_폴더를_연결한다", async () => {
    const t = await setup([projects(), targets(), servers(), created()]);

    const service = await runServicesCreate(
      { project: "demo", repo: REPO, name: "hello", branch: "dev", rootDir: "apps/api", target: "home-lab", link: true },
      t.deps,
    );

    expect(service.id).toBe(12);
    expect(t.pathOf(1)).toBe("/api/v1/targets");
    expect(t.pathOf(2)).toBe("/api/v1/onprem-servers");
    expect(t.calls[3]?.method).toBe("POST");
    expect(t.pathOf(3)).toBe("/api/v1/projects/1/services");
    expect(t.calls[3]?.body).toEqual({
      repositoryUrl: REPO,
      name: "hello",
      branch: "dev",
      rootDirectory: "apps/api",
      targetIds: [7],
    });
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.lines()).toContain(
      "서비스를 만들었습니다: demo / hello (서비스 12, 브랜치 main, 타깃 home-lab)",
    );
    expect(await findLink(cwd())).toEqual({
      apiUrl: API_URL,
      projectId: 1,
      projectName: "demo",
      serviceId: 12,
      serviceName: "hello",
    });
    expect(t.lines().at(-1)).toContain("likelion up");
  });

  it("대화형이면_프로젝트·저장소·타깃을_묻고_연결도_물어_본다", async () => {
    const t = await setup([projects(), targets(), servers(), created()]);
    t.findRepository.mockResolvedValue("git@github.com:octocat/hello.git");
    // 프로젝트 1번, 저장소는 Enter(감지한 origin), 타깃 2번(home-lab), 연결은 Enter(예)
    const ask = vi.fn().mockResolvedValueOnce("1").mockResolvedValueOnce("").mockResolvedValueOnce("2").mockResolvedValueOnce("");

    await runServicesCreate({}, { ...t.deps, ask });

    expect(ask).toHaveBeenNthCalledWith(2, "GitHub 저장소 주소 (Enter 면 git@github.com:octocat/hello.git): ");
    expect(ask).toHaveBeenNthCalledWith(4, expect.stringContaining("(Y/n)"));
    expect(t.lines()).toEqual(
      expect.arrayContaining(["  1) aws (공용)", "  2) home-lab (내 서버, 연결됨)", "  3) lab2 (내 서버, 대기)"]),
    );
    expect(t.calls[3]?.body).toEqual({ repositoryUrl: "git@github.com:octocat/hello.git", targetIds: [7] });
    expect(await findLink(cwd())).toMatchObject({ serviceId: 12 });
  });

  it("연결되지_않은_서버도_고를_수_있지만_배포는_연결_뒤에_된다고_경고한다", async () => {
    const t = await setup([projects(), targets(), servers(), created({ targetIds: [8] })]);

    await runServicesCreate({ project: "demo", repo: REPO, target: "lab2", link: false }, t.deps);

    expect(t.calls[3]?.body).toMatchObject({ targetIds: [8] });
    expect(t.warn).toHaveBeenCalledWith(
      expect.stringContaining("서버 lab2 은 아직 연결되지 않았습니다 (대기). 서비스는 만들지만 연결되기 전에는 배포할 수 없습니다."),
    );
  });

  it("타깃_이름이나_id_로도_고른다", async () => {
    const t = await setup([projects(), targets(), servers(), created()]);

    await runServicesCreate({ project: "demo", repo: REPO, target: "onprem-k3x9q2ma", link: false }, t.deps);

    expect(t.calls[3]?.body).toMatchObject({ targetIds: [7] });
  });

  it("타깃에_서버_이름이_있으면_서버_목록을_부르지_않고_null_필드는_공용_타깃으로_본다", async () => {
    const t = await setup([
      projects(),
      envelope([
        { id: 1, name: "aws", kind: "AWS", onpremServerId: null, onpremServerName: null, connectionStatus: null },
        { id: 7, name: "onprem-k3x9q2ma", kind: "ONPREM", onpremServerId: 3, onpremServerName: "home-lab", connectionStatus: "CONNECTED" },
      ]),
      created(),
    ]);
    const ask = vi.fn().mockResolvedValueOnce("2");

    await runServicesCreate({ project: "demo", repo: REPO, link: false }, { ...t.deps, ask });

    expect(t.lines()).toEqual(expect.arrayContaining(["  1) aws (공용)", "  2) home-lab (내 서버, 연결됨)"]));
    expect(t.pathOf(2)).toBe("/api/v1/projects/1/services");
    expect(t.calls[2]?.body).toMatchObject({ targetIds: [7] });
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("내_서버가_없으면_서버_목록을_부르지_않는다", async () => {
    const t = await setup([projects(), envelope([{ id: 1, name: "aws", kind: "AWS" }]), created({ targetIds: [1] })]);

    await runServicesCreate({ project: "demo", repo: REPO, target: "aws", link: false }, t.deps);

    expect(t.pathOf(2)).toBe("/api/v1/projects/1/services");
    expect(t.calls[2]?.body).toMatchObject({ targetIds: [1] });
  });

  it("없는_타깃이면_가능한_값을_알리고_만들지_않는다", async () => {
    const t = await setup([projects(), targets(), servers()]);

    await expect(
      runServicesCreate({ project: "demo", repo: REPO, target: "nope", link: false }, t.deps),
    ).rejects.toThrow("찾을 수 없습니다: 타깃 'nope'. 가능한 값: aws, home-lab, lab2");
    expect(t.calls).toHaveLength(3);
  });

  it("대화형이_아니고_타깃도_없으면_서버_기본(aws)을_쓰고_origin_을_저장소로_쓰며_연결하지_않는다", async () => {
    const t = await setup([projects(), created({ targetIds: [1] })]);
    t.findRepository.mockResolvedValue(REPO);

    await runServicesCreate({ project: "demo" }, t.deps);

    expect(t.calls[1]?.body).toEqual({ repositoryUrl: REPO });
    expect(t.lines()).toContain(`저장소: ${REPO} (현재 폴더의 git origin)`);
    expect(t.lines()).toContain("서비스를 만들었습니다: demo / hello (서비스 12, 브랜치 main, 타깃 aws (기본))");
    expect(t.lines().at(-1)).toBe("배포할 폴더에서 `likelion link --project demo --service hello` 로 연결하세요.");
    expect(await findLink(cwd())).toBeNull();
  });

  it("저장소를_알_수_없으면_repo_를_안내하고_만들지_않는다", async () => {
    const t = await setup([projects()]);

    await expect(runServicesCreate({ project: "demo" }, t.deps)).rejects.toThrow("--repo");
    expect(t.calls).toHaveLength(1);
  });

  it("연결을_물었을_때_아니라고_하면_연결하지_않는다", async () => {
    const t = await setup([projects(), targets(), servers(), created()]);
    const ask = vi.fn().mockResolvedValueOnce("n");

    await runServicesCreate({ project: "demo", repo: REPO, target: "home-lab" }, { ...t.deps, ask });

    expect(await findLink(cwd())).toBeNull();
  });

  it.each([
    [
      errorEnvelope(409, "SERVICE_NAME_CONFLICT", "service name already exists"),
      "'demo' 프로젝트에 같은 이름의 서비스가 이미 있습니다. --name 으로 다른 이름을 정해 주세요.",
    ],
    [errorEnvelope(422, "INVALID_INPUT", "branch not found in repository"), "저장소에 그 브랜치가 없습니다."],
    [errorEnvelope(422, "INVALID_INPUT", "not a github repository url"), "GitHub 저장소 주소가 아닙니다."],
    [errorEnvelope(422, "INVALID_INPUT", "unknown target"), "그 타깃은 쓸 수 없습니다."],
    [
      errorEnvelope(422, "INVALID_INPUT", "service name must be lowercase letters, digits and hyphens"),
      "서비스 이름은 영문 소문자·숫자·하이픈만",
    ],
    [errorEnvelope(422, "INVALID_INPUT", "something new"), "입력이 올바르지 않습니다: something new"],
    [errorEnvelope(403, "REPOSITORY_NOT_ACCESSIBLE", "repository not accessible"), "GitHub App 이 이 저장소에 설치돼"],
    [errorEnvelope(404, "PROJECT_NOT_FOUND", "project not found"), "project not found"],
  ])("서버_거절(%#)을_알기_쉬운_메시지로_바꾼다", async (response, message) => {
    const t = await setup([projects(), response]);

    await expect(runServicesCreate({ project: "demo", repo: REPO, link: true }, t.deps)).rejects.toThrow(
      message,
    );
    expect(await findLink(cwd())).toBeNull();
  });

  it("스키마_검증_실패는_필드별_사유를_보여_준다", async () => {
    const t = await setup([
      projects(),
      new Response(
        JSON.stringify({
          success: false,
          code: "VALIDATION_ERROR",
          message: "request validation failed",
          details: [{ field: "name", reason: "String should have at most 63 characters" }],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    ]);

    await expect(runServicesCreate({ project: "demo", repo: REPO, name: "x".repeat(64) }, t.deps)).rejects.toThrow(
      "입력이 올바르지 않습니다 (name: String should have at most 63 characters)",
    );
  });

  it("로그인_전이면_login_안내", async () => {
    await expect(runServicesCreate({}, { cwd: cwd(), log: vi.fn() })).rejects.toThrow("likelion login");
  });
});
