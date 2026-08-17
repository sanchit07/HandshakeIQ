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
  evidenceStatus: varchar("evidence_status").notNull().default("ok"), // ok | stale (evidence page no longer reachable)
  checkedAt: timestamp("checked_at").defaultNow(),
}, (table) => [
  index("idx_job_contacts_match").on(table.jobMatchId),
]);

export type JobContact = typeof jobContacts.$inferSelect;

// ── Auto-apply engine ────────────────────────────────────────────────────────

/**
 * Candidate profile vault — single-row table (single-user app) holding every
 * answer an application form can ask for. Sensitive answers (visa/sponsorship,
 * EEO) are EXPLICITLY user-entered: the apply engine refuses to answer any
 * sensitive question not present here — it pauses (needs_user) instead of guessing.
 */
export const candidateProfile = pgTable("candidate_profile", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fullName: varchar("full_name"),
  email: varchar("email"),
  phone: varchar("phone"),
  addressLine: varchar("address_line"),
  city: varchar("city"),
  country: varchar("country"),
  linkedinUrl: text("linkedin_url"),
  githubUrl: text("github_url"),
  portfolioUrl: text("portfolio_url"),
  noticePeriod: varchar("notice_period"),
  languages: text("languages"), // comma-separated, e.g. "English (fluent), Hindi (native)"
  // Per-country work-authorization records, user-entered only:
  // [{ country, rightToWork: 'citizen'|'permanent_resident'|'work_visa'|'needs_sponsorship'|'none',
  //    visaDetails, needsSponsorship: boolean, salaryExpectation, relocationWilling: boolean, notes }]
  countryAuth: jsonb("country_auth").$type<CountryAuthRecord[]>().default([]),
  // EEO / demographic answers (user-entered; empty = engine must not answer)
  eeoAnswers: jsonb("eeo_answers").$type<Record<string, string>>().default({}),
  // Standard screening Q&A: [{ question, answer }]
  screeningAnswers: jsonb("screening_answers").$type<{ question: string; answer: string }[]>().default([]),
  // Per-channel submit mode: { email: 'review'|'auto' } — default review-before-submit
  channelModes: jsonb("channel_modes").$type<Record<string, 'review' | 'auto'>>().default({}),
  seededFromResume: boolean("seeded_from_resume").default(false),
  confirmedAt: timestamp("confirmed_at"), // user confirmed seeded basics
  updatedAt: timestamp("updated_at").defaultNow(),
});

export interface CountryAuthRecord {
  country: string;
  rightToWork: 'citizen' | 'permanent_resident' | 'work_visa' | 'needs_sponsorship' | 'none';
  visaDetails?: string;
  needsSponsorship: boolean;
  salaryExpectation?: string;
  relocationWilling?: boolean;
  notes?: string;
}

export type CandidateProfile = typeof candidateProfile.$inferSelect;
export type UpsertCandidateProfile = typeof candidateProfile.$inferInsert;

/**
 * Application attempts — one row per apply attempt per channel, with a strict
 * state machine and a per-step JSON log. Nothing fails silently: failed and
 * needs_user states carry a reason and surface in the UI.
 *
 * States: queued → route_resolved → ready_for_review → approved → submitting
 *         → submitted | needs_user | failed
 */
export const applications = pgTable("applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobMatchId: varchar("job_match_id").notNull().references(() => jobMatches.id, { onDelete: "cascade" }),
  channel: varchar("channel").notNull(), // email | assisted | ats_auto (phase 2+)
  state: varchar("state").notNull().default("queued"),
  // Resolved apply route
  applyUrl: text("apply_url"),
  atsType: varchar("ats_type"), // greenhouse | lever | ashby | smartrecruiters | workday | icims | taleo | successfactors | workable | bamboohr | jobvite | email | unknown
  routeSource: varchar("route_source"), // official | source_fallback
  routeConfidence: varchar("route_confidence"), // high | medium | low
  // Email channel fields
  emailTo: varchar("email_to"),
  emailToStatus: varchar("email_to_status"), // verified | listed_in_posting | unverified
  emailSubject: text("email_subject"),
  emailBody: text("email_body"),
  // Assisted-apply packet: { applyUrl, answers: [{label, value, source}], coverNote }
  packet: jsonb("packet"),
  stepLog: jsonb("step_log").$type<{ ts: string; step: string; detail?: string }[]>().default([]),
  attemptCount: integer("attempt_count").notNull().default(0),
  errorReason: text("error_reason"),
  needsUserReason: text("needs_user_reason"),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_applications_match").on(table.jobMatchId),
  index("idx_applications_state").on(table.state),
  // One ACTIVE application per job: prevents concurrent prepare requests from
  // creating duplicate in-flight rows (terminal submitted rows are history and exempt).
  uniqueIndex("uq_applications_active_per_job").on(table.jobMatchId).where(sql`state NOT IN ('submitted', 'submitted_unconfirmed')`),
]);

/**
 * Screenshots captured by the headless ATS submitter (pre-submit review shot,
 * post-submit confirmation shot, failure/CAPTCHA evidence). Stored in the DB
 * (base64 JPEG) because the deployment filesystem is ephemeral.
 */
export const applicationScreenshots = pgTable("application_screenshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  kind: varchar("kind").notNull(), // pre_submit | confirmation | failure
  mime: varchar("mime").notNull().default("image/jpeg"),
  dataBase64: text("data_base64").notNull(),
  pageUrl: text("page_url"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_app_screenshots_app").on(table.applicationId),
]);

export type ApplicationScreenshot = typeof applicationScreenshots.$inferSelect;

/**
 * Per-company ATS account credential vault. Every account the automation
 * creates on a login-walled ATS (Workday, iCIMS, Taleo, SuccessFactors) is
 * recorded here BEFORE the signup form is submitted, so the user can always
 * log in themselves. Passwords are AES-256-GCM encrypted at rest.
 */
export const atsCredentials = pgTable("ats_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  company: varchar("company").notNull(),
  atsType: varchar("ats_type").notNull(), // workday | icims | taleo | successfactors | other
  portalDomain: varchar("portal_domain").notNull(), // e.g. acme.wd3.myworkdayjobs.com
  portalUrl: text("portal_url").notNull(),
  email: varchar("email").notNull(),
  passwordEnc: text("password_enc").notNull(), // AES-256-GCM: iv.tag.ciphertext (base64)
  status: varchar("status").notNull().default("created"), // created | verified | login_failed
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
}, (table) => [
  uniqueIndex("uq_ats_credentials_domain").on(table.portalDomain),
]);

export type AtsCredential = typeof atsCredentials.$inferSelect;

/**
 * Per-domain ban-risk guard-rails: cooldowns between automated sessions,
 * block counting (CAPTCHA walls, bot blocks, login failures), and automatic
 * downgrade to assisted mode after repeated blocks from one domain.
 */
export const domainControls = pgTable("domain_controls", {
  domain: varchar("domain").primaryKey(),
  blockCount: integer("block_count").notNull().default(0),
  lastBlockAt: timestamp("last_block_at"),
  lastRunAt: timestamp("last_run_at"),
  cooldownUntil: timestamp("cooldown_until"),
  downgraded: boolean("downgraded").notNull().default(false), // true → assisted mode only
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type DomainControl = typeof domainControls.$inferSelect;

// Live CAPTCHA hand-off sessions. DB-mediated so any replica can serve the
// remote view (frames, inputs, resolution) while the replica that owns the
// Playwright page pumps frames out and drains inputs in.
export const handoffSessions = pgTable("handoff_sessions", {
  id: varchar("id").primaryKey(),
  applicationId: varchar("application_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"), // open | solved | aborted | timeout
  frameB64: text("frame_b64"), // latest JPEG frame, base64 (owner-written)
  frameAt: timestamp("frame_at"),
  inputQueue: jsonb("input_queue").notNull().default(sql`'[]'::jsonb`), // pending user input events
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (t) => [index("handoff_sessions_app_idx").on(t.applicationId)]);

export type HandoffSessionRow = typeof handoffSessions.$inferSelect;

export type Application = typeof applications.$inferSelect;
export type UpsertApplication = typeof applications.$inferInsert;

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type Dossier = typeof dossiers.$inferSelect;
export type UpsertDossier = typeof dossiers.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type UpsertNote = typeof notes.$inferInsert;
export type SearchHistory = typeof searchHistory.$inferSelect;
export type UpsertSearchHistory = typeof searchHistory.$inferInsert;
