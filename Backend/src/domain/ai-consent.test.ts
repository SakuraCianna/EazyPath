import { describe, expect, it } from 'vitest';
import { AI_CONSENT_POLICY_VERSION, buildAiConsentSnapshot } from './ai-consent.js';

describe('buildAiConsentSnapshot', () => {
  it('only treats the current non-revoked policy as granted', () => {
    const snapshot = buildAiConsentSnapshot([
      { capability: 'asr', policyVersion: AI_CONSENT_POLICY_VERSION, processor: 'aliyun_model_studio', region: 'cn-beijing', noticeVerifiedAt: new Date('2026-08-11T00:00:00Z'), grantedAt: new Date('2026-08-11T00:00:00Z'), revokedAt: null, version: 1 },
      { capability: 'tts', policyVersion: '2026-01-01', processor: 'aliyun_model_studio', region: 'cn-beijing', noticeVerifiedAt: new Date('2026-08-11T00:00:00Z'), grantedAt: new Date('2026-01-01T00:00:00Z'), revokedAt: null, version: 2 },
      { capability: 'vision', policyVersion: AI_CONSENT_POLICY_VERSION, processor: 'aliyun_model_studio', region: 'cn-beijing', noticeVerifiedAt: new Date('2026-08-11T00:00:00Z'), grantedAt: new Date('2026-08-11T00:00:00Z'), revokedAt: new Date('2026-08-12T00:00:00Z'), version: 3 },
    ]);

    expect(snapshot.find((item) => item.capability === 'asr')?.granted).toBe(true);
    expect(snapshot.find((item) => item.capability === 'tts')?.granted).toBe(false);
    expect(snapshot.find((item) => item.capability === 'tts')?.decision).toBe('expired');
    expect(snapshot.find((item) => item.capability === 'vision')?.granted).toBe(false);
    expect(snapshot.find((item) => item.capability === 'agent')?.granted).toBe(false);
    expect(snapshot.find((item) => item.capability === 'vision')?.decision).toBe('revoked');
    expect(snapshot.find((item) => item.capability === 'agent')?.decision).toBe('not_asked');
  });
});
