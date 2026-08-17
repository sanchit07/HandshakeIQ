CREATE TABLE IF NOT EXISTS "applications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_match_id" varchar NOT NULL,
	"channel" varchar NOT NULL,
	"state" varchar DEFAULT 'queued' NOT NULL,
	"apply_url" text,
	"ats_type" varchar,
	"route_source" varchar,
	"route_confidence" varchar,
	"email_to" varchar,
	"email_to_status" varchar,
	"email_subject" text,
	"email_body" text,
	"packet" jsonb,
	"step_log" jsonb DEFAULT '[]'::jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_reason" text,
	"needs_user_reason" text,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_profile" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar,
	"email" varchar,
	"phone" varchar,
	"address_line" varchar,
	"city" varchar,
	"country" varchar,
	"linkedin_url" text,
	"github_url" text,
	"portfolio_url" text,
	"notice_period" varchar,
	"languages" text,
	"country_auth" jsonb DEFAULT '[]'::jsonb,
	"eeo_answers" jsonb DEFAULT '{}'::jsonb,
	"screening_answers" jsonb DEFAULT '[]'::jsonb,
	"channel_modes" jsonb DEFAULT '{}'::jsonb,
	"seeded_from_resume" boolean DEFAULT false,
	"confirmed_at" timestamp,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_match_id" varchar NOT NULL,
	"contact_role" varchar NOT NULL,
	"full_name" varchar NOT NULL,
	"title" varchar,
	"linkedin_url" text,
	"evidence_url" text,
	"evidence_note" text,
	"email" varchar,
	"email_source" varchar,
	"email_status" varchar DEFAULT 'not_found' NOT NULL,
	"evidence_status" varchar DEFAULT 'ok' NOT NULL,
	"checked_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_matches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_date" varchar NOT NULL,
	"rank" integer NOT NULL,
	"title" varchar NOT NULL,
	"company" varchar NOT NULL,
	"location" varchar,
	"country" varchar,
	"source" varchar,
	"url" text,
	"description" text,
	"match_score" integer,
	"match_reason" text,
	"tailored_cv" text,
	"cv_variant" varchar,
	"status" varchar DEFAULT 'shortlisted' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_questions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_match_id" varchar NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"created_at" timestamp DEFAULT now(),
	"answered_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_job_match_id_job_matches_id_fk') THEN
  ALTER TABLE "applications" ADD CONSTRAINT "applications_job_match_id_job_matches_id_fk" FOREIGN KEY ("job_match_id") REFERENCES "public"."job_matches"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_contacts_job_match_id_job_matches_id_fk') THEN
  ALTER TABLE "job_contacts" ADD CONSTRAINT "job_contacts_job_match_id_job_matches_id_fk" FOREIGN KEY ("job_match_id") REFERENCES "public"."job_matches"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_questions_job_match_id_job_matches_id_fk') THEN
  ALTER TABLE "job_questions" ADD CONSTRAINT "job_questions_job_match_id_job_matches_id_fk" FOREIGN KEY ("job_match_id") REFERENCES "public"."job_matches"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_applications_match" ON "applications" USING btree ("job_match_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_applications_state" ON "applications" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_applications_active_per_job" ON "applications" USING btree ("job_match_id") WHERE state != 'submitted';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_contacts_match" ON "job_contacts" USING btree ("job_match_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_matches_run_date" ON "job_matches" USING btree ("run_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_matches_run_date_rank" ON "job_matches" USING btree ("run_date","rank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_questions_match" ON "job_questions" USING btree ("job_match_id");