import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runDeploy } from "./commands/deploy.js";
import { runDeploymentsList, runDeploymentsShow } from "./commands/deployments.js";
import { runDiagnose } from "./commands/diagnose.js";
import { runEnvList, runEnvPull, runEnvPush, runEnvSet, runEnvUnset } from "./commands/env.js";
import { runFix } from "./commands/fix.js";
import { runLink } from "./commands/link.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { type LogsCommandOptions, runLogsCommand } from "./commands/logsCommand.js";
import { runOpen } from "./commands/open.js";
import {
  runServersAdd,
  runServersList,
  runServersRemove,
  runServersToken,
} from "./commands/servers.js";
import { runServicesCreate, type ServicesCreateOptions } from "./commands/services.js";
import { runSetupAgent } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runUp } from "./commands/up.js";
import { runWhoami } from "./commands/whoami.js";
import { DEFAULT_API_URL, resolveApiUrl } from "./lib/config.js";
import { createAsk } from "./lib/prompt.js";

export interface ProgramOptions {
  /** 옵션 파싱 오류를 commander 가 stderr 에 쓰지 않게 한다. `--json` 은 JSON 오류 한 줄만 내기 위해 쓴다 */
  quietParseErrors?: boolean;
}

export function buildProgram(options: ProgramOptions = {}): Command {
  // exitOverride: commander 가 직접 process.exit 하지 않고 던지게 해 `src/index.ts` 가 종료 코드(사용법 오류 = 2)를 정한다.
  const program = new Command()
    .name("likelion")
    .description("Likelion CLI")
    .version(pkg.version, "-v, --version")
    .exitOverride();
  if (options.quietParseErrors) program.configureOutput({ writeErr: () => {} });
  program.addHelpText(
    "after",
    [
      "",
      "에이전트(LLM)에서 쓰기:",
      "  likelion setup agent     Claude Code 등이 읽는 스킬(SKILL.md)을 설치한다",
      "  --json                   stdout 에 JSON 만 낸다 (진행 안내·오류는 stderr)",
      "  LIKELION_TOKEN           저장된 로그인 대신 쓸 토큰 (CI·원격 환경)",
      "  종료 코드                0 성공 · 1 실패 · 2 사용법 · 3 인증 · 4 결과 실패(배포 실패 등) · 5 일시적 오류",
    ].join("\n"),
  );

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
    .option("--json", "JSON 으로 낸다", false)
    .action(async (options: { json: boolean }) => {
      await runWhoami(options);
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
    .option("--json", "진행 안내는 stderr 로 보내고 stdout 에는 연결 정보 JSON 만 낸다 (묻지 않는다)", false)
    .action(async (options: { project?: string; service?: string; json: boolean }) => {
      await runLink(options, { ask: askUnlessJson(options.json) });
    });

  program
    .command("status")
    .description("연결된 서비스의 최근 배포 상태를 보여 준다")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (options: { json: boolean }) => {
      await runStatus(options);
    });

  program
    .command("logs")
    .description("연결된 서비스의 런타임 로그를 보여 준다 (--build·--deploy·--network 면 배포 하나의 로그)")
    .option("-f, --follow", "새 로그를 계속 따라간다 (런타임·--build)", false)
    .option("--since <duration>", "조회 기간 (예: 30m, 1h, 2d, 최대 7d). 런타임 로그만", "1h")
    .option("-n, --limit <count>", "최대 줄 수 (1~1000). --build 는 마지막 N줄만 보여 준다(생략하면 전부)", "200")
    .option("--search <text>", "이 문자열이 든 줄만 본다 (대소문자 구분). 런타임·--deploy")
    .option("--target <id|name>", "배포 타깃 (타깃이 여러 개일 때)")
    .option("--build", "배포의 빌드 로그(CodeBuild)를 본다", false)
    .option("--deploy", "배포의 런타임 로그(이 배포의 release 로 거른 것)를 본다", false)
    .option("--network", "배포의 네트워크 로그(ALB 접근 로그)를 본다", false)
    .option("--deployment <id>", "--build·--deploy·--network 대상 배포 번호 (기본: 가장 최근 배포)")
    .option("--status-class <class>", "--network 의 응답 코드 범위 (2xx·3xx·4xx·5xx)")
    .option("--json", "줄마다 로그 항목을 JSON 한 줄로 낸다 (JSON Lines)", false)
    .action(async (options: LogsCommandOptions, command: Command) => {
      await runLogsCommand(options, command.getOptionValueSource("limit"));
    });

  program
    .command("open")
    .description("배포된 서비스 주소를 브라우저로 연다")
    .option("--target <id|name>", "배포 타깃 (타깃이 여러 개일 때)")
    .option("--no-browser", "브라우저를 열지 않고 주소만 출력한다")
    .option("--json", "브라우저를 열지 않고 주소 목록을 JSON 으로 낸다", false)
    .action(async (options: { target?: string; browser: boolean; json: boolean }) => {
      await runOpen(options);
    });

  program
    .command("up")
    .description("연결된 폴더를 올려 배포한다")
    .option("--detach", "배포 요청만 보내고 끝까지 기다리지 않는다", false)
    .option("--logs", "기다리는 동안 빌드 로그도 보여 준다", false)
    .option("--json", "진행 안내는 stderr 로 보내고 stdout 에는 배포 결과 JSON 만 낸다", false)
    .action(async (options: { detach: boolean; logs: boolean; json: boolean }) => {
      await runUp(options);
    });

  const deployments = program
    .command("deployments")
    .description("배포 이력과 배포 상세를 본다");

  deployments
    .command("list", { isDefault: true })
    .description("연결된 서비스의 배포 이력을 최신순으로 보여 준다")
    .option("-n, --limit <count>", "최대 건수 (1~100)", "20")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (options: { limit: string; json: boolean }) => {
      await runDeploymentsList({ limit: Number(options.limit), json: options.json });
    });

  deployments
    .command("show")
    .description("배포 하나의 상태·소스·빌드·단계·반영 결과를 보여 준다")
    .argument("[deployment]", "배포 번호 (기본: 가장 최근 배포)")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (deployment: string | undefined, options: { json: boolean }) => {
      await runDeploymentsShow({ deployment, json: options.json });
    });

  addDeployFlags(
    program
      .command("deploy")
      .description("GitHub 브랜치의 최신 커밋(또는 지정한 커밋)을 빌드해 배포한다")
      .option("--sha <commit>", "배포할 커밋 SHA (기본: 브랜치 최신 커밋)"),
  ).action(async (options: { sha?: string; detach: boolean; logs: boolean; json: boolean }) => {
    await runDeploy({ kind: "deploy", ...options });
  });

  addDeployFlags(
    program
      .command("redeploy")
      .description("지난 배포의 커밋을 다시 빌드해 배포한다 (`up` 으로 올린 배포는 소스가 남지 않아 안 된다)")
      .argument("[deployment]", "원본 배포 번호 (기본: 가장 최근 배포)"),
  ).action(
    async (
      deployment: string | undefined,
      options: { detach: boolean; logs: boolean; json: boolean },
    ) => {
      await runDeploy({ kind: "redeploy", deployment, ...options });
    },
  );

  addDeployFlags(
    program
      .command("rollback")
      .description("성공했던 배포의 이미지를 빌드 없이 다시 배포해 되돌린다")
      .argument("<deployment>", "되돌릴 배포 번호 (`likelion deployments` 로 확인)"),
  ).action(
    async (deployment: string, options: { detach: boolean; logs: boolean; json: boolean }) => {
      await runDeploy({ kind: "rollback", deployment, ...options });
    },
  );

  addDeployFlags(
    program
      .command("restart")
      .description("지금 떠 있는 배포의 이미지를 빌드 없이 다시 띄워 Pod 를 새로 시작한다"),
  ).action(async (options: { detach: boolean; logs: boolean; json: boolean }) => {
    await runDeploy({ kind: "restart", ...options });
  });

  const env = program.command("env").description("서비스 환경변수를 관리한다");

  env
    .command("list", { isDefault: true })
    .alias("ls")
    .description("환경변수를 보여 준다 (기본은 이름과 값의 길이만)")
    .option("--show-values", "값까지 보여 준다", false)
    .option("--json", "JSON 으로 낸다 (--show-values 가 없으면 값은 뺀다)", false)
    .action(async (options: { showValues: boolean; json: boolean }) => {
      await runEnvList(options);
    });

  env
    .command("set")
    .description("환경변수를 추가하거나 값을 바꾼다")
    .argument("<assignments...>", "KEY=VALUE (여러 개 가능)")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (assignments: string[], options: { json: boolean }) => {
      await runEnvSet({ assignments, json: options.json });
    });

  env
    .command("unset")
    .alias("rm")
    .description("환경변수를 지운다")
    .argument("<keys...>", "지울 변수 이름 (여러 개 가능)")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (keys: string[], options: { json: boolean }) => {
      await runEnvUnset({ keys, json: options.json });
    });

  env
    .command("pull")
    .description("환경변수를 .env 파일로 내려받는다")
    .argument("[file]", "저장할 파일 (기본: .env)")
    .option("--force", "이미 있는 파일을 덮어쓴다", false)
    .action(async (file: string | undefined, options: { force: boolean }) => {
      await runEnvPull({ file, force: options.force });
    });

  env
    .command("push")
    .description(".env 파일 내용으로 환경변수 전체를 교체한다 (파일에 없는 변수는 삭제된다)")
    .argument("[file]", "올릴 파일 (기본: .env)")
    .option("-y, --yes", "묻지 않고 교체한다", false)
    .option("--json", "JSON 으로 낸다", false)
    .action(async (file: string | undefined, options: { yes: boolean; json: boolean }) => {
      await runEnvPush({ file, yes: options.yes, json: options.json }, { ask: askUnlessJson(options.json) });
    });

  program
    .command("diagnose")
    .description("실패한 배포의 AI 진단(원인·해결책)을 보여 준다. 없으면 시작한다")
    .argument("[deployment]", "배포 번호 (기본: 가장 최근 배포)")
    .option("--refresh", "성공한 진단이 있어도 새로 진단한다 (모델 비용이 든다)", false)
    .option("--no-wait", "진단이 끝날 때까지 기다리지 않는다")
    .option("--evidence", "진단이 근거로 쓴 로그 줄도 보여 준다", false)
    .option("--json", "JSON 으로 낸다", false)
    .action(
      async (
        deployment: string | undefined,
        options: { refresh: boolean; wait: boolean; evidence: boolean; json: boolean },
      ) => {
        await runDiagnose({ deployment, ...options });
      },
    );

  program
    .command("fix")
    .description("실패한 배포를 AI 가 고치게 한다 (핫픽스 PR → main 머지 → 재배포)")
    .argument("[deployment]", "배포 번호 (기본: 가장 최근 배포)")
    .option("-y, --yes", "묻지 않고 진행한다 (main 에 머지·재배포하는 것을 승인한다)", false)
    .option("--detach", "수정 요청만 보내고 끝까지 기다리지 않는다", false)
    .option("--json", "진행 안내는 stderr 로 보내고 stdout 에는 결과 JSON 만 낸다", false)
    .action(
      async (
        deployment: string | undefined,
        options: { yes: boolean; detach: boolean; json: boolean },
      ) => {
        await runFix({ deployment, ...options }, { ask: askUnlessJson(options.json) });
      },
    );

  const servers = program.command("servers").description("배포 대상으로 붙인 내 서버(온프레미스)를 관리한다");

  servers
    .command("list", { isDefault: true })
    .description("내 서버 목록과 연결 상태를 보여 준다")
    .option("--json", "JSON 으로 낸다", false)
    .action(async (options: { json: boolean }) => {
      await runServersList(options);
    });

  servers
    .command("add")
    .description("서버를 등록하고 서버에서 실행할 설치 명령을 보여 준다")
    .argument("<name>", "서버 이름 (1~63자, 영문·숫자·한글·.·_·-, 공백·숫자만 불가)")
    .option("--wait", "연결될 때까지 기다린다 (대화형 터미널의 기본)")
    .option("--no-wait", "설치 명령만 보여 주고 연결될 때까지 기다리지 않는다")
    .option("--json", "stdout 에 서버와 설치 명령 JSON 만 낸다 (기다리지 않는다)", false)
    .action(async (name: string, options: { wait?: boolean; json: boolean }) => {
      await withInterrupt((signal) => runServersAdd({ name, wait: options.wait, json: options.json }, { signal }));
    });

  servers
    .command("token")
    .description("등록 토큰을 다시 발급해 새 설치 명령을 보여 준다")
    .argument("<server>", "서버 이름 또는 id")
    .option("--wait", "연결될 때까지 기다린다 (대화형 터미널의 기본)")
    .option("--no-wait", "설치 명령만 보여 주고 연결될 때까지 기다리지 않는다")
    .option("--json", "stdout 에 서버와 설치 명령 JSON 만 낸다 (기다리지 않는다)", false)
    .action(async (server: string, options: { wait?: boolean; json: boolean }) => {
      await withInterrupt((signal) =>
        runServersToken({ server, wait: options.wait, json: options.json }, { signal }),
      );
    });

  servers
    .command("remove")
    .alias("rm")
    .description("서버를 삭제한다")
    .argument("<server>", "서버 이름 또는 id")
    .option("-y, --yes", "묻지 않고 삭제한다", false)
    .option("--json", "stdout 에 삭제 결과 JSON 만 낸다 (묻지 않으니 --yes 가 필요하다)", false)
    .action(async (server: string, options: { yes: boolean; json: boolean }) => {
      await runServersRemove(
        { server, yes: options.yes, json: options.json },
        { ask: askUnlessJson(options.json) },
      );
    });

  const services = program.command("services").description("서비스를 관리한다");

  services
    .command("create")
    .description("GitHub 저장소를 연결해 서비스를 만든다")
    .option("--project <id|name>", "서비스를 만들 프로젝트 (생략하면 목록에서 고른다)")
    .option("--repo <url>", "GitHub 저장소 주소 (생략하면 현재 폴더의 git origin)")
    .option("--name <name>", "서비스 이름 (생략하면 저장소 이름)")
    .option("--branch <branch>", "배포할 브랜치 (생략하면 저장소 기본 브랜치)")
    .option("--root-dir <path>", "저장소 안의 서비스 위치 (생략하면 저장소 루트)")
    .option("--target <name|id>", "배포 타깃: aws 같은 공용 타깃 또는 내 서버 이름 (생략하면 고르거나 aws)")
    .option("--link", "만든 뒤 묻지 않고 현재 폴더를 연결한다")
    .option("--no-link", "현재 폴더를 연결하지 않는다")
    .option("--json", "진행 안내는 stderr 로 보내고 stdout 에는 만든 서비스 JSON 만 낸다 (묻지 않는다)", false)
    .action(async (options: ServicesCreateOptions) => {
      await runServicesCreate(options, { ask: askUnlessJson(options.json ?? false) });
    });

  const setup = program.command("setup").description("에이전트 연동 등을 설정한다");

  setup
    .command("agent")
    .description("에이전트(Claude Code 등)가 이 CLI 를 쓰는 법을 담은 스킬(SKILL.md)을 설치한다")
    .option("--print", "파일을 쓰지 않고 내용을 stdout 으로 낸다", false)
    .option("--global", "~/.claude/skills 에 설치한다 (기본: 현재 폴더의 .claude/skills)", false)
    .option("--dir <path>", "스킬 폴더를 직접 지정한다 (예: .agents/skills)")
    .option("--force", "내용이 다른 파일을 최신 내용으로 덮어쓴다", false)
    .option("--json", "결과를 JSON 으로 낸다", false)
    .action(
      async (options: { print: boolean; global: boolean; dir?: string; force: boolean; json: boolean }) => {
        await runSetupAgent(options);
      },
    );

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

/** `--json` 이면 사람에게 묻지 않는다(출력이 JSON 한 덩어리여야 하므로). 필요한 값은 옵션으로 받는다. */
function askUnlessJson(json: boolean): ReturnType<typeof createAsk> {
  return json ? undefined : createAsk();
}

/** 배포를 만들고 기다리는 명령이 함께 쓰는 옵션. */
function addDeployFlags(command: Command): Command {
  return command
    .option("--detach", "배포 요청만 보내고 끝까지 기다리지 않는다", false)
    .option("--logs", "기다리는 동안 빌드 로그도 보여 준다", false)
    .option("--json", "진행 안내는 stderr 로 보내고 stdout 에는 배포 결과 JSON 만 낸다", false);
}
