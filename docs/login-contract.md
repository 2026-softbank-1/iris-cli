# `login` 서버 계약

CLI 가 기대하는 Control API(`iris-was`) 엔드포인트다. 서버 구현은 iris-was 에 있고(설계: iris-was `docs/adr/0018-cli-login-session-table-and-polling.md`), 이 문서가 두 레포의 합의 지점이다. 응답은 모두 `ApiResponse` 봉투, JSON 키는 camelCase 다. 실패 본문은 `{ "success": false, "code": "...", "message": "..." }` 이다.

## 흐름

```text
CLI                         Control API                    브라우저 / GitHub
 │ POST /auth/cli/sessions        │                               │
 │───────────────────────────────▶│ 세션 생성 (PENDING)            │
 │◀─── sessionId, pollSecret,     │                               │
 │     verificationUrl            │                               │
 │ (브라우저로 verificationUrl 열기) ──────────────────────────────▶│ GET .../authorize → GitHub 로그인
 │                                │◀── GET /auth/github/callback ──│ 승인 → 세션 APPROVED (user 연결)
 │ POST .../{sessionId}/token     │                               │
 │───────────────────────────────▶│ PENDING … 반복 (interval 초)   │
 │◀─── APPROVED + accessToken     │ 토큰은 한 번만 내준다           │
 │ GET /me (Bearer)               │                               │
```

## 엔드포인트

### `POST /api/v1/auth/cli/sessions`

인증 없음. 로그인 세션을 만든다. 성공하면 `201 Created`.

```json
{
  "success": true,
  "data": {
    "sessionId": "<추측 불가한 공개 ID(256비트 무작위). verificationUrl 에 들어간다>",
    "pollSecret": "<CLI 만 아는 비밀(256비트 무작위). 폴링할 때만 쓴다>",
    "verificationUrl": "https://api.likelion.uk/api/v1/auth/cli/sessions/<sessionId>/authorize",
    "expiresIn": 600,
    "interval": 2
  }
}
```

- `expiresIn`·`interval` 의 단위는 초다. 세션은 만든 뒤 10분(`expiresIn`)이 지나면 만료된다.
- `verificationUrl` 의 앞부분은 서버의 `API_BASE_URL` 설정이다(없으면 요청의 Host).
- `pollSecret` 은 이 응답에서만 볼 수 있다. 서버에는 해시만 있다.
- 서버에 세션 서명 키가 없으면 `503 NOT_CONFIGURED`.

### `GET /api/v1/auth/cli/sessions/{sessionId}/authorize`

브라우저가 여는 주소. GitHub 로그인(`/auth/github` 와 같은 OAuth)으로 `302` 이동시킨다. OAuth `state` 에 `sessionId` 를 실어, 콜백이 끝나면 `/auth/github/callback` 이 웹 세션 쿠키 대신 이 세션을 `APPROVED` 로 바꾸고 사용자를 연결한다.

- 승인이 끝나면 "터미널로 돌아가세요" 안내 화면(HTML, `200`)을 보여 준다.
- GitHub 에서 승인을 취소하면 세션을 `DENIED` 로 바꾸고 "로그인이 취소되었습니다" 안내 화면(HTML, `200`)을 보여 준다.
- 모르는 세션이거나 만료됐거나 이미 처리된 세션이면 `404 NOT_FOUND` 다. 안내 HTML 이 아니라 위의 JSON 봉투로 답한다.
- 로그인을 시작한 브라우저가 아닌 곳에서 콜백이 오면(nonce 쿠키 불일치) `401 UNAUTHORIZED`.

### `POST /api/v1/auth/cli/sessions/{sessionId}/token`

CLI 폴링. 비밀을 URL 이 아니라 본문에 둔다.

요청: `{ "pollSecret": "..." }` (필수. 없거나 비어 있으면 `422 VALIDATION_ERROR`)

| `status` | 의미 | `accessToken` |
|---|---|---|
| `PENDING` | 아직 승인 전 | 없음 |
| `APPROVED` | 승인됨. **처음 한 번만** 토큰을 준다 | 세션 JWT |
| `DENIED` | 사용자가 GitHub 에서 승인을 취소함 | 없음 |
| `EXPIRED` | 만료됐거나 토큰을 이미 가져감 | 없음 |

오류

| 상태 | 의미 |
|---|---|
| `401 UNAUTHORIZED` | `pollSecret` 이 틀림. 이 API 의 401 은 "로그인 필요"가 아니다 |
| `404 NOT_FOUND` | 모르는 `sessionId` |
| `429 TOO_MANY_REQUESTS` | 너무 빠른 폴링. `Retry-After`(초) 헤더가 있다 |

#### 폴링 속도 제한 (`429`)

- `PENDING` 으로 답할 때만 적용한다. 직전 폴링으로부터 `interval` 에서 0.5초를 뺀 시간보다 빠르면 `429` 를 돌려주고 `Retry-After` 에 남은 초(올림, 최소 1)를 담는다. `APPROVED`·`DENIED`·`EXPIRED` 응답에는 적용하지 않는다.
- 거절한 요청은 기준 시각을 갱신하지 않는다. 계속 두드려도 `interval` 이 지나면 통과한다.
- **CLI 는** `429` 를 실패로 끝내지 않는다. `Retry-After` 와 `interval` 중 큰 값만큼 쉬고 같은 세션으로 다시 묻는다. 그렇게 기다리면 `expiresIn` 을 넘는 경우에만 더 묻지 않고 시간 초과로 끝낸다. 그 밖의 오류(`401`·`404`·`5xx` 등)는 그대로 실패시킨다.

## 토큰

웹 세션과 같은 HS256 JWT 다 (iris-was ADR 0003, 기본 7일). 서버는 토큰을 저장하지 않는다. CLI 는 `Authorization: Bearer <accessToken>` 으로 보낸다. 로그아웃은 CLI 가 저장한 토큰을 지우는 것뿐이다.

토큰을 내준 응답이 유실되면 복구할 수 없다(같은 세션은 `EXPIRED`). 이때는 `login` 을 다시 실행한다.
