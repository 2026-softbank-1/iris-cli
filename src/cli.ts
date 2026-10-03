import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runLink } from "./commands/link.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runLogs } from "./commands/logs.js";
import { runOpen } from "./commands/open.js";
import {
  runServersAdd,
  runServersList,
  runServersRemove,
  runServersToken,
} from "./commands/servers.js";
import { runStatus } from "./commands/status.js";
import { runUp } from "./commands/up.js";
import { runWhoami } from "./commands/whoami.js";
import { DEFAULT_API_URL, resolveApiUrl } from "./lib/config.js";
import { createAsk } from "./lib/prompt.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("likelion")
    .description("Likelion CLI")
    .version(pkg.version, "-v, --version");

  program
    .command("login")
    .description("GitHub 계정으로 로그인한다")
    .option("--api-url <url>", `Control API 주소 (기본: LIKELION_API_URL 또는 ${DEFAULT_API_URL})`)
    .option("--no-browser", "브라우저를 자동으로 열지 않고 주소만 출력한다")
    .action(async (options: { apiUrl?: string; browser: boolean }) => {
      await runLogin({ apiUrl: resolveApiUrl(options.apiUrl), browser: options.browser });
    });

  program
    .command("whoami")
    .description("로그인한 GitHub 계정을 보여 준다")
    .action(async () => {
      await runWhoami();
    });

  program
    .command("logout")
    .description("저장된 로그인 정보를 지운다")
    .action(async () => {
      await runLogout();
    });

  program
    .command("link")
    .description("현재 폴더를 서비스에 연결한다")
    .option("--project <id|name>", "연결할 프로젝트 (생략하면 목록에서 고른다)")
    .option("--service <id|name>", "연결할 서비스 (생략하면 목록에서 고른다)")
    .action(async (options: { project?: string; service?: string }) => {
      await runLink(options, { ask: createAsk() });
    });

  program
    .command("status")
    .description("연결된 서비스의 최근 배포 상태를 보여 준다")
    .action(async () => {
      await runStatus();
    });

  program
    .command("logs")
    .description("연결된 서비스의 런타임 로그를 보여 준다")
    .option("-f, --follow", "새 로그를 계속 따라간다", false)
    .option("--since <duration>", "조회 기간 (예: 30m, 1h, 2d, 최대 7d)", "1h")
    .option("-n, --limit <count>", "최대 줄 수 (1~1000)", "200")
    .option("--search <text>", "이 문자열이 든 줄만 본다 (대소문자 구분)")
    .option("--target <id|name>", "배포 타깃 (타깃이 여러 개일 때)")
    .action(
      async (options: {
        follow: boolean;
        since: string;
        limit: string;
        search?: string;
        target?: string;
      }) => {
        await runLogs({ ...options, limit: Number(options.limit) });
      },
    );

  program
    .command("open")
    .description("배포된 서비스 주소를 브라우저로 연다")
    .option("--target <id|name>", "배포 타깃 (타깃이 여러 개일 때)")
    .option("--no-browser", "브라우저를 열지 않고 주소만 출력한다")
    .action(async (options: { target?: string; browser: boolean }) => {
      await runOpen(options);
    });

  program
    .command("up")
    .description("연결된 폴더를 올려 배포한다")
    .option("--detach", "배포 요청만 보내고 끝까지 기다리지 않는다", false)
    .action(async (options: { detach: boolean }) => {
      await runUp(options);
    });

  const servers = program.command("servers").description("배포 대상으로 붙인 내 서버(온프레미스)를 관리한다");

  servers
    .command("list", { isDefault: true })
    .description("내 서버 목록과 연결 상태를 보여 준다")
    .action(async () => {
      await runServersList();
    });

  servers
    .command("add")
    .description("서버를 등록하고 서버에서 실행할 설치 명령을 보여 준다")
    .argument("<name>", "서버 이름 (1~63자)")
    .option("--no-wait", "설치 명령만 보여 주고 연결될 때까지 기다리지 않는다")
    .action(async (name: string, options: { wait: boolean }) => {
      await withInterrupt((signal) => runServersAdd({ name, wait: options.wait }, { signal }));
    });

  servers
    .command("token")
    .description("등록 토큰을 다시 발급해 새 설치 명령을 보여 준다")
    .argument("<server>", "서버 이름 또는 id")
    .option("--no-wait", "설치 명령만 보여 주고 연결될 때까지 기다리지 않는다")
    .action(async (server: string, options: { wait: boolean }) => {
      await withInterrupt((signal) => runServersToken({ server, wait: options.wait }, { signal }));
    });

  servers
    .command("remove")
    .alias("rm")
    .description("서버를 삭제한다")
    .argument("<server>", "서버 이름 또는 id")
    .option("-y, --yes", "묻지 않고 삭제한다", false)
    .action(async (server: string, options: { yes: boolean }) => {
      await runServersRemove({ server, yes: options.yes }, { ask: createAsk() });
    });

  return program;
}

/** Ctrl+C 를 한 번 누르면 signal 로 알려 정리하고 끝내게 한다. 두 번째는 원래대로 바로 끝난다. */
async function withInterrupt<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    return await run(controller.signal);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
