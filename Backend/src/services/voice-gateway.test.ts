import { beforeEach, describe, expect, it, vi } from 'vitest';

const consent = vi.hoisted(() => ({ active: vi.fn() }));

vi.mock('../config/env.js', () => ({
  getEnv: () => ({
    TTS_MODEL: 'qwen-audio-3.0-tts-plus',
    TTS_VOICE: 'longanlingxin',
  }),
}));
vi.mock('./ai-consent.js', () => ({
  hasActiveAiConsent: (...arguments_: unknown[]) => consent.active(...arguments_),
}));
vi.mock('./voice-content.js', () => ({ getAuthorizedTtsText: vi.fn() }));

import { createTtsRunTask, mapAsrProviderEvent, VoiceGatewaySession } from './voice-gateway.js';

describe('百炼语音协议映射', () => {
  beforeEach(() => vi.clearAllMocks());

  it('客户端关闭后不再处理已排队的会话启动消息', async () => {
    const session = new VoiceGatewaySession('00000000-0000-4000-8000-000000000001', () => true);
    session.close();
    await session.handleText(JSON.stringify({
      type: 'audio.start',
      session_id: '00000000-0000-4000-8000-000000000002',
      sample_rate: 16_000,
      encoding: 'pcm_s16le',
    }));
    expect(consent.active).not.toHaveBeenCalled();
  });

  it('只向客户端输出 ASR 中间文本与最终文本', () => {
    expect(mapAsrProviderEvent({
      type: 'conversation.item.input_audio_transcription.text',
      text: '去',
      stash: '南',
      installation_id: '不得透传',
    })).toEqual({ type: 'transcript.partial', text: '去南' });
    expect(mapAsrProviderEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '去南昌。',
    })).toEqual({ type: 'transcript.final', text: '去南昌。' });
  });

  it('ASR 失败事件只映射稳定公开错误，不透传供应商详情', () => {
    expect(mapAsrProviderEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'provider secret detail' },
    })).toEqual({
      type: 'error',
      code: 'ASR_PROVIDER_ERROR',
      message: '语音识别服务暂时不可用',
      retryable: true,
      fallback: '请改用文字输入',
    });
  });

  it('TTS run-task 使用当前模型、合法音色、PCM 和有界语速', () => {
    const event = createTtsRunTask('00000000-0000-4000-8000-000000000001', 0.8);
    expect(event.payload).toMatchObject({
      model: 'qwen-audio-3.0-tts-plus',
      parameters: {
        voice: 'longanlingxin',
        format: 'pcm',
        sample_rate: 24_000,
        rate: 0.8,
      },
      input: {},
    });
  });
});
