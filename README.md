# Likelion CLI

[Likelion](https://github.com/2026-softbank-1/iris-was) Control API 를 터미널에서 쓰는 CLI. 명령 이름은 `likelion` 이다.

| 명령 | 설명 | 상태 |
|---|---|---|
| `likelion login` | 브라우저에서 GitHub 로그인을 승인하면 토큰을 받아 저장한다 | 구현됨 ([계약](docs/login-contract.md), 운영 서버에서 확인) |
| `likelion whoami` | 로그인한 GitHub 계정을 보여 준다 | 구현됨 |
| `likelion logout` | 저장된 로그인 정보를 지운다 | 구현됨 |
| `likelion link [--project <id\|name>] [--service <id\|name>]` | 프로젝트·서비스를 골라 현재 폴더에 연결한다 | 구현됨 |
| `likelion status` | 연결된 서비스의 최근 배포 상태·단계별 소요 시간·주소를 보여 준다 | 구현됨 |
| `likelion logs [-f] [--since 1h] [-n 200] [--search <text>] [--target <id\|name>]` | 런타임 로그를 보여 주고 `-f` 면 새 로그를 계속 따라간다 | 구현됨 (빌드 로그 제외) |
| `likelion open [--target <id\|name>] [--no-browser]` | 배포된 서비스 주소를 브라우저로 연다 | 구현됨 |
| `likelion up [--detach]` | 연결된 폴더를 tar.gz 로 묶어 올려 배포하고, 끝날 때까지 상태를 보여 준다 | 구현됨 ([계약](docs/up-contract.md)), 운영 서버에서 `up` 한 번으로 배포 확인 |

## 연결(`link`)

`link` 는 현재 폴더에 `.likelion/link.json` 을 만든다. 폴더 안 `.likelion/.gitignore` 가 `*` 라서 커밋되지 않는다. `status`·`logs`·`open` 은 현재 폴더에서 위로 올라가며 이 파일을 찾는다. 로그인한 서버와 연결된 서버가 다르면 `link` 를 다시 하라고 안내한다. 대화형 터미널이 아니면(파이프·CI) `--project`·`--service` 를 지정해야 한다.

## 올리기(`up`)

- `.likelion` 이 있는 폴더를 통째로 올린다. 하위 폴더에서 실행해도 같다.
- `.git`·`node_modules`·`.likelion`·`.DS_Store`·`.env`(`.env.example` 은 포함)는 항상 뺀다. 루트의 `.gitignore`·`.likelionignore` 도 따르고, `.likelionignore` 에 `!.env` 처럼 적어 다시 넣을 수 있다. 하위 폴더의 `.gitignore` 는 읽지 않는다.
- 폴더 밖을 가리키는 심볼릭 링크는 빼고 알려 준다. 압축한 크기 한도는 250 MB 이고(서버 소스 스냅샷 한도와 같다), 넘으면 올리기 전에 멈춘다.
- 올린 뒤 `CLI` 배포 요청을 만들고 2초마다 상태를 확인해 `SUCCEEDED`·`FAILED` 등으로 끝날 때까지 보여 준다(최대 20분). `--detach` 면 요청만 보내고 끝낸다. 서버에는 빌드 로그 API(`GET /services/{id}/deployments/{deploymentId}/build-logs`)가 생겼지만 CLI 가 아직 쓰지 않아 빌드 중에는 상태만 보인다. 일시적인 서버 오류(5xx)·연결 끊김은 연속 5회까지 2~5초씩 늘려 가며 다시 확인하고, 넘으면 배포 번호와 `likelion status` 안내를 남기고 끝낸다. 4xx 는 다시 시도하지 않는다.

## 사용하는 API

| 명령 | 엔드포인트 |
|---|---|
| `link` | `GET /projects` · `GET /projects/{id}/services` |
| `status` | `GET /services/{id}` · `GET /services/{id}/domains` · `GET /services/{id}/deployments/{deploymentId}` |
| `logs` | `GET /services/{id}/logs` · `GET /services/{id}/logs/stream`(SSE) · `GET /targets` |
| `login` | `POST /auth/cli/sessions` · `POST /auth/cli/sessions/{sessionId}/token`(폴링, `429` 면 `Retry-After` 만큼 쉬고 재시도) · `GET /me` |
| `open` | `GET /services/{id}/domains` |
| `up` | `POST /services/{id}/uploads`(본문 = tar.gz) · `POST /services/{id}/deployments`(`triggerType=CLI`) · `GET /services/{id}/deployments/{deploymentId}`(폴링) · `GET /services/{id}/domains` |

`logs -f` 는 과거 로그를 먼저 보여 준 뒤 그 마지막 시각부터 SSE 로 이어 받는다. 서버가 5분마다 연결을 끊으므로 마지막 `id` 를 커서로 다시 연결하고, 겹쳐 오는 줄은 한 번만 찍는다. 서버가 `overflow`·`error` 이벤트를 보내면 다시 연결하지 않고 끝낸다. `logs` 는 런타임 로그만 다룬다. 빌드 로그는 서버에 별도 API(`.../deployments/{deploymentId}/build-logs`)가 있지만 CLI 는 아직 쓰지 않는다.

## 설치

Node.js 20 이상이 필요하다. [Releases](https://github.com/2026-softbank-1/iris-cli/releases) 에 올라온 `likelion-<버전>.tgz` 를 설치한다. npm 에는 올리지 않는다(이름 `likelion` 을 다른 패키지가 쓰고 있다).

```bash
npm install -g https://github.com/2026-softbank-1/iris-cli/releases/download/v0.2.0/likelion-0.2.0.tgz
likelion --version
```

- 업데이트: 새 버전의 `.tgz` 주소로 같은 명령을 다시 실행한다.
- 삭제: `npm uninstall -g likelion`.
- 처음 쓰는 순서: `likelion login` → 배포할 폴더에서 `likelion link` → `likelion up`. 서비스는 대시보드에서 GitHub 레포를 연결해 먼저 만들어 둬야 한다.

## 릴리스

GitHub Actions 로 자동화하지 않았다. 버전을 올릴 때 손으로 한다.

1. `npm version <버전> --no-git-tag-version` 으로 `package.json`·`package-lock.json` 을 올리고 PR 로 `main` 에 병합한다.
2. 병합된 `main` 에서 `npm ci && npm run build && npm pack` 으로 `likelion-<버전>.tgz` 를 만든다.
3. `gh release create v<버전> likelion-<버전>.tgz --target <main 커밋> --title "v<버전>" --notes "<변경 내용>"` 으로 릴리스를 만든다.
4. 위 설치 명령의 주소를 새 버전으로 바꾼 뒤 설치해 `likelion --version` 이 맞는지 확인한다.

## 개발

Node.js 20 이상이 필요하다.

```bash
npm install
npm run dev -- whoami      # tsx 로 바로 실행
npm run typecheck
npm test
npm run build              # dist/index.js (실행 파일, shebang 포함)
```

## 설정

- API 주소: `login --api-url <url>` > 환경변수 `LIKELION_API_URL` > 기본값 `https://api.likelion.uk`. 로그인한 뒤에는 저장된 주소를 쓴다.
- 로그인 정보: `~/.config/likelion/credentials.json` (권한 `0600`). `XDG_CONFIG_HOME` 으로 위치를 바꾸고, 테스트에서는 `LIKELION_CONFIG_DIR` 로 덮어쓴다. 토큰은 로그·출력에 남기지 않는다.

## 규칙

- 서버 응답은 `ApiResponse` 봉투(`success`·`code`·`message`·`data`)이고 JSON 키는 camelCase 다. 봉투는 `src/lib/api.ts` 한 곳에서 벗긴다.
- 사용자에게 보일 오류는 `CliError` 로 던진다. `src/index.ts` 가 메시지 한 줄과 종료 코드로 끝낸다.
- 커밋 메시지는 Conventional Commits(`feat: 설명`), 한글, 명령형으로 쓴다.
