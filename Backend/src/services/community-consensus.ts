import { eq } from 'drizzle-orm';
import { communityReviewVotes, db } from '../db/index.js';
import { calculateWeightedConsensus, type WeightedVote } from '../domain/consensus.js';

export type CommunityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function recomputeCommunityConsensus(tx: CommunityTransaction, reviewTaskId: string) {
  const rows = await tx.select({
    installationId: communityReviewVotes.installationId,
    answer: communityReviewVotes.answer,
    submittedAt: communityReviewVotes.updatedAt,
    baseWeight: communityReviewVotes.baseWeight,
    finalWeight: communityReviewVotes.finalWeight,
    established: communityReviewVotes.established,
    locationProofPassed: communityReviewVotes.locationProofPassed,
    suspended: communityReviewVotes.suspended,
  }).from(communityReviewVotes).where(eq(communityReviewVotes.reviewTaskId, reviewTaskId));
  return calculateWeightedConsensus(rows.map((row): WeightedVote => ({
    installationId: row.installationId,
    answer: row.answer as 'present' | 'absent' | 'unknown',
    submittedAt: row.submittedAt,
    accountCreatedAt: row.submittedAt,
    hasAcceptedHistory: row.established,
    hasConfirmedRedactedMedia: Number(row.baseWeight) > 0.5,
    locationProofPassed: row.locationProofPassed,
    suspended: row.suspended,
    established: row.established,
    weight: Number(row.finalWeight),
  })));
}
