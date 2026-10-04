import { describe, expect, it, vi } from "vitest";
import {
  runServersAdd,
  runServersList,
  runServersRemove,
  runServersToken,
  type ServersDeps,
} from "../src/commands/servers.js";
import { envelope, errorEnvelope, fakeFetch, loginAs, useTempConfigDir } from "./helpers.js";

useTempConfigDir();

const INSTALL_COMMAND =
  "curl -fsSL https://api.example.test/api/v1/onprem-servers/install.sh | sudo bash -s -- --token reg-fixture";

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: "home-lab",
    serverKey: "k3x9q2ma",
    status: "PENDING",
    targetId: 7,
    registrationExpiresAt: "2026-10-05T03:00:00Z",
    createdAt: "2026-10-04T03:00:00Z",
    ...overrides,
  };
}

const registration = (overrides: Record<string, unknown> = {}) =>
  envelope(
    { server: server(overrides), registrationToken: "reg-fixture", installCommand: INSTALL_COMMAND },
    { status: 201 },
  );
const serverList = (...items: Record<string, unknown>[]) => envelope(items.length > 0 ? items : [server()]);
const noContent = () => new Response(null, { status: 204 });
const gatewayTimeout = () => new Response("Gateway Timeout", { status: 504 });

// 2026-10-04T03:00:00Z. 등록 토큰은 하루 뒤 만료된다.
const START = Date.parse("2026-10-04T03:00:00Z");

async function setup(responses: (Response | Error)[], extra: Partial<ServersDeps> = {}) {
  await loginAs();
  const { fetchImpl, calls } = fakeFetch(responses);
  let clock = START;
  const log = vi.fn();
  const warn = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: ServersDeps = { fetchImpl, log, warn, sleep, now: () => clock, ...extra };
  const lines = () => log.mock.calls.map(([line]) => String(line));
  const pathOf = (index: number) => new URL(calls[index]?.url ?? "").pathname;
  const advance = (ms: number) => {
    clock += ms;
  };
  return { calls, log, warn, sleep, deps, lines, pathOf, advance };
}

describe("runServersList", () => {
  it("이름·한글_상태·서버_키·tailnet_주소·연결_시각을_표로_보여_준다", async () => {
    const t = await setup([
      serverList(
        server({
          status: "CONNECTED",
          tailnetFqdn: "iris-k3x9q2ma.tailb046e8.ts.net",
          connectedAt: "2026-10-04T03:10:00Z",
        }),
        server({ id: 4, name: "lab2", serverKey: "p7m2x8qa", status: "FAILED", failureCode: "CONNECT_TIMED_OUT" }),
        server({ id: 5, name: "lab3", serverKey: "r9n4c2wd", status: "REGISTERING" }),
        server({ id: 6, name: "lab4", serverKey: "t2b8v5ke" }),
      ),
    ]);

    await runServersList({}, t.deps);

    expect(t.pathOf(0)).toBe("/api/v1/onprem-servers");
    expect(t.calls[0]?.headers.Authorization).toBe("Bearer jwt-1");
    expect(t.lines()).toEqual([
      "이름      상태                      서버 키   tailnet 주소                     연결 시각",
      "home-lab  연결됨                    k3x9q2ma  iris-k3x9q2ma.tailb046e8.ts.net  2026-10-04T03:10:00Z",
      "lab2      실패 (CONNECT_TIMED_OUT)  p7m2x8qa  -                                -",
      "lab3      연결 중                   r9n4c2wd  -                                -",
      "lab4      대기                      t2b8v5ke  -                                -",
    ]);
  });

  it("서버가_없으면_servers_add_를_안내한다", async () => {
    const t = await setup([envelope([])]);

    await runServersList({}, t.deps);

    expect(t.lines()).toEqual([
      "등록한 서버가 없습니다. `likelion servers add <이름>` 으로 서버를 등록하세요.",
    ]);
  });

  it("로그인_전이면_login_안내", async () => {
    await expect(runServersList({}, { log: vi.fn() })).rejects.toThrow("likelion login");
  });
});

describe("runServersAdd", () => {
  it("등록하고_설치_명령과_만료를_보여_준_뒤_연결될_때까지_상태_변화를_찍는다", async () => {
    const t = await setup([
      registration(),
      envelope(server()),
      envelope(server({ status: "REGISTERING" })),
      envelope(server({ status: "REGISTERING" })),
      envelope(
        server({ status: "CONNECTED", tailnetFqdn: "iris-k3x9q2ma.tailb046e8.ts.net", connectedAt: "2026-10-04T03:00:12Z" }),
      ),
    ]);

    const result = await runServersAdd({ name: " home-lab ", wait: true }, t.deps);

    expect(result.status).toBe("CONNECTED");
    expect(t.calls[0]?.method).toBe("POST");
    expect(t.pathOf(0)).toBe("/api/v1/onprem-servers");
    expect(t.calls[0]?.body).toEqual({ name: "home-lab" });
    expect(t.pathOf(1)).toBe("/api/v1/onprem-servers/3");
    expect(t.sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 3000, 3000, 3000]);

    const lines = t.lines();
    expect(lines).toContain("서버를 등록했습니다: home-lab (서버 키 k3x9q2ma)");
    expect(lines).toContain("서버에서 실행하세요 (Ubuntu 22.04/24.04, sudo):");
    expect(lines).toContain(`  ${INSTALL_COMMAND}`);
    expect(lines).toContain("이 명령의 토큰은 2026-10-05T03:00:00Z 까지 유효하고 지금 한 번만 보여 줍니다.");
    expect(lines).toContain("만료되면 `likelion servers token home-lab` 으로 다시 발급하세요.");
    expect(lines.filter((line) => line.startsWith("  ") && line.includes("(+"))).toEqual([
      "  대기 (+0s)",
      "  연결 중 (+6s)",
      "  연결됨 (+12s)",
    ]);
    expect(lines).toContain("서버가 연결되었습니다: home-lab (iris-k3x9q2ma.tailb046e8.ts.net)");
    expect(lines.at(-1)).toContain("likelion services create --target home-lab");
    // 토큰은 설치 명령 안에서만 보인다.
    expect(lines.filter((line) => line.includes("reg-fixture"))).toEqual([`  ${INSTALL_COMMAND}`]);
  });

  it("no_wait_면_설치_명령만_보여_주고_상태를_확인하지_않는다", async () => {
    const t = await setup([registration()]);

    await runServersAdd({ name: "home-lab", wait: false }, t.deps);

    expect(t.calls).toHaveLength(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines().at(-1)).toBe("연결 상태는 `likelion servers` 로 확인하세요.");
  });

  it("대화형이_아니면_기본으로_기다리지_않는다", async () => {
    const t = await setup([registration()], { isInteractive: false });

    await runServersAdd({ name: "home-lab" }, t.deps);

    expect(t.calls).toHaveLength(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.lines().at(-1)).toBe("연결 상태는 `likelion servers` 로 확인하세요.");
  });

  it("대화형이면_기본으로_기다리고_wait_를_주면_대화형이_아니어도_기다린다", async () => {
    const interactive = await setup([registration(), envelope(server({ status: "CONNECTED" }))], {
      isInteractive: true,
    });
    await runServersAdd({ name: "home-lab" }, interactive.deps);
    expect(interactive.calls).toHaveLength(2);

    const forced = await setup([registration(), envelope(server({ status: "CONNECTED" }))], {
      isInteractive: false,
    });
    await runServersAdd({ name: "home-lab", wait: true }, forced.deps);
    expect(forced.calls).toHaveLength(2);
  });

  it("20분이_지나도_연결되지_않으면_기다리기를_멈추고_servers_로_이어서_확인하라고_안내한다", async () => {
    const t = await setup([registration(), envelope(server()), envelope(server({ status: "REGISTERING" }))]);
    t.sleep.mockImplementation(async () => t.advance(10 * 60_000));

    const result = await runServersAdd({ name: "home-lab", wait: true }, t.deps);

    expect(result.status).toBe("REGISTERING");
    expect(t.calls).toHaveLength(3);
    expect(t.lines().at(-1)).toBe(
      "20분 동안 연결되지 않아 기다리기를 멈춥니다. 연결 확인은 `likelion servers` 로 계속할 수 있습니다.",
    );
  });

  it("연결이_실패하면_사유와_토큰_재발급을_안내한다", async () => {
    const t = await setup([
      registration(),
      envelope(server({ status: "REGISTERING" })),
      envelope(server({ status: "FAILED", failureCode: "CONNECT_TIMED_OUT" })),
    ]);

    const failure = runServersAdd({ name: "home-lab", wait: true }, t.deps);

    await expect(failure).rejects.toThrow("서버 연결에 실패했습니다 (CONNECT_TIMED_OUT)");
    await expect(failure).rejects.toThrow("likelion servers token home-lab");
  });

  it("대기_중에_등록_토큰이_만료되면_재발급을_안내하고_멈춘다", async () => {
    const t = await setup(
      [registration({ registrationExpiresAt: "2026-10-04T03:00:02Z" }), envelope(server({ registrationExpiresAt: "2026-10-04T03:00:02Z" }))],
    );

    await expect(runServersAdd({ name: "home-lab", wait: true }, t.deps)).rejects.toThrow(
      "등록 토큰이 만료되었습니다. `likelion servers token home-lab` 으로 다시 발급하세요.",
    );
    expect(t.calls).toHaveLength(2);
  });

  it("Ctrl+C_로_멈추면_등록은_남는다고_알리고_정상_종료한다", async () => {
    const controller = new AbortController();
    const t = await setup([registration(), envelope(server())], { signal: controller.signal });
    t.sleep.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => controller.abort());

    const result = await runServersAdd({ name: "home-lab", wait: true }, t.deps);

    expect(result.status).toBe("PENDING");
    expect(t.calls).toHaveLength(2);
    expect(t.lines().at(-1)).toContain("기다리기를 멈춥니다. 서버 등록은 남아 있으니");
  });

  it("상태_확인_중_일시적인_실패는_다시_시도한다", async () => {
    const t = await setup([
      registration(),
      gatewayTimeout(),
      new Error("blip"),
      envelope(server({ status: "CONNECTED" })),
    ]);

    await runServersAdd({ name: "home-lab", wait: true }, t.deps);

    expect(t.warn).toHaveBeenCalledTimes(2);
    expect(t.warn).toHaveBeenNthCalledWith(1, expect.stringContaining("HTTP 504"));
    expect(t.sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 3000, 4000]);
  });

  it("상태_확인이_연속으로_실패하면_servers_안내로_끝낸다", async () => {
    const t = await setup([registration(), ...Array.from({ length: 6 }, gatewayTimeout)]);

    await expect(runServersAdd({ name: "home-lab", wait: true }, t.deps)).rejects.toThrow(
      "서버 상태를 연속 6회 확인하지 못해",
    );
  });

  it("같은_이름이_있으면_ONPREM_SERVER_NAME_CONFLICT_를_알기_쉽게_알린다", async () => {
    const t = await setup([errorEnvelope(409, "ONPREM_SERVER_NAME_CONFLICT", "onprem server name already exists")]);

    await expect(runServersAdd({ name: "home-lab", wait: true }, t.deps)).rejects.toThrow(
      "같은 이름의 서버가 이미 있습니다: home-lab",
    );
  });

  it("다른_409_는_이름_중복으로_보지_않고_서버_메시지와_함께_알린다", async () => {
    const t = await setup([errorEnvelope(409, "CONFLICT", "something else")]);

    const failure = runServersAdd({ name: "home-lab", wait: true }, t.deps);

    await expect(failure).rejects.toThrow("서버를 등록할 수 없습니다 (something else).");
    await expect(failure).rejects.not.toThrow("같은 이름");
  });

  it("서버_수_한도를_넘으면_ONPREM_SERVER_LIMIT_EXCEEDED_를_알기_쉽게_알린다", async () => {
    const t = await setup([errorEnvelope(409, "ONPREM_SERVER_LIMIT_EXCEEDED", "onprem server limit exceeded")]);

    const failure = runServersAdd({ name: "home-lab", wait: true }, t.deps);

    await expect(failure).rejects.toThrow("서버는 한 사람당 5대까지 등록할 수 있습니다.");
    await expect(failure).rejects.toThrow("likelion servers remove");
  });

  it("서버_등록이_설정되지_않았으면_503_을_준비_중으로_알린다", async () => {
    const t = await setup([errorEnvelope(503, "NOT_CONFIGURED", "onprem registration is not configured")]);

    await expect(runServersAdd({ name: "home-lab", wait: true }, t.deps)).rejects.toThrow(
      "서버 등록이 아직 준비되지 않았습니다.",
    );
  });

  it("이름이_규칙에_맞지_않으면_422_를_알기_쉽게_알린다", async () => {
    const t = await setup([errorEnvelope(422, "VALIDATION_ERROR", "request validation failed")]);

    await expect(runServersAdd({ name: "x".repeat(64), wait: true }, t.deps)).rejects.toThrow("1~63자");
  });

  it("빈_이름은_서버를_부르지_않고_거절한다", async () => {
    const t = await setup([]);

    await expect(runServersAdd({ name: "  ", wait: true }, t.deps)).rejects.toThrow("서버 이름을 입력해 주세요.");
    expect(t.calls).toHaveLength(0);
  });
});

describe("runServersToken", () => {
  it("이름으로_찾아_토큰을_다시_발급하고_새_설치_명령을_보여_준다", async () => {
    const t = await setup([serverList(server({ status: "FAILED" })), registration()]);

    await runServersToken({ server: "home-lab", wait: false }, t.deps);

    expect(t.calls[1]?.method).toBe("POST");
    expect(t.pathOf(1)).toBe("/api/v1/onprem-servers/3/registration-token");
    expect(t.lines()).toContain("새 등록 토큰을 발급했습니다: home-lab. 이전 명령은 더 이상 쓸 수 없습니다.");
    expect(t.lines()).toContain(`  ${INSTALL_COMMAND}`);
  });

  it("id_로도_찾고_기본으로는_연결될_때까지_기다린다", async () => {
    const t = await setup([serverList(), registration(), envelope(server({ status: "CONNECTED" }))]);

    const result = await runServersToken({ server: "3", wait: true }, t.deps);

    expect(result.status).toBe("CONNECTED");
    expect(t.pathOf(2)).toBe("/api/v1/onprem-servers/3");
  });

  it("연결_중인_서버도_다시_발급해_대기로_돌아간다", async () => {
    const t = await setup([serverList(server({ status: "REGISTERING" })), registration()]);

    const result = await runServersToken({ server: "home-lab", wait: false }, t.deps);

    expect(result.status).toBe("PENDING");
    expect(t.pathOf(1)).toBe("/api/v1/onprem-servers/3/registration-token");
    expect(t.lines()).toContain(`  ${INSTALL_COMMAND}`);
  });

  it("서버_등록이_설정되지_않았으면_재발급도_준비_중으로_알린다", async () => {
    const t = await setup([
      serverList(server({ status: "FAILED" })),
      errorEnvelope(503, "NOT_CONFIGURED", "onprem registration is not configured"),
    ]);

    await expect(runServersToken({ server: "home-lab", wait: false }, t.deps)).rejects.toThrow(
      "서버 등록이 아직 준비되지 않았습니다.",
    );
  });

  it("연결된_서버면_409_를_상태와_함께_알린다", async () => {
    const t = await setup([
      serverList(server({ status: "CONNECTED" })),
      errorEnvelope(409, "INVALID_STATUS_TRANSITION", "invalid status transition"),
    ]);

    await expect(runServersToken({ server: "home-lab", wait: false }, t.deps)).rejects.toThrow(
      "home-lab 은 지금 연결됨 상태라 토큰을 다시 발급할 수 없습니다. 대기·연결 중·실패 상태에서만 다시 발급합니다.",
    );
  });

  it("없는_서버면_가능한_값을_알린다", async () => {
    const t = await setup([serverList()]);

    await expect(runServersToken({ server: "nope", wait: false }, t.deps)).rejects.toThrow(
      "찾을 수 없습니다: 서버 'nope'. 가능한 값: home-lab(3)",
    );
    expect(t.calls).toHaveLength(1);
  });

  it("서버가_하나도_없으면_servers_add_를_안내한다", async () => {
    const t = await setup([envelope([])]);

    await expect(runServersToken({ server: "home-lab", wait: false }, t.deps)).rejects.toThrow(
      "likelion servers add",
    );
  });
});

describe("runServersRemove", () => {
  it("확인을_받고_삭제한다", async () => {
    const ask = vi.fn().mockResolvedValue("y");
    const t = await setup([serverList(), noContent()], { ask });

    const isRemoved = await runServersRemove({ server: "home-lab", yes: false }, t.deps);

    expect(isRemoved).toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("서버 home-lab (k3x9q2ma) 를 삭제할까요?"));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("(y/N)"));
    expect(t.calls[1]?.method).toBe("DELETE");
    expect(t.pathOf(1)).toBe("/api/v1/onprem-servers/3");
    expect(t.lines().at(-1)).toContain("서버를 삭제했습니다: home-lab.");
  });

  it.each([["n"], [""]])("답이_%j_면_삭제하지_않는다", async (answer) => {
    const ask = vi.fn().mockResolvedValue(answer);
    const t = await setup([serverList()], { ask });

    const isRemoved = await runServersRemove({ server: "home-lab", yes: false }, t.deps);

    expect(isRemoved).toBe(false);
    expect(t.calls).toHaveLength(1);
    expect(t.lines()).toEqual(["삭제하지 않았습니다."]);
  });

  it("yes_면_묻지_않고_삭제한다", async () => {
    const ask = vi.fn();
    const t = await setup([serverList(), noContent()], { ask });

    await runServersRemove({ server: "3", yes: true }, t.deps);

    expect(ask).not.toHaveBeenCalled();
    expect(t.calls[1]?.method).toBe("DELETE");
  });

  it("대화형이_아니고_yes_도_없으면_삭제하지_않고_yes_를_안내한다", async () => {
    const t = await setup([serverList()]);

    await expect(runServersRemove({ server: "home-lab", yes: false }, t.deps)).rejects.toThrow("--yes");
    expect(t.calls).toHaveLength(1);
  });

  it("서비스가_붙어_있으면_ONPREM_SERVER_IN_USE_를_알기_쉽게_알린다", async () => {
    const t = await setup([
      serverList(),
      errorEnvelope(409, "ONPREM_SERVER_IN_USE", "onprem server is in use"),
    ]);

    await expect(runServersRemove({ server: "home-lab", yes: true }, t.deps)).rejects.toThrow(
      "이 서버에 배포하는 서비스가 있어 삭제할 수 없습니다: home-lab. 그 서비스를 먼저 삭제해 주세요.",
    );
  });
});

describe("runServersList json", () => {
  it("json_이면_서버_목록을_그대로_JSON_으로_낸다", async () => {
    const t = await setup([serverList(server({ status: "CONNECTED" }))]);

    await runServersList({ json: true }, t.deps);

    expect(t.lines()).toHaveLength(1);
    expect(JSON.parse(t.lines()[0] ?? "")[0]).toMatchObject({ name: "home-lab", status: "CONNECTED" });
  });
});
