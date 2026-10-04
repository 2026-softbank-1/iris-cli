import { UsageError } from "../lib/errors.js";
import { type DeploymentLogKind, type DeploymentLogsDeps, runDeploymentLogs } from "./deploymentLogs.js";
import { type LogsDeps, runLogs } from "./logs.js";

/** `likelion logs` 가 받는 옵션 그대로(숫자는 아직 문자열이다). */
export interface LogsCommandOptions {
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
}

/**
 * `logs` 명령 하나로 서비스 런타임 로그와 배포별 로그(`--build`·`--deploy`·`--network`)를 가른다.
 * `limitSource` 는 commander 가 `-n` 값을 어디서 얻었는지(`cli` 면 사용자가 직접 준 것)다.
 * `--build` 는 `-n` 을 직접 줬을 때만 마지막 N줄로 줄이고, 아니면 전부 보여 준다.
 */
export async function runLogsCommand(
  options: LogsCommandOptions,
  limitSource: string | undefined,
  deps: LogsDeps & DeploymentLogsDeps = {},
): Promise<void> {
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
    await runLogs(
      {
        follow: options.follow,
        since: options.since,
        limit: Number(options.limit),
        search: options.search,
        target: options.target,
        json: options.json,
      },
      deps,
    );
    return;
  }

  await runDeploymentLogs(
    {
      kind,
      deployment: options.deployment,
      follow: options.follow,
      limit: Number(options.limit),
      tail: kind === "build" && limitSource === "cli" ? Number(options.limit) : undefined,
      search: options.search,
      target: options.target,
      statusClass: options.statusClass,
      json: options.json,
    },
    deps,
  );
}
