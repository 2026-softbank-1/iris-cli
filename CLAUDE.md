# Likelion CLI

Likelion 배포 서비스의 터미널 클라이언트다. 서버(Control API)는 [iris-was](https://github.com/2026-softbank-1/iris-was) 레포이고, 이 레포는 그 API 를 부르는 npm 패키지(TypeScript, Node 20+)만 담는다.

## 서비스명

- 서비스명은 **likelion** 이다. 명령은 `likelion`, 설정 디렉터리는 `~/.config/likelion`, 환경변수는 `LIKELION_*` 로 쓴다.
- 옛 이름 `AnyDeploy`·`anydeploy` 는 쓰지 않는다. 사용자에게 보이는 문구·식별자·문서에 새로 들이지 않는다.
- iris-was 안의 `anydeploy_session` 쿠키 같은 옛 이름은 서버 쪽 일이다. 이 레포에서 서버 이름에 맞추려고 되돌리지 않는다.

## 작업 방식

- 구조·명령·설정은 [README.md](README.md) 를 따른다. 서버와 맞출 API 계약은 `docs/` 에 둔다 (`docs/login-contract.md`).
- 실행: `npm run dev -- <명령>` · `npm run typecheck` · `npm test` · `npm run build`. 커밋 전에 셋 다 통과시킨다.
- 서버 응답의 `ApiResponse` 봉투는 `src/lib/api.ts` 에서만 벗기고, 사용자에게 보일 오류는 `CliError` 로 던진다.
- 토큰·비밀값은 출력·로그·테스트 픽스처에 남기지 않는다. 테스트는 `LIKELION_CONFIG_DIR` 로 임시 디렉터리를 쓴다.
- 커밋 메시지는 Conventional Commits(`feat: 설명`), 한글, 명령형, 제목 50자 이내로 쓴다.
