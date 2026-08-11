import { and, eq, isNull, sql } from 'drizzle-orm';
import { aiProcessingConsents, db, installationAccounts } from '../db/index.js';
import {
  AI_CONSENT_NOTICE_VERIFIED_AT,
  AI_CONSENT_POLICY_VERSION,
  AI_CONSENT_PROCESSOR_CODE,
  AI_CONSENT_REGION_CODE,
  type AiCapability,
  buildAiConsentSnapshot,
} from '../domain/ai-consent.js';

const consentSelection = {
  capability: aiProcessingConsents.capability,
  policyVersion: aiProcessingConsents.policyVersion,
  processor: aiProcessingConsents.processor,
  region: aiProcessingConsents.region,
  noticeVerifiedAt: aiProcessingConsents.noticeVerifiedAt,
  grantedAt: aiProcessingConsents.grantedAt,
  revokedAt: aiProcessingConsents.revokedAt,
  version: aiProcessingConsents.version,
};

export class AiConsentVersionConflictError extends Error {
  constructor() {
    super('AI_CONSENT_VERSION_CONFLICT');
    this.name = 'AiConsentVersionConflictError';
  }
}

export async function listAiConsents(installationId: string) {
  const rows = await db.select(consentSelection)
    .from(aiProcessingConsents)
    .where(eq(aiProcessingConsents.installationId, installationId));
  return buildAiConsentSnapshot(rows);
}

export async function setAiConsent(
  installationId: string,
  capability: AiCapability,
  granted: boolean,
  expectedVersion: number | null,
) {
  const now = new Date();
  const noticeVerifiedAt = new Date(`${AI_CONSENT_NOTICE_VERIFIED_AT}T00:00:00.000Z`);
  await db.transaction(async (tx) => {
    await tx.select({ id: installationAccounts.id })
      .from(installationAccounts)
      .where(eq(installationAccounts.id, installationId))
      .for('update')
      .limit(1);
    const [existing] = await tx.select({ version: aiProcessingConsents.version })
      .from(aiProcessingConsents)
      .where(and(
        eq(aiProcessingConsents.installationId, installationId),
        eq(aiProcessingConsents.capability, capability),
      ))
      .limit(1);
    if ((existing?.version ?? null) !== expectedVersion) throw new AiConsentVersionConflictError();
    if (!existing) {
      await tx.insert(aiProcessingConsents).values({
        installationId,
        capability,
        policyVersion: AI_CONSENT_POLICY_VERSION,
        processor: AI_CONSENT_PROCESSOR_CODE,
        region: AI_CONSENT_REGION_CODE,
        noticeVerifiedAt,
        grantedAt: granted ? now : null,
        revokedAt: granted ? null : now,
      });
      return;
    }
    if (expectedVersion === null) throw new AiConsentVersionConflictError();
    await tx.update(aiProcessingConsents).set(granted ? {
      policyVersion: AI_CONSENT_POLICY_VERSION,
      processor: AI_CONSENT_PROCESSOR_CODE,
      region: AI_CONSENT_REGION_CODE,
      noticeVerifiedAt,
      grantedAt: now,
      revokedAt: null,
      version: sql`${aiProcessingConsents.version} + 1`,
      updatedAt: now,
    } : {
      revokedAt: now,
      version: sql`${aiProcessingConsents.version} + 1`,
      updatedAt: now,
    }).where(and(
        eq(aiProcessingConsents.installationId, installationId),
        eq(aiProcessingConsents.capability, capability),
        eq(aiProcessingConsents.version, expectedVersion),
      ));
  });
  return (await listAiConsents(installationId)).find((item) => item.capability === capability);
}

export async function hasActiveAiConsent(installationId: string, capability: AiCapability): Promise<boolean> {
  const [record] = await db.select({ id: aiProcessingConsents.id })
    .from(aiProcessingConsents)
    .innerJoin(installationAccounts, eq(installationAccounts.id, aiProcessingConsents.installationId))
    .where(and(
      eq(aiProcessingConsents.installationId, installationId),
      eq(installationAccounts.status, 'active'),
      eq(aiProcessingConsents.capability, capability),
      eq(aiProcessingConsents.policyVersion, AI_CONSENT_POLICY_VERSION),
      sql`${aiProcessingConsents.grantedAt} IS NOT NULL`,
      isNull(aiProcessingConsents.revokedAt),
    ))
    .limit(1);
  return Boolean(record);
}
