import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runDeploy } from "./commands/deploy.js";
import { type DeploymentLogKind, runDeploymentLogs } from "./commands/deploymentLogs.js";
import { runDeploymentsList, runDeploymentsShow } from "./commands/deployments.js";
import { runDiagnose } from "./commands/diagnose.js";
import { runEnvList, runEnvPull, runEnvPush, runEnvSet, runEnvUnset } from "./commands/env.js";
import { runFix } from "./commands/fix.js";
import { runLink } from "./commands/link.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runLogs } from "./commands/logs.js";
import { runOpen } from "./commands/open.js";
import { runStatus } from "./commands/status.js";
import { runUp } from "./commands/up.js";
import { runWhoami } from "./commands/whoami.js";
import { DEFAULT_API_URL, resolveApiUrl } from "./lib/config.js";
import { UsageError } from "./lib/errors.js";
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
    .description("연결된 서비스의 런타임 로그를 보여 준다 (--build·--deploy·--network 면 배포 하나의 로그)")
    .option("-f, --follow", "새 로그를 계속 따라간다 (런타임·--build)", false)
    .option("--since <duration>", "조회 기간 (예: 30m, 1h, 2d, 최대 7d). 런타임 로그만", "1h")
    .option("-n, --limit <count>", "최대 줄 수 (1~1000). --build 는 무시한다", "200")
    .option("--search <text>", "이 문자열이 든 줄만 본다 (대소문자 구분). 런타임·--deploy")
    .option("--target <id|name>", "배포 타깃 (타깃이 여러 개일 때)")
    .option("--build", "배포의 빌드 로그(CodeBuild)를 본다", false)
    .option("--deploy", "배포의 런타임 로그(이 배포의 release 로 거른 것)를 본다", false)
    .option("--network", "배포의 네트워크 로그(ALB 접근 로그)를 본다", false)
    .option("--deployment <id>", "--build·--deploy·--network 대상 배포 번호 (기본: 가장 최근 배포)")
    .option("--status-class <class>", "--network 의 응답 코드 범위 (2xx·3xx·4xx·5xx)")
    .option("--json", "줄마다 로그 항목을 JSON 한 줄로 낸다 (JSON Lines)", false)
    .action(
      async (options: {
        follow: boolean;
        since: string;
        limit: string;
        search?: string;
        target?: string;
        build: boolean;
        deploy: boolean;
        network: boolean;
        deployment?: string;
        statusClass?: string;
        json: boolean;
      }) => {
        const kinds: DeploymentLogKind[] = [];
        if (options.build) kinds.push("build");
        if (options.deploy) kinds.push("deploy");
        if (options.network) kinds.push("network");
        if (kinds.length > 1) throw new UsageError("--build·--deploy·--network 는 하나만 고를 수 있습니다.");
        const [kind] = kinds;
        if (kind === undefined) {
          if (options.deployment !== undefined || options.statusClass !== undefined) {
            throw new UsageError("--deployment·--status-class 는 --build·--deploy·--network 와 함께 써야 합니다.");
          }
          await runLogs({
            follow: options.follow,
            since: options.since,
            limit: Number(options.limit),
            search: options.search,
            target: options.target,
            json: options.json,
          });
          return;
        }
        await runDeploymentLogs({
          kind,
          deployment: options.deployment,
          follow: options.follow,
          limit: Number(options.limit),
          search: options.search,
          target: options.target,
          statusClass: options.statusClass,
          json: options.json,
        });
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

  return program;
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
