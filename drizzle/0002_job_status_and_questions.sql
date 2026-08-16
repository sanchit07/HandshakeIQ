ALTER TABLE "job_matches" ADD COLUMN "status" varchar DEFAULT 'shortlisted' NOT NULL;--> statement-breakpoint
CREATE TABLE "job_questions" (
"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"job_match_id" varchar NOT NULL,
"question" text NOT NULL,
"answer" text,
"created_at" timestamp DEFAULT now(),
"answered_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "job_questions" ADD CONSTRAINT "job_questions_job_match_id_job_matches_id_fk" FOREIGN KEY ("job_match_id") REFERENCES "public"."job_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_job_questions_match" ON "job_questions" USING btree ("job_match_id");
