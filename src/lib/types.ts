// Control API 응답 중 CLI 가 쓰는 필드만 옮긴 것이다. 서버는 null 필드를 응답에서 빼므로 선택 필드다.

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface Project {
  id: number;
  name: string;
}

export interface LatestDeployment {
  id: number;
  status: string;
  sourceSha: string;
  sourceCommitMessage?: string;
  triggerType: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: number;
  projectId: number;
  name: string;
  sourceRepositoryUrl: string;
  sourceBranch: string;
  targetIds: number[];
  latestDeployment?: LatestDeployment;
}

export interface DeploymentStage {
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationSeconds?: number;
}

/** 배포 요청 1건(목록 항목·생성 응답). 서버는 null 필드를 뺀다. */
export interface Deployment extends LatestDeployment {
  serviceId: number;
  /** 재배포·롤백·재시작이 따라간 원본 배포 */
  sourceDeploymentId?: number;
  isActive: boolean;
  requestedDeploymentStrategy?: string;
  deploymentStrategy?: string;
}

export interface DeploymentHistory {
  fromStatus?: string;
  toStatus: string;
  failureCode?: string;
  createdAt: string;
}

export interface DeploymentBuild {
  status: string;
  builder?: string;
  imageDigest?: string;
  startedAt?: string;
  finishedAt?: string;
  failureCode?: string;
}

export interface DeploymentRelease {
  id: number;
  targetId: number;
  status: string;
  argoSyncStatus?: string;
  argoHealthStatus?: string;
  gitopsCommitSha?: string;
  failureCode?: string;
  finishedAt?: string;
}

export interface DeploymentDetail extends LatestDeployment {
  stages: DeploymentStage[];
  serviceId?: number;
  sourceDeploymentId?: number;
  isActive?: boolean;
  requestedDeploymentStrategy?: string;
  deploymentStrategy?: string;
  history?: DeploymentHistory[];
  source?: { repository: string; branch: string };
  configuration?: {
    build?: { builder?: string; rootDirectory?: string; buildCommand?: string };
    deploy?: {
      targets?: { id: number; name: string; kind?: string }[];
      port?: number;
      startCommand?: string;
    };
  };
  build?: DeploymentBuild;
  releases?: DeploymentRelease[];
  replacedBy?: { deploymentId: number; at: string };
}

export interface ServiceDomain {
  targetId: number;
  targetName: string;
  isConnected: boolean;
  host?: string;
  url?: string;
}

export interface Target {
  id: number;
  name: string;
  kind?: string;
  /** 사용자가 등록한 서버의 타깃이면 그 서버 id. 공용 타깃은 없다. */
  onpremServerId?: number | null;
  /** 서버 타깃이면 그 서버 이름. 이 필드가 없는 서버는 `GET /onprem-servers` 로 찾는다. */
  onpremServerName?: string | null;
  /** 서버 타깃의 연결 상태. 공용 타깃은 없다(항상 배포할 수 있다). */
  connectionStatus?: OnpremServerStatus | null;
}

/**
 * `DISCONNECTED` 는 연결됐던 서버의 신호(하트비트)가 한동안 끊긴 상태다. 신호가 다시 오면 저절로
 * `CONNECTED` 로 돌아온다. 서버(iris-was)가 계산해서 주는 값이다.
 */
export type OnpremServerStatus = "PENDING" | "REGISTERING" | "CONNECTED" | "DISCONNECTED" | "FAILED";

export interface OnpremServer {
  id: number;
  name: string;
  serverKey: string;
  status: OnpremServerStatus;
  targetId: number;
  tailnetFqdn?: string | null;
  failureCode?: string | null;
  registrationExpiresAt?: string | null;
  connectedAt?: string | null;
  /** 서버가 마지막으로 신호를 보낸 시각(1분마다). 한 번도 연결되지 않았으면 없다 */
  lastSeenAt?: string | null;
  createdAt: string;
}

/** 서버 등록·토큰 재발급 응답. 토큰은 설치 명령에 들어 있고 이 응답에서만 받는다. */
export interface OnpremServerRegistration {
  server: OnpremServer;
  registrationToken: string;
  installCommand: string;
}

export interface LogEntry {
  timestampNs: string;
  message: string;
  pod: string;
  container: string;
}

export interface LogsPage {
  entries: LogEntry[];
  isTruncated: boolean;
}

export interface BuildLogEntry {
  timestampNs: string;
  message: string;
}

export interface BuildLogsPage {
  entries: BuildLogEntry[];
  nextCursor?: string;
  buildStatus?: string;
  /** 빌드가 끝났고 이번 호출에서 읽은 줄이 없다. 폴링을 멈춘다. */
  isComplete: boolean;
  /** 앞부분이 빠진 끝부분만 받았다 */
  isPartial?: boolean;
  /** 롤백·재시작은 새로 빌드하지 않아 원본 배포의 로그다 */
  loggedDeploymentId?: number;
}

export interface DeployLogsPage {
  entries: LogEntry[];
  isTruncated: boolean;
}

export interface NetworkLogEntry {
  timestampNs: string;
  status: number;
  targetStatus?: number;
  receivedBytes: number;
  sentBytes: number;
  responseTimeSeconds?: number;
}

export interface NetworkLogsPage {
  entries: NetworkLogEntry[];
  isTruncated: boolean;
}

export interface Variable {
  key: string;
  value: string;
}

export interface SystemVariable {
  key: string;
  description: string;
  value?: string;
}

export interface ServiceVariables {
  variables: Variable[];
  systemVariables: SystemVariable[];
}

export type DiagnosisStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export interface DiagnosisHypothesis {
  id: string;
  category: string;
  supportLevel: string;
  statement: string;
  evidenceIds?: string[];
  uncertainty?: string;
}

export interface DiagnosisChange {
  kind: string;
  target: string;
  instruction: string;
  language?: string;
  snippet?: string;
}

export interface DiagnosisPlan {
  id: string;
  title: string;
  applyWhen?: string[];
  changes?: DiagnosisChange[];
  verification?: { instruction: string; expectedResult: string }[];
  rollback?: string[];
  risks?: string[];
}

export interface DiagnosisAnalysis {
  analysisStatus: string;
  summary: string;
  hypotheses?: DiagnosisHypothesis[];
  nextChecks?: { target: string; method: string; purpose: string }[];
  missingInformation?: { requestedData: string; reason: string }[];
  limitations?: string[];
  remediation?: { status: string; reason: string; plans?: DiagnosisPlan[] };
}

export interface EvidenceLine {
  id: string;
  sourceId: string;
  stage: string;
  text: string;
}

export interface SourceFinding {
  path: string;
  startLine: number;
  endLine: number;
  explanation: string;
}

export interface Diagnosis {
  id: number;
  deploymentId: number;
  status: DiagnosisStatus;
  errorCode?: string;
  analysis?: DiagnosisAnalysis;
  evidence?: EvidenceLine[];
  sourceAnalysis?: { status: string; reason: string; findings?: SourceFinding[] };
  inputLimitations?: string[];
  createdAt: string;
  finishedAt?: string;
}

export interface RepairPublication {
  status: string;
  branch?: string;
  commitSha?: string;
  pullUrl?: string;
  mergeCommitSha?: string;
  redeploymentId?: number;
  errorCode?: string;
}

export interface Repair {
  id: number;
  deploymentId: number;
  diagnosisId: number;
  /** RUNNING · SUCCEEDED · FAILED · UNKNOWN_OUTCOME */
  status: string;
  sourceSha: string;
  planIds: string[];
  errorCode?: string;
  createdAt: string;
  finishedAt?: string;
  publication?: RepairPublication;
  autoMerge?: boolean;
  autoRedeploy?: boolean;
}

export interface RepairAccess {
  repository: string;
  canWrite: boolean;
  installationUrl: string;
  reason?: string;
}
