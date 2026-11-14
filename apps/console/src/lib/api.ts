import type { ApiErrorBody } from '@landledger/contracts';

/** An error the API answered (`{ error: { code, message, details } }`), or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorOf(response: Response): Promise<ApiError> {
  let code = response.status === 401 ? 'unauthorized' : 'internal';
  let message = `The Landledger API answered ${response.status}.`;
  let details: unknown;
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message || message;
      details = body.error.details;
    }
  } catch {
    // Vite's proxy answers 502/504 (or 500 with an empty body) when the API isn't running.
    if (response.status >= 500) message = 'The Landledger API isn’t answering. Is it running on 127.0.0.1:4810?';
  }
  return new ApiError(response.status, code, message, details);
}

export async function request(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'The Landledger API did not answer.');
  }
  if (!response.ok) throw await errorOf(response);
  return response;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await (await request('GET', path, undefined, { signal })).json()) as T;
}

export async function send<T>(method: 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const response = await request(method, path, body);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Retry server errors twice; never retry a 4xx (it won't change). */
export const quiet = (failureCount: number, error: Error) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2;
