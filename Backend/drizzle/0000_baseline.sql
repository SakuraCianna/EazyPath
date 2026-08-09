CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"csrf_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_subtasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"external_key" varchar(64) NOT NULL,
	"category" varchar(32) NOT NULL,
	"title" varchar(160) NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"input_type" varchar(16) NOT NULL,
	"original_content" text NOT NULL,
	"client_timezone" varchar(64) NOT NULL,
	"profile_version" integer NOT NULL,
	"profile_snapshot" jsonb NOT NULL,
	"parsed_intent" jsonb,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"failure_code" varchar(64),
	"failure_message" text,
	"idempotency_key" varchar(128),
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_agent_tasks_status" CHECK ("agent_tasks"."status" IN ('queued', 'running', 'needs_input', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(24) NOT NULL,
	"actor_id" uuid,
	"action" varchar(96) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(128),
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"network_risk_key" varchar(128),
	"request_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_review_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" uuid NOT NULL,
	"feature_definition_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'pending_review' NOT NULL,
	"reason" varchar(32) NOT NULL,
	"consensus_outcome" varchar(16),
	"consensus_snapshot" jsonb,
	"location_radius_meters" integer DEFAULT 200 NOT NULL,
	"closes_at" timestamp with time zone,
	"resolution_reason" text,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"superseded_by_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_community_review_task_status" CHECK ("community_review_tasks"."status" IN ('pending_review', 'community_consensus', 'conflicting', 'admin_rejected', 'cancelled', 'reopened'))
);
--> statement-breakpoint
CREATE TABLE "community_review_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_task_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"client_submission_id" uuid NOT NULL,
	"answer" varchar(16) NOT NULL,
	"media_id" uuid,
	"location_proof_passed" boolean DEFAULT false NOT NULL,
	"location_distance_bucket" varchar(24),
	"base_weight" numeric(3, 2) NOT NULL,
	"final_weight" numeric(3, 2) NOT NULL,
	"established" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_community_review_vote_answer" CHECK ("community_review_votes"."answer" IN ('present', 'absent', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "evidence_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid,
	"storage_path" text NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"fingerprint_hmac" varchar(128),
	"fingerprint_key_version" varchar(32),
	"redaction_confirmed" boolean NOT NULL,
	"status" varchar(24) DEFAULT 'pending_link' NOT NULL,
	"linked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"place_unit_id" uuid,
	"facility_type" varchar(64) NOT NULL,
	"name" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_key" varchar(128) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"value_type" varchar(16) NOT NULL,
	"unit" varchar(32),
	"target_types" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_guid" uuid NOT NULL,
	"public_key_spki" text NOT NULL,
	"key_algorithm" varchar(32) DEFAULT 'EC_P256' NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"accepted_contribution_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_installation_accounts_status" CHECK ("installation_accounts"."status" IN ('active', 'suspended', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "installation_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_guid" uuid NOT NULL,
	"challenge_hash" varchar(128) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_installation_challenges_purpose" CHECK ("installation_challenges"."purpose" IN ('register', 'recover', 'sensitive_action'))
);
--> statement-breakpoint
CREATE TABLE "location_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"review_task_id" uuid,
	"passed" boolean NOT NULL,
	"distance_bucket" varchar(24) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
CREATE TABLE "media_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"total_bytes" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"whole_sha256" varchar(64) NOT NULL,
	"redaction_confirmed" boolean NOT NULL,
	"status" varchar(24) DEFAULT 'uploading' NOT NULL,
	"idempotency_key" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"completed_media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_media" (
	"observation_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "observation_media_observation_id_media_id_pk" PRIMARY KEY("observation_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid,
	"place_id" uuid NOT NULL,
	"place_unit_id" uuid,
	"facility_id" uuid,
	"feature_definition_id" uuid NOT NULL,
	"value_json" jsonb NOT NULL,
	"evidence_source" varchar(32) NOT NULL,
	"moderation_status" varchar(24) DEFAULT 'pending' NOT NULL,
	"evidence_grade" varchar(1) DEFAULT 'U' NOT NULL,
	"freshness_status" varchar(24) DEFAULT 'current' NOT NULL,
	"confidence" numeric(4, 3),
	"observed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_observation_grade" CHECK ("observations"."evidence_grade" IN ('A', 'B', 'C', 'U'))
);
--> statement-breakpoint
CREATE TABLE "place_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"parent_unit_id" uuid,
	"unit_type" varchar(64) NOT NULL,
	"name" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_source" varchar(32),
	"external_id" varchar(128),
	"name" varchar(160) NOT NULL,
	"category_code" varchar(64) NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"latitude" numeric(10, 7) NOT NULL,
	"address" text,
	"province_code" varchar(12) DEFAULT '360000' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"merged_into_place_id" uuid,
	"source_updated_at" timestamp with time zone,
	"admin_override_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_link_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(32) NOT NULL,
	"capability" varchar(64) NOT NULL,
	"mode" varchar(24) NOT NULL,
	"app_uri_template" text,
	"web_url_template" text,
	"allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_cards_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"subtask_id" uuid,
	"category" varchar(32) NOT NULL,
	"title" varchar(160) NOT NULL,
	"status" varchar(24) NOT NULL,
	"result_snapshot" jsonb NOT NULL,
	"evidence_summary" jsonb NOT NULL,
	"risk_level" varchar(16) DEFAULT 'unknown' NOT NULL,
	"risk_message" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"event_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"mobility" jsonb NOT NULL,
	"interaction" jsonb NOT NULL,
	"custom_habits_encrypted" text,
	"encryption_key_version" varchar(32),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_records_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid,
	"place_id" uuid,
	"place_unit_id" uuid,
	"scene" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"result_json" jsonb,
	"confidence" numeric(4, 3),
	"risk_level" varchar(16) DEFAULT 'unknown' NOT NULL,
	"model_name" varchar(64) NOT NULL,
	"prompt_version" varchar(32) NOT NULL,
	"image_fingerprint_hmac" varchar(128),
	"fingerprint_key_version" varchar(32),
	"fingerprint_expires_at" timestamp with time zone,
	"original_media_stored" boolean DEFAULT false NOT NULL,
	"temporary_media_deleted_at" timestamp with time zone,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_id_admin_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subtasks" ADD CONSTRAINT "agent_subtasks_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_tasks" ADD CONSTRAINT "community_review_tasks_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_tasks" ADD CONSTRAINT "community_review_tasks_feature_definition_id_feature_definitions_id_fk" FOREIGN KEY ("feature_definition_id") REFERENCES "public"."feature_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_tasks" ADD CONSTRAINT "community_review_tasks_resolved_by_admin_id_admin_users_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_tasks" ADD CONSTRAINT "community_review_tasks_superseded_by_fk" FOREIGN KEY ("superseded_by_task_id") REFERENCES "public"."community_review_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_votes" ADD CONSTRAINT "community_review_votes_review_task_id_community_review_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."community_review_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_votes" ADD CONSTRAINT "community_review_votes_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_review_votes" ADD CONSTRAINT "community_review_votes_media_id_evidence_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."evidence_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_media" ADD CONSTRAINT "evidence_media_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_place_unit_id_place_units_id_fk" FOREIGN KEY ("place_unit_id") REFERENCES "public"."place_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_proofs" ADD CONSTRAINT "location_proofs_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_proofs" ADD CONSTRAINT "location_proofs_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_proofs" ADD CONSTRAINT "location_proofs_review_task_id_community_review_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."community_review_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_parts" ADD CONSTRAINT "media_upload_parts_upload_id_media_upload_sessions_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_completed_media_id_evidence_media_id_fk" FOREIGN KEY ("completed_media_id") REFERENCES "public"."evidence_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_media" ADD CONSTRAINT "observation_media_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_media" ADD CONSTRAINT "observation_media_media_id_evidence_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."evidence_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_place_unit_id_place_units_id_fk" FOREIGN KEY ("place_unit_id") REFERENCES "public"."place_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_feature_definition_id_feature_definitions_id_fk" FOREIGN KEY ("feature_definition_id") REFERENCES "public"."feature_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_units" ADD CONSTRAINT "place_units_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_merged_into_place_id_fk" FOREIGN KEY ("merged_into_place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_cards_v2" ADD CONSTRAINT "service_cards_v2_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_cards_v2" ADD CONSTRAINT "service_cards_v2_subtask_id_agent_subtasks_id_fk" FOREIGN KEY ("subtask_id") REFERENCES "public"."agent_subtasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles_v2" ADD CONSTRAINT "user_profiles_v2_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD CONSTRAINT "verification_records_v2_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD CONSTRAINT "verification_records_v2_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD CONSTRAINT "verification_records_v2_place_unit_id_place_units_id_fk" FOREIGN KEY ("place_unit_id") REFERENCES "public"."place_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_sessions_token" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_admin_sessions_user_expiry" ON "admin_sessions" USING btree ("admin_user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_users_username" ON "admin_users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_subtasks_task_key" ON "agent_subtasks" USING btree ("task_id","external_key");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_installation_status" ON "agent_tasks" USING btree ("installation_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_tasks_idempotency" ON "agent_tasks" USING btree ("installation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_audit_events_time_action" ON "audit_events" USING btree ("created_at","action");--> statement-breakpoint
CREATE INDEX "idx_community_review_tasks_status" ON "community_review_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_review_tasks_place" ON "community_review_tasks" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "idx_community_review_tasks_admin_queue" ON "community_review_tasks" USING btree ("status","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_community_review_votes_round_installation" ON "community_review_votes" USING btree ("review_task_id","installation_id");--> statement-breakpoint
CREATE INDEX "idx_evidence_media_owner_status" ON "evidence_media" USING btree ("installation_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_facilities_place" ON "facilities" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feature_definitions_key" ON "feature_definitions" USING btree ("feature_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_installation_accounts_guid" ON "installation_accounts" USING btree ("installation_guid");--> statement-breakpoint
CREATE INDEX "idx_installation_challenges_guid" ON "installation_challenges" USING btree ("installation_guid","expires_at");--> statement-breakpoint
CREATE INDEX "idx_location_proofs_owner_expiry" ON "location_proofs" USING btree ("installation_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_location_proofs_place" ON "location_proofs" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "idx_location_proofs_review_task" ON "location_proofs" USING btree ("review_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_media_upload_sessions_idempotency" ON "media_upload_sessions" USING btree ("installation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_media_upload_sessions_expiry" ON "media_upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_observations_place_feature" ON "observations" USING btree ("place_id","feature_definition_id","moderation_status","freshness_status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_place_units_place" ON "place_units" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_places_external" ON "places" USING btree ("external_source","external_id");--> statement-breakpoint
CREATE INDEX "idx_places_category" ON "places" USING btree ("category_code");--> statement-breakpoint
CREATE INDEX "idx_places_status" ON "places" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_places_merged_target" ON "places" USING btree ("merged_into_place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_link_configs_capability" ON "platform_link_configs" USING btree ("platform","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refresh_sessions_token_hash" ON "refresh_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_refresh_sessions_installation" ON "refresh_sessions" USING btree ("installation_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_service_cards_v2_task" ON "service_cards_v2" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_events_task_cursor" ON "task_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_profiles_v2_installation" ON "user_profiles_v2" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_verification_records_v2_owner" ON "verification_records_v2" USING btree ("installation_id","created_at");
--> statement-breakpoint
INSERT INTO "feature_definitions" ("feature_key", "display_name", "value_type", "unit", "target_types") VALUES
  ('entrance.step_free', '入口无台阶', 'boolean', NULL, '["place","place_unit"]'),
  ('entrance.door_clear_width_cm', '入口净门宽', 'number', 'cm', '["place","place_unit"]'),
  ('path.minimum_clear_width_cm', '通道最小净宽', 'number', 'cm', '["place","place_unit"]'),
  ('ramp.present', '坡道存在', 'boolean', NULL, '["place","facility"]'),
  ('ramp.slope_percent', '坡道坡度', 'number', '%', '["facility"]'),
  ('elevator.available', '电梯可用', 'boolean', NULL, '["place","facility"]'),
  ('restroom.accessible', '无障碍卫生间', 'boolean', NULL, '["place","place_unit","facility"]'),
  ('bathroom.roll_in_shower', '平地淋浴', 'boolean', NULL, '["place_unit","facility"]'),
  ('bathroom.grab_bars', '浴室安全扶手', 'boolean', NULL, '["place_unit","facility"]'),
  ('route.segment_obstacle', '路线段障碍', 'string', NULL, '["place","facility"]')
ON CONFLICT ("feature_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "platform_link_configs" ("platform", "capability", "mode", "app_uri_template", "web_url_template", "allowed_hosts", "verified_at", "enabled") VALUES
  ('amap', 'route_view', 'app_uri', 'amapuri://route/plan/', 'https://uri.amap.com/navigation', '["uri.amap.com"]', NOW(), true),
  ('railway12306', 'special_passenger_info', 'web', NULL, 'https://kyfw.12306.cn/otn/view/icentre_qxyyInfo.html', '["kyfw.12306.cn"]', NOW(), true),
  ('didi', 'ride_booking', 'unavailable', NULL, NULL, '[]', NOW(), false),
  ('ctrip', 'hotel_search', 'web', NULL, 'https://m.ctrip.com/webapp/hotels/', '["m.ctrip.com"]', NOW(), true),
  ('meituan', 'place_search', 'web', NULL, 'https://i.meituan.com/', '["i.meituan.com"]', NOW(), true)
ON CONFLICT ("platform", "capability") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid,
	"feedback_type" varchar(32) NOT NULL,
	"source_type" varchar(24) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" uuid NOT NULL,
	"message" text NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"resolution_reason" text,
	"created_by_admin_id" uuid,
	"resolved_by_admin_id" uuid,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_feedback_type" CHECK ("user_feedback"."feedback_type" IN ('appeal', 'supplement_request', 'correction', 'withdrawal')),
	CONSTRAINT "chk_user_feedback_source" CHECK ("user_feedback"."source_type" IN ('installation', 'admin')),
	CONSTRAINT "chk_user_feedback_status" CHECK ("user_feedback"."status" IN ('open', 'in_review', 'resolved', 'rejected', 'withdrawn')),
	CONSTRAINT "chk_user_feedback_active_expiry" CHECK ("user_feedback"."feedback_type" NOT IN ('appeal', 'supplement_request') OR "user_feedback"."status" NOT IN ('open', 'in_review') OR "user_feedback"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "moderation_reason" text;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "moderation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "appeal_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "location_proof_passed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "location_distance_bucket" varchar(24);--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "location_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD COLUMN "admin_review_status" varchar(24) DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD COLUMN "admin_review_reason" text;--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD COLUMN "admin_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_installation_id_installation_accounts_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_resolved_by_admin_id_admin_users_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_feedback_queue" ON "user_feedback" USING btree ("feedback_type","target_type","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_user_feedback_target" ON "user_feedback" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_feedback_expiry" ON "user_feedback" USING btree ("feedback_type","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_feedback_active" ON "user_feedback" USING btree ("installation_id","feedback_type","target_type","target_id") WHERE "user_feedback"."status" IN ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "idx_observations_moderation_queue" ON "observations" USING btree ("moderation_status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_verification_records_v2_admin_review" ON "verification_records_v2" USING btree ("admin_review_status","created_at");--> statement-breakpoint
CREATE INDEX "idx_verification_records_v2_place" ON "verification_records_v2" USING btree ("place_id");--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "chk_observation_moderation_status" CHECK ("observations"."moderation_status" IN ('pending', 'approved', 'rejected', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "verification_records_v2" ADD CONSTRAINT "chk_verification_admin_review_status" CHECK ("verification_records_v2"."admin_review_status" IN ('unreviewed', 'confirmed', 'flagged'));
--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "chk_places_status" CHECK ("places"."status" IN ('active', 'disabled', 'merged'));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "chk_places_merge_target" CHECK (("places"."status" = 'merged' AND "places"."merged_into_place_id" IS NOT NULL) OR ("places"."status" <> 'merged' AND "places"."merged_into_place_id" IS NULL));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "chk_places_not_self_merged" CHECK ("places"."merged_into_place_id" IS NULL OR "places"."merged_into_place_id" <> "places"."id");
