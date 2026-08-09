import { describe, expect, it } from 'vitest';
import { fingerprintCommunityReviewSource } from './community-review-guard.js';

describe('fingerprintCommunityReviewSource', () => {
  it('信任反向代理时只生成不可逆来源指纹', () => {
    const fingerprint = fingerprintCommunityReviewSource({
      trustProxy: true,
      realIp: '203.0.113.10',
      forwardedFor: '198.51.100.5, 10.0.0.1',
    }, 's'.repeat(32));

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('203.0.113.10');
  });

  it('不信任代理时忽略可伪造的转发头', () => {
    const first = fingerprintCommunityReviewSource({ trustProxy: false, realIp: '203.0.113.10' }, 's'.repeat(32));
    const second = fingerprintCommunityReviewSource({ trustProxy: false, forwardedFor: '198.51.100.5' }, 's'.repeat(32));

    expect(first).toBe(second);
  });
});
