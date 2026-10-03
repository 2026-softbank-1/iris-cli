import { ApiError, CliError, ConnectionError } from "./errors.js";

interface ApiEnvelope<T> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
}

export type QueryValue = string | number | undefined;

export interface RequestOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

export type FetchLike = typeof fetch;

export const SESSION_EXPIRED_MESSAGE =
  "세션이 만료되었습니다. `likelion login` 을 다시 실행해 주세요.";

/** Control API 의 `ApiResponse` 봉투를 벗겨 `data` 만 돌려주는 얇은 클라이언트. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, "application/json", options);
    const envelope = await parseEnvelope<T>(response);
    if (!response.ok || !envelope?.success) throw failure(response, envelope, options.token);
    return envelope.data as T;
  }

  /** SSE 처럼 본문을 스트림으로 읽는 GET. 실패 응답이면 `request` 와 같은 오류를 던진다. */
  async openStream(path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await this.send("GET", path, "text/event-stream", options);
    if (!response.ok) throw failure(response, await parseEnvelope(response), options.token);
    return response;
  }

  private async send(
    method: string,
    path: string,
    accept: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1${path}${queryString(options.query)}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ConnectionError(this.baseUrl);
    }
  }
}

function queryString(query: Record<string, QueryValue> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function failure(
  response: Response,
  envelope: ApiEnvelope<unknown> | null,
  token: string | undefined,
): CliError {
  if (response.status === 401 && token) return new CliError(SESSION_EXPIRED_MESSAGE);
  return new ApiError(
    envelope?.message ?? `요청이 실패했습니다 (HTTP ${response.status})`,
    response.status,
    envelope?.code,
    retryAfterSeconds(response),
  );
}

/** `Retry-After` 는 초 단위 숫자만 읽는다. 날짜 형식이거나 없으면 undefined. */
function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T> | null> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return null;
  }
}
