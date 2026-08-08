import { z } from 'zod';
import { getEnv } from '../config/env.js';

export const visionResultSchema = z.object({
  scene: z.enum(['hotel_bathroom', 'entrance', 'interior_path', 'sidewalk_ramp', 'accessible_restroom', 'general_accessibility']),
  observations: z.array(z.object({
    feature_key: z.string().min(1).max(128),
    value: z.union([z.boolean(), z.number(), z.string()]),
    visible_evidence: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })).max(30),
  unknown_items: z.array(z.string().max(300)).max(30),
  overall_confidence: z.number().min(0).max(1),
  risk_level: z.enum(['low', 'medium', 'high', 'unknown']),
  recommendation: z.string().min(1).max(1000),
});

export type VisionResult = z.infer<typeof visionResultSchema>;

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export class VisionVerificationError extends Error {
  constructor(public readonly code: 'VISION_UNAVAILABLE' | 'VISION_OUTPUT_INVALID') {
    super(code === 'VISION_UNAVAILABLE' ? '视觉验真服务暂时不可用' : '视觉验真结果结构无效');
  }
}

export async function verifyAccessibilityImage(
  dataUrl: string,
  scene: string,
): Promise<VisionResult> {
  const env = getEnv();
  const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.VISION_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `你是谨慎的无障碍设施验真助手。场景提示: ${scene}。只描述图片中直接可见的证据；没有尺度参照时不得推断厘米数、坡度或门宽；盲区写入 unknown_items；不得承诺绝对安全。仅输出 JSON，字段为 scene、observations[{feature_key,value,visible_evidence,confidence}]、unknown_items、overall_confidence、risk_level、recommendation。`,
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(40_000),
  }).catch(() => null);
  if (!response?.ok) throw new VisionVerificationError('VISION_UNAVAILABLE');
  const envelope = responseSchema.safeParse(await response.json().catch(() => null));
  if (!envelope.success) throw new VisionVerificationError('VISION_OUTPUT_INVALID');
  const rawContent = envelope.data.choices[0]?.message.content;
  if (!rawContent) throw new VisionVerificationError('VISION_OUTPUT_INVALID');
  try {
    const parsed = visionResultSchema.safeParse(JSON.parse(rawContent.replace(/^```json\s*|\s*```$/g, '')));
    if (!parsed.success) throw new VisionVerificationError('VISION_OUTPUT_INVALID');
    return parsed.data;
  } catch (error) {
    if (error instanceof VisionVerificationError) throw error;
    throw new VisionVerificationError('VISION_OUTPUT_INVALID');
  }
}
