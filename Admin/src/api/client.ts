export interface ApiEnvelope<T> {
  request_id: string;
  code: string;
  message: string;
  data: T;
  error: { retryable: boolean; details?: Record<string, unknown> } | null;
  timestamp: string;
}

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const csrf = sessionStorage.getItem('eazypath_admin_csrf');
  if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !body || body.code !== 'OK') {
    throw new ApiClientError(body?.code ?? 'NETWORK_ERROR', body?.message ?? '无法连接管理 API', response.status);
  }
  return body.data;
}

export function formatDate(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
