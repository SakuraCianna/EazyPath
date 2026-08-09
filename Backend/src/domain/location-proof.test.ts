import { describe, expect, it } from 'vitest';
import { evaluateLocationProof } from './location-proof.js';

describe('一次性位置证明规则', () => {
  it('把定位精度计入最保守距离并使用任务半径', () => {
    expect(evaluateLocationProof(80, 20, 100)).toEqual({ passed: true, distanceBucket: 'within_200m' });
    expect(evaluateLocationProof(80, 21, 100)).toEqual({ passed: false, distanceBucket: 'within_200m' });
  });

  it('距离区间不泄露精确坐标或精确距离', () => {
    expect(evaluateLocationProof(920, 80, 120).distanceBucket).toBe('within_1km');
    expect(evaluateLocationProof(920, 81, 120).distanceBucket).toBe('over_1km');
  });
});
