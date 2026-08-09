export type ObservationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type AppealStatus = 'open' | 'in_review' | 'resolved' | 'rejected';
export type VerificationReviewStatus = 'unreviewed' | 'confirmed' | 'flagged';

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ObservationReviewItem {
  id: string;
  moderationStatus: ObservationStatus;
  moderationReason: string | null;
  moderationVersion: number;
  evidenceGrade: string;
  evidenceSource: string;
  freshnessStatus: string;
  value: unknown;
  placeId: string;
  placeName: string;
  featureKey: string;
  featureName: string;
  contributorId: string | null;
  observedAt: string | null;
  appealUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservationReviewDetail {
  observation: {
    id: string;
    installationId: string | null;
    moderationStatus: ObservationStatus;
    moderationReason: string | null;
    moderationVersion: number;
    moderatedAt: string | null;
    appealUntil: string | null;
    evidenceGrade: string;
    evidenceSource: string;
    freshnessStatus: string;
    confidence: string | null;
    value: unknown;
    observedAt: string | null;
    expiresAt: string | null;
    locationProofPassed: boolean;
    locationDistanceBucket: string | null;
    locationVerifiedAt: string | null;
    placeId: string;
    placeName: string;
    placeAddress: string | null;
    unitId: string | null;
    unitName: string | null;
    facilityId: string | null;
    facilityName: string | null;
    featureKey: string;
    featureName: string;
    featureValueType: string;
    featureUnit: string | null;
    contributorStatus: string | null;
    contributorAcceptedCount: number | null;
    contributorCreatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  media: Array<{
    id: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    status: string;
    redactionConfirmed: boolean;
    expiresAt: string | null;
    deletedAt: string | null;
    createdAt: string;
  }>;
  feedback: Array<{
    id: string;
    feedbackType: string;
    sourceType: string;
    message: string;
    status: string;
    resolutionReason: string | null;
    expiresAt: string | null;
    resolvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  history: Array<{
    id: string;
    actorType: string;
    actorId: string | null;
    action: string;
    reason: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface AppealReviewItem {
  id: string;
  status: AppealStatus;
  message: string;
  resolutionReason: string | null;
  observationId: string;
  observationStatus: ObservationStatus;
  moderationVersion: number;
  placeName: string;
  featureName: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface VerificationReviewItem {
  id: string;
  placeId: string | null;
  placeUnitId: string | null;
  scene: string;
  status: string;
  result: unknown;
  confidence: string | null;
  riskLevel: string;
  modelName: string;
  promptVersion: string;
  originalMediaStored: boolean;
  temporaryMediaDeletedAt: string | null;
  failureCode: string | null;
  adminReviewStatus: VerificationReviewStatus;
  adminReviewReason: string | null;
  adminReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
