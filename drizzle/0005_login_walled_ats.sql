-- Phase 3: login-walled ATSs (Workday-class), credential vault, guard-rails
CREATE TABLE IF NOT EXISTS "ats_credentials" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company" varchar NOT NULL,
  "ats_type" varchar NOT NULL,
  "portal_domain" varchar NOT NULL,
  "portal_url" text NOT NULL,
  "email" varchar NOT NULL,
  "password_enc" text NOT NULL,
  "status" varchar DEFAULT 'created' NOT NULL,
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "last_used_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ats_credentials_domain" ON "ats_credentials" ("portal_domain");

CREATE TABLE IF NOT EXISTS "domain_controls" (
  "domain" varchar PRIMARY KEY NOT NULL,
  "block_count" integer DEFAULT 0 NOT NULL,
  "last_block_at" timestamp,
  "last_run_at" timestamp,
  "cooldown_until" timestamp,
  "downgraded" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp DEFAULT now()
);
