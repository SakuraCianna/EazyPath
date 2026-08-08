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
    distinctInstallations: votes.length,
    snapshot: policy,
    votes,
  };
}

function sumAnswer(votes: WeightedVote[], answer: ReviewAnswer): number {
  return votes
    .filter((vote) => vote.answer === answer)
    .reduce((total, vote) => total + vote.weight, 0);
}
