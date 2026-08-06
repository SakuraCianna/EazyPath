import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'EazyPath Agent Backend',
    timestamp: new Date().toISOString(),
  });
});

// 行程串联 Agent 路由预留
app.post('/api/v1/agent/plan', async (c) => {
  const body = await c.req.json();
  return c.json({
    message: 'Agent 行程串联规划接口预留',
    request: body,
  });
});

// 视觉无障碍识别 路由预留
app.post('/api/v1/vision/analyze', async (c) => {
  return c.json({
    message: 'Qwen-VL 实时/图片无障碍分析接口预留',
  });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
