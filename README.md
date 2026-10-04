# iris-cli

Likelion CLI (`likelion`)

[![Release](https://img.shields.io/github/v/release/2026-softbank-1/iris-cli)](https://github.com/2026-softbank-1/iris-cli/releases)
[![CI](https://github.com/2026-softbank-1/iris-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/2026-softbank-1/iris-cli/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

```bash
npm install -g https://github.com/2026-softbank-1/iris-cli/releases/download/v0.3.1/likelion-0.3.1.tgz
likelion login
likelion link && likelion up
```

<!-- TODO: likelion up 데모 GIF -->

## 시스템 내 위치

Likelion Control API([iris-was](https://github.com/2026-softbank-1/iris-was))를 터미널에서 부르는 클라이언트다. 같은 API 를 웹에서 쓰는 쪽은 [iris-web](https://github.com/2026-softbank-1/iris-web) 이다.

```mermaid
flowchart LR
  CLI[iris-cli] --> WAS
  WEB[iris-web] --> WAS
  WAS[iris-was<br/>Control API · Workers] -->|values 커밋| GITOPS[iris-gitops-environments]
  GITOPS --> ARGO[Argo CD] -->|동기화| WL[Workload EKS<br/>*.likelion.uk]
  WAS -->|실패 로그| ERR[iris-error-check-agent]
  WAS -->|진단 결과| FIX[iris-code-fix-agent]
  FIX -.핫픽스 PR·자동 머지.-> REPO[(사용자 레포)]
  INFRA[iris-infra] -.프로비저닝.-> ARGO
  ANA[iris-code-analyzer-agent<br/>개발 중 · 미연동]
  style CLI fill:#f96,stroke:#333,stroke-width:2px
```

## 명령

| 명령 | 설명 | 상태 |
|---|---|---|
| `likelion login` | 브라우저에서 GitHub 로그인을 승인하면 토큰을 받아 저장한다 | 구현됨 ([계약](docs/login-contract.md), 운영 서버에서 확인) |
| `likelion whoami [--json]` | 로그인한 GitHub 계정을 보여 준다 | 구현됨 |
| `likelion logout` | 저장된 로그인 정보를 지운다 | 구현됨 |
| `likelion link [--project <id\|name>] [--service <id\|name>]` | 프로젝트·서비스를 골라 현재 폴더에 연결한다 | 구현됨 |
| `likelion status [--json]` | 연결된 서비스의 최근 배포 상태·단계별 소요 시간·주소를 보여 준다 | 구현됨 |
| `likelion logs [-f] [--since 1h] [-n 200] [--search <text>] [--target <id\|name>] [--json]` | 런타임 로그를 보여 주고 `-f` 면 새 로그를 계속 따라간다 | 구현됨 |
| `likelion logs --build\|--deploy\|--network [--deployment <id>] [-n N] [-f] [--status-class 5xx]` | 배포 하나의 빌드·런타임·네트워크(ALB) 로그를 본다. `--build -f` 는 빌드가 끝날 때까지 따라가고, `--build -n N` 은 마지막 N줄만 보여 준다 | 구현됨 ([운영 명령](docs/operations.md)) |
| `likelion open [--target <id\|name>] [--no-browser] [--json]` | 배포된 서비스 주소를 브라우저로 연다 | 구현됨 |
| `likelion up [--detach] [--logs] [--json]` | 연결된 폴더를 tar.gz 로 묶어 올려 배포하고, 끝날 때까지 상태를 보여 준다. `--logs` 면 빌드 로그도 보여 준다 | 구현됨 ([계약](docs/up-contract.md)), 운영 서버에서 `up` 한 번으로 배포 확인 |
| `likelion deployments [-n 20] [--json]` · `likelion deployments show [id]` | 배포 이력과 배포 하나의 상세(소스·빌드·단계·반영 결과)를 본다 | 구현됨 ([운영 명령](docs/operations.md)) |
| `likelion deploy [--sha <commit>]` · `redeploy [id]` · `rollback <id>` · `restart` (`--detach` `--logs` `--json`) | 대시보드의 Deploy·Redeploy·Rollback·Restart 와 같은 배포 요청을 만들고 끝날 때까지 기다린다 | 위와 같음 |
| `likelion env [--show-values]` · `env set KEY=VALUE…` · `env unset KEY…` · `env pull [file]` · `env push [file] [--yes]` | 서비스 환경변수를 보고(기본은 값 숨김) 바꾸고 `.env` 로 내려받거나 올린다(`push` 는 전체 교체) | 위와 같음 |
| `likelion diagnose [id] [--refresh] [--evidence]` | 실패한 배포의 AI 진단(원인·해결책)을 보여 주고, 없으면 시작해 끝날 때까지 기다린다 | 위와 같음 |
| `likelion fix [id] [--yes]` | 실패한 배포를 AI 가 고치게 한다(핫픽스 PR → main 머지 → 재배포) | 위와 같음 |
| `likelion services create [--project] [--repo] [--name] [--branch] [--root-dir] [--target] [--link\|--no-link]` | GitHub 저장소를 연결해 서비스를 만들고, 원하면 현재 폴더를 연결한다 | 구현됨 ([계약](docs/onprem-servers-contract.md)) |
| `likelion servers` | 내 서버(온프레미스) 목록과 연결 상태를 보여 준다 | 구현됨 ([계약](docs/onprem-servers-contract.md)), 서버 API 는 iris-was 에서 구현 중 |
| `likelion servers add <name> [--wait\|--no-wait]` | 서버를 등록하고 서버에서 실행할 설치 명령을 보여 준 뒤 연결될 때까지 기다린다 | 위와 같음 |
| `likelion servers token <name\|id> [--wait\|--no-wait]` | 등록 토큰을 다시 발급해 새 설치 명령을 보여 준다 | 위와 같음 |
| `likelion servers remove <name\|id> [--yes]` | 서버를 삭제한다 (`rm` 도 된다) | 위와 같음 |
| `likelion setup agent [--print\|--global\|--dir <폴더>]` | 에이전트(Claude Code 등)가 이 CLI 를 쓰는 법을 담은 스킬 `SKILL.md` 를 설치한다 | 구현됨 ([에이전트](docs/agents.md)) |

## 설치

Node.js 20 이상이 필요하다. [Releases](https://github.com/2026-softbank-1/iris-cli/releases) 에 올라온 `likelion-<버전>.tgz` 를 설치한다(최신 v0.3.1). npm 에는 올리지 않는다(이름 `likelion` 을 다른 패키지가 쓰고 있다).

- 업데이트: 새 버전의 `.tgz` 주소로 위 설치 명령을 다시 실행한다.
- 삭제: `npm uninstall -g likelion`.
- 처음 쓰는 순서: `likelion login` → 배포할 폴더에서 `likelion services create`(또는 대시보드에서 만든 뒤 `likelion link`) → `likelion up`. 서비스는 GitHub 레포를 연결해 만든다.

## 동작

```mermaid
flowchart LR
  A[login<br/>토큰 저장] --> B[link<br/>.likelion/link.json] --> C[up<br/>tar.gz 업로드] --> D[배포 요청<br/>triggerType=CLI] --> E[2초 폴링<br/>SUCCEEDED·FAILED]
  B --> F[status · logs · open]
```

### 연결(`link`)

`link` 는 현재 폴더에 `.likelion/link.json` 을 만든다. 폴더 안 `.likelion/.gitignore` 가 `*` 라서 커밋되지 않는다. `status`·`logs`·`open`·`deployments`·`deploy` 등은 현재 폴더에서 위로 올라가며 이 파일을 찾는다. 로그인한 서버와 연결된 서버가 다르면 `link` 를 다시 하라고 안내한다. 대화형 터미널이 아니면(파이프·CI) `--project`·`--service` 를 지정해야 한다.

### 올리기(`up`)

- `.likelion` 이 있는 폴더를 통째로 올린다. 하위 폴더에서 실행해도 같다.
- `.git`·`node_modules`·`.likelion`·`.DS_Store`·`.env`(`.env.example` 은 포함)는 항상 뺀다. 루트의 `.gitignore`·`.likelionignore` 도 따르고, `.likelionignore` 에 `!.env` 처럼 적어 다시 넣을 수 있다. 하위 폴더의 `.gitignore` 는 읽지 않는다.
- 폴더 밖을 가리키는 심볼릭 링크는 빼고 알려 준다. 압축한 크기 한도는 250 MB 이고(서버 소스 스냅샷 한도와 같다), 넘으면 올리기 전에 멈춘다.
- 올린 뒤 `CLI` 배포 요청을 만들고 2초마다 상태를 확인해 `SUCCEEDED`·`FAILED` 등으로 끝날 때까지 보여 준다(최대 20분). `--detach` 면 요청만 보내고 끝낸다. 기본은 상태만 보이고 `--logs` 를 주면 빌드 로그도 이어서 보여 준다. 일시적인 서버 오류(5xx)·연결 끊김은 연속 5회까지 2~5초씩 늘려 가며 다시 확인하고, 넘으면 배포 번호와 `likelion status` 안내를 남기고 끝낸다. 4xx 는 다시 시도하지 않는다.

### 서비스 만들기(`services create`)

- 저장소는 `--repo` 로 주고, 없으면 현재 폴더의 git `origin` 을 쓴다(대화형이면 확인을 묻는다). `https://github.com/owner/repo`·`git@github.com:owner/repo.git`·`owner/repo` 를 받는다. GitHub App 이 그 저장소에 설치돼 있어야 한다.
- 이름은 저장소 이름, 브랜치는 저장소 기본 브랜치, 타깃은 `aws` 가 기본이다. 대화형이면 프로젝트·타깃을 목록에서 고른다(내 서버는 연결 상태를 같이 보여 준다).
- 만든 뒤 현재 폴더를 연결할지 묻는다. `--link` 면 묻지 않고 연결하고, `--no-link` 나 비대화형이면 연결하지 않고 `link` 명령을 안내한다.

### 내 서버(`servers`)

내 Ubuntu 서버(22.04/24.04, x86_64·arm64)를 배포 대상으로 붙인다. 서버 쪽 동작은 iris-was 의 [온프레미스 서버 등록 계약](https://github.com/2026-softbank-1/iris-was/blob/main/docs/onprem-server-registration-contract.md)을 따른다.

```text
$ likelion servers add home-lab
서버를 등록했습니다: home-lab (서버 키 k3x9q2ma)

서버에서 실행하세요 (Ubuntu 22.04/24.04, sudo):

  curl -fsSL https://api.likelion.uk/api/v1/onprem-servers/install.sh | sudo bash -s -- --token <토큰>

이 명령의 토큰은 2026-10-05T03:00:00Z 까지 유효하고 지금 한 번만 보여 줍니다.
만료되면 `likelion servers token home-lab` 으로 다시 발급하세요.

서버에서 명령을 실행하면 연결을 확인합니다. 기다리는 중... (Ctrl+C 로 멈춰도 등록은 남습니다)
  대기 (+0s)
  연결 중 (+96s)
  연결됨 (+171s)
서버가 연결되었습니다: home-lab (iris-k3x9q2ma.tailb046e8.ts.net)
```

- 상태는 대기(`PENDING`) → 연결 중(`REGISTERING`) → 연결됨(`CONNECTED`) / 실패(`FAILED`) 다. 실패하거나 토큰이 만료되거나 연결 중에 멈추면 `servers token` 으로 다시 발급해(상태는 대기로 돌아간다) 서버에서 명령을 다시 실행한다. 서버는 한 사람당 5대까지 등록한다.
- 등록 토큰은 설치 명령 안에서 한 번만 보인다. 대화형 터미널이면 3초마다 상태를 확인하며 최대 20분 기다리고, 파이프·CI 에서는 명령만 보여 주고 끝낸다. `--wait`·`--no-wait` 로 바꾼다.
- 삭제는 서비스가 붙어 있지 않은 서버만 된다. 서버에 설치된 K3s·Tailscale 은 지우지 않는다.
- 연결된 서버에 배포하려면 `likelion services create --target home-lab` 으로 서비스를 만든다. 연결 전 서버도 고를 수 있지만 경고하고, `up` 은 서버가 연결될 때까지 배포하지 않는다.

### 로그(`logs`)

`logs -f` 는 과거 로그를 먼저 보여 준 뒤 그 마지막 시각부터 SSE 로 이어 받는다. 서버가 5분마다 연결을 끊으므로 마지막 `id` 를 커서로 다시 연결하고, 겹쳐 오는 줄은 한 번만 찍는다. 서버가 `overflow`·`error` 이벤트를 보내면 다시 연결하지 않고 끝낸다. `--build`·`--deploy`·`--network` 는 배포 하나의 로그를 조회한다([운영 명령](docs/operations.md)).

## 설정

- API 주소: `login --api-url <url>` > 환경변수 `LIKELION_API_URL` > 기본값 `https://api.likelion.uk`. 로그인한 뒤에는 저장된 주소를 쓴다.
- 로그인 정보: `~/.config/likelion/credentials.json` (권한 `0600`). `XDG_CONFIG_HOME` 으로 위치를 바꾸고, 테스트에서는 `LIKELION_CONFIG_DIR` 로 덮어쓴다. 토큰은 로그·출력에 남기지 않는다.
- `LIKELION_TOKEN`: 저장된 로그인 대신 쓸 토큰(CI·에이전트). 서버 주소는 `LIKELION_API_URL` 이나 기본값이다.
- `LIKELION_NON_INTERACTIVE=1`: 터미널에서도 질문하지 않는다. `CI`·`CLAUDECODE`·`AI_AGENT`·`AGENT` 가 설정돼 있어도 같다. 확인이 필요한 명령은 `--yes` 를 요구한다.

## 에이전트에서 쓰기

LLM 에이전트가 쓰기 쉽게 `--json`(stdout 에 JSON 만, 진행 안내·오류는 stderr), 구분된 종료 코드(0 성공 · 1 실패 · 2 사용법 · 3 인증 · 4 결과 실패 · 5 일시적 오류), 질문 없는 실행, 스킬 파일을 갖췄다. `likelion setup agent` 로 스킬을 설치한다. 규약은 [docs/agents.md](docs/agents.md) 에 있다.

## 개발

Node.js 20 이상, TypeScript · commander · tsup · vitest 를 쓴다. CI(`.github/workflows/ci.yml`)는 PR·`main` push 마다 typecheck·test·build 를 돌리고 배포는 하지 않는다.

```bash
npm install
npm run dev -- whoami      # tsx 로 바로 실행
npm run typecheck
npm test
npm run build              # dist/index.js (실행 파일, shebang 포함)
```

## 문서

- [docs/development.md](docs/development.md) — 사용하는 API 표 · 릴리스 절차 · 코드 규칙
- [docs/operations.md](docs/operations.md) — 배포 이력·배포 요청·배포 로그·환경변수·AI 진단/수정 명령
- [docs/agents.md](docs/agents.md) — LLM 에이전트에서 쓰기: 스킬 설치 · 인증 · `--json` · 종료 코드
- [docs/login-contract.md](docs/login-contract.md) — `login` 서버 계약
- [docs/onprem-servers-contract.md](docs/onprem-servers-contract.md) — `servers`·`services create` 서버 계약
- [docs/up-contract.md](docs/up-contract.md) — `up` 서버 계약
