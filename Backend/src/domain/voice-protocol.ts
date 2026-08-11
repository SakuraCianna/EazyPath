import { z } from 'zod';

export const ASR_SAMPLE_RATE = 16_000;
export const ASR_BYTES_PER_SECOND = ASR_SAMPLE_RATE * 2;
export const ASR_MAX_SECONDS = 60;
export const ASR_MAX_BYTES = ASR_BYTES_PER_SECOND * ASR_MAX_SECONDS;
export const VOICE_MAX_CLIENT_MESSAGE_BYTES = 16_384;
export const VOICE_MAX_PENDING_INPUT_BYTES = 256 * 1024;
export const VOICE_MAX_PENDING_INPUT_MESSAGES = 32;

export class VoiceInputBudget {
  private pendingBytes = 0;
  private pendingMessages = 0;

  tryAcquire(bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    if (this.pendingBytes + bytes > VOICE_MAX_PENDING_INPUT_BYTES
      || this.pendingMessages + 1 > VOICE_MAX_PENDING_INPUT_MESSAGES) return null;
    this.pendingBytes += bytes;
    this.pendingMessages += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingBytes -= bytes;
      this.pendingMessages -= 1;
    };
  }
}

const audioStartSchema = z.object({
  type: z.literal('audio.start'),
  session_id: z.uuid(),
  sample_rate: z.literal(ASR_SAMPLE_RATE),
  encoding: z.literal('pcm_s16le'),
}).strict();

const audioStopSchema = z.object({ type: z.literal('audio.stop') }).strict();

const ttsStartSchema = z.object({
  type: z.literal('tts.start'),
  task_id: z.uuid(),
  card_id: z.uuid().nullable().optional(),
  playback_id: z.uuid(),
  speed: z.number().min(0.5).max(2).default(1),
}).strict();

const ttsCancelSchema = z.object({
  type: z.literal('tts.cancel'),
  playback_id: z.uuid(),
}).strict();

export const voiceClientMessageSchema = z.discriminatedUnion('type', [
  audioStartSchema,
  audioStopSchema,
  ttsStartSchema,
  ttsCancelSchema,
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;

export function parseVoiceClientMessage(value: string): VoiceClientMessage | null {
  if (Buffer.byteLength(value, 'utf8') > VOICE_MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = voiceClientMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function publicVoiceError(
  code: string,
  message: string,
  retryable = false,
  fallback = '可改用文字输入或关闭语音播报',
) {
  return { type: 'error', code, message, retryable, fallback } as const;
}
