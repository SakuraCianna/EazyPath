import { describe, expect, it } from 'vitest';
import {
  canSubmitObservationAppeal,
  planObservationModeration,
  REJECTED_EVIDENCE_RETENTION_MS,
} from './moderation.js';

describe('证据审核状态机', () => {
  const now = new Date('2026-08-09T00:00:00.000Z');

  it('通过审核只把未知证据提升到 C 级，不自动升级为 A 级', () => {
    expect(planObservationModeration({ currentStatus: 'pending', currentGrade: 'U', decision: 'approve', now }))
      .toMatchObject({ moderationStatus: 'approved', evidenceGrade: 'C', acceptedContributionDelta: 1 });
    expect(planObservationModeration({ currentStatus: 'pending', currentGrade: 'B', decision: 'approve', now }))
      .toMatchObject({ evidenceGrade: 'B' });
  });

  it('驳回后保留 30 天申诉期并停止公开证明', () => {
    const plan = planObservationModeration({ currentStatus: 'approved', currentGrade: 'C', decision: 'reject', now });
    expect(plan).toMatchObject({ moderationStatus: 'rejected', evidenceGrade: 'U', mediaStatus: 'rejected', acceptedContributionDelta: -1 });
    expect(plan?.appealUntil?.getTime()).toBe(now.getTime() + REJECTED_EVIDENCE_RETENTION_MS);
    expect(plan?.mediaExpiresAt).toEqual(plan?.appealUntil);
  });

  it('要求补充时回到 pending，撤回证据不可再审核', () => {
    expect(planObservationModeration({ currentStatus: 'approved', currentGrade: 'C', decision: 'request_changes', now }))
      .toMatchObject({ moderationStatus: 'pending', evidenceGrade: 'U', acceptedContributionDelta: -1 });
    expect(planObservationModeration({ currentStatus: 'withdrawn', currentGrade: 'U', decision: 'approve', now })).toBeNull();
  });

  it('只有仍在 30 天窗口内的驳回证据可申诉', () => {
    expect(canSubmitObservationAppeal({ status: 'rejected', appealUntil: new Date(now.getTime() + 1), now })).toBe(true);
    expect(canSubmitObservationAppeal({ status: 'rejected', appealUntil: now, now })).toBe(false);
    expect(canSubmitObservationAppeal({ status: 'pending', appealUntil: new Date(now.getTime() + 1), now })).toBe(false);
  });
});
