# 온프레미스 서버 API 계약

`likelion servers`·`likelion services create`·`likelion up` 이 내 서버(온프레미스)를 다룰 때 기대하는 Control API(`iris-was`) 동작이다. 기준 문서는 iris-was 의 [온프레미스 서버 등록 계약](https://github.com/2026-softbank-1/iris-was/blob/main/docs/onprem-server-registration-contract.md)(§4 사용자 API, §6 설치 스크립트)이고, 이 문서는 그중 CLI 가 쓰는 엔드포인트·필드만 적는다. 두 문서가 다르면 iris-was 쪽이 맞고, 이 문서와 코드를 같이 고친다.

응답은 모두 `ApiResponse` 봉투, JSON 키는 camelCase 다. 서버는 null 필드를 응답에서 빼므로 CLI 는 없는 필드를 null 로 본다.

## 흐름

```text
CLI                                          Control API                사용자 서버
 │ POST /onprem-servers {name}                  │                           │
 │◀── server(PENDING) + installCommand ─────────│                           │
 │ (설치 명령을 보여 준다)                         │                           │
 │                                              │◀── install.sh 실행 (sudo) ─│
 │ GET /onprem-servers/{id} (3초마다)             │  bootstrap → connect       │
 │◀── PENDING → REGISTERING → CONNECTED/FAILED ─│                           │
 │ POST /projects/{id}/services {targetIds:[서버 타깃]}                       │
 │ likelion up → POST /services/{id}/deployments                           │
```

## 서버 (`OnpremServer`)

| 필드 | CLI 가 쓰는 곳 |
|---|---|
| `id` | `token`·`remove`·상태 확인 경로 |
| `name` | 목록·`<이름\|id>` 로 찾기 (`matchByIdOrName`) |
| `serverKey` | 목록·삭제 확인 문구 |
| `status` | `PENDING`(대기)·`REGISTERING`(연결 중)·`CONNECTED`(연결됨)·`FAILED`(실패). 모르는 값은 그대로 보여 준다 |
| `failureCode` | `FAILED` 일 때 상태 옆에 붙인다 (`CONNECT_TIMED_OUT`·`GITOPS_COMMIT_FAILED`) |
| `tailnetFqdn` | 목록·연결 완료 문구 |
| `connectedAt` | 목록 |
| `registrationExpiresAt` | 설치 명령 아래 만료 안내. `PENDING` 인 채로 이 시각이 지나면 기다리기를 멈추고 재발급을 안내한다 |
| `targetId`, `createdAt` | 타입에만 둔다 |

## 엔드포인트

| 명령 | 엔드포인트 | 처리 |
|---|---|---|
| `servers` (`list`) | `GET /onprem-servers` | 표로 보여 준다. 빈 목록이면 `servers add` 를 안내한다 |
| `servers add <name>` | `POST /onprem-servers` `{name}` → 201 `{server, registrationToken, installCommand}` | `installCommand` 만 보여 준다(토큰을 따로 찍지 않는다). 409 `ONPREM_SERVER_NAME_CONFLICT` → 같은 이름 안내, 409 `ONPREM_SERVER_LIMIT_EXCEEDED` → 한 사람당 5대 한도 안내(다른 409 는 서버 메시지를 붙여 안내), 422 → 이름 규칙 안내(서버가 `details[].reason` 으로 준 사유를 풀어 알린다: 빈 이름·63자 초과·숫자만·시작 글자·허용 문자), 503 `NOT_CONFIGURED` → 서버 등록이 아직 준비되지 않았다고 안내 |
| `servers add`·`token` 의 기다리기 | `GET /onprem-servers/{id}` | 3초마다. 상태가 바뀔 때만 찍는다. `CONNECTED` 면 성공, `FAILED` 면 `failureCode` 와 `servers token` 안내로 실패. 5xx·연결 끊김은 연속 5회까지 다시 확인하고, 4xx 는 바로 끝낸다. Ctrl+C 나 20분이 지나면 등록은 남는다고 알리고 끝낸다. 대화형 터미널이 아니면 기본으로 부르지 않는다(`--wait`·`--no-wait` 로 바꾼다) |
| `servers token <이름\|id>` | `GET /onprem-servers` 로 찾은 뒤 `POST /onprem-servers/{id}/registration-token` → `{server, registrationToken, installCommand}` | 대기·연결 중·실패 상태에서 되고 상태는 대기로 돌아간다. 409 `INVALID_STATUS_TRANSITION`(연결됨) → 상태와 함께 안내, 503 `NOT_CONFIGURED` → 준비 중 안내 |
| `servers remove <이름\|id>` | `GET /onprem-servers` 로 찾은 뒤 `DELETE /onprem-servers/{id}` → 204 | 확인을 묻는다(`--yes` 면 생략, 비대화형이면 `--yes` 필수). 409 `ONPREM_SERVER_IN_USE` → 서비스를 먼저 지우라고 안내 |
| `services create` | `GET /projects` · `GET /targets` · (서버 타깃이 있으면) `GET /onprem-servers` · `POST /projects/{projectId}/services` | 아래 참고 |
| `up` | `GET /services/{id}` · `GET /targets` · (연결 전이고 `onpremServerName` 이 없으면) `GET /onprem-servers/{id}` | 아래 참고 |

### 서버 이름 규칙

서버(iris-was)가 판정한다. 앞뒤 공백을 자른 이름이 **1~63자, 영문 대소문자·숫자·한글 완성형(가-힣)·`.`·`_`·`-` 만, 첫 글자는 영문·숫자·한글, 숫자만으로는 안 됨**이어야 한다(`^(?![0-9]+$)[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{0,62}$`). 같은 사용자의 삭제되지 않은 서버와 이름이 같으면 409 `ONPREM_SERVER_NAME_CONFLICT` 다(대소문자를 구분한다). 어기면 422 `INVALID_INPUT` 이고 `details` 는 `[{field:"name", reason}]` 이며 `reason` 은 영어 고정 문구다: `must not be blank`·`must be at most 63 characters`·`must not be only digits`·`must start with a letter, digit or Hangul syllable`·`may contain only letters, digits, Hangul syllables, '.', '_' and '-' (no spaces)`. 숫자만 이름을 막는 까닭은 CLI 의 `<이름|id>` 가 숫자를 id 로 먼저 읽어 `servers remove 1` 이 이름이 `1` 인 서버가 아니라 id 1 인 서버를 지울 수 있어서다. 이미 등록한 이름은 검사하지 않는다.

### `GET /targets` 에 더해진 필드

| 필드 | 뜻 |
|---|---|
| `onpremServerId` | 내 서버의 타깃이면 서버 id. 공용 타깃은 없다 |
| `onpremServerName` | 서버 타깃이면 서버 이름. 있으면 `GET /onprem-servers` 를 부르지 않는다 |
| `connectionStatus` | 서버 타깃의 연결 상태(`OnpremServer.status` 와 같은 코드). 공용 타깃은 없다(항상 배포할 수 있다) |

목록은 공용 타깃 + 내 서버 타깃만 온다. CLI 는 서버 타깃을 타깃 이름(`onprem-<serverKey>`) 대신 서버 이름(`onpremServerName`, 없으면 `GET /onprem-servers`)으로 보여 준다. 값이 없는 필드는 빠지거나 null 로 오므로 둘 다 없는 것으로 본다. `--target` 은 서버 이름·타깃 이름·타깃 id 를 모두 받는다.

### `POST /projects/{projectId}/services`

요청 `{ repositoryUrl, name?, branch?, rootDirectory?, targetIds?: [타깃 id] }`. 빠진 값은 서버가 정한다(이름 = 저장소 이름, 브랜치 = 저장소 기본 브랜치, 타깃 = `aws`). 응답은 `ServiceResponse`(CLI 는 `id`·`name`·`sourceBranch` 를 쓴다).

| 실패 | CLI 메시지 |
|---|---|
| 409 `SERVICE_NAME_CONFLICT` | 같은 이름의 서비스가 있다, `--name` 으로 바꿔라 |
| 403 `REPOSITORY_NOT_ACCESSIBLE` | GitHub App 설치·권한 확인 |
| 422 `INVALID_INPUT` | 서버 메시지(계약)로 나눈다: `not a github repository url` · `branch not found in repository` · `service name must be lowercase letters, digits and hyphens` · `root directory must stay inside the repository` · `unknown target`(남의 서버 타깃도 같다) · `exactly one target is required`. 모르는 메시지는 그대로 붙인다 |
| 422 `VALIDATION_ERROR` | `details` 의 `field: reason` 을 붙인다 |

### `up` 의 타깃 확인

묶고 올리기 전에 서비스의 타깃 중 `connectionStatus` 가 있고 `CONNECTED` 가 아닌 것이 있으면 서버 이름과 상태를 알리고 멈춘다. 그래도 서버가 배포 요청(`POST /services/{id}/deployments`)을 409 `TARGET_NOT_CONNECTED` 로 거절하면 같은 뜻의 메시지로 끝낸다.

## 확인된 점

- 남의 서버·삭제된 서버의 타깃으로 서비스를 만들면 서버는 없는 타깃과 같은 422 `INVALID_INPUT`(`unknown target`)을 준다.
- `GET /onprem-servers/{id}` 를 기다리는 동안 토큰을 재발급하면 `registrationExpiresAt` 이 바뀐다. CLI 는 매번 받은 값으로 만료를 다시 본다.
