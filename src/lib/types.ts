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

export interface DeploymentDetail extends LatestDeployment {
  stages: DeploymentStage[];
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
  onpremServerId?: number;
  /** 서버 타깃의 연결 상태. 공용 타깃은 없다(항상 배포할 수 있다). */
  connectionStatus?: OnpremServerStatus;
}

export type OnpremServerStatus = "PENDING" | "REGISTERING" | "CONNECTED" | "FAILED";

export interface OnpremServer {
  id: number;
  name: string;
  serverKey: string;
  status: OnpremServerStatus;
  targetId: number;
  tailnetFqdn?: string;
  failureCode?: string;
  registrationExpiresAt?: string;
  connectedAt?: string;
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
