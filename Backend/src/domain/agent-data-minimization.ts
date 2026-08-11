const PHONE_NUMBER = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g;
const ID_CARD_NUMBER = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const PRECISE_ADDRESS_PART = /(?:\d{1,6}|[一二三四五六七八九十百千零〇两]+)(?:号|弄|栋|幢|座|单元|室)(?:楼|栋|幢|座|单元|室|\d|[一二三四五六七八九十百千零〇两]|-){0,12}/g;
const HYPHENATED_ADDRESS_PART = /((?:小区|社区|花园|公寓|大厦|苑|新村|家园))\s*\d{1,4}(?:-\d{1,4}){1,3}/g;

const MOBILITY_KEYS = [
  'mobilityMode',
  'requireStepFree',
  'minimumDoorWidthCm',
  'maximumObstacleHeightCm',
  'maximumSlopePercent',
  'requireAccessibleRestroom',
  'requireRollInShower',
  'avoidUnverifiedSegments',
] as const;

export function minimizeAgentContent(content: string): string {
  return content
    .replace(PHONE_NUMBER, '[已移除手机号]')
    .replace(ID_CARD_NUMBER, '[已移除身份证号]')
    .replace(PRECISE_ADDRESS_PART, '[已移除精确门牌]')
    .replace(HYPHENATED_ADDRESS_PART, '$1[已移除精确门牌]');
}

export function minimizeAgentProfile(profileSnapshot: unknown): Record<string, unknown> {
  if (!isRecord(profileSnapshot)) return {};
  const sourceMobility = profileSnapshot.mobility;
  if (!isRecord(sourceMobility)) return {};
  const mobility = Object.fromEntries(
    MOBILITY_KEYS.flatMap((key) => {
      const value = sourceMobility[key];
      return isSafePrimitive(value) ? [[key, value] as const] : [];
    }),
  );
  return { mobility };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
