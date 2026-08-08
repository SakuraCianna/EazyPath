import { describe, expect, it } from 'vitest';
import { isFeatureValueCompatible } from './feature-values.js';

describe('isFeatureValueCompatible', () => {
  it('按通用字段定义校验现场观测值', () => {
    expect(isFeatureValueCompatible('boolean', true)).toBe(true);
    expect(isFeatureValueCompatible('boolean', 'true')).toBe(false);
    expect(isFeatureValueCompatible('number', 88.5)).toBe(true);
    expect(isFeatureValueCompatible('number', Number.NaN)).toBe(false);
    expect(isFeatureValueCompatible('string', '入口左侧有临时台阶')).toBe(true);
    expect(isFeatureValueCompatible('string', '   ')).toBe(false);
    expect(isFeatureValueCompatible('unknown', true)).toBe(false);
  });
});
