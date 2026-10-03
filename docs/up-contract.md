# `up` 서버 계약

`likelion up` 이 기대하는 Control API(`iris-was`) 동작이다. 서버 구현은 iris-was 쪽 작업이며, 이 문서가 두 레포의 합의 지점이다. 응답은 모두 `ApiResponse` 봉투, JSON 키는 camelCase 다. 계약과 달라지는 점이 생기면 이 문서를 같이 고친다.

## 흐름

```text
CLI                                   Control API
 │ (현재 폴더를 tar.gz 로 묶는다)            │
 │ POST /services/{id}/uploads            │
 │   본문 = tar.gz                         │ 업로드 저장 (한도·형식 검사)
 │◀── 201 uploadId, sizeBytes, sha256 ────│
 │ POST /services/{id}/deployments        │
 │   { triggerType: CLI, uploadId }       │ 배포 요청 생성 (업로드를 이 요청에 묶는다)
 │◀── 배포 요청(id, status=QUEUED …) ──────│
 │ GET /services/{id}/deployments/{id}    │ Build Worker 가 업로드를 소스 스냅샷으로 쓴다
 │   (상태가 끝날 때까지 폴링)               │
 │◀── SUCCEEDED / FAILED …                │
```

## 엔드포인트

### `POST /api/v1/services/{serviceId}/uploads`

로컬 소스 아카이브를 올린다. 인증은 `Authorization: Bearer`. 요청 본문이 곧 아카이브다(multipart 아님).

| 헤더 | 값 |
|---|---|
| `Content-Type` | `application/gzip` |
| `Content-Length` | 필수 (본문 바이트 수) |

본문은 `tar` 를 gzip 으로 압축한 파일이다. 서비스 소스의 루트가 아카이브의 루트다(GitHub 소스 스냅샷과 같은 모양: 최상위에 파일이 바로 있고 `.git` 은 없다).

응답 `201`:

```json
{
  "success": true,
  "data": {
    "uploadId": "<추측 불가한 ID>",
    "sizeBytes": 123456,
    "sha256": "<아카이브의 sha256 hex>",
    "expiresAt": "2026-10-04T00:00:00Z"
  }
}
```

- 서비스가 로그인한 사용자 것이 아니면 `404`(`SERVICE_NOT_FOUND`)다.
- 크기 한도(현재 소스 스냅샷 한도 `snapshot_max_bytes` 와 같게)를 넘으면 `413`(`UPLOAD_TOO_LARGE`). 본문을 다 읽기 전에 `Content-Length` 로 먼저 거절한다.
- gzip 이 아니면 `415`(`UPLOAD_NOT_GZIP`), 빈 본문·`Content-Length` 없음은 `422`.
- 업로드는 `expiresAt` 이 지나거나 배포 요청에 쓰이면 더 쓸 수 없다.

### `POST /api/v1/services/{serviceId}/deployments`

기존 배포 요청 API 에 `CLI` 트리거를 더한다. 헤더 `Idempotency-Key` 는 기존과 같다.

```json
{ "triggerType": "CLI", "uploadId": "<uploadId>" }
```

- `triggerType=CLI` 이면 `uploadId` 가 필수이고, 다른 트리거에서는 `uploadId` 를 받지 않는다(기존 `sourceDeploymentId` 검증과 같은 방식).
- 응답은 기존 `DeploymentResponse` 와 같다. `sourceSha` 에는 업로드를 가리키는 값을 넣는다(형식은 서버가 정하고 `docs/up-contract.md` 에 적는다). `sourceCommitMessage` 는 비어 있어도 된다.
- 알 수 없는 `uploadId` 는 `404`(`UPLOAD_NOT_FOUND`), 이미 쓰였거나 만료됐으면 `409`(`UPLOAD_UNAVAILABLE`), 진행 중인 배포가 있으면 기존대로 `409`(`DEPLOYMENT_IN_PROGRESS`).
- 한 업로드는 배포 요청 하나에만 묶인다.

### 빌드

Build Worker 는 `CLI` 요청의 소스를 GitHub 가 아니라 이 업로드에서 가져와 기존 소스 스냅샷(`snapshots/{buildId}.tar.gz`)과 같은 자리에 둔다. 그 뒤 CodeBuild·배포 단계는 기존과 같다.

## CLI 쪽 규칙

- 아카이브에서 `.git`·`node_modules`·`.likelion` 은 항상 뺀다. 폴더의 `.gitignore` 와 `.likelionignore` 도 따른다.
- 한도를 넘는 아카이브는 올리기 전에 알려 주고, 서버의 `413` 도 같은 메시지로 안내한다.
- 배포가 끝날 때까지 `GET /services/{id}/deployments/{deploymentId}` 를 폴링해 상태 전이를 출력한다. 서버에는 빌드 로그 API(`GET /services/{id}/deployments/{deploymentId}/build-logs`)가 있지만 `up` 은 아직 쓰지 않고 상태만 보여 준다.
- 폴링 중 5xx 와 연결 오류는 연속 5회까지 2~5초씩 늘려 가며 다시 확인한다(성공하면 횟수를 0 으로 되돌린다). 넘으면 배포 번호와 `likelion status` 확인 안내를 담아 끝낸다. 4xx 는 다시 시도하지 않고 바로 끝낸다.
