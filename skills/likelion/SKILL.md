---
name: likelion
description: Deploy and operate services on Likelion with the `likelion` CLI. Deploy a local folder (`likelion up`), deploy from GitHub, redeploy, roll back or restart, check status, read build/runtime/network logs, manage environment variables, and run AI diagnosis or auto-fix on failed deployments. Use when the user asks to deploy, check or debug a deployment, read logs, change env vars, or roll back a Likelion service (배포, 롤백, 로그, 환경변수, 배포 실패 원인).
compatibility: Requires the `likelion` CLI (Node.js 20+) and a login (`likelion login`) or the LIKELION_TOKEN environment variable.
---

# Likelion CLI (`likelion`)

Likelion 서비스(GitHub 저장소를 연결한 배포 서비스)를 터미널에서 배포·운영하는 CLI 다. 대시보드에서 하는 일을 거의 다 한다.

## 에이전트가 지킬 규칙

- **그냥 실행한다.** 폴더에 `.likelion/link.json`(`likelion link`가 만든다)이 있으면 어느 서비스인지 CLI 가 안다. API 를 직접 부르지 않는다.
- **파싱할 출력에는 `--json` 을 붙인다.** stdout 에는 서버 응답의 `data` JSON 만 나온다(키는 camelCase). 진행 안내와 오류는 stderr 다. 로그는 줄마다 JSON 한 줄(JSON Lines)이다.
- **질문에 답할 수 없다.** 비대화형(파이프·CI·에이전트 환경)으로 실행되면 CLI 는 절대 묻지 않는다. 필요한 값은 옵션으로 준다(`--project`·`--service`·`--yes`).
- **종료 코드를 본다.**

  | 코드 | 뜻 | 할 일 |
  |---|---|---|
  | 0 | 성공 | |
  | 1 | 서버가 거절·없음·충돌 등 | 메시지를 읽고 고친다 |
  | 2 | 사용법 오류 | 인자·옵션을 고쳐 다시 실행한다 |
  | 3 | 인증 필요 | 아래 "로그인" |
  | 4 | 실행은 됐지만 결과가 실패(배포 실패·롤백됨·AI 수정 실패) | 아래 "배포가 실패했을 때" |
  | 5 | 일시적 오류(서버에 닿지 못함·5xx·429) | 그대로 다시 시도한다 |

  `--json` 이면 오류도 stderr 에 한 줄 JSON 이다: `{"error":{"code","message","exitCode","retryable","status"?,"details"?}}`. `code` 로 분기한다(예: `DEPLOYMENT_IN_PROGRESS`, `VARIABLE_CONFLICT`).
- **사용자에게 먼저 물어야 하는 동작**: `fix`(AI 수정을 main 에 머지하고 재배포), `env push`(변수 전체 교체), `rollback`, `restart`, `servers remove`. 사용자가 시킨 경우에만 `--yes` 를 붙인다.
- **비밀을 다루는 법**: `likelion env` 는 값을 숨긴다. 사용자가 값을 달라고 할 때만 `--show-values` 를 쓰고, 값을 대화에 되풀이하거나 커밋하지 않는다. `env pull` 이 만든 `.env` 는 커밋하지 않는다.
- **출력을 작게 받는다**: `-n`(줄 수)·`--since`·`--search`·`--json | jq` 를 쓴다. 빌드 로그는 `-n` 을 주지 않으면 전부(최대 10,000줄) 나오니 `logs --build -n 100` 처럼 끝부분만 본다.

## 시작하기

```bash
likelion whoami --json     # 로그인돼 있나? (exit 3 이면 아니다)
likelion status --json     # 이 폴더에 연결된 서비스와 최근 배포
```

- **로그인(exit 3)**: 에이전트는 GitHub 로그인을 승인할 수 없다. 사용자에게 `likelion login` 을 실행해 달라고 하거나, `likelion login --no-browser` 가 출력하는 주소를 사용자에게 전달해 승인하게 한다. CI·원격 환경에서는 사용자가 준 토큰을 환경변수 `LIKELION_TOKEN` 으로 준다(저장된 로그인보다 우선한다).
- **연결 안 됨**("연결된 서비스가 없습니다"): `likelion link --project <이름|id> --service <이름|id>`. 서비스가 아직 없으면 `likelion services create --repo <GitHub 주소> --link --project <이름|id>`.

## 자주 하는 일

**폴더를 올려 배포** — 현재 폴더를 묶어 올리고 끝날 때까지 기다린다.

```bash
likelion up --json --logs   # 빌드 로그는 stderr, 최종 배포 상세 JSON 은 stdout
```

**GitHub 에서 배포 / 다시 배포 / 되돌리기 / 재시작** — 모두 끝날 때까지 기다린다(`--detach` 면 요청만).

```bash
likelion deploy --json                 # 브랜치 최신 커밋(--sha <커밋> 으로 지정)
likelion redeploy [id] --json          # 그 배포의 커밋을 다시 빌드 (up 으로 올린 배포는 불가)
likelion rollback <id> --json          # 성공했던 배포의 이미지로 되돌린다 (빌드 없음)
likelion restart --json                # Pod 새로 시작 (빌드 없음)
```

진행 중인 배포가 있으면 `DEPLOYMENT_IN_PROGRESS`(exit 1)다. 끝난 뒤 다시 한다.

**상태와 이력**

```bash
likelion deployments --json -n 10      # 이력(최신순)
likelion deployments show 12 --json    # 한 배포의 소스·빌드·단계·반영 결과
```

**로그**

```bash
likelion logs --since 30m -n 100 --json          # 서비스 런타임 로그 (-f 로 따라가기)
likelion logs --build --deployment 12 -n 100 --json   # 빌드 로그의 마지막 100줄 (-n 을 생략하면 전부, -f 면 빌드가 끝날 때까지)
likelion logs --deploy --deployment 12 --json    # 그 배포의 런타임 로그
likelion logs --network --status-class 5xx --json
```

`--deployment` 를 생략하면 가장 최근 배포다.

**환경변수** — 바꿔도 실행 중인 앱은 그대로다. 다음 배포나 `restart` 부터 반영된다.

```bash
likelion env --json                    # 이름만(값 숨김). 값은 --show-values
likelion env set KEY=VALUE OTHER=1     # 추가 또는 수정
likelion env unset KEY                 # 삭제
likelion env pull .env                 # 파일로 내려받기 (권한 0600, 덮어쓰려면 --force)
likelion env push .env --yes           # 파일 내용으로 전체 교체! 파일에 없는 변수는 삭제된다
```

**내 서버(온프레미스)에 배포** — 사용자가 자기 서버를 등록해 배포 대상으로 쓴다.

```bash
likelion servers --json                                  # 등록한 서버와 연결 상태 (CONNECTED 여야 배포된다. 연결됐던 서버의 신호가 끊기면 DISCONNECTED + lastSeenAt)
likelion servers add <이름> --json                       # {server, installCommand} 를 낸다 (기다리지 않는다). installCommand 를 사용자가 서버에서 sudo 로 실행. 이름: 1~63자, 영문·숫자·한글·.·_·- (공백·숫자만 불가)
likelion servers token <이름|id> --json                  # 토큰 만료·연결 실패 때 새 installCommand 를 받는다
likelion services create --repo <url> --target <서버 이름> --project <이름|id> --link
```

서버가 연결되기 전이거나 연결이 끊겼으면(`DISCONNECTED`) `up`·`deploy` 가 `TARGET_NOT_CONNECTED` 로 거절된다(`--json` 의 `error.code`). 끊긴 서버는 토큰 재발급이 아니라 서버가 다시 신호를 보내길 기다린다(저절로 `CONNECTED` 로 돌아온다). 등록 토큰은 `installCommand` 안에 한 번만 나오니 사용자에게 그대로 전달하고 다른 곳에 남기지 않는다. 내 서버 타깃은 런타임 로그(`logs`·`logs --deploy`)가 지금 떠 있는 Pod 의 것만 나오고(재시작·교체·중지된 Pod 의 로그는 없다), 네트워크 로그(`logs --network`)는 지원하지 않아 `NOT_SUPPORTED`(exit 1, 다시 시도해도 같다)로 끝난다. 빌드 로그는 공용 타깃과 같다.

## 배포가 실패했을 때 (exit 4)

1. `likelion deployments show <id> --json` — `failureCode` 와 `build.status` 로 어느 단계인지 본다.
2. `likelion logs --build --deployment <id> -n 200` (빌드 실패) 또는 `--deploy`·`logs --since 15m` (실행 중 실패)로 원인 줄을 찾는다.
3. `likelion diagnose <id> --json` — 서버의 AI 진단(원인 후보 `analysis.hypotheses`, 해결책 제안 `analysis.remediation.plans`). 서버는 제안만 하고 실행하지 않는다. 수정 예시의 `{{이름}}` 은 채워 쓸 자리표시자다. 진단은 실패 직후 서버가 자동으로 시작하므로 보통 결과가 바로 나온다(`--refresh` 는 새로 돌려 비용이 든다).
4. 고친다.
   - 코드 문제: 소스를 직접 고쳐 `likelion up`(또는 푸시 후 `deploy`)한다. 사용자가 원하면 `likelion fix <id> --yes` 로 AI 가 핫픽스 PR → main 머지 → 재배포까지 한다(**main 에 쓰므로 먼저 물어본다**).
   - 환경변수 값이 필요한 실패(`fix` 가 `CONFIGURATION_VALUES_REQUIRED`): 사용자에게 값을 받아 `env set` 하고 `redeploy`.
5. 급하면 `likelion rollback <마지막 성공 배포 id>`.

## 명령 한눈에 보기

| 명령 | 설명 |
|---|---|
| `login [--no-browser]` · `whoami` · `logout` | 인증 |
| `link [--project --service]` | 폴더를 서비스에 연결 |
| `services create --repo <url> [--project --name --branch --root-dir --target --link]` | GitHub 저장소로 서비스 만들기 |
| `servers [add\|token\|remove]` | 내 서버(온프레미스) 등록·관리 |
| `status` · `open [--target]` | 상태·주소 |
| `up [--detach --logs]` | 현재 폴더를 올려 배포 |
| `deploy [--sha]` · `redeploy [id]` · `rollback <id>` · `restart` | 배포 요청 |
| `deployments [-n]` · `deployments show [id]` | 이력·상세 |
| `logs [-f --since -n --search --target]` + `--build\|--deploy\|--network [--deployment --status-class]` | 로그 |
| `env [list\|set\|unset\|pull\|push]` | 환경변수 |
| `diagnose [id] [--refresh --evidence]` · `fix [id] --yes` | AI 진단·수정 |
| `setup agent [--print --global --dir --force]` | 이 스킬 파일을 설치하거나 내용을 출력 |

`--json` 은 `login`·`logout`·`env pull` 을 뺀 명령이 지원한다. 자세한 옵션은 `likelion <명령> --help`.
