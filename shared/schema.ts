import { sql } from 'drizzle-orm';
import {
  index,
  uniqueIndex,
  integer,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
  boolean,
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
  passwordHash: varchar("password_hash"),
  isAdmin: boolean("is_admin").default(false),
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

// Search History - tracks all person searches for quick lookups and exact matching
export const searchHistory = pgTable("search_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: 'cascade' }),
  personName: varchar("person_name").notNull(),
  personCompany: varchar("person_company"),
  personTitle: varchar("person_title"),
  personPhotoUrl: varchar("person_photo_url"),
  intelligenceReport: jsonb("intelligence_report"),
  sources: jsonb("sources"),
  socialMediaLinks: jsonb("social_media_links"),
  searchedAt: timestamp("searched_at").defaultNow(),
}, (table) => [
  index("idx_search_history_user_id").on(table.userId),
  index("idx_search_history_person_name").on(table.personName),
  index("idx_search_history_searched_at").on(table.searchedAt),
]);

// Daily shortlisted job opportunities matched against the candidate profile
export const jobMatches = pgTable("job_matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runDate: varchar("run_date").notNull(), // YYYY-MM-DD (Asia/Kuala_Lumpur)
  rank: integer("rank").notNull(),
  title: varchar("title").notNull(),
  company: varchar("company").notNull(),
  location: varchar("location"),
  country: varchar("country"),
  source: varchar("source"), // job board the posting was found on
  url: text("url"),
  description: text("description"),
  matchScore: integer("match_score"), // 0-100
  matchReason: text("match_reason"),
  tailoredCv: text("tailored_cv"), // generated on demand
  cvVariant: varchar("cv_variant"), // which base CV was used for tailoring (role→CV mapping)
  status: varchar("status").notNull().default("shortlisted"), // shortlisted | cv_ready | cv_failed
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_job_matches_run_date").on(table.runDate),
  uniqueIndex("uq_job_matches_run_date_rank").on(table.runDate, table.rank),
]);

export type JobMatch = typeof jobMatches.$inferSelect;
export type UpsertJobMatch = typeof jobMatches.$inferInsert;

// Questions the AI needs the admin to answer for a specific opportunity.
// Answered questions become "learnings" injected into future prompts so
// the number of questions trends toward zero over time.
export const jobQuestions = pgTable("job_questions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobMatchId: varchar("job_match_id").notNull().references(() => jobMatches.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer"),
  createdAt: timestamp("created_at").defaultNow(),
  answeredAt: timestamp("answered_at"),
}, (table) => [
  index("idx_job_questions_match").on(table.jobMatchId),
]);

export type JobQuestion = typeof jobQuestions.$inferSelect;

// Discovered HR / hiring-manager contacts for a job match. Every row carries
// its provenance (source URL confirming the person currently holds the role)
// and an email verification status — unverified data is stored but clearly
// labeled, never silently presented as fact.
export const jobContacts = pgTable("job_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobMatchId: varchar("job_match_id").notNull().references(() => jobMatches.id, { onDelete: "cascade" }),
  contactRole: varchar("contact_role").notNull(), // hr | hiring_manager | department_head
  fullName: varchar("full_name").notNull(),
  title: varchar("title"),
  linkedinUrl: text("linkedin_url"),
  evidenceUrl: text("evidence_url"), // public source confirming current role
  evidenceNote: text("evidence_note"),
  email: varchar("email"),
  emailSource: varchar("email_source"), // job_posting | explorium | none
  emailStatus: varchar("email_status").notNull().default("not_found"), // verified | unverified | listed_in_posting | not_found
  checkedAt: timestamp("checked_at").defaultNow(),
}, (table) => [
  index("idx_job_contacts_match").on(table.jobMatchId),
]);

export type JobContact = typeof jobContacts.$inferSelect;

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type Dossier = typeof dossiers.$inferSelect;
export type UpsertDossier = typeof dossiers.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type UpsertNote = typeof notes.$inferInsert;
export type SearchHistory = typeof searchHistory.$inferSelect;
export type UpsertSearchHistory = typeof searchHistory.$inferInsert;
