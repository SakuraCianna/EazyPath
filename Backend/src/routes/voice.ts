import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { fail } from '../lib/api-response.js';
import { VoiceInputBudget } from '../domain/voice-protocol.js';
import { requireUser } from '../middleware/auth.js';
import { VoiceGatewaySession } from '../services/voice-gateway.js';
import {
  acquireVoiceStreamPermit,
  VoiceStreamProtectionUnavailableError,
  type VoiceStreamPermit,
} from '../services/voice-stream-guard.js';
import type { AppBindings } from '../types.js';

const CLIENT_BACKPRESSURE_BYTES = 512 * 1024;

export const voiceRouter = new Hono<AppBindings>();

voiceRouter.use('/voice-stream', requireUser);
voiceRouter.use('/voice-stream', async (c, next) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    c.header('Upgrade', 'websocket');
    return fail(c, 426, 'WEBSOCKET_UPGRADE_REQUIRED', '该接口仅支持 WebSocket 升级');
  }
  await next();
});

voiceRouter.get('/voice-stream', upgradeWebSocket((c) => {
  let permit: VoiceStreamPermit | null = null;
  let session: VoiceGatewaySession | null = null;
  let messageChain = Promise.resolve();
  const inputBudget = new VoiceInputBudget();
  let leaseRefreshTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (leaseRefreshTimer) clearInterval(leaseRefreshTimer);
    leaseRefreshTimer = null;
    await permit?.release().catch(() => undefined);
  };
  return {
    onOpen(_event, ws) {
      void (async () => {
        try {
          const acquired = await acquireVoiceStreamPermit(c.get('installationId'));
          if (closed || ws.readyState !== 1) {
            await acquired.release().catch(() => undefined);
            return;
          }
          if (!acquired.allowed) {
            trySendClientJson(ws, {
              type: 'error',
              code: 'VOICE_STREAM_LIMITED',
              message: '语音连接过于频繁，请稍后重试',
              retryable: true,
              retry_after_ms: acquired.retryAfterSeconds * 1_000,
              fallback: '可改用文字输入或关闭语音播报',
            });
            ws.close(1013, 'voice stream limited');
            return;
          }
          permit = acquired;
          session = new VoiceGatewaySession(c.get('installationId'), (payload) => {
            if (!trySendClientJson(ws, payload)) {
              closed = true;
              session?.close();
              ws.close(1013, 'client backpressure');
              void release();
              return false;
            }
            return true;
          });
          leaseRefreshTimer = setInterval(() => {
            void acquired.refresh().catch(() => {
              if (closed || ws.readyState !== 1) return;
              session?.close();
              trySendClientJson(ws, {
                type: 'error',
                code: 'VOICE_STREAM_PROTECTION_UNAVAILABLE',
                message: '语音连接保护服务暂时不可用',
                retryable: true,
                fallback: '可改用文字输入或关闭语音播报',
              });
              ws.close(1013, 'voice lease refresh failed');
              void release();
            });
          }, 30_000);
          if (!trySendClientJson(ws, { type: 'voice.ready', protocol_version: 1 })) {
            closed = true;
            session.close();
            ws.close(1013, 'client unavailable');
            await release();
          }
        } catch (error) {
          if (closed || ws.readyState !== 1) return;
          const code = error instanceof VoiceStreamProtectionUnavailableError
            ? 'VOICE_STREAM_PROTECTION_UNAVAILABLE'
            : 'VOICE_STREAM_UNAVAILABLE';
          trySendClientJson(ws, {
            type: 'error',
            code,
            message: '语音连接暂时不可用',
            retryable: true,
            fallback: '可改用文字输入或关闭语音播报',
          });
          ws.close(1013, 'voice stream unavailable');
        }
      })();
    },
    onMessage(event, ws) {
      if (closed || !session) return;
      const inputBytes = getClientMessageBytes(event.data);
      const returnBudget = inputBytes === null ? null : inputBudget.tryAcquire(inputBytes);
      if (!returnBudget) {
        closed = true;
        session.close();
        ws.close(1009, 'voice input queue exceeded');
        void release();
        return;
      }
      messageChain = messageChain.then(async () => {
        if (closed) return;
        if (typeof event.data === 'string') await session?.handleText(event.data);
        else if (event.data instanceof ArrayBuffer) await session?.handleBinary(new Uint8Array(event.data));
        else if (ArrayBuffer.isView(event.data)) {
          await session?.handleBinary(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        }
      }).catch(() => {
        if (closed || ws.readyState !== 1) return;
        closed = true;
        session?.close();
        trySendClientJson(ws, {
          type: 'error',
          code: 'VOICE_SESSION_UNAVAILABLE',
          message: '语音会话暂时不可用',
          retryable: true,
          fallback: '可改用文字输入或关闭语音播报',
        });
        ws.close(1011, 'voice session unavailable');
        void release();
      }).finally(returnBudget);
    },
    onClose() {
      closed = true;
      session?.close();
      void release();
    },
    onError(_event, ws) {
      closed = true;
      session?.close();
      ws.close(1011, 'voice gateway error');
      void release();
    },
  };
}));

function getClientBufferedAmount(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || !('bufferedAmount' in raw)) return 0;
  const bufferedAmount = (raw as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount) ? bufferedAmount : 0;
}

interface ClientWebSocket {
  readyState: number;
  raw?: unknown;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

function trySendClientJson(ws: ClientWebSocket, payload: Record<string, unknown>): boolean {
  if (ws.readyState !== 1) return false;
  const encoded = JSON.stringify(payload);
  if (getClientBufferedAmount(ws.raw) + Buffer.byteLength(encoded, 'utf8') > CLIENT_BACKPRESSURE_BYTES) return false;
  try {
    ws.send(encoded);
    return true;
  } catch {
    return false;
  }
}

function getClientMessageBytes(data: unknown): number | null {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return null;
}
