import { describe, expect, it } from 'vitest';
import { calculateConsensus, type ReviewVoteInput } from './consensus.js';

const now = new Date('2026-08-08T12:00:00Z');
const oldAccount = new Date('2026-07-01T00:00:00Z');
const newAccount = new Date('2026-08-07T00:00:00Z');

function vote(overrides: Partial<ReviewVoteInput>): ReviewVoteInput {
  return {
    installationId: crypto.randomUUID(),
    answer: 'present',
    submittedAt: now,
    accountCreatedAt: oldAccount,
    hasAcceptedHistory: true,
    hasConfirmedRedactedMedia: false,
    locationProofPassed: false,
    suspended: false,
    ...overrides,
  };
}

describe('calculateConsensus', () => {
  it('三个独立账户满足权重、历史账户和现场媒体门槛时形成共识', () => {
    const result = calculateConsensus([
      vote({ hasConfirmedRedactedMedia: true, locationProofPassed: true }),
      vote({ hasConfirmedRedactedMedia: true }),
      vote({}),
    ]);

    expect(result.status).toBe('community_consensus');
    expect(result.outcome).toBe('present');
    expect(result.directionalWeight).toBe(2.3);
  });

  it('新安装账户即使附现场媒体也最多按 0.5 计权', () => {
    const result = calculateConsensus([
      vote({ accountCreatedAt: newAccount, hasAcceptedHistory: false, hasConfirmedRedactedMedia: true, locationProofPassed: true }),
      vote({ accountCreatedAt: newAccount, hasAcceptedHistory: false, hasConfirmedRedactedMedia: true, locationProofPassed: true }),
      vote({ accountCreatedAt: newAccount, hasAcceptedHistory: false, hasConfirmedRedactedMedia: true, locationProofPassed: true }),
    ]);

    expect(result.status).toBe('pending_review');
    expect(result.votes.every((item) => item.weight === 0.5)).toBe(true);
  });

  it('同一安装账户只保留最后一票', () => {
    const installationId = crypto.randomUUID();
    const result = calculateConsensus([
      vote({ installationId, answer: 'present', submittedAt: new Date('2026-08-08T10:00:00Z') }),
      vote({ installationId, answer: 'absent', submittedAt: now }),
    ]);

    expect(result.distinctInstallations).toBe(1);
    expect(result.presentWeight).toBe(0);
    expect(result.absentWeight).toBe(0.5);
  });

  it('达到门槛但正反方向均未达到 75% 时进入冲突', () => {
    const result = calculateConsensus([
      vote({ answer: 'present', hasConfirmedRedactedMedia: true, locationProofPassed: true }),
      vote({ answer: 'present' }),
      vote({ answer: 'absent', hasConfirmedRedactedMedia: true }),
      vote({ answer: 'absent' }),
    ]);

    expect(result.status).toBe('conflicting');
    expect(result.outcome).toBeNull();
  });
});
