# 배포 운영 명령

대시보드에서 하던 배포 운영·디버깅을 터미널에서 하는 명령이다. 모두 `likelion link` 로 연결한 폴더의 서비스를 대상으로 한다. 엔드포인트는 README 의 [사용하는 API](../README.md#사용하는-api) 표에 있다.

## 출력 규칙

- `--json` 이 있는 명령은 서버 응답의 `data` 를 봉투 없이 그대로 stdout 에 낸다(키는 camelCase). 사람용 진행 안내는 stderr 로 보내서 `| jq` 로 바로 읽을 수 있다. 로그 명령은 줄마다 JSON 한 줄(JSON Lines)이다.
- 실패는 메시지를 stderr 로 내고 [종료 코드](agents.md#종료-코드)로 끝낸다. 배포가 `FAILED`·`ROLLED_BACK` 으로 끝나는 것은 종료 코드 `4` 다. `--json` 이면 오류도 stderr 에 `{"error":{…}}` 한 줄이다.
- 값이 비밀일 수 있는 출력(환경변수)은 기본으로 숨긴다.

## 배포 이력·상세

- `likelion deployments [-n 20] [--json]` — 최신순 이력. `-n` 은 1~100.
- `likelion deployments show [id] [--json]` — 상태·사유·요청 방식·커밋·소스(저장소·브랜치)·배포 방식·빌드·단계별 소요 시간·반영 결과(Argo CD 상태)·대체한 배포. `id` 를 생략하면 가장 최근 배포다.

## 배포 요청

`deploy`·`redeploy`·`rollback`·`restart` 는 배포 요청을 만들고 `up` 과 같은 방식으로 끝날 때까지(최대 20분) 상태를 보여 준다. 공통 옵션은 `--detach`(요청만 보내고 끝), `--logs`(기다리는 동안 빌드 로그 표시), `--json`(stdout 에 배포 상세 JSON). 요청마다 `Idempotency-Key` 를 보낸다.

| 명령 | 요청 | 설명 |
|---|---|---|
| `deploy [--sha <commit>]` | `MANUAL` | GitHub 브랜치 최신 커밋(또는 `--sha`)을 빌드해 배포한다 |
| `redeploy [id]` | `REDEPLOY` | `id`(기본: 가장 최근 배포)의 커밋을 다시 빌드한다. `up` 으로 올린 배포는 소스가 남지 않아 서버가 거절한다 |
| `rollback <id>` | `ROLLBACK` | 성공했던 `id` 가 만든 이미지를 빌드 없이 배포한다 |
| `restart` | `RESTART` | 지금 떠 있는 배포의 이미지를 빌드 없이 다시 띄워 Pod 를 새로 시작한다 |

진행 중인 배포가 있으면 서버가 `409 DEPLOYMENT_IN_PROGRESS` 로 거절한다.

## 배포 로그

`likelion logs` 에 배포 하나를 고르는 플래그를 더한다. `--deployment <id>` 를 생략하면 가장 최근 배포다. 셋 중 하나만 고른다.

- `--build` — CodeBuild 빌드 로그. 1000줄씩 이어 읽고 최대 10,000줄에서 멈춘다. `-f` 면 빌드가 끝날 때까지 따라간다. 롤백·재시작은 새로 빌드하지 않아 원본 배포의 로그를 보여 주고 그 배포 번호를 알린다.
- `--deploy` — 이 배포의 release 가 붙은 앱 컨테이너 로그. `-n`(1~1000)·`--search`·`--target`.
- `--network` — ALB 접근 로그(상태 코드·바이트·응답 시간만 있고 URL·IP 는 없다). `--status-class 2xx|3xx|4xx|5xx`·`-n`·`--target`. ALB 가 로그를 몇 분 늦게 올린다.

`--since` 는 서비스 런타임 로그(`--build` 등을 주지 않은 `logs`)에만 쓴다.

## 환경변수

`likelion env` 는 서비스 환경변수를 다룬다. **바꿔도 실행 중인 앱은 그대로**이고 다음 배포나 `restart` 부터 반영된다.

- `env [list] [--show-values] [--json]` — 기본은 이름과 값의 글자 수만 보여 준다. `--show-values` 로 값을 본다. `--json` 은 `--show-values` 가 없으면 `value` 를 뺀다. 플랫폼이 넣는 변수(`PORT`·`IRIS_*` 등)도 함께 보여 준다.
- `env set KEY=VALUE…` — 없으면 추가하고(`POST`) 이미 있으면 값을 바꾼다(`PUT`). 값에는 `=` 가 들어가도 된다. 값이 셸 기록에 남으므로 비밀은 `env push` 가 낫다.
- `env unset KEY…` (`rm`) — 지운다. 없는 이름이 있으면 나머지를 지운 뒤 실패로 끝낸다.
- `env pull [file] [--force]` — 변수를 `.env`(또는 `file`)에 쓴다. 권한 `0600`. 이미 있는 파일은 `--force` 없이는 덮어쓰지 않는다. `up` 은 `.env` 를 올리지 않는다.
- `env push [file] [--yes]` — 파일 내용(`KEY=VALUE`, 따옴표 값은 여러 줄 가능)으로 **변수 전체를 교체**한다. 파일에 없는 변수는 지워진다. 대화형 터미널이면 확인을 묻고, 아니면 `--yes` 가 필요하다. 끝나면 추가·변경·삭제한 이름을 알린다(값은 싣지 않는다). 파싱·검증은 서버가 하고 틀린 줄은 사유와 함께 거절된다.

서버에 암호화 키가 없으면(`503 NOT_CONFIGURED`) 환경변수를 쓸 수 없다.

## AI 진단·수정

- `diagnose [id] [--refresh] [--no-wait] [--evidence] [--json]` — 실패한 배포(`FAILED`·`ROLLED_BACK`·`MANUAL_INTERVENTION`)의 진단을 보여 준다. 서버는 실패를 확정한 뒤 스스로 진단을 시작하므로 보통 결과가 이미 있다. 없거나 직전 진단이 실패했으면 시작하고, 진행 중이면 최대 4분 기다린다. `--refresh` 는 성공한 진단이 있어도 새로 돌린다(모델 비용). 해결책은 제안일 뿐 서버가 실행하지 않는다. 수정 예시의 `{{이름}}` 은 채워 쓸 자리표시자다.
- `fix [id] [--yes] [--detach] [--json]` — 서버가 AI 로 수정을 만들어 **핫픽스 PR 을 올리고 main 에 머지한 뒤 재배포**한다(GitHub 보호 규칙은 그대로 적용된다). main 에 쓰는 동작이라 대화형이면 저장소·브랜치를 보여 주며 확인하고, 비대화형이면 `--yes` 가 필요하다. 이 진단의 수정이 이미 있으면 새로 만들지 않고 이어 본다(`--detach` 로 끊어도 같은 명령을 다시 실행하면 이어진다). 환경변수 값이 필요한 실패는 `CONFIGURATION_VALUES_REQUIRED` 로 변수 이름과 `env set` 안내를 보여 주고, GitHub 쓰기 권한이 없으면(`403`) App 승인 주소를 알려 준다.
