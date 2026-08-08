import { z } from 'zod';
import { getEnv } from '../config/env.js';

const amapResponseSchema = z.object({
  status: z.string(),
  info: z.string().optional(),
  infocode: z.string().optional(),
  pois: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    typecode: z.string().optional(),
    address: z.union([z.string(), z.array(z.string())]).optional(),
    location: z.string().regex(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/),
    tel: z.union([z.string(), z.array(z.string())]).optional(),
  })).default([]),
});

export interface AmapPlace {
  externalId: string;
  name: string;
  category: string;
  address: string | null;
  longitude: number;
  latitude: number;
  telephone: string | null;
  source: 'amap';
  accessibilityEvidence: 'unknown';
}

export class AmapUpstreamError extends Error {
  constructor(public readonly retryable: boolean) {
    super('高德地点服务暂时不可用');
  }
}

export async function searchAmapPlaces(
  keywords: string,
  region = '江西省',
  typeCode?: string,
): Promise<AmapPlace[]> {
  const url = new URL('https://restapi.amap.com/v5/place/text');
  url.searchParams.set('key', getEnv().AMAP_WEB_SERVICE_KEY);
  url.searchParams.set('keywords', keywords);
  url.searchParams.set('region', region);
  url.searchParams.set('city_limit', 'true');
  url.searchParams.set('page_size', '20');
  if (typeCode) url.searchParams.set('types', typeCode);

  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!response?.ok) throw new AmapUpstreamError(true);
  const parsed = amapResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.status !== '1') throw new AmapUpstreamError(true);

  return parsed.data.pois.map((poi) => {
    const [longitudeText, latitudeText] = poi.location.split(',');
    return {
      externalId: poi.id,
      name: poi.name,
      category: poi.type ?? poi.typecode ?? 'unknown',
      address: normalizeValue(poi.address),
      longitude: Number(longitudeText),
      latitude: Number(latitudeText),
      telephone: normalizeValue(poi.tel),
      source: 'amap' as const,
      accessibilityEvidence: 'unknown' as const,
    };
  });
}

function normalizeValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join('、') || null;
  return value?.trim() || null;
}
