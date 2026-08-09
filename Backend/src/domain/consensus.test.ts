import { describe, expect, it } from 'vitest';
import { calculateConsensus, calculateWeightedConsensus, sanitizeStoredConsensusSnapshot, toPublicConsensusSnapshot, type ReviewVoteInput, type WeightedVote } from './consensus.js';

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

function frozenVote(overrides: Partial<WeightedVote> = {}): WeightedVote {
  return {
    ...vote({}),
    weight: 0.5,
    established: true,
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

  it('持久共识快照只包含聚合结果和规则版本', () => {
    const result = calculateConsensus([vote({ hasConfirmedRedactedMedia: true, locationProofPassed: true })]);
    const snapshot = toPublicConsensusSnapshot(result);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('installationId');
    expect(serialized).not.toContain('accountCreatedAt');
    expect(serialized).not.toContain('votes');
    expect(snapshot.snapshot.version).toBe('mvp-1');
  });

  it('读取旧快照时清除逐票安装标识', () => {
    const snapshot = sanitizeStoredConsensusSnapshot({
      status: 'conflicting', presentWeight: 1, absentWeight: 1,
      snapshot: { version: 'mvp-1', dominanceRatio: .75 },
      votes: [{ installationId: 'private-installation-id', accountCreatedAt: '2026-01-01' }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-installation-id');
    expect(snapshot?.snapshot.version).toBe('mvp-1');
  });

  it('暂停票即使保留非零历史权重也不进入人数和方向权重', () => {
    const weighted = [
      { ...vote({ hasConfirmedRedactedMedia: true, locationProofPassed: true }), weight: 1, established: true },
      { ...vote({ hasConfirmedRedactedMedia: true, locationProofPassed: true }), weight: 1, established: true },
      { ...vote({ hasConfirmedRedactedMedia: true, locationProofPassed: true, suspended: true }), weight: 1, established: true },
    ] satisfies WeightedVote[];

    const result = calculateWeightedConsensus(weighted);

    expect(result.status).toBe('pending_review');
    expect(result.presentWeight).toBe(2);
  });

  it.each([
    { name: '无票', votes: [], status: 'pending_review', outcome: null },
    { name: '单个现场票', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true })], status: 'pending_review', outcome: null },
    { name: '两个现场票', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true })], status: 'pending_review', outcome: null },
    { name: '三票但无图片', votes: [frozenVote(), frozenVote(), frozenVote()], status: 'pending_review', outcome: null },
    { name: '三名新账户', votes: [frozenVote({ established: false, weight: 0.5, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ established: false, weight: 0.5, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ established: false, weight: 0.5, hasConfirmedRedactedMedia: true, locationProofPassed: true })], status: 'pending_review', outcome: null },
    { name: '正向权重 2.3', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote()], status: 'community_consensus', outcome: 'present' },
    { name: '反向权重 2.3', votes: [frozenVote({ answer: 'absent', weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ answer: 'absent', weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote({ answer: 'absent' })], status: 'community_consensus', outcome: 'absent' },
    { name: '正向恰好占 75%', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote(), frozenVote({ answer: 'absent' })], status: 'community_consensus', outcome: 'present' },
    { name: '反向恰好占 75%', votes: [frozenVote({ answer: 'absent', weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ answer: 'absent' }), frozenVote({ answer: 'present' })], status: 'community_consensus', outcome: 'absent' },
    { name: '正向超过 75%', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote({ answer: 'absent' })], status: 'community_consensus', outcome: 'present' },
    { name: '正向不足 75%', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote(), frozenVote({ answer: 'absent', weight: 0.8, hasConfirmedRedactedMedia: true })], status: 'conflicting', outcome: null },
    { name: '反向不足 75%', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ answer: 'absent', weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote({ answer: 'absent' })], status: 'conflicting', outcome: null },
    { name: '未知现场票不进入方向权重', votes: [frozenVote({ answer: 'unknown', weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote()], status: 'pending_review', outcome: null },
    { name: '未知票可满足人数但不增加方向权重', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ answer: 'unknown' })], status: 'community_consensus', outcome: 'present' },
    { name: '暂停现场票不满足人数', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true, suspended: true }), frozenVote(), frozenVote()], status: 'pending_review', outcome: null },
    { name: '暂停反向票不稀释正向共识', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ weight: 0.8, hasConfirmedRedactedMedia: true }), frozenVote(), frozenVote({ answer: 'absent', weight: 1, suspended: true })], status: 'community_consensus', outcome: 'present' },
    { name: '方向权重 1.5 不达标', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote(), frozenVote({ answer: 'unknown' })], status: 'pending_review', outcome: null },
    { name: '四名新账户总权重 2 仍无历史账户', votes: [frozenVote({ established: false }), frozenVote({ established: false }), frozenVote({ established: false, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ established: false })], status: 'pending_review', outcome: null },
    { name: '正向恰好总权重 2', votes: [frozenVote({ weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote(), frozenVote()], status: 'community_consensus', outcome: 'present' },
    { name: '反向恰好总权重 2', votes: [frozenVote({ answer: 'absent', weight: 1, hasConfirmedRedactedMedia: true, locationProofPassed: true }), frozenVote({ answer: 'absent' }), frozenVote({ answer: 'absent' })], status: 'community_consensus', outcome: 'absent' },
  ] satisfies Array<{ name: string; votes: WeightedVote[]; status: string; outcome: string | null }>)('$name', ({ votes, status, outcome }) => {
    const result = calculateWeightedConsensus(votes);

    expect(result.status).toBe(status);
    expect(result.outcome).toBe(outcome);
  });
});
