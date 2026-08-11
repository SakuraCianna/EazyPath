export function canRecoverRunningAgentTask(input: {
  attemptsStarted: number;
  stalledCounter: number;
}): boolean {
  return input.attemptsStarted > 1 || input.stalledCounter > 0;
}

export function agentTaskFailureEventType(nextStatus: 'queued' | 'failed'): 'task.retrying' | 'task.failed' {
  return nextStatus === 'failed' ? 'task.failed' : 'task.retrying';
}
