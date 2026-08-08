import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, userProfiles } from '../db/index.js';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import type { AppBindings } from '../types.js';

const profileSchema = z.object({
  mobility: z.object({
    mobilityMode: z.enum(['wheelchair_manual', 'wheelchair_powered', 'limited_mobility']),
    requireStepFree: z.boolean(),
    minimumDoorWidthCm: z.number().int().min(40).max(300),
    maximumObstacleHeightCm: z.number().min(0).max(30),
    maximumSlopePercent: z.number().min(0).max(100).optional(),
    requireAccessibleRestroom: z.boolean(),
    requireRollInShower: z.boolean(),
    avoidUnverifiedSegments: z.boolean(),
  }),
  interaction: z.object({
    largeText: z.boolean(),
    highContrast: z.boolean(),
    preferVoiceInput: z.boolean(),
    preferVoiceOutput: z.boolean(),
    hapticFeedback: z.boolean(),
  }),
});

export const profileRouter = new Hono<AppBindings>();
profileRouter.use('*', requireUser);

profileRouter.get('/', async (c) => {
  const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.installationId, c.get('installationId'))).limit(1);
  if (!profile) return fail(c, 404, 'PROFILE_NOT_FOUND', '无障碍偏好档案不存在');
  return ok(c, { mobility: profile.mobility, interaction: profile.interaction, version: profile.version, updated_at: profile.updatedAt });
});

profileRouter.put('/', async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'PROFILE_INVALID', '无障碍偏好参数无效', { retryable: false, details: { fields: parsed.error.issues.map((issue) => issue.path.join('.')) } });
  const [current] = await db.select().from(userProfiles).where(eq(userProfiles.installationId, c.get('installationId'))).limit(1);
  if (!current) return fail(c, 404, 'PROFILE_NOT_FOUND', '无障碍偏好档案不存在');
  const [profile] = await db.update(userProfiles).set({ ...parsed.data, version: current.version + 1, updatedAt: new Date() }).where(eq(userProfiles.id, current.id)).returning();
  return ok(c, { mobility: profile?.mobility, interaction: profile?.interaction, version: profile?.version, updated_at: profile?.updatedAt }, '偏好已保存');
});
