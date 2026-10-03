# 개발자 문서

README 에서 옮긴 개발자용 내용이다. 서버와 맞출 계약은 [login-contract.md](login-contract.md)·[up-contract.md](up-contract.md) 에 있다.

## 사용하는 API

| 명령 | 엔드포인트 |
|---|---|
| `link` | `GET /projects` · `GET /projects/{id}/services` |
| `status` | `GET /services/{id}` · `GET /services/{id}/domains` · `GET /services/{id}/deployments/{deploymentId}` |
| `logs` | `GET /services/{id}/logs` · `GET /services/{id}/logs/stream`(SSE) · `GET /targets` |
| `login` | `POST /auth/cli/sessions` · `POST /auth/cli/sessions/{sessionId}/token`(폴링, `429` 면 `Retry-After` 만큼 쉬고 재시도) · `GET /me` |
| `open` | `GET /services/{id}/domains` |
| `up` | `POST /services/{id}/uploads`(본문 = tar.gz) · `POST /services/{id}/deployments`(`triggerType=CLI`) · `GET /services/{id}/deployments/{deploymentId}`(폴링) · `GET /services/{id}/domains` |

## 릴리스

GitHub Actions 로 자동화하지 않았다. 버전을 올릴 때 손으로 한다.

1. `npm version <버전> --no-git-tag-version` 으로 `package.json`·`package-lock.json` 을 올리고 PR 로 `main` 에 병합한다.
2. 병합된 `main` 에서 `npm ci && npm run build && npm pack` 으로 `likelion-<버전>.tgz` 를 만든다.
3. `gh release create v<버전> likelion-<버전>.tgz --target <main 커밋> --title "v<버전>" --notes "<변경 내용>"` 으로 릴리스를 만든다.
4. [README](../README.md#설치) 설치 명령의 주소를 새 버전으로 바꾼 뒤 설치해 `likelion --version` 이 맞는지 확인한다.

## 규칙

- 서버 응답은 `ApiResponse` 봉투(`success`·`code`·`message`·`data`)이고 JSON 키는 camelCase 다. 봉투는 `src/lib/api.ts` 한 곳에서 벗긴다.
- 사용자에게 보일 오류는 `CliError` 로 던진다. `src/index.ts` 가 메시지 한 줄과 종료 코드로 끝낸다.
- 커밋 메시지는 Conventional Commits(`feat: 설명`), 한글, 명령형으로 쓴다.
