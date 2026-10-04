import { ApiError, type ApiErrorDetail, AuthError, type CliError, ConnectionError } from "./errors.js";

interface ApiEnvelope<T> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
  details?: ApiErrorDetail[];
}

export type QueryValue = string | number | undefined;

/** 파일 업로드처럼 JSON 이 아니라 원본 바이트를 그대로 보내는 본문. */
export interface StreamBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  stream?: StreamBody;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

export type FetchLike = typeof fetch;

export const SESSION_EXPIRED_MESSAGE =
  "세션이 만료되었습니다. `likelion login` 을 다시 실행해 주세요.";

export const ENV_TOKEN_REJECTED_MESSAGE =
  "LIKELION_TOKEN 이 올바르지 않거나 만료되었습니다. 새 토큰으로 바꾸거나, 환경변수를 지우고 `likelion login` 을 실행해 주세요.";

/** Control API 의 `ApiResponse` 봉투를 벗겨 `data` 만 돌려주는 얇은 클라이언트. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, "application/json", options);
    // 삭제처럼 본문 없이 끝나는 성공(204)에는 봉투가 없다.
    if (response.status === 204) return undefined as T;
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
    const headers: Record<string, string> = { Accept: accept, ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    let body: RequestInit["body"];
    if (options.stream) {
      headers["Content-Type"] = options.stream.contentType;
      headers["Content-Length"] = String(options.stream.contentLength);
      body = options.stream.body;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1${path}${queryString(options.query)}`, {
        method,
        headers,
        body,
        // 스트림 본문은 duplex 를 명시해야 한다.
        ...(options.stream ? { duplex: "half" } : {}),
        signal: options.signal,
      } as RequestInit);
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
  if (response.status === 401 && token) {
    return new AuthError(
      token === process.env.LIKELION_TOKEN?.trim() ? ENV_TOKEN_REJECTED_MESSAGE : SESSION_EXPIRED_MESSAGE,
    );
  }
  return new ApiError(
    envelope?.message ?? `요청이 실패했습니다 (HTTP ${response.status})`,
    response.status,
    envelope?.code,
    retryAfterSeconds(response),
    envelope?.details,
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
