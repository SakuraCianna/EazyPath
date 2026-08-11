import { z } from 'zod';

export const AI_CONSENT_POLICY_VERSION = '2026-08-11';
export const AI_CONSENT_PROCESSOR_CODE = 'aliyun_model_studio';
export const AI_CONSENT_PROCESSOR = '阿里云计算有限公司（大模型服务平台百炼）';
export const AI_CONSENT_REGION_CODE = 'cn-beijing';
export const AI_CONSENT_REGION = '中国内地（华北 2 / 北京接入地域）';
export const AI_CONSENT_NOTICE_VERIFIED_AT = '2026-08-11';
export const AI_CONSENT_PRIVACY_URL = 'https://help.aliyun.com/zh/model-studio/privacy-notice';

export const AiCapabilitySchema = z.enum(['agent', 'vision', 'asr', 'tts']);
export type AiCapability = z.infer<typeof AiCapabilitySchema>;

export class AiConsentRequiredError extends Error {
  constructor(public readonly capability: AiCapability) {
    super(`AI_CONSENT_REQUIRED:${capability}`);
    this.name = 'AiConsentRequiredError';
  }
}

export const AI_CAPABILITY_NOTICES: Readonly<Record<AiCapability, {
  title: string;
  dataType: string;
  purpose: string;
  fallback: string;
}>> = {
  agent: {
    title: '智能文本规划',
    dataType: '用户确认后的出行需求文本与最小化无障碍偏好',
    purpose: '理解复合出行需求并生成可核验的任务链',
    fallback: '拒绝或撤回后可继续使用规则提示与手动搜索',
  },
  vision: {
    title: '图片辅助判断',
    dataType: '用户确认后的端侧脱敏图片',
    purpose: '辅助判断图片中的无障碍设施与风险',
    fallback: '拒绝或撤回后可使用人工检查清单',
  },
  asr: {
    title: '语音转文字',
    dataType: '当前一次录音的实时音频流',
    purpose: '把语音需求实时转写为可编辑文字',
    fallback: '拒绝或撤回后可直接使用文字输入',
  },
  tts: {
    title: '结果语音播报',
    dataType: '当前账户有权访问的脱敏任务卡片文字',
    purpose: '把任务结果和风险提示合成为语音',
    fallback: '拒绝或撤回后仍可阅读全部文字结果',
  },
};

export interface AiConsentRecord {
  capability: string;
  policyVersion: string;
  processor: string;
  region: string;
  noticeVerifiedAt: Date;
  grantedAt: Date | null;
  revokedAt: Date | null;
  version: number;
}

export function buildAiConsentSnapshot(rows: readonly AiConsentRecord[]) {
  const byCapability = new Map(rows.map((row) => [row.capability, row]));
  return AiCapabilitySchema.options.map((capability) => {
    const record = byCapability.get(capability);
    const notice = AI_CAPABILITY_NOTICES[capability];
    return {
      capability,
      ...notice,
      granted: record?.policyVersion === AI_CONSENT_POLICY_VERSION && record.grantedAt !== null && record.revokedAt === null,
      decision: record === undefined
        ? 'not_asked'
        : record.policyVersion !== AI_CONSENT_POLICY_VERSION
          ? 'expired'
          : record.revokedAt === null ? 'granted' : record.grantedAt === null ? 'denied' : 'revoked',
      policyVersion: AI_CONSENT_POLICY_VERSION,
      consentedPolicyVersion: record?.policyVersion ?? null,
      consentedProcessor: record?.processor ?? null,
      consentedRegion: record?.region ?? null,
      noticeVerifiedAt: AI_CONSENT_NOTICE_VERIFIED_AT,
      consentedNoticeVerifiedAt: record?.noticeVerifiedAt.toISOString().slice(0, 10) ?? null,
      grantedAt: record?.grantedAt?.toISOString() ?? null,
      revokedAt: record?.revokedAt?.toISOString() ?? null,
      version: record?.version ?? null,
      processor: AI_CONSENT_PROCESSOR,
      region: AI_CONSENT_REGION,
      privacyUrl: AI_CONSENT_PRIVACY_URL,
      retentionNotice: 'EazyPath 不保存原始语音或模型临时输入；百炼侧会依法保存模型调用数据，但官方说明未明确具体保留期限与用户删除能力，请以最新隐私说明和服务协议为准。',
    };
  });
}
