import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const geometryPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Point,4326)';
  },
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

export const installationAccounts = pgTable(
  'installation_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationGuid: uuid('installation_guid').notNull(),
    publicKeySpki: text('public_key_spki').notNull(),
    keyAlgorithm: varchar('key_algorithm', { length: 32 }).default('EC_P256').notNull(),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    acceptedContributionCount: integer('accepted_contribution_count').default(0).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_installation_accounts_guid').on(table.installationGuid),
    check('chk_installation_accounts_status', sql`${table.status} IN ('active', 'suspended', 'deleting', 'deleted')`),
  ],
);

export const installationChallenges = pgTable(
  'installation_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationGuid: uuid('installation_guid').notNull(),
    challengeHash: varchar('challenge_hash', { length: 128 }).notNull(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_installation_challenges_guid').on(table.installationGuid, table.expiresAt),
    check('chk_installation_challenges_purpose', sql`${table.purpose} IN ('register', 'recover', 'sensitive_action')`),
  ],
);

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installationAccounts.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_refresh_sessions_token_hash').on(table.tokenHash),
    index('idx_refresh_sessions_installation').on(table.installationId, table.expiresAt),
  ],
);

export interface MobilityProfile {
  mobilityMode: 'wheelchair_manual' | 'wheelchair_powered' | 'limited_mobility';
  requireStepFree: boolean;
  minimumDoorWidthCm: number;
  maximumObstacleHeightCm: number;
  maximumSlopePercent?: number | undefined;
  requireAccessibleRestroom: boolean;
  requireRollInShower: boolean;
  avoidUnverifiedSegments: boolean;
}

export interface InteractionProfile {
  largeText: boolean;
  highContrast: boolean;
  preferVoiceInput: boolean;
  preferVoiceOutput: boolean;
  hapticFeedback: boolean;
}

export const userProfiles = pgTable(
  'user_profiles_v2',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installationAccounts.id, { onDelete: 'cascade' }),
    mobility: jsonb('mobility').$type<MobilityProfile>().notNull(),
    interaction: jsonb('interaction').$type<InteractionProfile>().notNull(),
    customHabitsEncrypted: text('custom_habits_encrypted'),
    encryptionKeyVersion: varchar('encryption_key_version', { length: 32 }),
    version: integer('version').default(1).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_user_profiles_v2_installation').on(table.installationId)],
);

export interface TaskIntent {
  title: string;
  origin?: string | undefined;
  destination: string;
  startDate?: string | undefined;
  endDate?: string | undefined;
  constraints: Record<string, unknown>;
}

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installationAccounts.id, { onDelete: 'cascade' }),
    inputType: varchar('input_type', { length: 16 }).notNull(),
    originalContent: text('original_content').notNull(),
    clientTimezone: varchar('client_timezone', { length: 64 }).notNull(),
    profileVersion: integer('profile_version').notNull(),
    profileSnapshot: jsonb('profile_snapshot').notNull(),
    parsedIntent: jsonb('parsed_intent').$type<TaskIntent>(),
    status: varchar('status', { length: 24 }).default('queued').notNull(),
    runClaimToken: uuid('run_claim_token'),
    failureCode: varchar('failure_code', { length: 64 }),
    failureMessage: text('failure_message'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('idx_agent_tasks_installation_status').on(table.installationId, table.status, table.createdAt),
    uniqueIndex('uq_agent_tasks_idempotency').on(table.installationId, table.idempotencyKey),
    check('chk_agent_tasks_status', sql`${table.status} IN ('queued', 'running', 'needs_input', 'completed', 'failed', 'cancelled')`),
    check('chk_agent_tasks_run_claim', sql`(${table.status} = 'running' AND ${table.runClaimToken} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.runClaimToken} IS NULL)`),
  ],
);

export const agentSubtasks = pgTable(
  'agent_subtasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
    externalKey: varchar('external_key', { length: 64 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    dependsOn: jsonb('depends_on').$type<string[]>().default([]).notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().default({}).notNull(),
    status: varchar('status', { length: 24 }).default('queued').notNull(),
    failureCode: varchar('failure_code', { length: 64 }),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_agent_subtasks_task_key').on(table.taskId, table.externalKey)],
);

export interface ServiceAction {
  type: 'app_uri' | 'web' | 'clipboard' | 'phone';
  label: string;
  platform?: string;
  url?: string;
  content?: string;
}

export const serviceCards = pgTable(
  'service_cards_v2',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
    subtaskId: uuid('subtask_id').references(() => agentSubtasks.id, { onDelete: 'set null' }),
    category: varchar('category', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    resultSnapshot: jsonb('result_snapshot').notNull(),
    evidenceSummary: jsonb('evidence_summary').notNull(),
    riskLevel: varchar('risk_level', { length: 16 }).default('unknown').notNull(),
    riskMessage: text('risk_message').notNull(),
    actions: jsonb('actions').$type<ServiceAction[]>().default([]).notNull(),
    ...timestamps,
  },
  (table) => [index('idx_service_cards_v2_task').on(table.taskId, table.createdAt)],
);

export const taskEvents = pgTable(
  'task_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    eventData: jsonb('event_data').$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_task_events_task_cursor').on(table.taskId, table.id)],
);

export const places = pgTable(
  'places',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalSource: varchar('external_source', { length: 32 }),
    externalId: varchar('external_id', { length: 128 }),
    name: varchar('name', { length: 160 }).notNull(),
    categoryCode: varchar('category_code', { length: 64 }).notNull(),
    location: geometryPoint('location').notNull(),
    longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),
    latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
    address: text('address'),
    provinceCode: varchar('province_code', { length: 12 }).default('360000').notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    mergedIntoPlaceId: uuid('merged_into_place_id'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    adminOverrideAt: timestamp('admin_override_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_places_external').on(table.externalSource, table.externalId),
    index('idx_places_category').on(table.categoryCode),
    index('idx_places_status').on(table.status, table.updatedAt),
    index('idx_places_merged_target').on(table.mergedIntoPlaceId),
    foreignKey({ columns: [table.mergedIntoPlaceId], foreignColumns: [table.id], name: 'places_merged_into_place_id_fk' }).onDelete('restrict'),
    check('chk_places_status', sql`${table.status} IN ('active', 'disabled', 'merged')`),
    check('chk_places_merge_target', sql`(${table.status} = 'merged' AND ${table.mergedIntoPlaceId} IS NOT NULL) OR (${table.status} <> 'merged' AND ${table.mergedIntoPlaceId} IS NULL)`),
    check('chk_places_not_self_merged', sql`${table.mergedIntoPlaceId} IS NULL OR ${table.mergedIntoPlaceId} <> ${table.id}`),
  ],
);

export const placeUnits = pgTable(
  'place_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    parentUnitId: uuid('parent_unit_id'),
    unitType: varchar('unit_type', { length: 64 }).notNull(),
    name: varchar('name', { length: 160 }),
    ...timestamps,
  },
  (table) => [index('idx_place_units_place').on(table.placeId)],
);

export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    placeUnitId: uuid('place_unit_id').references(() => placeUnits.id, { onDelete: 'cascade' }),
    facilityType: varchar('facility_type', { length: 64 }).notNull(),
    name: varchar('name', { length: 160 }),
    ...timestamps,
  },
  (table) => [index('idx_facilities_place').on(table.placeId)],
);

export const featureDefinitions = pgTable(
  'feature_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    featureKey: varchar('feature_key', { length: 128 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    valueType: varchar('value_type', { length: 16 }).notNull(),
    unit: varchar('unit', { length: 32 }),
    targetTypes: jsonb('target_types').$type<string[]>().notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    active: boolean('active').default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_feature_definitions_key').on(table.featureKey)],
);

export const evidenceMedia = pgTable(
  'evidence_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').references(() => installationAccounts.id, { onDelete: 'set null' }),
    storagePath: text('storage_path').notNull(),
    mimeType: varchar('mime_type', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width'),
    height: integer('height'),
    fingerprintHmac: varchar('fingerprint_hmac', { length: 128 }),
    fingerprintKeyVersion: varchar('fingerprint_key_version', { length: 32 }),
    redactionConfirmed: boolean('redaction_confirmed').notNull(),
    status: varchar('status', { length: 24 }).default('pending_link').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('idx_evidence_media_owner_status').on(table.installationId, table.status, table.expiresAt)],
);

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').references(() => installationAccounts.id, { onDelete: 'set null' }),
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    placeUnitId: uuid('place_unit_id').references(() => placeUnits.id, { onDelete: 'set null' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    featureDefinitionId: uuid('feature_definition_id').notNull().references(() => featureDefinitions.id),
    valueJson: jsonb('value_json').notNull(),
    evidenceSource: varchar('evidence_source', { length: 32 }).notNull(),
    moderationStatus: varchar('moderation_status', { length: 24 }).default('pending').notNull(),
    moderationReason: text('moderation_reason'),
    moderationVersion: integer('moderation_version').default(0).notNull(),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    appealUntil: timestamp('appeal_until', { withTimezone: true }),
    evidenceGrade: varchar('evidence_grade', { length: 1 }).default('U').notNull(),
    freshnessStatus: varchar('freshness_status', { length: 24 }).default('current').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    locationProofPassed: boolean('location_proof_passed').default(false).notNull(),
    locationDistanceBucket: varchar('location_distance_bucket', { length: 24 }),
    locationVerifiedAt: timestamp('location_verified_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('idx_observations_place_feature').on(
      table.placeId,
      table.featureDefinitionId,
      table.moderationStatus,
      table.freshnessStatus,
      table.expiresAt,
    ),
    index('idx_observations_moderation_queue').on(table.moderationStatus, table.updatedAt),
    check('chk_observation_moderation_status', sql`${table.moderationStatus} IN ('pending', 'approved', 'rejected', 'withdrawn')`),
    check('chk_observation_grade', sql`${table.evidenceGrade} IN ('A', 'B', 'C', 'U')`),
  ],
);

export const observationMedia = pgTable(
  'observation_media',
  {
    observationId: uuid('observation_id').notNull().references(() => observations.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id').notNull().references(() => evidenceMedia.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.observationId, table.mediaId] })],
);

export const verificationRecords = pgTable(
  'verification_records_v2',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').references(() => installationAccounts.id, { onDelete: 'set null' }),
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'set null' }),
    placeUnitId: uuid('place_unit_id').references(() => placeUnits.id, { onDelete: 'set null' }),
    scene: varchar('scene', { length: 64 }).notNull(),
    status: varchar('status', { length: 24 }).default('queued').notNull(),
    resultJson: jsonb('result_json'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    riskLevel: varchar('risk_level', { length: 16 }).default('unknown').notNull(),
    modelName: varchar('model_name', { length: 64 }).notNull(),
    promptVersion: varchar('prompt_version', { length: 32 }).notNull(),
    imageFingerprintHmac: varchar('image_fingerprint_hmac', { length: 128 }),
    fingerprintKeyVersion: varchar('fingerprint_key_version', { length: 32 }),
    fingerprintExpiresAt: timestamp('fingerprint_expires_at', { withTimezone: true }),
    originalMediaStored: boolean('original_media_stored').default(false).notNull(),
    temporaryMediaDeletedAt: timestamp('temporary_media_deleted_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
    adminReviewStatus: varchar('admin_review_status', { length: 24 }).default('unreviewed').notNull(),
    adminReviewReason: text('admin_review_reason'),
    adminReviewedAt: timestamp('admin_reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_verification_records_v2_owner').on(table.installationId, table.createdAt),
    index('idx_verification_records_v2_admin_review').on(table.adminReviewStatus, table.createdAt),
    index('idx_verification_records_v2_place').on(table.placeId),
    check('chk_verification_admin_review_status', sql`${table.adminReviewStatus} IN ('unreviewed', 'confirmed', 'flagged')`),
  ],
);

export const communityReviewTasks = pgTable(
  'community_review_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: uuid('target_id').notNull(),
    featureDefinitionId: uuid('feature_definition_id').notNull().references(() => featureDefinitions.id),
    status: varchar('status', { length: 24 }).default('pending_review').notNull(),
    reason: varchar('reason', { length: 32 }).notNull(),
    consensusOutcome: varchar('consensus_outcome', { length: 16 }),
    consensusSnapshot: jsonb('consensus_snapshot'),
    locationRadiusMeters: integer('location_radius_meters').default(200).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    resolutionReason: text('resolution_reason'),
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    supersededByTaskId: uuid('superseded_by_task_id'),
    ...timestamps,
  },
  (table) => [
    index('idx_community_review_tasks_status').on(table.status, table.createdAt),
    index('idx_community_review_tasks_place').on(table.placeId),
    index('idx_community_review_tasks_admin_queue').on(table.status, table.updatedAt, table.id),
    foreignKey({ columns: [table.supersededByTaskId], foreignColumns: [table.id], name: 'community_review_tasks_superseded_by_fk' }).onDelete('set null'),
    check('chk_community_review_task_status', sql`${table.status} IN ('pending_review', 'community_consensus', 'conflicting', 'admin_rejected', 'cancelled', 'reopened')`),
  ],
);

export const communityReviewVotes = pgTable(
  'community_review_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewTaskId: uuid('review_task_id').notNull().references(() => communityReviewTasks.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id').notNull().references(() => installationAccounts.id, { onDelete: 'cascade' }),
    clientSubmissionId: uuid('client_submission_id').notNull(),
    answer: varchar('answer', { length: 16 }).notNull(),
    mediaId: uuid('media_id').references(() => evidenceMedia.id, { onDelete: 'set null' }),
    locationProofPassed: boolean('location_proof_passed').default(false).notNull(),
    locationDistanceBucket: varchar('location_distance_bucket', { length: 24 }),
    baseWeight: numeric('base_weight', { precision: 3, scale: 2 }).notNull(),
    finalWeight: numeric('final_weight', { precision: 3, scale: 2 }).notNull(),
    established: boolean('established').default(false).notNull(),
    suspended: boolean('suspended').default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_community_review_votes_round_installation').on(table.reviewTaskId, table.installationId),
    check('chk_community_review_vote_answer', sql`${table.answer} IN ('present', 'absent', 'unknown')`),
  ],
);

export const locationProofs = pgTable(
  'location_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').notNull().references(() => installationAccounts.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    reviewTaskId: uuid('review_task_id').references(() => communityReviewTasks.id, { onDelete: 'cascade' }),
    passed: boolean('passed').notNull(),
    distanceBucket: varchar('distance_bucket', { length: 24 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_location_proofs_owner_expiry').on(table.installationId, table.expiresAt),
    index('idx_location_proofs_place').on(table.placeId),
    index('idx_location_proofs_review_task').on(table.reviewTaskId),
  ],
);

export const mediaUploadSessions = pgTable(
  'media_upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').notNull().references(() => installationAccounts.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 64 }).notNull(),
    totalBytes: integer('total_bytes').notNull(),
    totalParts: integer('total_parts').notNull(),
    wholeSha256: varchar('whole_sha256', { length: 64 }).notNull(),
    redactionConfirmed: boolean('redaction_confirmed').notNull(),
    status: varchar('status', { length: 24 }).default('uploading').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedMediaId: uuid('completed_media_id').references(() => evidenceMedia.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_media_upload_sessions_idempotency').on(table.installationId, table.idempotencyKey),
    index('idx_media_upload_sessions_expiry').on(table.status, table.expiresAt),
  ],
);

export const mediaUploadParts = pgTable(
  'media_upload_parts',
  {
    uploadId: uuid('upload_id').notNull().references(() => mediaUploadSessions.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.uploadId, table.partNumber] })],
);

export const platformLinkConfigs = pgTable(
  'platform_link_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: varchar('platform', { length: 32 }).notNull(),
    capability: varchar('capability', { length: 64 }).notNull(),
    mode: varchar('mode', { length: 24 }).notNull(),
    appUriTemplate: text('app_uri_template'),
    webUrlTemplate: text('web_url_template'),
    allowedHosts: jsonb('allowed_hosts').$type<string[]>().default([]).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    enabled: boolean('enabled').default(false).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_platform_link_configs_capability').on(table.platform, table.capability)],
);

export const adminRoles = pgTable('admin_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  permissions: jsonb('permissions').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    roleId: uuid('role_id').notNull().references(() => adminRoles.id),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    failedLoginCount: integer('failed_login_count').default(0).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_admin_users_username').on(table.username)],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    csrfHash: varchar('csrf_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_admin_sessions_token').on(table.tokenHash),
    index('idx_admin_sessions_user_expiry').on(table.adminUserId, table.expiresAt),
  ],
);

export const userFeedback = pgTable(
  'user_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').references(() => installationAccounts.id, { onDelete: 'set null' }),
    feedbackType: varchar('feedback_type', { length: 32 }).notNull(),
    sourceType: varchar('source_type', { length: 24 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: uuid('target_id').notNull(),
    message: text('message').notNull(),
    status: varchar('status', { length: 24 }).default('open').notNull(),
    resolutionReason: text('resolution_reason'),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('idx_user_feedback_queue').on(table.feedbackType, table.targetType, table.status, table.updatedAt, table.id),
    index('idx_user_feedback_target').on(table.targetType, table.targetId, table.createdAt),
    index('idx_user_feedback_expiry').on(table.feedbackType, table.status, table.expiresAt),
    uniqueIndex('uq_user_feedback_active').on(
      table.installationId,
      table.feedbackType,
      table.targetType,
      table.targetId,
    ).where(sql`${table.status} IN ('open', 'in_review')`),
    check('chk_user_feedback_type', sql`${table.feedbackType} IN ('appeal', 'supplement_request', 'correction', 'withdrawal')`),
    check('chk_user_feedback_source', sql`${table.sourceType} IN ('installation', 'admin')`),
    check('chk_user_feedback_status', sql`${table.status} IN ('open', 'in_review', 'resolved', 'rejected', 'withdrawn')`),
    check('chk_user_feedback_active_expiry', sql`${table.feedbackType} NOT IN ('appeal', 'supplement_request') OR ${table.status} NOT IN ('open', 'in_review') OR ${table.expiresAt} IS NOT NULL`),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: varchar('actor_type', { length: 24 }).notNull(),
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 96 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: varchar('target_id', { length: 128 }),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    networkRiskKey: varchar('network_risk_key', { length: 128 }),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_audit_events_time_action').on(table.createdAt, table.action)],
);
