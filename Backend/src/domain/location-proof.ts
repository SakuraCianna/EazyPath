export interface LocationProofOutcome {
  passed: boolean;
  distanceBucket: 'within_50m' | 'within_200m' | 'within_1km' | 'over_1km';
}

export function evaluateLocationProof(
  pointDistanceMeters: number,
  accuracyMeters: number,
  allowedRadiusMeters: number,
): LocationProofOutcome {
  const effectiveDistance = pointDistanceMeters + accuracyMeters;
  return {
    passed: effectiveDistance <= allowedRadiusMeters,
    distanceBucket: effectiveDistance <= 50
      ? 'within_50m'
      : effectiveDistance <= 200
        ? 'within_200m'
        : effectiveDistance <= 1_000
          ? 'within_1km'
          : 'over_1km',
  };
}
