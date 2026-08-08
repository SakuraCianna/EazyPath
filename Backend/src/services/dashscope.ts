import { z } from 'zod';
import { getEnv } from '../config/env.js';

export const ParsedIntentSchema = z.object({
  title: z.string().min(1).max(160),
  origin: z.string().min(1).max(160).optional(),
  destination: z.string().min(1).max(160),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  constraints: z.object({
    requireStepFree: z.boolean(),
    minDoorWidthCm: z.number().min(40).max(300),
    maximumObstacleHeightCm: z.number().min(0).max(30),
    maximumSlopePercent: z.number().min(0).max(100).nullable(),
    requireAccessibleRestroom: z.boolean(),
    requireRollInShower: z.boolean(),
    avoidUnverifiedSegments: z.boolean(),
  }),
  tasks: z.array(
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      category: z.enum(['rail', 'ride', 'route', 'hotel', 'dining', 'verification']),
      title: z.string().min(1).max(160),
      dependsOn: z.array(z.string()).default([]),
      params: z.record(z.string(), z.unknown()).default({}),
    }),
  ).min(1).max(20),
});

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

const dashScopeResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export class AgentPlanningError extends Error {
  constructor(
    public readonly code: 'AI_UNAVAILABLE' | 'AI_OUTPUT_INVALID',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function parseTravelIntent(
  content: string,
  profileSnapshot: unknown,
  timezone: string,
): Promise<ParsedIntent> {
  const env = getEnv();
  const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AGENT_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `你是 EazyPath 无障碍出行 Agent。仅输出 JSON。服务对象是轮椅或行动不便用户。不得声称地图原生支持轮椅路线，不得把未知信息写成已满足。当前时区: ${timezone}。用户偏好快照: ${JSON.stringify(profileSnapshot)}。输出字段必须包含 title、origin、destination、startDate、endDate、constraints 和 tasks；tasks 类型仅可为 rail、ride、route、hotel、dining、verification，并给出 DAG dependsOn。`,
        },
        { role: 'user', content },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);

  if (!response?.ok) {
    throw new AgentPlanningError('AI_UNAVAILABLE', 'Agent 服务暂时不可用', true);
  }
  const envelope = dashScopeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!envelope.success) {
    throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 返回结构无效', true);
  }
  const contentText = envelope.data.choices[0]?.message.content;
  if (!contentText) throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 未返回有效内容', true);
  const raw = safeParseJson(contentText);
  const parsed = ParsedIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 返回内容未通过结构校验', true);
  }
  validateDag(parsed.data);
  return parsed.data;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 返回内容不是合法 JSON', true);
  }
}

function validateDag(intent: ParsedIntent): void {
  const keys = new Set(intent.tasks.map((task) => task.id));
  if (keys.size !== intent.tasks.length) {
    throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 子任务标识重复', true);
  }
  for (const task of intent.tasks) {
    if (task.dependsOn.some((key) => !keys.has(key) || key === task.id)) {
      throw new AgentPlanningError('AI_OUTPUT_INVALID', 'Agent 子任务依赖无效', true);
    }
  }
}
