-- Headless ATS submitter (Phase 2): screenshots table + terminal
-- submitted_unconfirmed state exempted from the one-active-app-per-job index.
CREATE TABLE IF NOT EXISTS "application_screenshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" varchar NOT NULL,
	"kind" varchar NOT NULL,
	"mime" varchar DEFAULT 'image/jpeg' NOT NULL,
	"data_base64" text NOT NULL,
	"page_url" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_screenshots" ADD CONSTRAINT "application_screenshots_application_id_applications_id_fk"
  FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_screenshots_app" ON "application_screenshots" USING btree ("application_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_applications_active_per_job";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_applications_active_per_job" ON "applications" USING btree ("job_match_id") WHERE state NOT IN ('submitted', 'submitted_unconfirmed');
