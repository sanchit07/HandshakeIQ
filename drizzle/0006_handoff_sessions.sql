-- Live CAPTCHA hand-off sessions: DB-mediated so any replica can serve the
-- remote view while the browser-owning replica pumps frames and drains inputs.
CREATE TABLE IF NOT EXISTS "handoff_sessions" (
  "id" varchar PRIMARY KEY,
  "application_id" varchar NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "frame_b64" text,
  "frame_at" timestamp,
  "input_queue" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "handoff_sessions_app_idx" ON "handoff_sessions" ("application_id");
