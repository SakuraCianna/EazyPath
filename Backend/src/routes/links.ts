import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/api-response.js';
import { requireUser } from '../middleware/auth.js';
import { resolvePublicActions } from '../services/deeplink.js';
import type { AppBindings } from '../types.js';

const linkSchema = z.object({
  platform: z.enum(['amap', 'didi', 'ctrip', 'meituan', 'railway12306']),
  destination_name: z.string().min(1).max(160),
  longitude: z.number().min(-180).max(180).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  date: z.iso.date().optional(),
  accessibility_notes: z.string().max(1000).optional(),
});

export const linksRouter = new Hono<AppBindings>();
linksRouter.use('*', requireUser);
linksRouter.post('/resolve', async (c) => {
  const parsed = linkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 422, 'LINK_TARGET_INVALID', '平台跳转参数无效');
  return ok(c, { actions: resolvePublicActions(parsed.data.platform, {
    destinationName: parsed.data.destination_name,
    longitude: parsed.data.longitude,
    latitude: parsed.data.latitude,
    date: parsed.data.date,
    accessibilityNotes: parsed.data.accessibility_notes,
  }) });
});
