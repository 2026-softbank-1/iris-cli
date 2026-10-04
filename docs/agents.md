# 에이전트에서 쓰기

Claude Code·Codex 같은 LLM 에이전트가 `likelion` 을 안전하게 쓰도록 정한 규약이다. 다른 서비스 CLI(gh·Vercel·Railway·Supabase·Sentry·Stripe 등)가 공통으로 갖춘 것 중 비용 대비 효과가 큰 것만 골랐다.

## 설치

```bash
likelion setup agent            # ./.claude/skills/likelion/SKILL.md
likelion setup agent --global   # ~/.claude/skills/likelion/SKILL.md
likelion setup agent --dir .agents/skills   # 다른 에이전트의 스킬 폴더
likelion setup agent --print    # 파일을 쓰지 않고 내용만 출력 (AGENTS.md 등에 붙일 때)
```

- 원본은 이 저장소의 [`skills/likelion/SKILL.md`](../skills/likelion/SKILL.md) 하나다. 패키지에 함께 들어가고 `setup agent` 가 그 내용을 쓴다. 내용이 다른 파일은 `--force` 없이는 덮어쓰지 않는다. CLI 를 업데이트한 뒤에는 `--force` 로 갱신한다.
- 스킬 규격(agentskills.io)의 디렉터리 구조(`skills/<이름>/SKILL.md`)를 따른다. `npx skills add` 같은 스킬 설치 도구로도 설치할 수 있을 것이다. 이 도구로는 아직 확인하지 않았다.
- 테스트가 frontmatter 규격(`name` 64자 이하·소문자, `description` 1024자 이하)과 본문 500줄 제한, CLI 명령·옵션과의 일치를 검사한다. 명령을 고치면 스킬도 같이 고쳐야 테스트가 통과한다.

## 인증

- 사람이 한 번 `likelion login` 한다. 에이전트는 GitHub 로그인을 승인할 수 없다. 브라우저가 없는 환경이면 `likelion login --no-browser` 가 주소를 출력하니 다른 기기에서 승인한다.
- CI·원격 환경은 환경변수 `LIKELION_TOKEN` 으로 토큰을 준다. 저장된 로그인보다 우선하고 서버 주소는 `LIKELION_API_URL`(없으면 기본값)이다. 서버가 토큰을 거절하면 `LIKELION_TOKEN` 이 잘못됐다고 알린다.
- 토큰은 어떤 출력·오류 메시지에도 싣지 않는다. 토큰을 보여 주는 명령은 두지 않았다.

## 출력

- `--json` 을 지원하는 명령은 서버 응답의 `data` 를 stdout 에 JSON 으로만 낸다. 진행 안내(`up --logs` 의 빌드 로그 포함)는 stderr 다. 로그 명령은 줄마다 JSON 한 줄(JSON Lines)이다.
- `--json` 이 없는 명령: `login`, `logout`, `env pull`.
- `servers add|token --json` 은 stdout 에 `{"server": …, "installCommand": "…"}` 한 덩어리만 내고 연결을 기다리지 않는다(`--wait` 와 함께 주면 2). 서버에서 실행할 명령이 `installCommand` 이고, 일회용 등록 토큰은 그 안에만 있다(따로 내지 않는다). 사용자에게 그대로 전달하고 로그·파일에 남기지 않는다. 연결은 `servers --json` 으로 확인한다.
- `servers remove --yes --json` 은 `{"removed": true, "server": {"id", "name", "serverKey"}}` 를 낸다. `--yes` 가 없으면 2.
- `--json` 을 주면 사람에게 묻지 않는다. 확인이 필요한 명령은 `--yes` 를 요구한다.

## 종료 코드

| 코드 | 이름 | 언제 | 에이전트가 할 일 |
|---|---|---|---|
| 0 | 성공 | | |
| 1 | 실패 | 서버가 거절(없음·충돌·검증 실패)·파일 오류 등 | 메시지(또는 `error.code`)를 읽고 고친다 |
| 2 | 사용법 | 인자·옵션 오류, 비대화형인데 선택·확인이 필요 | 옵션을 고쳐 다시 실행한다 |
| 3 | 인증 | 로그인하지 않음, 토큰 거절(401) | 사람에게 로그인을 요청하거나 `LIKELION_TOKEN` 을 바로잡는다 |
| 4 | 결과 실패 | 배포 `FAILED`·`ROLLED_BACK`·`MANUAL_INTERVENTION`·`SUPERSEDED`, AI 진단·수정 실패 | 원인을 조사한다 (`deployments show`·`logs --build`·`diagnose`) |
| 5 | 일시적 | 서버에 닿지 못함, 5xx, 429 | 그대로 다시 시도한다 |

HTTP 상태와의 대응은 401 → 3, 429·5xx → 5, 나머지 4xx → 1 이다. commander 의 인자 파싱 오류도 2 다. `--help`·`--version` 은 0 이다.

## 오류 JSON

`--json` 이 인자에 있으면 실패를 stderr 에 한 줄 JSON 으로 낸다(파싱 오류 포함). stdout 에는 아무것도 내지 않는다.

```json
{"error":{"code":"DEPLOYMENT_IN_PROGRESS","message":"진행 중인 배포가 있어 …","exitCode":1,"retryable":false,"status":409}}
```

| 필드 | 설명 |
|---|---|
| `code` | 서버가 준 코드(`VARIABLE_CONFLICT`·`DEPLOYMENT_IN_PROGRESS`·`CONFIGURATION_VALUES_REQUIRED` 등)나 CLI 의 코드: `USAGE`·`UNAUTHENTICATED`·`CONNECTION_FAILED`·`DEPLOYMENT_FAILED`·`DEPLOYMENT_ROLLED_BACK`·`DEPLOYMENT_MANUAL_INTERVENTION`·`DEPLOYMENT_SUPERSEDED`·`TARGET_NOT_CONNECTED`(배포 타깃 서버가 아직 연결되지 않음)·진단·수정 실패 코드. 코드가 없는 일반 오류는 종료 코드별 기본값(`ERROR`·`FAILED`·`UNAVAILABLE`) |
| `message` | 사람이 읽을 안내(다음에 할 명령 포함) |
| `exitCode` | 종료 코드 |
| `retryable` | 종료 코드가 5 이면 `true` |
| `status` | 서버가 거절한 오류의 HTTP 상태 |
| `retryAfterSeconds`·`details` | 있으면 `Retry-After` 초, 검증 실패의 필드별 사유 |

CLI 의 버그로 보이는 예상 밖 오류는 `code: "INTERNAL"` 이다(텍스트 모드에서는 스택과 함께 던진다).

## 비대화형 규약

다음 중 하나면 CLI 는 절대 질문하지 않는다: 표준 입력이 터미널이 아님, `CI`·`LIKELION_NON_INTERACTIVE`·`CLAUDECODE`·`AI_AGENT`·`AGENT` 환경변수가 설정됨(`0`·`false`·빈 값은 설정하지 않은 것으로 본다), 명령에 `--json`. 그때 `link`·`services create` 는 `--project`·`--service`·`--repo` 를 요구하고(2), `env push`·`fix`·`servers remove` 는 `--yes` 를 요구한다(2).

## 위험한 동작

에이전트가 의도 없이 실행하지 못하게 비대화형에서는 `--yes` 가 있어야 하는 명령이다. 스킬 파일도 사용자에게 먼저 물으라고 안내한다.

- `fix --yes`: AI 가 만든 핫픽스를 main 에 머지하고 재배포한다.
- `env push --yes`: 환경변수 전체를 교체한다.
- `servers remove --yes`: 서버와 그 배포 타깃을 지운다.

`rollback`·`restart` 는 `--yes` 가 없지만 운영 서비스를 바꾸므로 스킬 파일이 사용자 확인을 안내한다.

환경변수 값은 `env`·`env --json` 이 기본으로 숨긴다(`--show-values` 로만 본다).
