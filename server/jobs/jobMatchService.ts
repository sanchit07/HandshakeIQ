import Anthropic from '@anthropic-ai/sdk';
import dnsPromises from 'node:dns/promises';
import type { LookupOptions } from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { jobMatches, type JobMatch } from '../../shared/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

const MODEL = 'claude-sonnet-4-5';

// One country per day, Sunday → Saturday (7 countries; Malaysia gets Sunday as top priority)
const COUNTRY_BY_DAY: string[] = [
  'Malaysia',     // Sunday
  'Australia',    // Monday
  'New Zealand',  // Tuesday
  'Ireland',      // Wednesday
  'Switzerland',  // Thursday
  'Sweden',       // Friday
  'Poland',       // Saturday
];

export function countryForToday(): string {
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short' }).format(new Date());
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
  return COUNTRY_BY_DAY[idx >= 0 ? idx : 0];
}

const COMPANY_COOLDOWN_DAYS = 28; // skip companies shortlisted in the last 4 weeks
const VACANCY_DEDUP_DAYS = 90;    // never re-shortlist the same vacancy

const BOARDS = ['LinkedIn', 'Indeed', 'JobStreet', 'Randstad', 'Hays'];

// JobStreet.com.au was shut down and redirects to the Malaysian site; SEEK covers AU/NZ.
// JobStreet is therefore only used on the Malaysia day.
const JOBSTREET_COUNTRIES = new Set(['Malaysia']);
const EXAMPLE_ROLES = [
  'Innovation Manager', 'Delivery Manager', 'Product Manager', 'Head of Product',
  'Lead Product Manager', 'Product Owner', 'Senior Business Analyst',
];

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
  return new Anthropic({ apiKey });
}

const RESUME_DIR = path.join(process.cwd(), 'server', 'jobs', 'resumes');

export function loadResumes(): { name: string; text: string }[] {
  const files: [string, string][] = [
    ['Senior Product Manager CV', 'senior_pm.txt'],
    ['Senior Business Analyst CV', 'business_analyst.txt'],
    ['General Product Leader CV', 'general.txt'],
  ];
  return files
    .filter(([, f]) => fs.existsSync(path.join(RESUME_DIR, f)))
    .map(([name, f]) => ({ name, text: fs.readFileSync(path.join(RESUME_DIR, f), 'utf-8') }));
}

function profileSummary(): string {
  const resumes = loadResumes();
  if (resumes.length === 0) throw new Error('No resume files found in server/jobs/resumes');
  // Use the most detailed resume as the core profile for search context
  return resumes[0].text.slice(0, 8000);
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function parseJsonLoose(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  const os = trimmed.indexOf('{');
  const oe = trimmed.lastIndexOf('}');
  if (os !== -1 && oe > os) return JSON.parse(trimmed.slice(os, oe + 1));
  throw new Error('No JSON found in Claude response');
}

export function todayKL(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
}

// Advisory lock key for the daily search (coordinates across processes, e.g.
// dev workflow + published deployment both running the 7 AM cron)
const RUN_LOCK_KEY = 771230117;

/**
 * Known job-board and ATS domains. Only URLs whose hostname matches one of
 * these (exact match or subdomain) are probed. Everything else is kept without
 * a network request — prevents arbitrary outbound requests to LLM-generated URLs.
 */
export const ALLOWED_JOB_BOARD_DOMAINS: readonly string[] = [
  'linkedin.com', 'indeed.com',
  // JobStreet — Malaysia only (jobstreet.com.au was shut down; AU/NZ use SEEK)
  'jobstreet.com', 'jobstreet.com.my',
  // Randstad — country-specific domains
  'randstad.com', 'randstad.com.my', 'randstad.com.au', 'randstad.co.nz',
  'randstad.ie', 'randstad.ch', 'randstad.se', 'randstad.pl',
  // Hays — country-specific domains
  'hays.com', 'hays.com.my', 'hays.com.au', 'hays.net.nz',
  'hays.ie', 'hays.ch', 'hays.se', 'hays.pl',
  'glassdoor.com',
  'seek.com', 'seek.com.au', 'seek.co.nz',
  'monster.com', 'careerbuilder.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com',
  'myworkdayjobs.com', 'taleo.net', 'icims.com', 'smartrecruiters.com',
  'bamboohr.com', 'jobvite.com', 'successfactors.com',
  'jobsdb.com', 'reed.co.uk', 'totaljobs.com', 'stepstone.de', 'xing.com',
  'careers24.com', 'pnet.co.za',
];
/**
 * Checks whether a job posting URL is still live.
 *
 * Security design:
 *  1. Domain allowlist — only known job-board/ATS hostnames are probed.
 *  2. SSRF-safe DNS — the ssrfSafeLookup callback validates ALL resolved IPs
 *     at connection time (no TOCTOU gap between check and use).
 *  3. No redirect following — 3xx is treated as "live"; we never connect to
 *     a redirect destination.
 *  4. Shared 10-second deadline across HEAD and fallback GET.
 *
 * Conservative failure policy: only 404/410 → dead. 403/429/5xx and network
 * errors → live (bot-blocking boards and transient outages are not discarded).
 * SSRF-blocked URLs → dead (actively rejected).
 */
export async function checkUrlLive(url: string | null | undefined): Promise<boolean> {
  if (!url || !/^https?:\/\//.test(url)) return true; // no URL — keep

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return true; // unparseable — keep
  }

  // Domain allowlist: skip probe entirely for non-allowlisted hostnames
  if (!isAllowedJobBoardDomain(parsedUrl.hostname)) {
    console.log(`[LIVENESS] Skipping probe (non-allowlisted domain): ${parsedUrl.hostname}`);
    return true;
  }

  // Single AbortController — shared across HEAD + fallback GET (10 s combined budget)
  const TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let status = await httpRequest(parsedUrl, 'HEAD', controller.signal);

    // Some servers reject HEAD — retry with GET using the same signal (shared budget)
    if (status === 405 || status === 501) {
      status = await httpRequest(parsedUrl, 'GET', controller.signal);
    }

    const dead = status === 404 || status === 410;
    if (dead) console.log(`[LIVENESS] DEAD (${status}): ${url}`);
    return !dead;
  } catch (err: any) {
    if (err?.message?.startsWith('SSRF blocked')) {
      console.log(`[LIVENESS] ${err.message}`);
      return false; // actively blocked private IP — treat as dead
    }
    // Timeout, DNS failure, TLS, connection refused → keep (don't discard real jobs)
    console.log(`[LIVENESS] Network error (keeping): ${url} — ${err?.message}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}
export async function runDailyJobSearch(force = false): Promise<{ runDate: string; count: number; skipped?: boolean }> {
  const runDate = todayKL();

  // Cross-process lock: only one process may run the pipeline at a time
  const lockResult: any = await db.execute(sql`SELECT pg_try_advisory_lock(${RUN_LOCK_KEY}) AS locked`);
  const locked = lockResult?.rows?.[0]?.locked ?? lockResult?.[0]?.locked;
  if (!locked) {
    console.log('[JOB SEARCH] Another process is already running the daily search; skipping');
    return { runDate, count: 0, skipped: true };
  }

  try {
    // Idempotence (checked while holding the lock): don't duplicate a day's shortlist unless forced
    const existing = await db.select({ count: sql<number>`count(*)` }).from(jobMatches).where(eq(jobMatches.runDate, runDate));
    if (Number(existing[0]?.count) > 0 && !force) {
      return { runDate, count: Number(existing[0].count), skipped: true };
    }
    const client = getClient();
    const profile = profileSummary();
    const country = countryForToday();

    console.log(`[JOB SEARCH] Starting daily job search for ${runDate} — country of the day: ${country}`);

    // History for dedup rules: past vacancies (never repeat) and recent companies (4-week cooldown)
    const pastVacancies = await db
      .select({ title: jobMatches.title, company: jobMatches.company, url: jobMatches.url })
      .from(jobMatches)
      .where(sql`${jobMatches.createdAt} > now() - interval '${sql.raw(String(VACANCY_DEDUP_DAYS))} days'`);
    const recentCompanies = Array.from(new Set((await db
      .select({ company: jobMatches.company })
      .from(jobMatches)
      .where(sql`${jobMatches.createdAt} > now() - interval '${sql.raw(String(COMPANY_COOLDOWN_DAYS))} days'`))
      .map((r) => r.company)));
    const pastUrls = new Set(pastVacancies.map((v) => (v.url || '').toLowerCase()).filter(Boolean));
    const pastTitleCompany = new Set(pastVacancies.map((v) => `${v.title}::${v.company}`.toLowerCase()));
    const cooldownCompanies = new Set(recentCompanies.map((c) => c.toLowerCase()));

    // Phase 1: derive suitable role titles from the profile (not restricted to examples)
    const rolesResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Given this candidate profile, list the 12 most suitable job titles to search for. Include but do not limit yourself to: ${EXAMPLE_ROLES.join(', ')}. Consider adjacent roles the profile strongly qualifies for (e.g. AI product roles, platform product roles, transformation/innovation roles). Return ONLY a JSON array of strings.\n\nPROFILE:\n${profile}`,
      }],
    });
    let roles: string[] = EXAMPLE_ROLES;
    try {
      const parsed = parseJsonLoose(extractText(rolesResponse));
      if (Array.isArray(parsed) && parsed.length > 0) roles = parsed.filter((r) => typeof r === 'string').slice(0, 14);
    } catch (e) {
      console.error('[JOB SEARCH] Role derivation failed, using defaults:', e);
    }
    console.log(`[JOB SEARCH] Target roles: ${roles.join(', ')}`);

    // Phase 2: one dedicated Claude API call per board so results are attributable per-source.
    const boardConfigs = getBoardConfigs(country);
    console.log(`[JOB SEARCH] Searching ${boardConfigs.length} boards in parallel: ${boardConfigs.map((b) => b.name).join(', ')}`);

    const boardResultSets = await Promise.all(
      boardConfigs.map((board) => searchSingleBoard(client, board, country, roles, recentCompanies)),
    );

    // Log per-board yield and build structured finding pool
    interface BoardFinding {
      title: string; company: string; location: string; url: string; description: string; source: string;
    }
    const allFindings: BoardFinding[] = [];
    const findingsByBoard: Map<string, BoardFinding[]> = new Map();
    boardConfigs.forEach((board, i) => {
      const results = boardResultSets[i];
      findingsByBoard.set(board.name, results);
      console.log(`[JOB SEARCH] ${board.name}: ${results.length} direct posting(s) found`);
      allFindings.push(...results);
    });

    if (allFindings.length === 0) throw new Error('No job postings found across any board');

    // Format findings for Phase 3 ranking
    const findingsText = boardConfigs.map((board, i) => {
      const results = boardResultSets[i];
      if (results.length === 0) return `=== ${board.name}: No direct postings found ===`;
      return `=== ${board.name} (${results.length} postings) ===\n${results.map((j) =>
        `- ${j.title} at ${j.company} (${j.location})\n  URL: ${j.url}\n  ${j.description}`,
      ).join('\n')}`;
    }).join('\n\n');

    // Phase 3: rank and shortlist top 10 against the profile
    const rankResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are shortlisting job opportunities for this candidate.

CANDIDATE PROFILE:
${profile}

VACANCIES FOUND TODAY (grouped by job board):
${findingsText}

Select the 10 opportunities with the HIGHEST CHANCE OF THE CANDIDATE GETTING SHORTLISTED. That is the primary criterion — not seniority or domain purity:
- Seniority is NOT a bar: roles asking for 5-6+ years of experience are fine if the candidate would be a strong applicant.
- Domain is NOT a bar: fintech, e-commerce, automotive, construction, and other industries are all fine if the candidate's transferable skills give a high chance of shortlisting.
- Judge realistically: does the candidate meet the stated must-haves, and would a recruiter screening CVs likely advance them?

SHORTLISTING PREFERENCE RULES (apply in this priority order):
1. Prefer roles where the working language is English (deprioritize postings requiring local languages).
2. Prefer companies that provide visa sponsorship or explicitly welcome international candidates.

EXCLUSION RULES (hard):
- NEVER include a vacancy already shortlisted before. Previously shortlisted vacancies (title :: company): ${Array.from(pastTitleCompany).slice(0, 80).join(' | ') || 'none'}.
- NEVER include companies shortlisted within the last 4 weeks: ${recentCompanies.slice(0, 60).join(', ') || 'none'}.

Discard anything without a real company name and a plausible direct URL to an individual job ad.

Return ONLY a JSON array (no markdown) of up to 10 objects, best match first. Set "source" to the board name exactly as shown in the section header above:
[{"title": "...", "company": "...", "location": "city", "country": "...", "source": "LinkedIn|Indeed|JobStreet|Randstad|Hays|Other", "url": "https://...", "description": "1-3 sentence summary of the role and key requirements", "matchScore": <0-100>, "matchReason": "1-2 sentences on why this fits the candidate"}]`,
      }],
    });

    const ranked = parseJsonLoose(extractText(rankResponse));
    if (!Array.isArray(ranked) || ranked.length === 0) throw new Error('Ranking step returned no results');

    // Re-derive 'source' from the URL hostname — do not trust the ranker's self-reported label,
    // which can be wrong (e.g. a ranker labelling an ATS URL as "Hays").
    const rankedWithSource = ranked.map((j: any) => ({
      ...j,
      source: deriveSourceFromUrl(typeof j.url === 'string' ? j.url : null, boardConfigs),
    }));

    // Hard dedup enforcement (in case the model ignores exclusion rules)
    const dedupedCandidates = rankedWithSource
      .filter((j: any) => j && typeof j.title === 'string' && typeof j.company === 'string')
      .filter((j: any) => {
        const url = typeof j.url === 'string' ? j.url.toLowerCase() : '';
        if (url && pastUrls.has(url)) return false;
        if (pastTitleCompany.has(`${j.title}::${j.company}`.toLowerCase())) return false;
        if (cooldownCompanies.has(String(j.company).toLowerCase())) return false;
        return true;
      });

    // Phase 4: liveness check — drop postings whose URL returns a confirmed-dead status
    console.log(`[JOB SEARCH] Liveness-checking ${dedupedCandidates.length} candidate URLs…`);
    const liveJobs = await filterLiveJobs(dedupedCandidates);
    console.log(`[JOB SEARCH] ${liveJobs.length} of ${dedupedCandidates.length} jobs passed liveness check`);
    if (liveJobs.length === 0) throw new Error('All shortlisted jobs failed liveness check');

    // Board-slot enforcement: every board that yielded ≥1 finding must appear in the final list.
    const boardsWithFindings = boardConfigs.filter((_, i) => boardResultSets[i].length > 0).map((b) => b.name);
    const dedupedRows = await enforceSlotCoverage(
      liveJobs,
      boardsWithFindings,
      findingsByBoard,
      pastUrls,
      pastTitleCompany,
      cooldownCompanies,
    );

    const rows = dedupedRows.map((j: any, i: number) => ({
      runDate,
      rank: i + 1,
      title: String(j.title).slice(0, 250),
      company: String(j.company).slice(0, 250),
      location: j.location ? String(j.location).slice(0, 250) : null,
      country: j.country ? String(j.country).slice(0, 100) : country,
      source: j.source ? String(j.source).slice(0, 100) : null,
      url: typeof j.url === 'string' && /^https?:\/\//.test(j.url) ? j.url : null,
      description: j.description ? String(j.description) : null,
      matchScore: Number.isFinite(Number(j.matchScore)) ? Math.max(0, Math.min(100, Math.round(Number(j.matchScore)))) : null,
      matchReason: j.matchReason ? String(j.matchReason) : null,
    }));

    // Atomic replace: never leave the day empty if the insert fails
    await db.transaction(async (tx) => {
      if (force) {
        await tx.delete(jobMatches).where(eq(jobMatches.runDate, runDate));
      }
      await tx.insert(jobMatches).values(rows);
    });

    console.log(`[JOB SEARCH] Saved ${rows.length} shortlisted jobs for ${runDate}`);
    return { runDate, count: rows.length };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${RUN_LOCK_KEY})`).catch(() => {});
  }
}

export async function getJobById(matchId: string): Promise<JobMatch | undefined> {
  const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, matchId));
  return job;
}

export async function getShortlist(runDate?: string): Promise<JobMatch[]> {
  const date = runDate || todayKL();
  return await db.select().from(jobMatches).where(eq(jobMatches.runDate, date)).orderBy(jobMatches.rank);
}

export async function getShortlistDates(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ runDate: jobMatches.runDate })
    .from(jobMatches)
    .orderBy(desc(jobMatches.runDate));
  return rows.map((r) => r.runDate);
}

// Serialize CV tailoring per job so concurrent requests don't both pay for generation
const tailoringInFlight = new Map<string, Promise<JobMatch>>();

export async function tailorCvForJob(matchId: string): Promise<JobMatch> {
  const inFlight = tailoringInFlight.get(matchId);
  if (inFlight) return inFlight;
  const promise = doTailorCv(matchId).finally(() => tailoringInFlight.delete(matchId));
  tailoringInFlight.set(matchId, promise);
  return promise;
}

async function doTailorCv(matchId: string): Promise<JobMatch> {
  const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, matchId));
  if (!job) throw new Error('Job match not found');
  if (job.tailoredCv) return job;

  const client = getClient();
  const resumes = loadResumes();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as any],
    messages: [{
      role: 'user',
      content: `You are an expert CV writer. Prepare a tailored CV for this job opportunity, drawing on the candidate's real experience from the source CVs below. NEVER invent experience, employers, dates, or qualifications the candidate does not have — only reframe, reorder, and emphasize genuinely existing experience to fit the job description.

FIRST, use web search (up to 3 searches) to check what type of CV gets shortlisted at ${job.company} for ${job.title}-type roles and what CV norms apply in ${job.country || 'the target country'} (screening process, ATS usage, expected format/length, what recruiters there look for). Apply what you learn.

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || ''}, ${job.country || ''}
Description / requirements: ${job.description || 'Not available — tailor based on the job title and typical requirements for this role.'}

SOURCE CVs (choose the most relevant as the base, blend strengths from others):
${resumes.map((r) => `--- ${r.name} ---\n${r.text}`).join('\n\n')}

CV CREATION RULES (mandatory):
1. Follow the CV norms of ${job.country || 'the target country'} (e.g. length conventions, whether to include photo/date of birth — omit personal details where the norm is to exclude them).
2. Keep the formatting simple: standard section headings, plain bullet points, no tables, columns, graphics, or icons.
3. The document must be clean and ATS-friendly: conventional headings (Professional Summary, Work Experience, Skills, Education), standard date formats, keywords mirrored from the job description where truthful.
4. Use simple, clear English — short sentences, active verbs, no jargon beyond what the job description itself uses.
5. Optimize for getting shortlisted for THIS role: mirror the job's key requirements prominently in the summary and skills, and lead each role with the achievements most relevant to this job.

Produce the complete tailored CV in clean Markdown (headings, bullet points), ready to copy into a document. Lead with a professional summary rewritten for this specific role, reorder core competencies to match the job's priorities, and emphasize the most relevant achievements in each role.

The VERY FIRST line of your response must be exactly: "BASE CV: <name of the source CV you used as the base>" followed by a blank line, then the CV itself (do not include any other commentary).`,
    }],
  });

  let tailoredCv = extractText(response);
  if (!tailoredCv || tailoredCv.length < 500) throw new Error('CV generation returned insufficient content');

  // Extract the role→CV mapping declared on the first line
  let cvVariant: string | null = null;
  const baseMatch = tailoredCv.match(/^\s*BASE CV:\s*(.+?)\s*$/m);
  if (baseMatch) {
    cvVariant = baseMatch[1].slice(0, 200);
    tailoredCv = tailoredCv.replace(/^\s*BASE CV:.*\n+/, '');
  }

  await db.update(jobMatches).set({ tailoredCv, cvVariant }).where(eq(jobMatches.id, matchId));
  return { ...job, tailoredCv, cvVariant };
}

// ---------------------------------------------------------------------------
// Per-board search infrastructure
// ---------------------------------------------------------------------------

const HAYS_TLD: Record<string, string> = {
  Malaysia:      'hays.com.my',
  Australia:     'hays.com.au',
  'New Zealand': 'hays.net.nz',
  Ireland:       'hays.ie',
  Switzerland:   'hays.ch',
  Sweden:        'hays.se',
  Poland:        'hays.pl',
};

export async function filterLiveJobs(jobs: any[]): Promise<any[]> {
  const results = await Promise.all(
    jobs.map(async (job) => ({ job, live: await checkUrlLive(job?.url) })),
  );
  return results.filter((r) => r.live).map((r) => r.job);
}

/**
 * Ensures every board that produced ≥1 finding is represented in the final shortlist.
 *
 * Two-phase algorithm (avoids the sequential-eviction bug):
 *  Phase 1 — collect all fills: for each missing board, pick the first live, dedup-clean
 *             candidate from that board's raw findings.
 *  Phase 2 — make room then append: trim the ranked list by exactly `fills.length` rows
 *             from the tail, then push all fills at once.
 *
 * Exported for unit tests; injectable `liveCheckFn` defaults to `checkUrlLive`.
 */
export async function enforceSlotCoverage(
  rankedLiveJobs: any[],
  boardsWithFindings: string[],
  findingsByBoard: Map<string, any[]>,
  pastUrls: Set<string>,
  pastTitleCompany: Set<string>,
  cooldownCompanies: Set<string>,
  maxSize = 10,
  liveCheckFn: (url: string) => Promise<boolean> = checkUrlLive,
): Promise<any[]> {
  const top = rankedLiveJobs.slice(0, maxSize);
  const present = new Set(top.map((j: any) => String(j.source)));
  const usedUrls = new Set(top.map((j: any) => (typeof j.url === 'string' ? j.url.toLowerCase() : '')));
  const usedTC = new Set(top.map((j: any) => `${j.title}::${j.company}`.toLowerCase()));

  // Phase 1: find one live candidate per missing board
  const fills: any[] = [];
  for (const board of boardsWithFindings) {
    if (present.has(board)) continue;
    const eligible = (findingsByBoard.get(board) ?? []).filter((f) => {
      const u = f.url.toLowerCase();
      return !pastUrls.has(u) && !usedUrls.has(u)
        && !pastTitleCompany.has(`${f.title}::${f.company}`.toLowerCase())
        && !usedTC.has(`${f.title}::${f.company}`.toLowerCase())
        && !cooldownCompanies.has(f.company.toLowerCase());
    });
    let pick: any | null = null;
    for (const c of eligible) {
      if (await liveCheckFn(c.url)) { pick = c; break; }
      console.log(`[JOB SEARCH] Board slot candidate dead for ${board}: ${c.url}`);
    }
    if (!pick) {
      console.warn(`[JOB SEARCH] WARN: ${board} had findings but no live/dedup-clean slot candidate`);
      continue;
    }
    // Reserve this candidate so no later board picks the same posting
    usedUrls.add(pick.url.toLowerCase());
    usedTC.add(`${pick.title}::${pick.company}`.toLowerCase());
    present.add(board);
    fills.push({
      title: pick.title, company: pick.company, location: pick.location ?? '',
      source: pick.source, url: pick.url, description: pick.description ?? '',
      matchScore: null, matchReason: `Included to ensure ${board} board coverage`,
    });
    console.log(`[JOB SEARCH] Board slot filled for ${board}: ${pick.title} at ${pick.company}`);
  }

  // Phase 2: trim ranked list once to make room, then append all fills atomically
  const base = top.slice(0, Math.max(maxSize - fills.length, 0));
  return [...base, ...fills];
}

/** Returns true when hostname matches an allowed domain exactly or as subdomain. */
export function isAllowedJobBoardDomain(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  for (const allowed of ALLOWED_JOB_BOARD_DOMAINS) {
    if (h === allowed || h.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * Synchronously checks whether an IP address string is private, loopback,
 * link-local, or otherwise reserved (RFC 1918, RFC 4193, RFC 3513, etc.).
 * Handles both IPv4 and IPv6, including IPv4-mapped IPv6 addresses.
 */
export function isPrivateIp(address: string): boolean {
  // Unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const v4mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const check = v4mapped ? v4mapped[1] : address;

  if (net.isIPv4(check)) {
    const [a, b] = check.split('.').map(Number);
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                           // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC1918
    if (a === 192 && b === 168) return true;             // RFC1918
    if (a === 169 && b === 254) return true;             // link-local / metadata (AWS, GCP, etc.)
    if (a === 0) return true;                            // this-network
    if (a >= 224) return true;                           // multicast + reserved
    return false;
  }

  if (net.isIPv6(check)) {
    const lower = check.toLowerCase();
    if (lower === '::1') return true;                              // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA (RFC 4193)
    if (lower.startsWith('fe80')) return true;                    // link-local (RFC 3513)
    if (lower.startsWith('ff')) return true;                      // multicast
    return false;
  }

  return false; // unrecognised format — allow (fetch will fail naturally)
}

/**
 * Custom DNS lookup passed to Node's http/https.request `lookup` option.
 *
 * SSRF guarantee: this callback is called BY the networking layer at the
 * moment of connection, so the IP address it validates IS the address used for
 * the TCP socket. There is no TOCTOU gap between a pre-check and the actual
 * connection.
 *
 * Security properties:
 *  - Resolves ALL A and AAAA records (not just one) via resolve4/resolve6.
 *  - Rejects the connection if ANY resolved address is private/reserved,
 *    preventing mixed-record DNS rebinding attacks.
 *  - Returns the first fully-public address for the connection.
 */
export async function ssrfSafeLookup(
  hostname: string,
  _opts: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): Promise<void> {
  try {
    const [v4Result, v6Result] = await Promise.allSettled([
      dnsPromises.resolve4(hostname),
      dnsPromises.resolve6(hostname),
    ]);

    const candidates: Array<{ address: string; family: 4 | 6 }> = [
      ...(v4Result.status === 'fulfilled'
        ? v4Result.value.map((a) => ({ address: a, family: 4 as const }))
        : []),
      ...(v6Result.status === 'fulfilled'
        ? v6Result.value.map((a) => ({ address: a, family: 6 as const }))
        : []),
    ];

    if (candidates.length === 0) {
      callback(Object.assign(new Error(`DNS lookup failed for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }

    // Reject if ANY candidate is private — blocks mixed-record DNS rebinding
    for (const { address } of candidates) {
      if (isPrivateIp(address)) {
        callback(Object.assign(new Error(`SSRF blocked: ${hostname} resolves to private/reserved IP ${address}`), { code: 'ECONNREFUSED' }), '', 0);
        return;
      }
    }

    // All candidates are public — use the first for the connection
    const { address, family } = candidates[0];
    callback(null, address, family);
  } catch (err: any) {
    callback(err, '', 0);
  }
}

/**
 * Makes an HTTP/HTTPS request using Node's native stack with the SSRF-safe
 * lookup function. Returns the HTTP status code (0 on connection failure).
 * Redirects are NOT followed — a 3xx status counts as "live".
 */
function httpRequest(parsedUrl: URL, method: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('AbortError')); return; }

    const isHttps = parsedUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobLivenessBot/1.0)' },
        lookup: (h: string, o: LookupOptions, cb: any) => { ssrfSafeLookup(h, o, cb); },
      },
      (res) => {
        res.destroy(); // discard body
        signal.removeEventListener('abort', onAbort);
        resolve(res.statusCode ?? 0);
      },
    );

    function onAbort() {
      req.destroy(new Error('AbortError'));
      reject(new Error('AbortError'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.end();
  });
}

// jobstreet.com.au was shut down (redirects to my.jobstreet.com); only MY is active.
const JOBSTREET_DOMAIN: Record<string, string> = {
  Malaysia: 'jobstreet.com.my',
};

/**
 * Returns true when `hostname` belongs to one of `boardDomains`.
 * Handles www. prefix and subdomains (e.g. au.indeed.com matches indeed.com).
 * Exported for unit tests.
 */
export function hostnameMatchesBoardDomain(hostname: string, boardDomains: string[]): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return boardDomains.some((d) => {
    const bd = d.toLowerCase().replace(/^www\./, '');
    return h === bd || h.endsWith('.' + bd);
  });
}

export interface BoardConfig {
  name: string;
  /** Primary site: domain to use in web searches */
  domain: string;
  /** Human-readable hint of what a direct posting URL looks like */
  urlHint: string;
  /** Extra instruction appended to the search prompt (e.g. local-domain note) */
  extraNote?: string;
  /** Acceptable base domains for URL hostname validation; subdomains also accepted */
  validDomains: string[];
}

/**
 * Maps a posting URL to a board name using the URL's hostname.
 * Override for the ranker's self-reported "source" field, which cannot be trusted.
 * Returns 'Other' when no board config's validDomains match.
 * Exported for unit tests.
 */
export function deriveSourceFromUrl(url: string | null | undefined, boardConfigs: BoardConfig[]): string {
  if (!url) return 'Other';
  try {
    const hostname = new URL(url).hostname;
    for (const board of boardConfigs) {
      if (hostnameMatchesBoardDomain(hostname, board.validDomains)) return board.name;
    }
  } catch {}
  return 'Other';
}

const RANDSTAD_TLD: Record<string, string> = {
  Malaysia:      'randstad.com.my',
  Australia:     'randstad.com.au',
  'New Zealand': 'randstad.co.nz',
  Ireland:       'randstad.ie',
  Switzerland:   'randstad.ch',
  Sweden:        'randstad.se',
  Poland:        'randstad.pl',
};


/** Run one Claude API call targeting a single job board. Returns structured findings. */
async function searchSingleBoard(
  client: Anthropic,
  board: BoardConfig,
  country: string,
  roles: string[],
  recentCompanies: string[],
): Promise<Array<{ title: string; company: string; location: string; url: string; description: string; source: string }>> {
  const roleList = roles.slice(0, 8).join(', ');
  const roleQuery = roles.slice(0, 3).join(' OR ');
  const prompt = `You are a job-search agent. Search the job board "${board.name}" for CURRENTLY OPEN vacancies posted in the last 2 weeks in ${country} for these roles: ${roleList}.

SEARCH STRATEGY:
1. Run a web search: site:${board.domain} (${roleQuery}) ${country}
2. If results are category/listing pages rather than individual job ads, refine by adding a specific city or using a single role title.
${board.extraNote ? '3. ' + board.extraNote : ''}

DIRECT URL REQUIREMENT: Only include postings with a URL that resolves to a single specific job ad.
Accepted URL pattern: ${board.urlHint}
Reject: search-results pages, category pages, homepages, or URLs without a unique job identifier.

SKIP postings from these recently-shortlisted companies: ${recentCompanies.slice(0, 40).join(', ') || 'none'}
PREFER English-language postings. Note any mention of visa sponsorship or relocation support.

Return ONLY a valid JSON array (empty array [] if nothing valid was found — do NOT apologise or explain):
[{"title":"...","company":"...","location":"city, country","url":"https://...","description":"1-2 sentence summary; include visa/relocation notes if present"}]`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3072,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 } as any],
    });
    const text = extractText(response);
    const parsed = parseJsonLoose(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j: any) => j && typeof j.title === 'string' && typeof j.company === 'string' && typeof j.url === 'string' && /^https?:\/\//.test(j.url))
      // Reject any URL whose hostname doesn't belong to this board's known domains.
      // Prevents Claude from returning LinkedIn/ATS URLs when asked to search Hays, etc.
      .filter((j: any) => {
        try {
          const hostname = new URL(String(j.url)).hostname;
          if (!hostnameMatchesBoardDomain(hostname, board.validDomains)) {
            console.log(`[JOB SEARCH] ${board.name}: rejected off-board URL (${hostname}): ${j.url}`);
            return false;
          }
          return true;
        } catch { return false; }
      })
      .map((j: any) => ({
        title: String(j.title).slice(0, 250),
        company: String(j.company).slice(0, 250),
        location: j.location ? String(j.location).slice(0, 250) : '',
        url: String(j.url),
        description: j.description ? String(j.description) : '',
        source: board.name,
      }));
  } catch (e) {
    console.error(`[JOB SEARCH] Board search failed for ${board.name}:`, e);
    return [];
  }
}

function getBoardConfigs(country: string): BoardConfig[] {
  const randstad = RANDSTAD_TLD[country] ?? 'randstad.com';
  const hays = HAYS_TLD[country] ?? 'hays.com';
  const configs: BoardConfig[] = [
    {
      name: 'LinkedIn',
      domain: 'linkedin.com/jobs/view',
      urlHint: 'https://www.linkedin.com/jobs/view/<numeric-id>',
      validDomains: ['linkedin.com'],
    },
    {
      name: 'Indeed',
      domain: 'indeed.com',
      urlHint: 'URLs containing /viewjob?jk= or /rc/clk?jk=',
      // indeed.com covers country subdomains (au.indeed.com, ie.indeed.com, etc.)
      extraNote: 'Also try the country-specific Indeed domain (e.g. au.indeed.com, ie.indeed.com, pl.indeed.com, se.indeed.com). If the first search yields only listing pages, try a city name or a single specific role title.',
      validDomains: ['indeed.com'],
    },
    {
      name: 'Randstad',
      domain: randstad,
      urlHint: `a URL on ${randstad} that includes a job reference number or job slug — NOT the homepage or a /jobs category page`,
      validDomains: [randstad],
    },
    {
      name: 'Hays',
      domain: hays,
      urlHint: `a URL on ${hays} that contains /job/ followed by a job reference or title slug`,
      validDomains: [hays],
    },
  ];
  // JobStreet is only active in Malaysia (jobstreet.com.my).
  // jobstreet.com.au was shut down and redirects to the Malaysian site — AU/NZ use SEEK instead.
  if (JOBSTREET_COUNTRIES.has(country)) {
    configs.push({
      name: 'JobStreet',
      domain: 'jobstreet.com.my',
      urlHint: 'https://www.jobstreet.com.my/job/<numeric-id>',
      validDomains: ['jobstreet.com.my'],
    });
  }
  return configs;
}
