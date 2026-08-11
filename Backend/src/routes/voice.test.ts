import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock('@hono/node-server', () => ({
  upgradeWebSocket: () => (c: { text: (value: string) => Response }) => c.text('upgraded'),
}));
vi.mock('../middleware/auth.js', () => ({
  requireUser: async (
    c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: string) => void; json: (value: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (c.req.header('authorization') !== 'Bearer valid') {
      return c.json({ success: false, error: { code: 'AUTH_REQUIRED' } }, 401);
    }
    c.set('installationId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
}));
vi.mock('../services/voice-stream-guard.js', () => ({
  acquireVoiceStreamPermit: (...arguments_: unknown[]) => guard.acquire(...arguments_),
  VoiceStreamProtectionUnavailableError: class extends Error {},
}));
vi.mock('../services/voice-gateway.js', () => ({ VoiceGatewaySession: class {} }));

import { voiceRouter } from './voice.js';

describe('语音 WebSocket 建连门禁', () => {
  beforeEach(() => vi.clearAllMocks());

  it('没有 Bearer 会话时在升级前拒绝', async () => {
    const app = new Hono().route('/ws', voiceRouter);
    const response = await app.request('/ws/voice-stream');
    expect(response.status).toBe(401);
    expect(guard.acquire).not.toHaveBeenCalled();
  });

  it('普通 HTTP 请求返回 426 且不占用 Redis 租约', async () => {
    const app = new Hono().route('/ws', voiceRouter);
    const response = await app.request('/ws/voice-stream', { headers: { authorization: 'Bearer valid' } });
    expect(response.status).toBe(426);
    expect(response.headers.get('upgrade')).toBe('websocket');
    expect(guard.acquire).not.toHaveBeenCalled();
  });

  it('升级请求进入处理器时仍不提前获取租约', async () => {
    const app = new Hono().route('/ws', voiceRouter);
    const response = await app.request('/ws/voice-stream', {
      headers: { authorization: 'Bearer valid', upgrade: 'websocket' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upgraded');
    expect(guard.acquire).not.toHaveBeenCalled();
  });
});
