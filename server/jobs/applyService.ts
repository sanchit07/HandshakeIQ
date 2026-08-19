/**
 * Auto-apply engine foundation (Phase 1 — no browser automation).
 *
 * Design principles (from the auto-apply research benchmark):
 *  1. NOTHING fails silently — every attempt is a row in `applications` with a
 *     strict state machine and per-step log; failures carry a reason.
 *  2. Sensitive answers (visa/sponsorship/EEO) are NEVER guessed — they come
 *     only from the user-entered profile vault. Missing answer = needs_user.
 *  3. Review-before-submit is the default mode for every channel.
 *  4. Dead-post protection: the apply route is liveness-verified before any
 *     application is prepared.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import {
  applications, candidateProfile, jobMatches, jobContacts,
  type Application, type CandidateProfile, type CountryAuthRecord, type JobMatch,
} from '../../shared/schema.js';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { probeUrlLive } from './jobMatchService.js';

const MODEL = 'claude-sonnet-4-5';

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
  return new Anthropic({ apiKey, timeout: 5 * 60 * 1000, maxRetries: 1 });
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseJsonLoose(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const os = trimmed.indexOf('{');
  const oe = trimmed.lastIndexOf('}');
  if (os !== -1 && oe > os) return JSON.parse(trimmed.slice(os, oe + 1));
  throw new Error('No JSON found in response');
}

// ── State machine ────────────────────────────────────────────────────────────

export type ApplicationState =
  | 'queued' | 'route_resolved' | 'ready_for_review' | 'approved'
  | 'submitting' | 'submitted' | 'submitted_unconfirmed' | 'needs_user' | 'failed';

/** Allowed transitions. needs_user and failed are recoverable (back to queued via retry). */
export const ALLOWED_TRANSITIONS: Record<ApplicationState, ApplicationState[]> = {
  queued: ['route_resolved', 'needs_user', 'failed'],
  route_resolved: ['ready_for_review', 'needs_user', 'failed'],
  ready_for_review: ['approved', 'needs_user', 'failed'],
  approved: ['submitting', 'needs_user', 'failed'],
  // submitted_unconfirmed: the ATS form was submitted but no confirmation
  // message was detected — terminal, with a screenshot as evidence.
  submitting: ['submitted', 'submitted_unconfirmed', 'needs_user', 'failed'],
  submitted: [],
  submitted_unconfirmed: [],
  needs_user: ['queued', 'ready_for_review'],
  failed: ['queued'],
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Append a step-log entry and move the application to a new state (validated). */
export async function transitionApplication(
  appId: string,
  to: ApplicationState,
  step: string,
  detail?: string,
  extra?: Partial<typeof applications.$inferInsert>,
): Promise<Application> {
  const [app] = await db.select().from(applications).where(eq(applications.id, appId));
  if (!app) throw new Error('Application not found');
  const from = app.state as ApplicationState;
  if (from !== to && !canTransition(from, to)) {
    throw new Error(`Invalid application state transition: ${from} → ${to}`);
  }
  const log = [...(app.stepLog ?? []), { ts: new Date().toISOString(), step, ...(detail ? { detail } : {}) }];
  // Compare-and-set: the update only applies if the row is still in the state
  // we read. A concurrent request that already advanced the row makes this
  // return zero rows — we fail loudly instead of double-transitioning
  // (e.g. two approvals racing would otherwise send duplicate emails).
  const updated = await db.update(applications)
    .set({
      state: to,
      stepLog: log,
      updatedAt: new Date(),
      ...(to === 'submitted' || to === 'submitted_unconfirmed' ? { submittedAt: new Date() } : {}),
      ...(extra ?? {}),
    })
    .where(sql`${applications.id} = ${appId} AND ${applications.state} = ${from}`)
    .returning();
  if (updated.length === 0) {
    throw new Error(`Application state changed concurrently (expected ${from}); refresh and retry.`);
  }
  console.log(`[APPLY] ${appId.slice(0, 8)} ${from} → ${to}: ${step}${detail ? ` (${detail})` : ''}`);
  return updated[0];
}

// ── ATS classification (pure, testable) ──────────────────────────────────────

const ATS_PATTERNS: Array<[RegExp, string]> = [
  [/greenhouse\.io/i, 'greenhouse'],
  [/lever\.co/i, 'lever'],
  [/ashbyhq\.com/i, 'ashby'],
  [/smartrecruiters\.com/i, 'smartrecruiters'],
  [/myworkdayjobs\.com|workday/i, 'workday'],
  [/icims\.com/i, 'icims'],
  [/taleo\.net|oraclecloud\.com/i, 'taleo'],
  [/successfactors\.(com|eu)|sapsf/i, 'successfactors'],
  [/workable\.com/i, 'workable'],
  [/bamboohr\.com/i, 'bamboohr'],
  [/jobvite\.com/i, 'jobvite'],
];

/** True only for a parseable http:// or https:// URL — anything else can't be liveness-probed and must never become an apply route. */
/**
 * Carry user-supplied continuation state from a prior packet into a freshly
 * rebuilt one. A pasted verification link must survive the rebuild that
 * prepareApplication performs on every retry, or the login-walled signup flow
 * can never complete (and the run-gap bypass never triggers). Mutates and
 * returns `next`.
 */
export function preserveContinuation(prior: unknown, next: Record<string, any>): Record<string, any> {
  const link = (prior as any)?.verificationLink;
  if (typeof link === 'string' && link) next.verificationLink = link;
  return next;
}

export function isValidHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

export function classifyAtsFromUrl(url: string | null | undefined): string {
  if (!url) return 'unknown';
  for (const [re, ats] of ATS_PATTERNS) {
    if (re.test(url)) return ats;
  }
  return 'unknown';
}

// ── Profile vault ────────────────────────────────────────────────────────────

/** Fields the engine treats as sensitive: never AI-answered, only vault-sourced. */
export const SENSITIVE_FIELDS = ['rightToWork', 'needsSponsorship', 'visaDetails', 'eeoAnswers'] as const;

export async function getProfile(): Promise<CandidateProfile | null> {
  const rows = await db.select().from(candidateProfile).limit(1);
  return rows[0] ?? null;
}

const ALLOWED_RIGHT_TO_WORK = new Set(['citizen', 'permanent_resident', 'work_visa', 'needs_sponsorship', 'none']);

export function validateCountryAuth(records: unknown): CountryAuthRecord[] {
  if (!Array.isArray(records)) return [];
  return records
    .filter((r: any) => r && typeof r.country === 'string' && r.country.trim()
      && typeof r.rightToWork === 'string' && ALLOWED_RIGHT_TO_WORK.has(r.rightToWork)
      && typeof r.needsSponsorship === 'boolean')
    .map((r: any) => ({
      country: String(r.country).trim(),
      rightToWork: r.rightToWork,
      visaDetails: r.visaDetails ? String(r.visaDetails).slice(0, 500) : undefined,
      needsSponsorship: r.needsSponsorship,
      salaryExpectation: r.salaryExpectation ? String(r.salaryExpectation).slice(0, 200) : undefined,
      relocationWilling: typeof r.relocationWilling === 'boolean' ? r.relocationWilling : undefined,
      notes: r.notes ? String(r.notes).slice(0, 1000) : undefined,
    }));
}

export async function saveProfile(input: Partial<typeof candidateProfile.$inferInsert>): Promise<CandidateProfile> {
  const clean: Partial<typeof candidateProfile.$inferInsert> = {
    fullName: input.fullName?.toString().slice(0, 200),
    email: input.email?.toString().slice(0, 200),
    phone: input.phone?.toString().slice(0, 50),
    addressLine: input.addressLine?.toString().slice(0, 300),
    city: input.city?.toString().slice(0, 100),
    country: input.country?.toString().slice(0, 100),
    linkedinUrl: input.linkedinUrl?.toString().slice(0, 500),
    githubUrl: input.githubUrl?.toString().slice(0, 500),
    portfolioUrl: input.portfolioUrl?.toString().slice(0, 500),
    noticePeriod: input.noticePeriod?.toString().slice(0, 200),
    languages: input.languages?.toString().slice(0, 1000),
    countryAuth: validateCountryAuth(input.countryAuth),
    eeoAnswers: (input.eeoAnswers && typeof input.eeoAnswers === 'object') ? input.eeoAnswers as Record<string, string> : {},
    screeningAnswers: Array.isArray(input.screeningAnswers)
      ? (input.screeningAnswers as any[])
          .filter((s) => s && typeof s.question === 'string' && typeof s.answer === 'string')
          .map((s) => ({ question: s.question.slice(0, 500), answer: s.answer.slice(0, 2000) }))
      : [],
    channelModes: (input.channelModes && typeof input.channelModes === 'object')
      ? Object.fromEntries(Object.entries(input.channelModes as Record<string, string>)
          .filter(([, v]) => v === 'review' || v === 'auto')) as Record<string, 'review' | 'auto'>
      : {},
    confirmedAt: new Date(),
    updatedAt: new Date(),
  };
  const existing = await getProfile();
  if (existing) {
    const [row] = await db.update(candidateProfile).set(clean).where(eq(candidateProfile.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(candidateProfile).values(clean).returning();
  return row;
}

/**
 * Seed personal basics from the resume text files (deterministic extraction,
 * no AI) for user confirmation. Only fills fields that are currently empty.
 */
export async function seedProfileFromResume(): Promise<CandidateProfile> {
  const resumePath = path.join(process.cwd(), 'server', 'jobs', 'resumes', 'general.txt');
  const text = fs.existsSync(resumePath) ? fs.readFileSync(resumePath, 'utf-8') : '';
  const lines = text.split('\n').slice(0, 10);
  const emailMatch = text.match(/Email:\s*([^\s|]+@[^\s|]+)/i);
  const phoneMatch = text.match(/Phone:\s*([+\d][\d\s()-]{6,20})/i);
  const linkedinMatch = text.match(/LinkedIn:\s*(https?:\/\/\S+)/i);
  const githubMatch = text.match(/Github:\s*(https?:\/\/\S+)/i);
  const locationMatch = text.match(/Location:\s*([^|\n]+)/i);
  const name = lines[0]?.trim() || '';

  const existing = await getProfile();
  const seed: Partial<typeof candidateProfile.$inferInsert> = {
    fullName: existing?.fullName || name || undefined,
    email: existing?.email || emailMatch?.[1]?.trim(),
    phone: existing?.phone || phoneMatch?.[1]?.trim(),
    linkedinUrl: existing?.linkedinUrl || linkedinMatch?.[1]?.trim(),
    githubUrl: existing?.githubUrl || githubMatch?.[1]?.trim(),
    city: existing?.city || locationMatch?.[1]?.trim().split(',')[0]?.trim(),
    country: existing?.country || locationMatch?.[1]?.trim().split(',')[1]?.trim(),
    seededFromResume: true,
    updatedAt: new Date(),
  };
  if (existing) {
    const [row] = await db.update(candidateProfile).set(seed).where(eq(candidateProfile.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(candidateProfile).values(seed).returning();
  return row;
}

/** Returns the vault's work-auth record for a country (case-insensitive), or null. */
export function findCountryAuth(profile: CandidateProfile | null, country: string | null | undefined): CountryAuthRecord | null {
  if (!profile || !country) return null;
  const recs = profile.countryAuth ?? [];
  return recs.find((r) => r.country.toLowerCase() === country.toLowerCase()) ?? null;
}

// ── Apply-route resolver ─────────────────────────────────────────────────────

export interface ResolvedRoute {
  applyUrl: string;
  atsType: string;
  routeSource: 'official' | 'source_fallback';
  routeConfidence: 'high' | 'medium' | 'low';
  note: string;
}

/**
 * Finds the official company careers-page URL for a shortlisted job via Claude
 * web search, verifies it is live AND the same role (title/company/country),
 * and classifies the ATS. Falls back to the original source URL.
 */
export async function resolveApplyRoute(job: JobMatch): Promise<ResolvedRoute> {
  // The fallback (original posting URL) must ALSO be verified live before it
  // is ever presented as an apply route — a dead board URL must never be
  // marked route_resolved (this is exactly the dead-post failure mode the
  // engine exists to prevent).
  const buildFallback = async (note: string): Promise<ResolvedRoute> => {
    // probeUrlLive deliberately returns live:true for unparseable/non-HTTP(S)
    // URLs (it can't probe them) — so require a valid HTTP(S) URL up front.
    if (!job.url || !isValidHttpUrl(job.url)) {
      return { applyUrl: '', atsType: 'unknown', routeSource: 'source_fallback', routeConfidence: 'low', note: `${note} The posting has no valid HTTP(S) URL.` };
    }
    const probe = await probeUrlLive(job.url);
    if (!probe.live) {
      return { applyUrl: '', atsType: 'unknown', routeSource: 'source_fallback', routeConfidence: 'low', note: `${note} The original posting URL is no longer live — no verified apply route exists.` };
    }
    return { applyUrl: job.url, atsType: classifyAtsFromUrl(job.url), routeSource: 'source_fallback', routeConfidence: 'medium', note: `${note} Using the original posting URL (verified live).` };
  };

  let candidate: { url: string; confidence: string; reason: string } | null = null;
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 } as any],
      messages: [{
        role: 'user',
        content: `Find the OFFICIAL company careers-page posting for this job (the company's own careers site or its ATS — Greenhouse, Lever, Ashby, SmartRecruiters, Workday, iCIMS, Taleo, etc. — NOT a job board like LinkedIn/Indeed/Glassdoor/JobStreet).

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || ''} ${job.country || ''}
Known posting URL: ${job.url || 'n/a'}

RULES:
- The URL must be a DIRECT posting page for THIS EXACT role in THIS country — same title (or a trivially close variant) at ${job.company}${job.country ? ` in ${job.country}` : ''}. A careers landing page or search-results page does not count.
- Only return a URL you actually saw in search results. Never construct or guess URLs.
- If you cannot find the official posting, return null — that is a valid answer.

Respond ONLY with JSON: {"url": "https://..." | null, "confidence": "high"|"medium"|"low", "reason": "one sentence"}`,
      }],
    });
    const parsed = parseJsonLoose(extractText(response));
    if (parsed?.url && isValidHttpUrl(parsed.url)) {
      candidate = { url: parsed.url, confidence: parsed.confidence || 'low', reason: parsed.reason || '' };
    }
  } catch (e: any) {
    console.log(`[APPLY ROUTE] Official-page search failed for ${job.company}: ${e?.message}`);
  }

  if (candidate) {
    // Verify the candidate URL is live (reuses the pipeline's SSRF-safe probe)
    const probe = await probeUrlLive(candidate.url);
    if (probe.live) {
      return {
        applyUrl: candidate.url,
        atsType: classifyAtsFromUrl(candidate.url),
        routeSource: 'official',
        routeConfidence: (['high', 'medium', 'low'].includes(candidate.confidence) ? candidate.confidence : 'low') as any,
        note: `Official posting found: ${candidate.reason}`.slice(0, 500),
      };
    }
    console.log(`[APPLY ROUTE] Official candidate URL not live, falling back to source: ${candidate.url}`);
    return buildFallback('Official careers URL was found but is not reachable.');
  }
  return buildFallback('No official careers posting found.');
}

// ── Email channel ────────────────────────────────────────────────────────────

export interface ContactCandidate {
  email: string | null;
  emailStatus: string;
  evidenceStatus: string;
  fullName: string;
}

/**
 * Pure selection logic: a verified NAMED individual first — the point of
 * outreach is a genuine personalized note, not a mailbox alias just because
 * the posting happened to list one — falling back to the posting-listed
 * mailbox only when no named contact was found. Either way, a contact whose
 * public evidence page has gone stale (no longer confirms they hold the
 * role) is excluded outright, not just flagged for the admin.
 */
export function pickApplicationContact(contacts: ContactCandidate[]): { email: string; status: string; who: string } | null {
  const eligible = contacts.filter((c) => c.email && c.evidenceStatus !== 'stale');
  const verified = eligible.find((c) => c.emailStatus === 'verified');
  if (verified?.email) return { email: verified.email, status: 'verified', who: verified.fullName };
  const listed = eligible.find((c) => c.emailStatus === 'listed_in_posting');
  if (listed?.email) return { email: listed.email, status: 'listed_in_posting', who: listed.fullName };
  return null;
}

/** Best application email for a job — see pickApplicationContact for the selection policy. */
export async function findApplicationEmail(jobId: string): Promise<{ email: string; status: string; who: string } | null> {
  const contacts = await db.select().from(jobContacts).where(eq(jobContacts.jobMatchId, jobId));
  return pickApplicationContact(contacts);
}

/**
 * Minimum days between contacting the SAME email address for different jobs.
 * A recruiter or hiring manager who covers multiple roles/countries could
 * otherwise get several separate cold emails "from the same candidate" in
 * one week — the internal 90-day vacancy dedup and 28-day company cooldown
 * don't catch this, since they're keyed by job/company, not by who actually
 * gets emailed.
 */
export const EMAIL_CONTACT_COOLDOWN_DAYS = 21;

/** Application channel/states that represent a real (sent or about-to-be-sent) email contact. */
const EMAIL_CONTACT_STATES = ['ready_for_review', 'approved', 'submitting', 'submitted'] as const;

/**
 * True when `email` already has an email-channel application — sent, or
 * drafted and awaiting/undergoing approval — for a DIFFERENT job within the
 * cooldown window. Excludes the job being checked so re-preparing the SAME
 * job's own application never blocks itself.
 */
export async function wasContactRecentlyEmailed(email: string, excludeJobId: string, days = EMAIL_CONTACT_COOLDOWN_DAYS): Promise<boolean> {
  const rows = await db.select({ id: applications.id }).from(applications)
    .where(sql`lower(${applications.emailTo}) = lower(${email})
      AND ${applications.jobMatchId} != ${excludeJobId}
      AND ${applications.channel} = 'email'
      AND ${applications.state} IN ${EMAIL_CONTACT_STATES}
      AND ${applications.createdAt} > now() - interval '${sql.raw(String(days))} days'`);
  return rows.length > 0;
}

/**
 * Hard daily cap on outbound application emails sent through the connected
 * Gmail account — protects its sending reputation/deliverability. Mirrors
 * DAILY_ATS_SUBMIT_CAP's role for the browser-automation channel.
 */
export const DAILY_EMAIL_SEND_CAP = 15;

export async function countTodaysEmailSends(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(applications)
    .where(sql`${applications.channel} = 'email'
      AND ${applications.state} = 'submitted'
      AND ${applications.submittedAt} >= date_trunc('day', now())`);
  return rows[0]?.n ?? 0;
}

export async function draftApplicationEmail(job: JobMatch, profile: CandidateProfile, recipientName: string): Promise<{ subject: string; body: string }> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Draft a concise, professional job-application email (max 160 words). Plain text, no markdown. Truthful — only claims supported by the profile below. Simple English. The tailored CV is attached as a PDF.

ROLE: ${job.title} at ${job.company} (${job.location || ''} ${job.country || ''})
RECIPIENT: ${recipientName}
CANDIDATE: ${profile.fullName || 'the candidate'} — ${profile.email || ''} ${profile.phone || ''} ${profile.linkedinUrl || ''}
WHY THE ROLE FITS (from shortlisting): ${job.matchReason || 'n/a'}

Respond ONLY with JSON: {"subject": "...", "body": "..."} — body ends with a signature block (name, phone, LinkedIn).`,
    }],
  });
  const parsed = parseJsonLoose(extractText(response));
  if (!parsed?.subject || !parsed?.body) throw new Error('Email draft generation returned no subject/body');
  return { subject: String(parsed.subject).slice(0, 300), body: String(parsed.body).slice(0, 6000) };
}

// ── Assisted-apply packet ────────────────────────────────────────────────────

export interface PacketAnswer { label: string; value: string; source: 'vault' | 'cv' | 'missing' }
export interface AssistedPacket {
  applyUrl: string;
  answers: PacketAnswer[];
  coverNote: string | null;
  missing: string[];
  /** ats_auto only: hash binding user approval to the exact reviewed answers */
  reviewHash?: string;
}

/**
 * Builds the copy-paste-ready answer packet from the vault. Sensitive fields
 * missing from the vault are listed under `missing` — never guessed.
 */
export function buildPacketAnswers(profile: CandidateProfile | null, job: JobMatch): { answers: PacketAnswer[]; missing: string[] } {
  const answers: PacketAnswer[] = [];
  const missing: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) answers.push({ label, value, source: 'vault' });
    else missing.push(label);
  };
  add('Full name', profile?.fullName);
  add('Email', profile?.email);
  add('Phone', profile?.phone);
  add('Location', [profile?.city, profile?.country].filter(Boolean).join(', ') || null);
  add('LinkedIn', profile?.linkedinUrl);
  if (profile?.githubUrl) answers.push({ label: 'GitHub', value: profile.githubUrl, source: 'vault' });
  if (profile?.portfolioUrl) answers.push({ label: 'Portfolio', value: profile.portfolioUrl, source: 'vault' });
  add('Notice period', profile?.noticePeriod);
  if (profile?.languages) answers.push({ label: 'Languages', value: profile.languages, source: 'vault' });

  const auth = findCountryAuth(profile, job.country);
  if (auth) {
    answers.push({ label: `Right to work in ${job.country}`, value: auth.rightToWork.replace(/_/g, ' '), source: 'vault' });
    answers.push({ label: 'Requires visa sponsorship', value: auth.needsSponsorship ? 'Yes' : 'No', source: 'vault' });
    if (auth.visaDetails) answers.push({ label: 'Visa details', value: auth.visaDetails, source: 'vault' });
    if (auth.salaryExpectation) answers.push({ label: 'Salary expectation', value: auth.salaryExpectation, source: 'vault' });
    if (auth.relocationWilling !== undefined) answers.push({ label: 'Willing to relocate', value: auth.relocationWilling ? 'Yes' : 'No', source: 'vault' });
  } else {
    missing.push(`Work-authorization answers for ${job.country || 'this country'} (add in Profile vault — the engine never guesses visa/sponsorship answers)`);
  }
  for (const s of profile?.screeningAnswers ?? []) {
    answers.push({ label: s.question, value: s.answer, source: 'vault' });
  }
  // EEO / demographic answers: included ONLY if the user entered them.
  // Absent entries are simply not answered (EEO questions are optional on
  // forms; "prefer not to say" must be an explicit user choice, never a guess).
  for (const [question, answer] of Object.entries(profile?.eeoAnswers ?? {})) {
    if (question.trim() && answer.trim()) answers.push({ label: `EEO: ${question}`, value: answer, source: 'vault' });
  }
  return { answers, missing };
}

/**
 * Returns the reason an application must pause for missing work-authorization
 * data, or null if the vault covers the job's country. A job without a known
 * country always pauses — no per-country record can be selected for it.
 */
export function workAuthBlockReason(
  profile: CandidateProfile | null,
  country: string | null | undefined,
): { step: string; reason: string } | null {
  if (!country || !country.trim()) {
    return {
      step: 'Job has no country — work-authorization answers cannot be selected',
      reason: 'This job has no country recorded, so your work-authorization answers cannot be matched to it. Confirm the job country (or add a matching record in the Profile Vault) before applying — visa and sponsorship answers are never guessed.',
    };
  }
  if (!findCountryAuth(profile, country)) {
    return {
      step: `No work-authorization record for ${country}`,
      reason: `Add your work-authorization answers for ${country} in the Profile Vault, then retry. The engine never guesses visa or sponsorship answers.`,
    };
  }
  return null;
}

/** True if an assisted packet still lacks sensitive work-authorization answers and therefore must not reach review. */
export function packetBlocksReview(packet: { missing: string[] } | null | undefined): boolean {
  return !!packet?.missing?.some((m) => /work-authorization/i.test(m));
}

export async function buildAssistedPacket(job: JobMatch, applyUrl: string): Promise<AssistedPacket> {
  const profile = await getProfile();
  const { answers, missing } = buildPacketAnswers(profile, job);
  let coverNote: string | null = null;
  if (profile) {
    try {
      const draft = await draftApplicationEmail(job, profile, 'Hiring Team');
      coverNote = draft.body;
    } catch (e: any) {
      console.log(`[APPLY] Cover note generation failed (packet still usable): ${e?.message}`);
    }
  }
  return { applyUrl, answers, coverNote, missing };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Prepares (or refreshes) the application for a job:
 * route resolution → channel pick (email if an address exists, else assisted)
 * → draft/packet → ready_for_review (or needs_user with a reason).
 */
export async function prepareApplication(jobId: string): Promise<Application> {
  const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, jobId));
  if (!job) throw new Error('Job match not found');

  // Reuse the latest non-terminal application or create a fresh one
  const existing = await db.select().from(applications)
    .where(eq(applications.jobMatchId, jobId))
    .orderBy(desc(applications.createdAt));
  const TERMINAL_SUBMITTED = new Set(['submitted', 'submitted_unconfirmed']);
  let app = existing.find((a) => !TERMINAL_SUBMITTED.has(a.state));
  if (app && (app.state === 'failed' || app.state === 'needs_user')) {
    app = await transitionApplication(app.id, 'queued', 'retry', 'Re-preparing application', {
      errorReason: null, needsUserReason: null, attemptCount: (app.attemptCount ?? 0) + 1,
    });
  }
  if (!app) {
    // onConflictDoNothing + partial unique index (one active app per job):
    // a concurrent prepare that won the race leaves us with zero rows — we
    // then adopt the winner's row instead of creating a duplicate.
    const inserted = await db.insert(applications)
      .values({ jobMatchId: jobId, channel: 'assisted', state: 'queued' })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      app = inserted[0];
    } else {
      const again = await db.select().from(applications)
        .where(eq(applications.jobMatchId, jobId)).orderBy(desc(applications.createdAt));
      app = again.find((a) => !TERMINAL_SUBMITTED.has(a.state));
      if (!app) throw new Error('Failed to create application record');
      return app; // another request is preparing it
    }
  } else if (app.state !== 'queued') {
    // Already in progress (route_resolved/ready_for_review/...) — return as-is
    return app;
  }

  try {
    // 1. Resolve apply route (official careers page, verified live)
    const route = await resolveApplyRoute(job);
    if (!route.applyUrl) {
      return await transitionApplication(app.id, 'needs_user', 'route_resolution',
        route.note, { needsUserReason: `No live, verified apply route exists for this job. ${route.note}` });
    }
    app = await transitionApplication(app.id, 'route_resolved', 'route_resolution', route.note, {
      applyUrl: route.applyUrl, atsType: route.atsType, routeSource: route.routeSource, routeConfidence: route.routeConfidence,
    });

    // 2. Profile vault must exist before any answers are prepared
    const profile = await getProfile();
    if (!profile || !profile.fullName || !profile.email) {
      return await transitionApplication(app.id, 'needs_user', 'vault_check',
        'Profile vault incomplete', { needsUserReason: 'Complete your Profile vault (at minimum name and email) before applications can be prepared.' });
    }

    // 3. Sensitive-answer gate (BOTH channels): the application pauses unless
    //    a user-entered work-authorization record exists for the job's country.
    //    A job with no known country also pauses — no per-country record can be
    //    selected, and visa/sponsorship answers are never guessed or omitted.
    const workAuthGap = workAuthBlockReason(profile, job.country);
    if (workAuthGap) {
      return await transitionApplication(app.id, 'needs_user', 'work_auth_check',
        workAuthGap.step, { needsUserReason: workAuthGap.reason });
    }

    // 4. Channel pick — the ordering lives in the pure, unit-tested
    //    chooseApplyChannel (see below for preserveContinuation).
    //    chooseApplyChannel: supported ATS → login-walled ATS → email →
    //    generic ATS → assisted. A recognized ATS route always beats an
    //    available contact email.
    const { SUPPORTED_ATS, LOGIN_WALLED_ATS, chooseApplyChannel } = await import('./atsSubmitter/core.js');
    const { prepareAtsApplication } = await import('./atsSubmitter/index.js');
    const atsRecognized = !!(route.atsType && (SUPPORTED_ATS.has(route.atsType) || LOGIN_WALLED_ATS.has(route.atsType)));
    // Email lookup is only needed when no recognized ATS route exists.
    let emailTarget = atsRecognized ? null : await findApplicationEmail(jobId);
    if (emailTarget && await wasContactRecentlyEmailed(emailTarget.email, jobId)) {
      // Same contact already emailed (or mid-approval) for a different job
      // within the cooldown — don't draft a second cold email to them this
      // soon. Falls through to the assisted-packet path below, same as if no
      // contact had been found at all.
      console.log(`[APPLY] Skipping email channel for job ${jobId} — ${emailTarget.email} was already contacted for a different job within ${EMAIL_CONTACT_COOLDOWN_DAYS} days`);
      emailTarget = null;
    }
    const choice = chooseApplyChannel(route.atsType, !!emailTarget);

    if (choice === 'ats_supported' || choice === 'ats_login_walled' || choice === 'ats_generic') {
      // Build a cover note up-front so the browser layer can fill cover-letter
      // textareas; the fill-only run then pauses at ready_for_review with a
      // pre-submit screenshot + every answer for approval. Login-walled ATSs
      // (Workday, iCIMS, Taleo, SuccessFactors) additionally handle account
      // creation (credentials vaulted BEFORE signup), email verification, and
      // the multi-page wizard; blocked situations degrade to assisted.
      const packet = await buildAssistedPacket(job, route.applyUrl);
      // Preserve continuation state from any prior attempt: a user-pasted
      // verification link must survive the packet rebuild or the signup flow
      // can never complete (and the run-gap bypass never triggers).
      const [fresh] = await db.select({ packet: applications.packet }).from(applications).where(eq(applications.id, app.id));
      preserveContinuation(fresh?.packet, packet);
      await db.update(applications)
        .set({ channel: 'ats_auto', packet, updatedAt: new Date() })
        .where(eq(applications.id, app.id));
      if (choice === 'ats_login_walled') {
        const { prepareLoginWalledApplication } = await import('./atsSubmitter/loginWalled.js');
        return await prepareLoginWalledApplication(app.id);
      }
      return await prepareAtsApplication(app.id);
    }

    if (choice === 'email' && emailTarget) {
      const draft = await draftApplicationEmail(job, profile, emailTarget.who);
      return await transitionApplication(app.id, 'ready_for_review', 'email_drafted',
        `Draft ready for ${emailTarget.email} (${emailTarget.status})`, {
          channel: 'email', emailTo: emailTarget.email, emailToStatus: emailTarget.status,
          emailSubject: draft.subject, emailBody: draft.body,
        });
    }

    const packet = await buildAssistedPacket(job, route.applyUrl);
    // Defensive re-check: a packet that still lacks sensitive work-auth data
    // must never reach review (belt-and-braces on top of the gate above).
    if (packetBlocksReview(packet)) {
      return await transitionApplication(app.id, 'needs_user', 'packet_incomplete',
        'Assisted packet is missing sensitive answers', {
          needsUserReason: `The application packet is missing sensitive answers: ${packet.missing.join('; ')}. Complete the Profile Vault, then retry.`,
          packet,
        });
    }
    return await transitionApplication(app.id, 'ready_for_review', 'packet_built',
      packet.missing.length ? `Packet ready with ${packet.missing.length} missing answer(s)` : 'Packet complete', {
        channel: 'assisted', packet,
      });
  } catch (e: any) {
    console.error(`[APPLY] prepareApplication failed for job ${jobId}:`, e);
    return await transitionApplication(app.id, 'failed', 'error', String(e?.message ?? e).slice(0, 500), {
      errorReason: String(e?.message ?? e).slice(0, 1000),
    });
  }
}

/**
 * Approve a reviewed application. Email channel: sends via the connected Gmail
 * integration with the tailored CV PDF attached. Assisted channel: marks the
 * application as submitted (user confirms they completed it).
 */
export async function approveApplication(appId: string, edits?: { emailSubject?: string; emailBody?: string }): Promise<Application> {
  const [app] = await db.select().from(applications).where(eq(applications.id, appId));
  if (!app) throw new Error('Application not found');
  if (app.state !== 'ready_for_review') throw new Error(`Application is not awaiting review (state: ${app.state})`);

  if (app.channel === 'assisted') {
    // Defensive gate: an assisted packet still missing sensitive work-auth
    // answers must never be marked submitted, even if it somehow reached review.
    if (packetBlocksReview(app.packet as AssistedPacket | null)) {
      return await transitionApplication(appId, 'needs_user', 'packet_incomplete',
        'Assisted packet is missing sensitive answers', {
          needsUserReason: `This application packet is missing sensitive answers: ${(app.packet as AssistedPacket).missing.join('; ')}. Complete the Profile Vault, then prepare it again.`,
        });
    }
    return transitionApplication(appId, 'approved', 'user_approved', 'Assisted apply confirmed by user')
      .then(() => transitionApplication(appId, 'submitting', 'assisted_submit'))
      .then(() => transitionApplication(appId, 'submitted', 'assisted_submitted', 'User confirmed manual submission'));
  }

  if (app.channel === 'ats_auto') {
    // User approved the reviewed, pre-filled form → headless submission run.
    await transitionApplication(appId, 'approved', 'user_approved', 'ATS auto-submit approved by user');
    await transitionApplication(appId, 'submitting', 'ats_submit_start', `Submitting via ${app.atsType ?? 'ATS'}`);
    const { submitAtsApplication, LOGIN_WALLED_ATS } = await import('./atsSubmitter/index.js');
    if (app.atsType && LOGIN_WALLED_ATS.has(app.atsType)) {
      const { submitLoginWalledApplication } = await import('./atsSubmitter/loginWalled.js');
      return submitLoginWalledApplication(appId);
    }
    return submitAtsApplication(appId);
  }

  if (app.channel === 'email') {
    if (!app.emailTo) throw new Error('No recipient email on this application');
    const subject = edits?.emailSubject?.trim() || app.emailSubject || '';
    const body = edits?.emailBody?.trim() || app.emailBody || '';
    if (!subject || !body) throw new Error('Email subject and body are required');

    // Daily send-volume cap: protects the connected Gmail account's sending
    // reputation/deliverability — mirrors the ATS channel's daily submit cap.
    if (await countTodaysEmailSends() >= DAILY_EMAIL_SEND_CAP) {
      return await transitionApplication(appId, 'needs_user', 'daily_email_cap',
        `Daily email-send cap reached (${DAILY_EMAIL_SEND_CAP})`, {
          needsUserReason: `Today's automatic email-sending cap (${DAILY_EMAIL_SEND_CAP}) is reached, to protect your Gmail account's sending reputation. Approve this application again tomorrow, or send it manually.`,
        });
    }

    await transitionApplication(appId, 'approved', 'user_approved', undefined, { emailSubject: subject, emailBody: body });
    await transitionApplication(appId, 'submitting', 'email_send_start', `Sending to ${app.emailTo}`);
    try {
      const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, app.jobMatchId));
      if (!job) throw new Error('Job match not found');
      // An application email is never sent without the tailored CV attached —
      // a missing CV pauses the application instead of silently downgrading it.
      if (!job.tailoredCv) {
        return await transitionApplication(appId, 'needs_user', 'cv_missing',
          'No tailored CV exists for this job', {
            needsUserReason: 'This job has no tailored CV yet. Generate the CV first ("Prepare Tailored CV"), then approve the email again — application emails are always sent with the CV PDF attached.',
          });
      }
      const { generateCvPdf } = await import('./cvPdfGenerator.js');
      const pdf = await generateCvPdf(job.tailoredCv, job.title, job.company);
      const attachment = { filename: `CV_${job.company.replace(/[^a-z0-9]/gi, '_')}_${job.title.replace(/[^a-z0-9]/gi, '_')}.pdf`, content: pdf };
      const { sendApplicationEmail } = await import('./emailSender.js');
      const messageId = await sendApplicationEmail({ to: app.emailTo, subject, body, attachment });
      return await transitionApplication(appId, 'submitted', 'email_sent', `Gmail message ${messageId} with CV PDF attached`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/not connected|X_REPLIT_TOKEN|connection settings/i.test(msg)) {
        return await transitionApplication(appId, 'needs_user', 'email_send_failed', msg.slice(0, 300), {
          needsUserReason: 'Gmail is not connected. Connect the Gmail integration, then approve this application again.',
        });
      }
      return await transitionApplication(appId, 'failed', 'email_send_failed', msg.slice(0, 500), {
        errorReason: msg.slice(0, 1000),
      });
    }
  }
  throw new Error(`Unsupported channel: ${app.channel}`);
}

// ── Queries for UI / daily report ────────────────────────────────────────────

export async function getApplicationsForJobs(jobIds: string[]): Promise<Record<string, Application[]>> {
  if (jobIds.length === 0) return {};
  const rows = await db.select().from(applications)
    .where(inArray(applications.jobMatchId, jobIds))
    .orderBy(desc(applications.createdAt));
  const out: Record<string, Application[]> = {};
  for (const r of rows) (out[r.jobMatchId] ??= []).push(r);
  return out;
}

export interface ApplySummary {
  total: number; submitted: number; unconfirmed: number; awaitingReview: number; needsUser: number; failed: number; inProgress: number; notStarted: number;
}

/** Day-level apply summary: every shortlisted role lands in exactly one bucket. */
export async function getApplySummary(runDate: string): Promise<ApplySummary> {
  const jobs = await db.select({ id: jobMatches.id }).from(jobMatches).where(eq(jobMatches.runDate, runDate));
  const byJob = await getApplicationsForJobs(jobs.map((j) => j.id));
  const summary: ApplySummary = { total: jobs.length, submitted: 0, unconfirmed: 0, awaitingReview: 0, needsUser: 0, failed: 0, inProgress: 0, notStarted: 0 };
  for (const j of jobs) {
    const apps = byJob[j.id] ?? [];
    // submitted_unconfirmed is deliberately NOT counted as submitted: a click
    // without a detected confirmation is unverified until the user checks it.
    if (apps.some((a) => a.state === 'submitted')) summary.submitted++;
    else if (apps.some((a) => a.state === 'submitted_unconfirmed')) summary.unconfirmed++;
    else if (apps.some((a) => a.state === 'ready_for_review')) summary.awaitingReview++;
    else if (apps.some((a) => a.state === 'needs_user')) summary.needsUser++;
    else if (apps.some((a) => a.state === 'failed')) summary.failed++;
    else if (apps.length > 0) summary.inProgress++;
    else summary.notStarted++;
  }
  return summary;
}

/**
 * Daily-pipeline hook: prepare applications for every job on a run-date that
 * doesn't have one yet. Sequential (Anthropic web-search calls must not run in
 * parallel). Failures are logged per job and never abort the batch.
 */
export async function prepareApplicationsForDate(runDate: string): Promise<{ prepared: number; failed: number }> {
  const jobs = await db.select().from(jobMatches).where(eq(jobMatches.runDate, runDate));
  const byJob = await getApplicationsForJobs(jobs.map((j) => j.id));
  let prepared = 0, failed = 0;
  for (const job of jobs) {
    if ((byJob[job.id] ?? []).length > 0) continue; // already has an application
    try {
      const app = await prepareApplication(job.id);
      if (app.state === 'failed') failed++; else prepared++;
    } catch (e) {
      console.error(`[APPLY] Batch preparation failed for ${job.title} at ${job.company}:`, e);
      failed++;
    }
  }
  console.log(`[APPLY] Batch preparation for ${runDate}: ${prepared} prepared, ${failed} failed`);
  return { prepared, failed };
}
