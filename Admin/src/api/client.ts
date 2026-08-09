export interface ApiEnvelope<T> {
  request_id: string;
  code: string;
  message: string;
  data: T;
  error: { retryable: boolean; details?: Record<string, unknown> } | null;
  timestamp: string;
}

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
const csrfStorageKey = 'eazypath_admin_csrf';
const csrfChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('eazypath-admin-csrf');
let csrfRestorePromise: Promise<string> | null = null;

type CsrfMessage = { type: 'request'; requestId: string } | { type: 'token'; requestId?: string; token: string } | { type: 'clear' };

csrfChannel?.addEventListener('message', (event: MessageEvent<CsrfMessage>) => {
  if (event.data.type === 'request') {
    const token = sessionStorage.getItem(csrfStorageKey);
    if (token) csrfChannel.postMessage({ type: 'token', requestId: event.data.requestId, token } satisfies CsrfMessage);
  } else if (event.data.type === 'token') {
    sessionStorage.setItem(csrfStorageKey, event.data.token);
  } else if (event.data.type === 'clear') {
    sessionStorage.removeItem(csrfStorageKey);
  }
});

export async function apiRequest<T>(path: string, init: RequestInit = {}, allowCsrfRetry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const csrf = sessionStorage.getItem(csrfStorageKey);
  if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  const response = await fetchApi(`${baseUrl}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !body || body.code !== 'OK') {
    if (body?.code === 'CSRF_INVALID' && allowCsrfRetry && !['GET', 'HEAD'].includes(init.method ?? 'GET')) {
      await restoreAdminCsrf(true);
      return apiRequest<T>(path, init, false);
    }
    if (isInvalidSession(response.status, body?.code)) expireAdminSession();
    throw new ApiClientError(
      body?.code ?? 'NETWORK_ERROR',
      body?.message ?? '无法连接管理 API',
      response.status,
      body?.error?.retryable ?? false,
      body?.error?.details,
    );
  }
  return body.data;
}

export async function apiBlobRequest(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetchApi(`${baseUrl}${path}`, { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiEnvelope<never> | null;
    if (isInvalidSession(response.status, body?.code)) expireAdminSession();
    throw new ApiClientError(
      body?.code ?? 'MEDIA_READ_FAILED',
      body?.message ?? '无法读取脱敏证据图片',
      response.status,
      body?.error?.retryable ?? false,
      body?.error?.details,
    );
  }
  return response.blob();
}

export function setAdminCsrf(token: string): void {
  sessionStorage.setItem(csrfStorageKey, token);
  csrfChannel?.postMessage({ type: 'token', token } satisfies CsrfMessage);
}

export function clearAdminCsrf(broadcast = true): void {
  sessionStorage.removeItem(csrfStorageKey);
  if (broadcast) csrfChannel?.postMessage({ type: 'clear' } satisfies CsrfMessage);
}

export async function restoreAdminCsrf(forceRotation = false): Promise<string> {
  if (csrfRestorePromise) return csrfRestorePromise;
  csrfRestorePromise = withCsrfLock(async () => {
    if (!forceRotation) {
      const local = sessionStorage.getItem(csrfStorageKey);
      if (local) return local;
      const peer = await requestPeerCsrf();
      if (peer) return peer;
    }
    const response = await fetchApi(`${baseUrl}/api/v1/admin/auth/csrf`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    const body = await response.json().catch(() => null) as ApiEnvelope<{ csrf_token: string }> | null;
    if (!response.ok || !body || body.code !== 'OK') {
      if (isInvalidSession(response.status, body?.code)) expireAdminSession();
      throw new ApiClientError(body?.code ?? 'CSRF_RESTORE_FAILED', body?.message ?? '无法恢复管理会话安全令牌', response.status, body?.error?.retryable ?? false);
    }
    setAdminCsrf(body.data.csrf_token);
    return body.data.csrf_token;
  }).finally(() => { csrfRestorePromise = null; });
  return csrfRestorePromise;
}

async function withCsrfLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return work();
  return navigator.locks.request('eazypath-admin-csrf-restore', work);
}

async function requestPeerCsrf(): Promise<string | null> {
  if (!csrfChannel) return null;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { csrfChannel.removeEventListener('message', receive); resolve(null); }, 120);
    const receive = (event: MessageEvent<CsrfMessage>) => {
      if (event.data.type !== 'token' || event.data.requestId !== requestId) return;
      window.clearTimeout(timer);
      csrfChannel.removeEventListener('message', receive);
      sessionStorage.setItem(csrfStorageKey, event.data.token);
      resolve(event.data.token);
    };
    csrfChannel.addEventListener('message', receive);
    csrfChannel.postMessage({ type: 'request', requestId } satisfies CsrfMessage);
  });
}

function isInvalidSession(status: number, code?: string): boolean {
  return status === 401 && ['ADMIN_AUTH_REQUIRED', 'ADMIN_SESSION_INVALID', 'ADMIN_SESSION_IDLE_TIMEOUT'].includes(code ?? '');
}

function expireAdminSession(): void {
  clearAdminCsrf();
  window.dispatchEvent(new Event('eazypath:admin-session-expired'));
}

async function fetchApi(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiClientError(
      'NETWORK_ERROR',
      '无法连接管理 API，请检查网络后重试',
      0,
      true,
      cause instanceof Error ? { cause: cause.name } : undefined,
    );
  }
}

export function formatDate(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
