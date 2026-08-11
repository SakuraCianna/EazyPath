import { and, asc, eq, sql } from 'drizzle-orm';
import { agentTasks, db, serviceCards } from '../db/index.js';

const taskStatusText: Record<string, string> = {
  queued: '等待处理',
  running: '正在规划',
  needs_input: '需要补充信息',
  completed: '规划完成',
  failed: '规划失败',
  cancelled: '已取消',
};

export function buildTtsSpeechText(parts: Array<string | null | undefined>): string {
  const text = parts
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter((part): part is string => Boolean(part))
    .join('。');
  if (text.length <= 60) return text;
  return `${text.slice(0, 48)}。更多内容请查看文字结果`;
}

export async function getAuthorizedTtsText(
  installationId: string,
  taskId: string,
  cardId?: string | null,
): Promise<string | null> {
  const [task] = await db.select({
    id: agentTasks.id,
    status: agentTasks.status,
    intentTitle: sql<string | null>`${agentTasks.parsedIntent} ->> 'title'`,
  }).from(agentTasks).where(and(
    eq(agentTasks.id, taskId),
    eq(agentTasks.installationId, installationId),
  )).limit(1);
  if (!task) return null;

  if (cardId) {
    const [card] = await db.select({
      title: serviceCards.title,
      status: serviceCards.status,
      riskLevel: serviceCards.riskLevel,
      riskMessage: serviceCards.riskMessage,
    }).from(serviceCards).where(and(
      eq(serviceCards.id, cardId),
      eq(serviceCards.taskId, task.id),
    )).limit(1);
    if (!card) return null;
    return buildTtsSpeechText([
      card.title,
      `卡片状态${card.status}`,
      `风险等级${card.riskLevel}`,
      card.riskMessage,
    ]);
  }

  const cards = await db.select({
    title: serviceCards.title,
    riskMessage: serviceCards.riskMessage,
  }).from(serviceCards).where(eq(serviceCards.taskId, task.id)).orderBy(asc(serviceCards.createdAt)).limit(8);
  return buildTtsSpeechText([
    task.intentTitle,
    `任务${taskStatusText[task.status] ?? task.status}`,
    ...cards.flatMap((card) => [card.title, card.riskMessage]),
  ]);
}
