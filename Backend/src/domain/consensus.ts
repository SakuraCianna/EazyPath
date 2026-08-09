export type ReviewAnswer = 'present' | 'absent' | 'unknown';

export interface ConsensusPolicy {
  version: string;
  minimumInstallations: number;
  minimumDirectionalWeight: number;
  dominanceRatio: number;
  requireEstablishedInstallation: boolean;
  requireLocatedMediaVote: boolean;
  newInstallationWeightCap: number;
}

export interface ReviewVoteInput {
  installationId: string;
  answer: ReviewAnswer;
  submittedAt: Date;
  accountCreatedAt: Date;
  hasAcceptedHistory: boolean;
  hasConfirmedRedactedMedia: boolean;
  locationProofPassed: boolean;
  suspended: boolean;
}

export interface WeightedVote extends ReviewVoteInput {
  weight: number;
  established: boolean;
}

export interface ConsensusResult {
  status: 'pending_review' | 'community_consensus' | 'conflicting';
  outcome: Exclude<ReviewAnswer, 'unknown'> | null;
  presentWeight: number;
  absentWeight: number;
  directionalWeight: number;
  dominantRatio: number;
  distinctInstallations: number;
  snapshot: ConsensusPolicy;
  votes: WeightedVote[];
}

export interface PublicConsensusSnapshot {
  status: unknown;
  outcome: unknown;
  presentWeight: unknown;
  absentWeight: unknown;
  directionalWeight: unknown;
  dominantRatio: unknown;
  distinctInstallations: unknown;
  snapshot: ConsensusPolicy | Record<string, unknown>;
}

export const defaultConsensusPolicy: ConsensusPolicy = {
  version: 'mvp-1',
  minimumInstallations: 3,
  minimumDirectionalWeight: 2,
  dominanceRatio: 0.75,
  requireEstablishedInstallation: true,
  requireLocatedMediaVote: true,
  newInstallationWeightCap: 0.5,
};

const DAYS_7_MS = 7 * 24 * 60 * 60 * 1000;

export function calculateVoteWeight(vote: ReviewVoteInput): WeightedVote {
  const established =
    vote.submittedAt.getTime() - vote.accountCreatedAt.getTime() >= DAYS_7_MS &&
    vote.hasAcceptedHistory;
  const baseWeight = vote.hasConfirmedRedactedMedia
    ? vote.locationProofPassed
      ? 1
      : 0.8
    : 0.5;

  return {
    ...vote,
    established,
    weight: vote.suspended
      ? 0
      : established
        ? baseWeight
        : Math.min(baseWeight, defaultConsensusPolicy.newInstallationWeightCap),
  };
}

export function calculateConsensus(
  inputs: ReviewVoteInput[],
  policy: ConsensusPolicy = defaultConsensusPolicy,
): ConsensusResult {
  // 同一安装账户同一轮只取最后一次提交，避免重复计权。
  const latestByInstallation = new Map<string, ReviewVoteInput>();
  [...inputs]
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
    .forEach((vote) => latestByInstallation.set(vote.installationId, vote));

  const votes = [...latestByInstallation.values()].map((vote) => {
    const weighted = calculateVoteWeight(vote);
    return {
      ...weighted,
      weight: weighted.suspended
        ? 0
        : weighted.established
          ? weighted.hasConfirmedRedactedMedia
            ? weighted.locationProofPassed
              ? 1
              : 0.8
            : 0.5
          : Math.min(
              weighted.hasConfirmedRedactedMedia
                ? weighted.locationProofPassed
                  ? 1
                  : 0.8
                : 0.5,
              policy.newInstallationWeightCap,
            ),
    };
  });

  return calculateWeightedConsensus(votes, policy);
}

export function calculateWeightedConsensus(
  votes: WeightedVote[],
  policy: ConsensusPolicy = defaultConsensusPolicy,
): ConsensusResult {
  const presentWeight = sumAnswer(votes, 'present');
  const absentWeight = sumAnswer(votes, 'absent');
  const directionalWeight = presentWeight + absentWeight;
  const dominantWeight = Math.max(presentWeight, absentWeight);
  const dominantRatio = directionalWeight === 0 ? 0 : dominantWeight / directionalWeight;
  const hasEstablished = votes.some((vote) => vote.established && !vote.suspended);
  const hasLocatedMedia = votes.some(
    (vote) => vote.hasConfirmedRedactedMedia && vote.locationProofPassed && !vote.suspended,
  );
  const meetsGate =
    votes.filter((vote) => !vote.suspended).length >= policy.minimumInstallations &&
    directionalWeight >= policy.minimumDirectionalWeight &&
    (!policy.requireEstablishedInstallation || hasEstablished) &&
    (!policy.requireLocatedMediaVote || hasLocatedMedia);

  return {
    status: !meetsGate
      ? 'pending_review'
      : dominantRatio >= policy.dominanceRatio
        ? 'community_consensus'
        : 'conflicting',
    outcome:
      meetsGate && dominantRatio >= policy.dominanceRatio
        ? presentWeight >= absentWeight
          ? 'present'
          : 'absent'
        : null,
    presentWeight,
    absentWeight,
    directionalWeight,
    dominantRatio,
    distinctInstallations: votes.filter((vote) => !vote.suspended).length,
    snapshot: policy,
    votes,
  };
}

export function toPublicConsensusSnapshot(result: ConsensusResult): PublicConsensusSnapshot {
  return {
    status: result.status,
    outcome: result.outcome,
    presentWeight: result.presentWeight,
    absentWeight: result.absentWeight,
    directionalWeight: result.directionalWeight,
    dominantRatio: result.dominantRatio,
    distinctInstallations: result.distinctInstallations,
    snapshot: result.snapshot,
  };
}

export function sanitizeStoredConsensusSnapshot(value: unknown): PublicConsensusSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const policy = source.snapshot && typeof source.snapshot === 'object' && !Array.isArray(source.snapshot)
    ? source.snapshot as Record<string, unknown>
    : {};
  return {
    status: source.status,
    outcome: source.outcome,
    presentWeight: source.presentWeight,
    absentWeight: source.absentWeight,
    directionalWeight: source.directionalWeight,
    dominantRatio: source.dominantRatio,
    distinctInstallations: source.distinctInstallations,
    snapshot: {
      version: policy.version,
      minimumInstallations: policy.minimumInstallations,
      minimumDirectionalWeight: policy.minimumDirectionalWeight,
      dominanceRatio: policy.dominanceRatio,
      requireEstablishedInstallation: policy.requireEstablishedInstallation,
      requireLocatedMediaVote: policy.requireLocatedMediaVote,
      newInstallationWeightCap: policy.newInstallationWeightCap,
    },
  };
}

function sumAnswer(votes: WeightedVote[], answer: ReviewAnswer): number {
  return votes
    .filter((vote) => vote.answer === answer && !vote.suspended)
    .reduce((total, vote) => total + vote.weight, 0);
}
