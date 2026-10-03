# Likelion CLI

[Likelion](https://github.com/2026-softbank-1/iris-was) Control API 를 터미널에서 쓰는 CLI. 명령 이름은 `likelion` 이다.

| 명령 | 설명 | 상태 |
|---|---|---|
| `likelion login` | 브라우저에서 GitHub 로그인을 승인하면 토큰을 받아 저장한다 | 구현됨 (서버 API 대기, [계약](docs/login-contract.md)) |
| `likelion whoami` | 로그인한 GitHub 계정을 보여 준다 | 구현됨 |
| `likelion logout` | 저장된 로그인 정보를 지운다 | 구현됨 |
| `likelion link` · `up` | 현재 폴더를 서비스에 연결하고 로컬 소스로 배포한다 | 예정 |
| `likelion logs` · `status` · `open` | 로그·상태 확인, 배포 도메인 열기 | 예정 |

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
