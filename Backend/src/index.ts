import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { getEnv } from './config/env.js';
import { checkDatabase, queryClient } from './db/index.js';
import { fail, ok } from './lib/api-response.js';
import { checkRedis } from './queue/connection.js';
import { registerMaintenanceSchedules, taskQueue } from './queue/task-queue.js';
import { adminAuthRouter, adminRouter } from './routes/admin.js';
import { observationsRouter, reviewTasksRouter, locationProofsRouter } from './routes/community.js';
import { installationsRouter, sessionsRouter } from './routes/installations.js';
import { linksRouter } from './routes/links.js';
import { mediaRouter } from './routes/media.js';
import { placesRouter } from './routes/places.js';
import { privacyRouter } from './routes/privacy.js';
import { profileRouter } from './routes/profile.js';
import { tasksRouter } from './routes/tasks.js';
import { verificationsRouter } from './routes/verifications.js';
import { prepareMediaDirectories } from './services/media-storage.js';
import type { AppBindings } from './types.js';

const env = getEnv();
const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()));
const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id')?.slice(0, 64) || `req_${crypto.randomUUID()}`;
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  await next();
});
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: 'no-referrer',
}));
app.use('/api/*', cors({
  origin: (origin) => allowedOrigins.has(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Last-Event-ID', 'X-CSRF-Token', 'X-Part-SHA256', 'X-Request-ID'],
  exposeHeaders: ['X-Request-ID'],
  credentials: true,
  maxAge: 600,
}));

app.route('/api/v1/installations', installationsRouter);
app.route('/api/v1/sessions', sessionsRouter);
app.route('/api/v1/profile', profileRouter);
app.route('/api/v1/tasks', tasksRouter);
app.route('/api/v1/verifications', verificationsRouter);
app.route('/api/v1/links', linksRouter);
app.route('/api/v1/places', placesRouter);
app.route('/api/v1/observations', observationsRouter);
app.route('/api/v1/review-tasks', reviewTasksRouter);
app.route('/api/v1/location-proofs', locationProofsRouter);
app.route('/api/v1/media', mediaRouter);
app.route('/api/v1/privacy', privacyRouter);
app.route('/api/v1/admin/auth', adminAuthRouter);
app.route('/api/v1/admin', adminRouter);

app.get('/health/live', (c) => ok(c, { status: 'ok', service: 'eazypath-api', version: '2.0.0' }));
app.get('/health/ready', async (c) => {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const ready = database.ok && redis.ok;
  const payload = { status: ready ? 'ready' : 'degraded', database, redis, queue: { name: taskQueue.name } };
  return ready ? ok(c, payload) : fail(c, 503, 'DEPENDENCY_UNAVAILABLE', '依赖服务未就绪', { retryable: true, details: payload });
});

app.notFound((c) => fail(c, 404, 'NOT_FOUND', '接口不存在'));
app.onError((error, c) => {
  console.error(JSON.stringify({ level: 'error', event: 'http.unhandled_error', requestId: c.get('requestId'), message: error.message }));
  return fail(c, 500, 'INTERNAL_ERROR', '服务内部错误', { retryable: true });
});

async function main(): Promise<void> {
  await prepareMediaDirectories();
  await registerMaintenanceSchedules();
  serve({ fetch: app.fetch, port: env.PORT });
  console.info(JSON.stringify({ level: 'info', event: 'server.ready', port: env.PORT }));
}

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ level: 'info', event: 'server.shutdown', signal }));
  await Promise.all([taskQueue.close(), queryClient.end()]);
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') void main();
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export default app;
