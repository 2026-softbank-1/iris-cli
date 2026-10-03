import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runLink } from "./commands/link.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runLogs } from "./commands/logs.js";
import { runOpen } from "./commands/open.js";
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

  return program;
}
