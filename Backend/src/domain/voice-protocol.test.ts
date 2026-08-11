import { describe, expect, it } from 'vitest';
import {
  ASR_MAX_BYTES,
  parseVoiceClientMessage,
  VoiceInputBudget,
  VOICE_MAX_CLIENT_MESSAGE_BYTES,
  VOICE_MAX_PENDING_INPUT_BYTES,
} from './voice-protocol.js';

describe('语音网关客户端协议', () => {
  it('只接受固定的 16k PCM ASR 启动消息', () => {
    expect(parseVoiceClientMessage(JSON.stringify({
      type: 'audio.start',
      session_id: '00000000-0000-4000-8000-000000000001',
      sample_rate: 16_000,
      encoding: 'pcm_s16le',
    }))?.type).toBe('audio.start');
    expect(parseVoiceClientMessage(JSON.stringify({
      type: 'audio.start',
      session_id: '00000000-0000-4000-8000-000000000001',
      sample_rate: 44_100,
      encoding: 'pcm_s16le',
    }))).toBeNull();
  });

  it('拒绝未知字段、任意 TTS 文本和超大控制消息', () => {
    expect(parseVoiceClientMessage(JSON.stringify({ type: 'audio.stop', extra: true }))).toBeNull();
    expect(parseVoiceClientMessage(JSON.stringify({
      type: 'tts.start',
      task_id: '00000000-0000-4000-8000-000000000001',
      playback_id: '00000000-0000-4000-8000-000000000002',
      text: '不能由客户端指定',
    }))).toBeNull();
    expect(parseVoiceClientMessage(`"${'x'.repeat(VOICE_MAX_CLIENT_MESSAGE_BYTES)}"`)).toBeNull();
  });

  it('把单次录音硬限制为 60 秒 PCM 字节数', () => {
    expect(ASR_MAX_BYTES).toBe(1_920_000);
  });

  it('在异步处理前同步限制待处理消息字节并可精确归还', () => {
    const budget = new VoiceInputBudget();
    const releases = Array.from({ length: 4 }, () => budget.tryAcquire(VOICE_MAX_PENDING_INPUT_BYTES / 4));
    expect(releases.every(Boolean)).toBe(true);
    expect(budget.tryAcquire(1)).toBeNull();
    releases[0]?.();
    expect(budget.tryAcquire(1)).not.toBeNull();
  });
});
