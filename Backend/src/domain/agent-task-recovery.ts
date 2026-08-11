export function canRecoverRunningAgentTask(input: {
  attemptsStarted: number;
  stalledCounter: number;
}): boolean {
  return input.attemptsStarted > 1 || input.stalledCounter > 0;
}
