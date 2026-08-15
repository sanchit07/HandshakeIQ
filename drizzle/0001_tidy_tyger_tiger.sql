CREATE TABLE "search_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"person_name" varchar NOT NULL,
	"person_company" varchar,
	"person_title" varchar,
	"person_photo_url" varchar,
	"intelligence_report" jsonb,
	"sources" jsonb,
	"social_media_links" jsonb,
	"searched_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_search_history_user_id" ON "search_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_search_history_person_name" ON "search_history" USING btree ("person_name");--> statement-breakpoint
CREATE INDEX "idx_search_history_searched_at" ON "search_history" USING btree ("searched_at");