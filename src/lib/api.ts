import { ApiError, CliError } from "./errors.js";

interface ApiEnvelope<T> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
}

export type FetchLike = typeof fetch;

/** Control API 의 `ApiResponse` 봉투를 벗겨 `data` 만 돌려주는 얇은 클라이언트. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new CliError(`서버에 연결할 수 없습니다: ${this.baseUrl}`);
    }

    const envelope = await parseEnvelope<T>(response);
    if (!response.ok || !envelope?.success) {
      throw new ApiError(
        envelope?.message ?? `요청이 실패했습니다 (HTTP ${response.status})`,
        response.status,
        envelope?.code,
      );
    }
    return envelope.data as T;
  }
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T> | null> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return null;
  }
}
