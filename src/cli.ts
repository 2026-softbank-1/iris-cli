import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runWhoami } from "./commands/whoami.js";
import { DEFAULT_API_URL, resolveApiUrl } from "./lib/config.js";

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

  return program;
}
