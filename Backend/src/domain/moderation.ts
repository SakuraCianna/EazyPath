export const REJECTED_EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const FEEDBACK_RESPONSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ObservationModerationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type ObservationModerationDecision = 'approve' | 'reject' | 'request_changes';
export type EvidenceGrade = 'A' | 'B' | 'C' | 'U';

export interface ObservationModerationPlan {
  moderationStatus: ObservationModerationStatus;
  evidenceGrade: EvidenceGrade;
  appealUntil: Date | null;
  mediaStatus: 'linked' | 'rejected';
  mediaExpiresAt: Date | null;
  acceptedContributionDelta: -1 | 0 | 1;
}

export function planObservationModeration(input: {
  currentStatus: ObservationModerationStatus;
  currentGrade: EvidenceGrade;
  decision: ObservationModerationDecision;
  now: Date;
}): ObservationModerationPlan | null {
  if (input.currentStatus === 'withdrawn') return null;
  const wasApproved = input.currentStatus === 'approved';

  if (input.decision === 'approve') {
    return {
      moderationStatus: 'approved',
      evidenceGrade: input.currentGrade === 'U' ? 'C' : input.currentGrade,
      appealUntil: null,
      mediaStatus: 'linked',
      mediaExpiresAt: null,
      acceptedContributionDelta: wasApproved ? 0 : 1,
    };
  }

  if (input.decision === 'reject') {
    const appealUntil = new Date(input.now.getTime() + REJECTED_EVIDENCE_RETENTION_MS);
    return {
      moderationStatus: 'rejected',
      evidenceGrade: 'U',
      appealUntil,
      mediaStatus: 'rejected',
      mediaExpiresAt: appealUntil,
      acceptedContributionDelta: wasApproved ? -1 : 0,
    };
  }

  return {
    moderationStatus: 'pending',
    evidenceGrade: 'U',
    appealUntil: null,
    mediaStatus: 'linked',
    mediaExpiresAt: null,
    acceptedContributionDelta: wasApproved ? -1 : 0,
  };
}

export function canSubmitObservationAppeal(input: {
  status: string;
  appealUntil: Date | null;
  now: Date;
}): boolean {
  return input.status === 'rejected' && input.appealUntil !== null && input.appealUntil > input.now;
}
