# `login` 서버 계약

CLI 가 기대하는 Control API(`iris-was`) 엔드포인트다. 서버 구현은 iris-was 쪽 작업이며, 이 문서가 두 레포의 합의 지점이다. 응답은 모두 `ApiResponse` 봉투, JSON 키는 camelCase 다.

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

인증 없음. 로그인 세션을 만든다.

```json
{
  "success": true,
  "data": {
    "sessionId": "<추측 불가한 공개 ID. verificationUrl 에 들어간다>",
    "pollSecret": "<CLI 만 아는 비밀. 폴링할 때만 쓴다>",
    "verificationUrl": "https://api.likelion.uk/api/v1/auth/cli/sessions/<sessionId>/authorize",
    "expiresIn": 600,
    "interval": 2
  }
}
```

`expiresIn`·`interval` 의 단위는 초다.

### `GET /api/v1/auth/cli/sessions/{sessionId}/authorize`

브라우저가 여는 주소. GitHub 로그인(`/auth/github` 와 같은 OAuth)으로 보낸다. OAuth `state` 에 `sessionId` 를 실어, 콜백이 끝나면 `/auth/github/callback` 이 웹 세션 쿠키 대신 이 세션을 `APPROVED` 로 바꾸고 사용자를 연결한다. 끝나면 "터미널로 돌아가세요" 안내 화면을 보여 준다. 만료됐거나 모르는 세션이면 404 안내.

### `POST /api/v1/auth/cli/sessions/{sessionId}/token`

CLI 폴링. 비밀을 URL 이 아니라 본문에 둔다.

요청: `{ "pollSecret": "..." }`

| `status` | 의미 | `accessToken` |
|---|---|---|
| `PENDING` | 아직 승인 전 | 없음 |
| `APPROVED` | 승인됨. **처음 한 번만** 토큰을 준다 | 세션 JWT |
| `DENIED` | 사용자가 승인하지 않음 | 없음 |
| `EXPIRED` | 만료됐거나 토큰을 이미 가져감 | 없음 |

`pollSecret` 이 틀리면 401, 모르는 `sessionId` 면 404 로 답한다.

## 토큰

웹 세션과 같은 HS256 JWT 다 (iris-was ADR 0003, 기본 7일). CLI 는 `Authorization: Bearer <accessToken>` 으로 보낸다. 로그아웃은 CLI 가 저장한 토큰을 지우는 것뿐이다.

## 서버 구현 메모

- 대기 중인 세션은 상태를 저장해야 한다 (`cli_login_sessions` 같은 테이블: 공개 ID, `pollSecret` 해시, 상태, `user_id`, 만료 시각, 소비 시각). 스키마 변경이라 모델 → Alembic revision → `db-schema.sql` 한 세트가 필요하다.
- `pollSecret` 은 해시로만 저장하고 비교는 상수 시간으로 한다.
- 폴링 남용을 막기 위해 `interval` 보다 빠른 요청은 429 로 줄이는 것을 검토한다.
