import type { Context } from 'hono';

export interface ApiErrorDetail {
  retryable: boolean;
  retry_after_ms?: number;
  details?: Record<string, unknown>;
}

export function ok<T>(c: Context, data: T, message = 'success', status = 200) {
  return c.json(
    {
      request_id: c.get('requestId') as string,
      code: 'OK',
      message,
      data,
      error: null,
      timestamp: new Date().toISOString(),
    },
    status as 200,
  );
}

export function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
  error: ApiErrorDetail = { retryable: false },
) {
  return c.json(
    {
      request_id: c.get('requestId') as string,
      code,
      message,
      data: null,
      error,
      timestamp: new Date().toISOString(),
    },
    status,
  );
}
