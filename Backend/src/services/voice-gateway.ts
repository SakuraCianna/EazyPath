import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { getEnv } from '../config/env.js';
import {
  ASR_MAX_BYTES,
  parseVoiceClientMessage,
  publicVoiceError,
  type VoiceClientMessage,
} from '../domain/voice-protocol.js';
import { hasActiveAiConsent } from './ai-consent.js';
import { getAuthorizedTtsText } from './voice-content.js';

const PROVIDER_BACKPRESSURE_BYTES = 512 * 1024;
const CLIENT_CHUNK_MAX_BYTES = 64 * 1024;
const TTS_SAMPLE_RATE = 24_000;
const TTS_MAX_SESSION_MS = 15_000;
const ASR_FINISH_GRACE_MS = 5_000;

type SendJson = (payload: Record<string, unknown>) => boolean;

export class VoiceProviderConfigurationError extends Error {
  constructor() {
    super('百炼语音工作区未配置');
    this.name = 'VoiceProviderConfigurationError';
  }
}

export function mapAsrProviderEvent(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as Record<string, unknown>;
  if (event.type === 'conversation.item.input_audio_transcription.text') {
    const text = typeof event.text === 'string' ? event.text : '';
    const stash = typeof event.stash === 'string' ? event.stash : '';
    const preview = `${text}${stash}`;
    return preview ? { type: 'transcript.partial', text: preview } : null;
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    return typeof event.transcript === 'string' ? { type: 'transcript.final', text: event.transcript } : null;
  }
  if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
    return publicVoiceError('ASR_PROVIDER_ERROR', '语音识别服务暂时不可用', true, '请改用文字输入');
  }
  return null;
}

export function createTtsRunTask(taskId: string, speed: number) {
  const env = getEnv();
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: env.TTS_MODEL,
      parameters: {
        text_type: 'PlainText',
        voice: env.TTS_VOICE,
        format: 'pcm',
        sample_rate: TTS_SAMPLE_RATE,
        volume: 50,
        rate: speed,
        pitch: 1,
        enable_ssml: false,
        language_hints: ['zh'],
      },
      input: {},
    },
  };
}

export class VoiceGatewaySession {
  private provider: WebSocket | null = null;
  private mode: 'asr' | 'tts' | null = null;
  private asrReady = false;
  private asrStopping = false;
  private asrBytes = 0;
  private playbackId: string | null = null;
  private providerTaskId: string | null = null;
  private ttsText: string | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private consentCheckAt = 0;
  private consentCheck: Promise<boolean> | null = null;
  private providerGeneration = 0;
  private closed = false;

  constructor(
    private readonly installationId: string,
    private readonly sendJson: SendJson,
  ) {}

  async handleText(value: string): Promise<void> {
    if (this.closed) return;
    const message = parseVoiceClientMessage(value);
    if (!message) {
      this.sendJson(publicVoiceError('VOICE_MESSAGE_INVALID', '语音控制消息无效'));
      return;
    }
    await this.handleMessage(message);
  }

  async handleBinary(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    if (this.mode !== 'asr' || !this.provider || !this.asrReady || this.asrStopping) {
      this.sendJson(publicVoiceError('ASR_NOT_READY', '语音识别尚未就绪', true, '请稍后重试或改用文字输入'));
      return;
    }
    if (data.byteLength === 0 || data.byteLength > CLIENT_CHUNK_MAX_BYTES || data.byteLength % 2 !== 0) {
      this.sendJson(publicVoiceError('AUDIO_CHUNK_INVALID', '录音分片格式无效'));
      this.stopProvider(1008, 'invalid audio chunk');
      return;
    }
    this.asrBytes += data.byteLength;
    if (this.asrBytes > ASR_MAX_BYTES) {
      this.sendJson(publicVoiceError('AUDIO_DURATION_EXCEEDED', '单次录音最长 60 秒'));
      this.finishAsr();
      return;
    }
    const provider = this.provider;
    const generation = this.providerGeneration;
    if (!await this.verifyOngoingConsent('asr', provider, generation)) return;
    if (!this.isCurrentProvider(provider, generation, 'asr') || this.asrStopping) return;
    if (this.provider.bufferedAmount > PROVIDER_BACKPRESSURE_BYTES) {
      this.sendJson(publicVoiceError('VOICE_BACKPRESSURE', '网络暂时跟不上录音速度，请停止后重试', true));
      this.stopProvider(1013, 'provider backpressure');
      return;
    }
    this.provider.send(JSON.stringify({
      event_id: `event_${randomUUID()}`,
      type: 'input_audio_buffer.append',
      audio: Buffer.from(data).toString('base64'),
    }));
  }

  close(): void {
    this.closed = true;
    this.stopProvider(1000, 'client disconnected');
  }

  private async handleMessage(message: VoiceClientMessage): Promise<void> {
    if (message.type === 'audio.start') {
      await this.startAsr(message.session_id);
      return;
    }
    if (message.type === 'audio.stop') {
      this.finishAsr();
      return;
    }
    if (message.type === 'tts.start') {
      await this.startTts(message);
      return;
    }
    if (message.type === 'tts.cancel') this.cancelTts(message.playback_id);
  }

  private async startAsr(sessionId: string): Promise<void> {
    if (this.mode) {
      this.sendJson(publicVoiceError('VOICE_SESSION_BUSY', '已有语音会话正在进行'));
      return;
    }
    if (!await hasActiveAiConsent(this.installationId, 'asr')) {
      this.sendJson(publicVoiceError('AI_CONSENT_REQUIRED', '请先阅读并同意语音转文字说明', false, '可直接使用文字输入'));
      return;
    }
    let provider: WebSocket;
    try {
      provider = this.createProviderSocket('realtime', getEnv().ASR_MODEL);
    } catch (error) {
      this.sendJson(publicVoiceError('VOICE_PROVIDER_NOT_CONFIGURED', '语音服务尚未完成部署配置'));
      if (!(error instanceof VoiceProviderConfigurationError)) throw error;
      return;
    }
    this.mode = 'asr';
    this.provider = provider;
    const generation = ++this.providerGeneration;
    this.asrReady = false;
    this.asrStopping = false;
    this.asrBytes = 0;
    // 连接建立不代表可以发送音频；首个分片必须再次检查最新同意状态。
    this.consentCheckAt = 0;
    provider.on('open', () => {
      if (!this.isCurrentProvider(provider, generation, 'asr')) return;
      provider.send(JSON.stringify({
        event_id: `event_${randomUUID()}`,
        type: 'session.update',
        session: {
          input_audio_format: 'pcm',
          sample_rate: 16_000,
          input_audio_transcription: { language: 'zh' },
          turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 400 },
        },
      }));
    });
    provider.on('message', (raw, isBinary) => {
      if (!this.isCurrentProvider(provider, generation, 'asr')) return;
      if (isBinary) return;
      const payload = parseProviderJson(raw);
      if (!payload) return;
      if (payload.type === 'session.updated') {
        this.asrReady = true;
        this.sendJson({ type: 'audio.ready', session_id: sessionId, sample_rate: 16_000, encoding: 'pcm_s16le' });
        return;
      }
      if (payload.type === 'session.finished') {
        this.sendJson({ type: 'audio.end', session_id: sessionId });
        this.stopProvider(1000, 'ASR finished', provider, generation);
        return;
      }
      const mapped = mapAsrProviderEvent(payload);
      if (mapped) this.sendJson(mapped);
    });
    this.bindProviderLifecycle(provider, generation, 'ASR_PROVIDER_UNAVAILABLE');
    this.setSessionTimer(getEnv().VOICE_WS_MAX_SESSION_SECONDS * 1_000, () => {
      this.sendJson(publicVoiceError('VOICE_SESSION_TIMEOUT', '语音识别会话已超时', true, '请重试或改用文字输入'));
      this.finishAsr();
    });
  }

  private finishAsr(): void {
    if (this.mode !== 'asr' || !this.provider || this.asrStopping) return;
    this.asrStopping = true;
    if (this.provider.readyState === WebSocket.OPEN) {
      this.provider.send(JSON.stringify({ event_id: `event_${randomUUID()}`, type: 'session.finish' }));
      const provider = this.provider;
      const generation = this.providerGeneration;
      this.setSessionTimer(ASR_FINISH_GRACE_MS, () => {
        if (!this.isCurrentProvider(provider, generation, 'asr')) return;
        this.sendJson(publicVoiceError('ASR_FINISH_TIMEOUT', '语音识别结束确认超时', true, '最终文字如不完整，请改用文字输入'));
        this.stopProvider(1013, 'ASR finish timeout', provider, generation);
      });
    } else {
      this.stopProvider(1000, 'ASR stopped before open');
    }
  }

  private async startTts(message: Extract<VoiceClientMessage, { type: 'tts.start' }>): Promise<void> {
    if (this.mode) {
      this.sendJson(publicVoiceError('VOICE_SESSION_BUSY', '已有语音会话正在进行'));
      return;
    }
    if (!await hasActiveAiConsent(this.installationId, 'tts')) {
      this.sendJson(publicVoiceError('AI_CONSENT_REQUIRED', '请先阅读并同意结果语音播报说明', false, '仍可阅读文字结果'));
      return;
    }
    const text = await getAuthorizedTtsText(this.installationId, message.task_id, message.card_id);
    if (!text) {
      this.sendJson(publicVoiceError('TTS_SNAPSHOT_NOT_FOUND', '没有可播报的任务或卡片内容'));
      return;
    }
    let provider: WebSocket;
    try {
      provider = this.createProviderSocket('inference');
    } catch (error) {
      this.sendJson(publicVoiceError('VOICE_PROVIDER_NOT_CONFIGURED', '语音服务尚未完成部署配置'));
      if (!(error instanceof VoiceProviderConfigurationError)) throw error;
      return;
    }
    const providerTaskId = randomUUID();
    this.mode = 'tts';
    this.provider = provider;
    const generation = ++this.providerGeneration;
    this.playbackId = message.playback_id;
    this.providerTaskId = providerTaskId;
    this.ttsText = text;
    // task-started 后发送真实文本前必须再次检查，覆盖连接期间发生的撤回。
    this.consentCheckAt = 0;
    provider.on('open', () => {
      if (this.isCurrentProvider(provider, generation, 'tts', message.playback_id)) {
        provider.send(JSON.stringify(createTtsRunTask(providerTaskId, message.speed)));
      }
    });
    let providerMessageChain = Promise.resolve();
    provider.on('message', (raw, isBinary) => {
      providerMessageChain = providerMessageChain.then(async () => {
        if (!this.isCurrentProvider(provider, generation, 'tts', message.playback_id)) return;
        if (isBinary) {
          await this.forwardTtsAudio(provider, generation, message.playback_id, raw);
          return;
        }
        const payload = parseProviderJson(raw);
        if (!payload) return;
        const header = payload.header && typeof payload.header === 'object'
          ? payload.header as Record<string, unknown>
          : null;
        if (header?.event === 'task-started' && provider.readyState === WebSocket.OPEN && this.ttsText) {
          await this.sendTtsText(provider, generation, providerTaskId, message.playback_id);
        } else if (header?.event === 'task-finished') {
          this.sendJson({ type: 'tts.end', playback_id: message.playback_id });
          this.stopProvider(1000, 'TTS finished', provider, generation);
        } else if (header?.event === 'task-failed') {
          this.sendJson(publicVoiceError('TTS_PROVIDER_ERROR', '语音播报服务暂时不可用', true, '仍可阅读文字结果'));
          this.stopProvider(1011, 'TTS failed', provider, generation);
        }
      }).catch(() => undefined);
    });
    this.bindProviderLifecycle(provider, generation, 'TTS_PROVIDER_UNAVAILABLE');
    this.setSessionTimer(TTS_MAX_SESSION_MS, () => {
      this.sendJson(publicVoiceError('TTS_SESSION_TIMEOUT', '语音播报会话已超时', true, '仍可阅读文字结果'));
      this.cancelTts(message.playback_id);
    });
  }

  private cancelTts(playbackId: string): void {
    if (this.mode !== 'tts' || playbackId !== this.playbackId || !this.provider || !this.providerTaskId) return;
    if (this.provider.readyState === WebSocket.OPEN) {
      this.provider.send(JSON.stringify({
        header: { action: 'finish-task', task_id: this.providerTaskId, streaming: 'duplex' },
        payload: { input: { directive: 'cancel' } },
      }));
    }
    this.sendJson({ type: 'tts.end', playback_id: playbackId, cancelled: true });
    this.stopProvider(1000, 'TTS cancelled');
  }

  private async sendTtsText(
    provider: WebSocket,
    generation: number,
    providerTaskId: string,
    playbackId: string,
  ): Promise<void> {
    if (!await this.verifyOngoingConsent('tts', provider, generation)) return;
    if (!this.isCurrentProvider(provider, generation, 'tts', playbackId)
      || provider.readyState !== WebSocket.OPEN
      || this.providerTaskId !== providerTaskId
      || !this.ttsText) return;
    provider.send(JSON.stringify({
      header: { action: 'continue-task', task_id: providerTaskId, streaming: 'duplex' },
      payload: { input: { text: this.ttsText } },
    }));
    provider.send(JSON.stringify({
      header: { action: 'finish-task', task_id: providerTaskId, streaming: 'duplex' },
      payload: { input: {} },
    }));
  }

  private async forwardTtsAudio(
    provider: WebSocket,
    generation: number,
    playbackId: string,
    raw: RawData,
  ): Promise<void> {
    if (!await this.verifyOngoingConsent('tts', provider, generation)) return;
    if (!this.isCurrentProvider(provider, generation, 'tts', playbackId)) return;
    const audio = rawDataToBuffer(raw);
    this.sendJson({
      type: 'tts.chunk',
      playback_id: playbackId,
      format: 'pcm_s16le',
      sample_rate: TTS_SAMPLE_RATE,
      audio_base64: audio.toString('base64'),
    });
  }

  private async verifyOngoingConsent(
    capability: 'asr' | 'tts',
    provider: WebSocket,
    generation: number,
  ): Promise<boolean> {
    if (!this.isCurrentProvider(provider, generation, capability)) return false;
    const now = Date.now();
    if (now - this.consentCheckAt < 2_000) return true;
    const check = this.consentCheck ?? hasActiveAiConsent(this.installationId, capability);
    this.consentCheck = check;
    let active: boolean;
    try {
      active = await check;
    } catch {
      if (this.consentCheck === check) this.consentCheck = null;
      if (!this.isCurrentProvider(provider, generation, capability)) return false;
      this.sendJson(publicVoiceError(
        'VOICE_CONSENT_CHECK_UNAVAILABLE',
        '暂时无法确认语音数据处理授权，会话已停止',
        true,
      ));
      this.stopProvider(1013, 'consent check unavailable', provider, generation);
      return false;
    }
    if (this.consentCheck === check) this.consentCheck = null;
    if (!this.isCurrentProvider(provider, generation, capability)) return false;
    if (active) {
      this.consentCheckAt = Date.now();
      return true;
    }
    this.sendJson(publicVoiceError('AI_CONSENT_REVOKED', '语音数据处理同意已撤回，会话已停止'));
    this.stopProvider(1008, 'consent revoked', provider, generation);
    return false;
  }

  private createProviderSocket(path: 'realtime' | 'inference', model?: string): WebSocket {
    const env = getEnv();
    if (!env.DASHSCOPE_WORKSPACE_ID) throw new VoiceProviderConfigurationError();
    const query = model ? `?model=${encodeURIComponent(model)}` : '';
    return new WebSocket(`wss://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/${path}${query}`, {
      headers: {
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
        'X-DashScope-WorkSpace': env.DASHSCOPE_WORKSPACE_ID,
        'User-Agent': 'EazyPath-Voice-Gateway/1.0',
      },
      handshakeTimeout: 3_000,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
    });
  }

  private bindProviderLifecycle(provider: WebSocket, generation: number, code: string): void {
    provider.on('error', () => {
      if (!this.closed && this.isCurrentProvider(provider, generation)) {
        this.sendJson(publicVoiceError(code, '语音服务连接失败', true));
        this.stopProvider(1011, 'provider error', provider, generation);
      }
    });
    provider.on('close', () => {
      if (!this.closed && this.isCurrentProvider(provider, generation)) {
        this.sendJson(publicVoiceError(code, '语音服务连接已中断', true));
      }
      if (this.isCurrentProvider(provider, generation)) this.resetProviderState();
    });
  }

  private setSessionTimer(milliseconds: number, onTimeout: () => void): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(onTimeout, milliseconds);
  }

  private stopProvider(code: number, reason: string, expectedProvider?: WebSocket, expectedGeneration?: number): void {
    const provider = this.provider;
    if (expectedProvider && (provider !== expectedProvider || this.providerGeneration !== expectedGeneration)) return;
    this.providerGeneration += 1;
    this.resetProviderState();
    if (!provider) return;
    if (provider.readyState === WebSocket.OPEN || provider.readyState === WebSocket.CONNECTING) {
      provider.close(code, reason);
    }
  }

  private resetProviderState(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    this.provider = null;
    this.mode = null;
    this.asrReady = false;
    this.asrStopping = false;
    this.asrBytes = 0;
    this.playbackId = null;
    this.providerTaskId = null;
    this.ttsText = null;
    this.consentCheck = null;
    this.consentCheckAt = 0;
  }

  private isCurrentProvider(
    provider: WebSocket,
    generation: number,
    mode?: 'asr' | 'tts',
    playbackId?: string,
  ): boolean {
    return this.provider === provider
      && this.providerGeneration === generation
      && (!mode || this.mode === mode)
      && (!playbackId || this.playbackId === playbackId);
  }
}

function parseProviderJson(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawDataToBuffer(raw).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}
