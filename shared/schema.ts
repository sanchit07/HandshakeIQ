import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
} from "drizzle-orm/pg-core";

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Dossiers - saved intelligence reports on people
export const dossiers = pgTable("dossiers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  personName: varchar("person_name").notNull(),
  personTitle: varchar("person_title"),
  personCompany: varchar("person_company"),
  personEmail: varchar("person_email"),
  personPhotoUrl: varchar("person_photo_url"),
  intelligenceReport: jsonb("intelligence_report"),
  sources: jsonb("sources"),
  socialMediaLinks: jsonb("social_media_links"),
  searchQuery: text("search_query"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_dossiers_user_id").on(table.userId),
]);

// Notes - user notes on dossiers
export const notes = pgTable("notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dossierId: varchar("dossier_id").notNull().references(() => dossiers.id, { onDelete: 'cascade' }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_notes_dossier_id").on(table.dossierId),
]);

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type Dossier = typeof dossiers.$inferSelect;
export type UpsertDossier = typeof dossiers.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type UpsertNote = typeof notes.$inferInsert;
