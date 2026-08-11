import { describe, expect, it } from 'vitest';
import { agentTaskFailureEventType, canRecoverRunningAgentTask } from './agent-task-recovery.js';

describe('Agent running 状态恢复', () => {
  it('普通首次 job 不能抢占另一个 running job', () => {
    expect(canRecoverRunningAgentTask({ attemptsStarted: 1, stalledCounter: 0 })).toBe(false);
  });

  it('同一 job 再次启动或已 stalled 时可以恢复', () => {
    expect(canRecoverRunningAgentTask({ attemptsStarted: 2, stalledCounter: 0 })).toBe(true);
    expect(canRecoverRunningAgentTask({ attemptsStarted: 1, stalledCounter: 1 })).toBe(true);
  });
});

describe('Agent 失败事件', () => {
  it('数据库终态 failed 始终对应 task.failed 事件', () => {
    expect(agentTaskFailureEventType('failed')).toBe('task.failed');
    expect(agentTaskFailureEventType('queued')).toBe('task.retrying');
  });
});
