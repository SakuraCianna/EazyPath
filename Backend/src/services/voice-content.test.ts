import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ agentTasks: {}, db: {}, serviceCards: {} }));

import { buildTtsSpeechText } from './voice-content.js';

describe('TTS 最小播报文本', () => {
  it('清理空白并保留短任务摘要', () => {
    expect(buildTtsSpeechText(['  南昌站  ', null, '无障碍入口\n待复核']))
      .toBe('南昌站。无障碍入口 待复核');
  });

  it('长结果限制在 60 字内并提示查看文字结果', () => {
    const result = buildTtsSpeechText(['这是很长的任务结果'.repeat(20)]);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toContain('更多内容请查看文字结果');
  });
});
