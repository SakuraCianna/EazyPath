import { and, asc, desc, eq, gt } from 'drizzle-orm';
import {
  agentTasks,
  db,
  serviceCards,
  taskEvents,
  userProfiles,
} from '../db/index.js';

export interface CreateTaskInput {
  installationId: string;
  inputType: 'text' | 'voice_text';
  content: string;
  profileVersion: number;
  clientTimezone: string;
  idempotencyKey?: string | undefined;
}

export const taskReadSelection = {
  id: agentTasks.id,
  installationId: agentTasks.installationId,
  inputType: agentTasks.inputType,
  originalContent: agentTasks.originalContent,
  clientTimezone: agentTasks.clientTimezone,
  profileVersion: agentTasks.profileVersion,
  profileSnapshot: agentTasks.profileSnapshot,
  parsedIntent: agentTasks.parsedIntent,
  status: agentTasks.status,
  failureCode: agentTasks.failureCode,
  failureMessage: agentTasks.failureMessage,
  completedAt: agentTasks.completedAt,
  cancelledAt: agentTasks.cancelledAt,
  createdAt: agentTasks.createdAt,
  updatedAt: agentTasks.updatedAt,
};

export async function createTask(input: CreateTaskInput) {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.installationId, input.installationId),
          eq(agentTasks.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return { task: existing, created: false };
  }

  const [profile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.installationId, input.installationId))
    .limit(1);
  if (!profile || profile.version !== input.profileVersion) return null;

  return db.transaction(async (tx) => {
    const [task] = await tx
      .insert(agentTasks)
      .values({
        installationId: input.installationId,
        inputType: input.inputType,
        originalContent: input.content,
        profileVersion: input.profileVersion,
        profileSnapshot: {
          mobility: profile.mobility,
          interaction: profile.interaction,
          version: profile.version,
        },
        clientTimezone: input.clientTimezone,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!task && input.idempotencyKey) {
      const [concurrent] = await tx.select().from(agentTasks).where(and(
        eq(agentTasks.installationId, input.installationId),
        eq(agentTasks.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (concurrent) return { task: concurrent, created: false };
    }
    if (!task) throw new Error('TASK_INSERT_FAILED');
    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: 'task.queued',
      eventData: { status: 'queued' },
    });
    return { task, created: true };
  });
}

export async function appendTaskEvent(
  taskId: string,
  eventType: string,
  eventData: Record<string, unknown>,
) {
  const [event] = await db
    .insert(taskEvents)
    .values({ taskId, eventType, eventData })
    .returning();
  return event;
}

export async function getTaskForInstallation(taskId: string, installationId: string) {
  const [task] = await db
    .select(taskReadSelection)
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.installationId, installationId)))
    .limit(1);
  if (!task) return null;
  const cards = await db
    .select()
    .from(serviceCards)
    .where(eq(serviceCards.taskId, taskId))
    .orderBy(asc(serviceCards.createdAt));
  return { ...task, cards };
}

export async function getTaskIdentityForInstallation(taskId: string, installationId: string) {
  const [task] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.installationId, installationId)))
    .limit(1);
  return task ?? null;
}

export async function getTaskEvents(taskId: string, afterEventId: number, limit = 100) {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.id, afterEventId)))
    .orderBy(asc(taskEvents.id))
    .limit(limit);
}

export async function getTaskEventCursor(taskId: string, eventId: number) {
  const [event] = await db
    .select({ id: taskEvents.id, occurredAt: taskEvents.occurredAt })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.id, eventId)))
    .limit(1);
  return event ?? null;
}

export async function getLatestTaskEventId(taskId: string): Promise<number> {
  const [event] = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.id))
    .limit(1);
  return event?.id ?? 0;
}

export async function listTasks(installationId: string, limit = 20) {
  return db
    .select(taskReadSelection)
    .from(agentTasks)
    .where(eq(agentTasks.installationId, installationId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit);
}
