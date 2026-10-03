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
