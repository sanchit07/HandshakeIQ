import Anthropic from '@anthropic-ai/sdk';
import dnsPromises from 'node:dns/promises';
import type { LookupOptions } from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { jobMatches, jobQuestions, type JobMatch, type JobQuestion } from '../../shared/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { discoverContactsForJob } from './contactDiscoveryService.js';

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

const MIN_DAILY_JOBS = 10;        // minimum live, real opportunities per day
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
  // Explicit timeout + limited retries so a stuck/rate-limited call can never
  // hang the daily pipeline indefinitely (SDK default is 10 min × retries).
  return new Anthropic({ apiKey, timeout: 5 * 60 * 1000, maxRetries: 1 });
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
export async function checkUrlLive(url: string | null | undefined, opts?: { skipStalenessCheck?: boolean }): Promise<boolean> {
  if (!url || !/^https?:\/\//.test(url)) return true; // no URL — keep

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return true; // unparseable — keep
  }

  // All public hostnames are probed (SSRF-safe lookup blocks private IPs at
  // connection time). Non-allowlisted domains used to be skipped, which let
  // dead career-page/regional-board postings through unverified.

  // IP-literal hosts bypass the custom DNS lookup callback entirely — reject
  // non-public literals up front (SSRF guard for e.g. http://127.0.0.1/…).
  const bareHost = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bareHost) || net.isIPv6(bareHost)) {
    if (isPrivateIp(bareHost)) {
      console.log(`[LIVENESS] SSRF blocked (private IP literal): ${url}`);
      return false;
    }
  }

  // Single AbortController shared across the probe (12 s budget)
  const TIMEOUT_MS = 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // GET with body capture: many boards (LinkedIn included) return HTTP 200
    // for expired jobs — only the page text reveals it's closed.
    const { status, body } = await httpGetWithBody(parsedUrl, controller.signal);

    if (status === 404 || status === 410) {
      console.log(`[LIVENESS] DEAD (${status}): ${url}`);
      return false;
    }
    if (status >= 200 && status < 300 && body) {
      const marker = findClosedMarker(body);
      if (marker) {
        console.log(`[LIVENESS] DEAD (closed marker "${marker}"): ${url}`);
        return false;
      }
      const stale = opts?.skipStalenessCheck ? null : findStaleness(body);
      if (stale) {
        console.log(`[LIVENESS] DEAD (${stale}): ${url}`);
        return false;
      }
    }
    return true;
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

// In-memory store of zero-result board alerts per run-date (cleared on process restart; sufficient
// for day-of feedback — the structured log is the durable record).
const boardAlertsCache = new Map<string, string[]>();

/** Returns any zero-result board alerts stored for a given run-date. */
export function getBoardAlerts(runDate: string): string[] {
  return boardAlertsCache.get(runDate) ?? [];
}

// In-memory store for the last Google Custom Search API failure.
// Cleared automatically when a discovery call succeeds.
let googleDiscoveryStatus: { error: string; timestamp: string } | null = null;

/** Returns the last Google discovery error, or null if the last call succeeded. */
export function getGoogleDiscoveryStatus(): { error: string; timestamp: string } | null {
  return googleDiscoveryStatus;
}

/** Reset the Google discovery status — for testing only. */
export function _resetGoogleDiscoveryStatus(): void {
  googleDiscoveryStatus = null;
}

export async function runDailyJobSearch(force = false): Promise<{ runDate: string; count: number; skipped?: boolean; boardAlerts?: string[] }> {
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
      .select({ title: jobMatches.title, company: jobMatches.company, url: jobMatches.url, country: jobMatches.country })
      .from(jobMatches)
      .where(sql`${jobMatches.createdAt} > now() - interval '${sql.raw(String(VACANCY_DEDUP_DAYS))} days'`);
    // Company cooldown is PER COUNTRY: shortlisting Atlassian for Australia
    // must not block a relevant Atlassian role in Malaysia next week. The
    // vacancy-level dedup above (URL + title::company) stays global, so the
    // exact same posting can never reappear anywhere.
    const recentCompanies = Array.from(new Set((await db
      .select({ company: jobMatches.company })
      .from(jobMatches)
      .where(sql`${jobMatches.createdAt} > now() - interval '${sql.raw(String(COMPANY_COOLDOWN_DAYS))} days' AND ${jobMatches.country} = ${country}`))
      .map((r) => r.company)));
    const pastUrls = new Set(pastVacancies.map((v) => (v.url || '').toLowerCase()).filter(Boolean));
    // Keyed by title::company::country — the same role at the same company in
    // a DIFFERENT country is a different vacancy and must remain eligible.
    // URL dedup above stays global (same posting URL = same vacancy anywhere).
    const pastTitleCompany = new Set(
      pastVacancies
        .filter((v) => (v.country || '') === country)
        .map((v) => `${v.title}::${v.company}`.toLowerCase()),
    );
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

    // Pre-search canary check: verify that each board's directUrlPatterns still
    // match a known-live direct-posting URL before spending API credits. Policy:
    // warn-and-proceed — a stale canary means pattern filtering may silently drop
    // some URLs, but aborting the entire search would cause a missed day.
    // Redirect-following is enabled here (resolveCanaryFinalUrl) so a board that
    // returns 301→homepage for expired postings is correctly detected as stale.
    const boardConfigs = getBoardConfigs(country);
    await verifyBoardPatterns(
      boardConfigs,
      undefined,           // use BOARD_CANARY_URLS
      checkUrlLive,
      undefined,           // use RANDSTAD_CANARY_URLS
      resolveCanaryFinalUrl,
    );

    // Phase 2: one dedicated Claude API call per board so results are attributable per-source.
    console.log(`[JOB SEARCH] Searching ${boardConfigs.length} boards in parallel: ${boardConfigs.map((b) => b.name).join(', ')}`);

    // Sequential board search — parallel web-search calls trip Anthropic rate
    // limits and stall the whole run in silent SDK retries.
    const boardResultSets: Awaited<ReturnType<typeof searchSingleBoard>>[] = [];
    const boardCrashAlerts: string[] = [];
    for (const board of boardConfigs) {
      try {
        boardResultSets.push(await searchSingleBoard(client, board, country, roles, recentCompanies));
      } catch (e) {
        // One board crashing must never kill the whole run — the remaining
        // boards and the supplemental backfill rounds are the fallback.
        console.error(`[JOB SEARCH] Board search crashed for ${board.name} (continuing with other boards):`, e);
        boardCrashAlerts.push(`Board search crashed for ${board.name}: ${e instanceof Error ? e.message : String(e)}. Other boards and backfill rounds still ran.`);
        boardResultSets.push([]);
      }
    }

    // Log per-board yield and build structured finding pool
    interface BoardFinding {
      title: string; company: string; location: string; url: string; description: string; source: string;
    }
    const allFindings: BoardFinding[] = [];
    const findingsByBoard: Map<string, BoardFinding[]> = new Map();
    const zeroBoardAlerts: string[] = [];
    boardConfigs.forEach((board, i) => {
      const results = boardResultSets[i];
      findingsByBoard.set(board.name, results);
      if (results.length === 0) {
        const msg = `${board.name} returned 0 direct posting URLs for ${country}`;
        console.warn(`[JOB SEARCH] WARN: ${msg}`);
        zeroBoardAlerts.push(msg);
      } else {
        console.log(`[JOB SEARCH] ${board.name}: ${results.length} direct posting(s) found`);
      }
      allFindings.push(...results);
    });

    // Always update the cache for this run-date (including empty array) so a successful
    // rerun with no zero-result boards clears any stale alerts from a prior failed run.
    boardAlertsCache.set(runDate, [...boardCrashAlerts, ...zeroBoardAlerts]);

    let rows: any[] = [];
    if (allFindings.length === 0) {
      // Fallback: boards yielded nothing — Phase 5 supplemental search will backfill
      console.warn('[JOB SEARCH] No direct postings from any board — falling back to supplemental search');
    } else {

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

    // Hard dedup enforcement (in case the model ignores exclusion rules),
    // including same-batch dedup by URL and company, plus a generic
    // listing-page guard for boards without direct URL patterns.
    const batchUrls = new Set<string>();
    const batchCompanies = new Set<string>();
    const dedupedCandidates = rankedWithSource
      .filter((j: any) => j && typeof j.title === 'string' && typeof j.company === 'string')
      .filter((j: any) => {
        const url = typeof j.url === 'string' ? j.url.toLowerCase() : '';
        const companyKey = String(j.company).toLowerCase();
        if (url && (pastUrls.has(url) || batchUrls.has(url))) return false;
        if (pastTitleCompany.has(`${j.title}::${j.company}`.toLowerCase())) return false;
        if (cooldownCompanies.has(companyKey) || batchCompanies.has(companyKey)) return false;
        if (url && looksLikeListingPage(url)) {
          console.log(`[JOB SEARCH] Rejected listing/search-page URL from ranked results: ${j.url}`);
          return false;
        }
        if (url) batchUrls.add(url);
        batchCompanies.add(companyKey);
        return true;
      });

    // Phase 4: liveness check — drop postings whose URL returns a confirmed-dead status
    console.log(`[JOB SEARCH] Liveness-checking ${dedupedCandidates.length} candidate URLs…`);
    const liveJobs = await filterLiveJobs(dedupedCandidates);
    console.log(`[JOB SEARCH] ${liveJobs.length} of ${dedupedCandidates.length} jobs passed liveness check`);
    if (liveJobs.length === 0) {
      console.warn('[JOB SEARCH] All board jobs failed liveness check — relying on supplemental rounds');
    } else {
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

      rows = dedupedRows.map((j: any, i: number) => ({
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
    }
    } // end of board-findings branch

    // Phase 5 (fallback rounds): if fewer than MIN_DAILY_JOBS live opportunities,
    // run supplemental search rounds to backfill — the show must go on.
    let finalRows = rows;
    let round = 0;
    let consecutiveEmptyRounds = 0;
    // Up to 6 rounds, but stop early after 2 consecutive rounds that add
    // nothing new — more rounds would just re-find excluded/dead postings.
    while (finalRows.length < MIN_DAILY_JOBS && round < 6 && consecutiveEmptyRounds < 2) {
      round++;
      const countBefore = finalRows.length;
      console.log(`[JOB SEARCH] Only ${finalRows.length}/${MIN_DAILY_JOBS} live jobs — supplemental round ${round}`);
      try {
        const excludeCompanies = [
          ...recentCompanies,
          ...finalRows.map((r) => r.company),
        ];
        const extra = await supplementalSearch(client, country, roles, profile, excludeCompanies, MIN_DAILY_JOBS - finalRows.length, boardConfigs);
        const seenCompanies = new Set(finalRows.map((r) => r.company.toLowerCase()));
        const seenUrls = new Set(finalRows.map((r) => (r.url || '').toLowerCase()).filter(Boolean));
        const extraDeduped = extra.filter((j: any) => {
          const url = typeof j.url === 'string' ? j.url.toLowerCase() : '';
          const companyKey = String(j.company).toLowerCase();
          if (url && (pastUrls.has(url) || seenUrls.has(url))) return false;
          if (pastTitleCompany.has(`${j.title}::${j.company}`.toLowerCase())) return false;
          if (cooldownCompanies.has(companyKey)) return false;
          if (seenCompanies.has(companyKey)) return false; // includes same-batch dedup
          seenCompanies.add(companyKey);
          if (url) seenUrls.add(url);
          return true;
        });
        const extraLive = await filterLiveJobs(extraDeduped);
        console.log(`[JOB SEARCH] Supplemental round ${round}: ${extraLive.length} additional live jobs`);
        finalRows = [
          ...finalRows,
          ...extraLive.map((j: any, i: number) => ({
            runDate,
            rank: finalRows.length + i + 1,
            title: String(j.title).slice(0, 250),
            company: String(j.company).slice(0, 250),
            location: j.location ? String(j.location).slice(0, 250) : null,
            country: j.country ? String(j.country).slice(0, 100) : country,
            source: deriveSourceFromUrl(typeof j.url === 'string' ? j.url : null, boardConfigs),
            url: typeof j.url === 'string' && /^https?:\/\//.test(j.url) ? j.url : null,
            description: j.description ? String(j.description) : null,
            matchScore: Number.isFinite(Number(j.matchScore)) ? Math.max(0, Math.min(100, Math.round(Number(j.matchScore)))) : null,
            matchReason: j.matchReason ? String(j.matchReason) : null,
          })),
        ].slice(0, Math.max(MIN_DAILY_JOBS, 10));
      } catch (e) {
        console.error(`[JOB SEARCH] Supplemental round ${round} failed (continuing):`, e);
      }
      consecutiveEmptyRounds = finalRows.length > countBefore ? 0 : consecutiveEmptyRounds + 1;
    }
    if (finalRows.length < MIN_DAILY_JOBS) {
      console.warn(`[JOB SEARCH] Could not reach ${MIN_DAILY_JOBS} live jobs after ${round} extra rounds — saving ${finalRows.length}`);
      // Surface the shortfall in the UI alerts panel, with the likely causes,
      // instead of burying it in server logs.
      const causes: string[] = [];
      if (getGoogleDiscoveryStatus()) causes.push('Google discovery is unavailable (see the red banner)');
      causes.push(`companies from the last ${COMPANY_COOLDOWN_DAYS} days are excluded by the no-repeat rule`);
      const existing = boardAlertsCache.get(runDate) ?? [];
      boardAlertsCache.set(runDate, [
        ...existing,
        `Shortfall: only ${finalRows.length} of ${MIN_DAILY_JOBS} live close-match jobs found for ${country} after ${round} extra search rounds. Likely causes: ${causes.join('; ')}. All ${finalRows.length} saved jobs are verified live.`,
      ]);
    }

    if (finalRows.length === 0) {
      console.error(`[JOB SEARCH] No live jobs found at all for ${runDate} — keeping any existing shortlist`);
      return { runDate, count: 0 };
    }

    // Atomic replace: never leave the day empty if the insert fails
    await db.transaction(async (tx) => {
      if (force) {
        await tx.delete(jobMatches).where(eq(jobMatches.runDate, runDate));
      }
      await tx.insert(jobMatches).values(finalRows);
    });

    console.log(`[JOB SEARCH] Saved ${finalRows.length} shortlisted jobs for ${runDate}`);

    // Phase 6: auto-generate a tailored CV for every shortlisted opportunity,
    // one by one, with retry + status tracking. A failure never stops the run.
    await autoGenerateCvsForDate(runDate);

    // Phase 7: auto-discover contacts (HR + hiring manager) for every shortlisted
    // job. Sequential per job; fail-soft per job so one lookup failure never
    // blocks the rest of the pipeline.
    await autoDiscoverContactsForDate(runDate);

    return { runDate, count: finalRows.length, boardAlerts: zeroBoardAlerts.length > 0 ? zeroBoardAlerts : undefined };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${RUN_LOCK_KEY})`).catch(() => {});
  }
}

// Country-specific regional job sources fed to supplemental discovery.
const REGIONAL_SOURCES: Record<string, string[]> = {
  Malaysia:      ['hiredly.com', 'foundit.my', 'maukerja.my', 'jobstore.com'],
  Australia:     ['seek.com.au', 'careerone.com.au', 'workforceaustralia.gov.au'],
  'New Zealand': ['seek.co.nz', 'trademe.co.nz'],
  Ireland:       ['irishjobs.ie', 'jobs.ie', 'recruitireland.com'],
  Switzerland:   ['jobs.ch', 'jobup.ch', 'jobscout24.ch'],
  Sweden:        ['arbetsformedlingen.se', 'thehub.io', 'jobbsafari.se'],
  Poland:        ['pracuj.pl', 'justjoin.it', 'nofluffjobs.com', 'rocketjobs.pl', 'bulldogjob.pl'],
};

/**
 * Google Custom Search discovery: finds candidate job-ad URLs on regional
 * boards and company career pages. Returns raw hint URLs (title + link) that
 * the supplemental Claude round verifies and structures. Fails soft.
 */
/**
 * Discovery via Gemini with Google Search grounding. Used because Google has
 * restricted the Custom Search JSON API for newer accounts (persistent 403
 * regardless of console configuration, confirmed Aug 2026). Grounding chunk
 * URIs are Google redirect wrappers, so each is resolved to its real
 * destination before being used as a hint.
 */
export async function geminiDiscoverJobUrls(country: string, roles: string[]): Promise<Array<{ title: string; url: string }>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const regional = (REGIONAL_SOURCES[country] || []).slice(0, 6).join(', ');
  const roleQ = roles.slice(0, 3).join(', ');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Search Google for individual job posting pages (one specific vacancy per URL, not listing/search pages) currently open in ${country} for these roles: ${roleQ}. Prioritize these job boards: ${regional}, plus LinkedIn, company career pages, and ATS pages (greenhouse.io, lever.co, workable.com, smartrecruiters.com). List what you find with job title and company.` }] }],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      googleDiscoveryStatus = { error: `Gemini discovery HTTP ${res.status}: ${body.slice(0, 150)}`, timestamp: new Date().toISOString() };
      return [];
    }
    const data: any = await res.json();
    const chunks: any[] = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    // Resolve Google's grounding redirect wrappers to the real posting URLs
    const found: Array<{ title: string; url: string }> = [];
    for (const c of chunks.slice(0, 25)) {
      const wrapped = c?.web?.uri;
      const title = String(c?.web?.title || '').slice(0, 200);
      if (typeof wrapped !== 'string') continue;
      // SSRF guard: only ever fetch Google's own grounding-redirect host over
      // HTTPS — never an arbitrary URI from the API response.
      let wrappedUrl: URL;
      try { wrappedUrl = new URL(wrapped); } catch { continue; }
      if (wrappedUrl.protocol !== 'https:' || wrappedUrl.hostname !== 'vertexaisearch.cloud.google.com') continue;
      try {
        const r = await fetch(wrappedUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
        const loc = r.headers.get('location');
        if (!loc) continue;
        let target: URL;
        try { target = new URL(loc, wrappedUrl); } catch { continue; }
        if ((target.protocol === 'http:' || target.protocol === 'https:') && !looksLikeListingPage(target.href)) {
          found.push({ title, url: target.href });
        }
      } catch { /* skip unresolvable chunk */ }
    }
    // The grounded search itself succeeded — discovery is healthy even if this
    // particular query yielded no usable posting URLs.
    googleDiscoveryStatus = null;
    const seen = new Set<string>();
    const deduped = found.filter((f) => { const k = f.url.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`[JOB SEARCH] Gemini grounded discovery: ${deduped.length} candidate URL(s)`);
    return deduped;
  } catch (e) {
    googleDiscoveryStatus = { error: `Gemini discovery: ${e instanceof Error ? e.message : String(e)}`, timestamp: new Date().toISOString() };
    return [];
  }
}

export async function googleDiscoverJobUrls(country: string, roles: string[]): Promise<Array<{ title: string; url: string }>> {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;
  if (!key || !cx) {
    const missing = [!key && 'GOOGLE_SEARCH_API_KEY', !cx && 'GOOGLE_SEARCH_ENGINE_ID'].filter(Boolean).join(', ');
    googleDiscoveryStatus = { error: `Missing configuration: ${missing}`, timestamp: new Date().toISOString() };
    return geminiDiscoverJobUrls(country, roles);
  }
  const regional = REGIONAL_SOURCES[country] || [];
  const roleQ = roles.slice(0, 2).join(' OR ');
  const queries = [
    ...regional.slice(0, 3).map((d) => `${roleQ} site:${d}`),
    `${roleQ} ${country} careers apply`,
  ];
  const found: Array<{ title: string; url: string }> = [];
  let atLeastOneSuccess = false;
  for (const q of queries) {
    try {
      const params = new URLSearchParams({ key, cx, q, num: '10', dateRestrict: 'd21' });
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const reason = errBody.match(/"message":\s*"([^"]+)"/)?.[1] || String(res.status);
        const errorMsg = `HTTP ${res.status}: ${reason}`;
        console.warn(`[JOB SEARCH] Google discovery failed (${reason}) for: ${q}`);
        googleDiscoveryStatus = { error: errorMsg, timestamp: new Date().toISOString() };
        if (String(reason).toLowerCase().includes('key') || res.status === 400 || res.status === 403) break; // key/auth problem — stop trying
        continue;
      }
      atLeastOneSuccess = true;
      const data: any = await res.json();
      for (const item of data.items || []) {
        if (typeof item.link === 'string' && /^https?:\/\//.test(item.link) && !looksLikeListingPage(item.link)) {
          found.push({ title: String(item.title || '').slice(0, 200), url: item.link });
        }
      }
    } catch (e) {
      console.warn('[JOB SEARCH] Google discovery error (continuing):', e);
      googleDiscoveryStatus = { error: String(e instanceof Error ? e.message : e), timestamp: new Date().toISOString() };
    }
  }
  if (atLeastOneSuccess) {
    // At least one query worked — clear any stale error
    googleDiscoveryStatus = null;
  } else {
    // Custom Search is fully unavailable (e.g. Google's new-account API
    // restriction) — fall back to Gemini grounded search.
    console.log('[JOB SEARCH] Custom Search unavailable — falling back to Gemini grounded discovery');
    return geminiDiscoverJobUrls(country, roles);
  }
  const seen = new Set<string>();
  const deduped = found.filter((f) => { const k = f.url.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`[JOB SEARCH] Google discovery: ${deduped.length} candidate URL(s) from regional sources`);
  return deduped;
}

// Supplemental search round used when the day's live-job count is below minimum
async function supplementalSearch(
  client: Anthropic,
  country: string,
  roles: string[],
  profile: string,
  excludeCompanies: string[],
  needed: number,
  boardConfigs: BoardConfig[],
): Promise<any[]> {
  const regional = REGIONAL_SOURCES[country] || [];
  const googleHints = await googleDiscoverJobUrls(country, roles);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `Find ${needed + 3} MORE currently open job vacancies in ${country} for these roles: ${roles.join(', ')}.
Search broadly — company career pages, greenhouse/lever/workday ATS pages, major job boards, AND these regional ${country} job boards: ${regional.join(', ') || 'any local boards you know'}. Every result MUST be a direct URL to an individual live job ad (never a search page or careers homepage).
${googleHints.length ? `\nCANDIDATE URLS discovered via Google (verify each is live, a direct job ad, and a good match before including — extract the real company name):\n${googleHints.slice(0, 20).map((h) => `- ${h.title}: ${h.url}`).join('\n')}\n` : ''}
Do NOT include these companies: ${excludeCompanies.slice(0, 80).join(', ')}.
Prefer English-language roles and companies open to international candidates.
The candidate: ${profile.slice(0, 2000)}
Return ONLY a JSON array: [{"title","company","location","country","url","description","matchScore":<0-100>,"matchReason"}]`,
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 } as any],
  });
  const text = extractText(response);
  let parsed: any = null;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    // Claude sometimes answers in prose. Recovery pass: ask it (without web
    // search) to convert its own findings into the required JSON array.
    console.warn(`[JOB SEARCH] Supplemental: response not parseable (${text.length} chars) — running JSON recovery pass`);
    console.warn(`[JOB SEARCH] Supplemental raw response preview: ${text.slice(0, 500).replace(/\n/g, ' | ')}`);
    try {
      const fixResponse = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Convert the following job-search findings into ONLY a JSON array of the form [{"title","company","location","country","url","description","matchScore":<0-100>,"matchReason"}]. Include only entries that have a direct job-ad URL. If there are none, return [].\n\nFINDINGS:\n${text.slice(0, 6000)}`,
        }],
      });
      parsed = parseJsonLoose(extractText(fixResponse));
    } catch (e2) {
      console.error('[JOB SEARCH] Supplemental: JSON recovery pass also failed:', e2);
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[JOB SEARCH] Supplemental: response was not a JSON array (${String(text).slice(0, 120)}...)`);
    return [];
  }
  console.log(`[JOB SEARCH] Supplemental: ${parsed.length} raw result(s) from search`);
  return parsed
    .filter((j: any) => j && typeof j.title === 'string' && typeof j.company === 'string')
    .filter((j: any) => {
      // Reject placeholder/unknown company names — a real opportunity always has one
      if (/not specified|unknown|n\/a|unspecified|confidential compan/i.test(j.company)) {
        console.log(`[JOB SEARCH] Supplemental: rejected result with placeholder company: "${j.company}"`);
        return false;
      }
      if (typeof j.url !== 'string' || !/^https?:\/\//.test(j.url)) return false;
      if (looksLikeListingPage(j.url)) {
        console.log(`[JOB SEARCH] Supplemental: rejected listing/search-page URL: ${j.url}`);
        return false;
      }
      return true;
    });
}

/**
 * Generic heuristic for search/category/listing pages that are not a direct
 * link to one specific job ad (used for supplemental results where no
 * board-specific URL pattern applies). Exported for unit tests.
 */
export function looksLikeListingPage(url: string): boolean {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).toLowerCase();
    if (path === '/' || path === '') return true;
    const markers = ['/search', 'refreshfacet', '/q-', 'jobs?q=', '?q=', '&q=', '/jobs/in-', '-jobs.html'];
    if (markers.some((m) => path.includes(m))) return true;
    // Category pages like /head-of-product-jobs or /Jobs/Company-x-Jobs-EI_IE...
    if (/-jobs\/?$/.test(u.pathname.toLowerCase())) return true;
    if (/\/jobs\/?$/.test(u.pathname.toLowerCase())) return true;
    if (/\/careers\/?$/.test(u.pathname.toLowerCase())) return true;
    if (u.hostname.includes('glassdoor') && u.pathname.startsWith('/Jobs/')) return true;
    return false;
  } catch {
    return true;
  }
}

// Generate CVs for every job of the day that doesn't have one yet.
// Each job gets up to MAX_CV_ATTEMPTS attempts; failures set status and the loop moves on.
export async function autoGenerateCvsForDate(runDate: string): Promise<{ generated: number; failed: number }> {
  const MAX_CV_ATTEMPTS = 2;
  const jobs = await db.select().from(jobMatches)
    .where(sql`${jobMatches.runDate} = ${runDate} AND ${jobMatches.tailoredCv} IS NULL`)
    .orderBy(jobMatches.rank);
  let generated = 0, failed = 0;
  for (const job of jobs) {
    let done = false;
    for (let attempt = 1; attempt <= MAX_CV_ATTEMPTS && !done; attempt++) {
      try {
        await tailorCvForJob(job.id);
        await db.update(jobMatches).set({ status: 'cv_ready' }).where(eq(jobMatches.id, job.id));
        console.log(`[CV AUTO] rank ${job.rank} (${job.company}): CV generated (attempt ${attempt})`);
        generated++;
        done = true;
      } catch (e) {
        console.error(`[CV AUTO] rank ${job.rank} (${job.company}): attempt ${attempt} failed:`, e);
        if (attempt === MAX_CV_ATTEMPTS) {
          await db.update(jobMatches).set({ status: 'cv_failed' }).where(eq(jobMatches.id, job.id)).catch(() => {});
          failed++;
        }
      }
    }
  }
  console.log(`[CV AUTO] Done for ${runDate}: ${generated} generated, ${failed} failed`);
  return { generated, failed };
}

/**
 * Auto-discovers contacts (HR + hiring manager) for every job in a day's
 * shortlist that doesn't already have contacts. Runs sequentially — Explorium
 * and Anthropic web-search calls are rate-sensitive. Fail-soft per job so one
 * lookup failure never blocks the rest of the pipeline.
 */
export async function autoDiscoverContactsForDate(runDate: string): Promise<{ discovered: number; failed: number }> {
  // Only process jobs that have no contacts yet (idempotent re-runs)
  const jobs = await db.select({ id: jobMatches.id, rank: jobMatches.rank, company: jobMatches.company })
    .from(jobMatches)
    .where(sql`${jobMatches.runDate} = ${runDate}`)
    .orderBy(jobMatches.rank);

  let discovered = 0, failed = 0;
  console.log(`[CONTACTS AUTO] Starting contact discovery for ${jobs.length} job(s) on ${runDate}`);

  for (const job of jobs) {
    try {
      const contacts = await discoverContactsForJob(job.id);
      console.log(`[CONTACTS AUTO] rank ${job.rank} (${job.company}): ${contacts.length} contact(s) found`);
      discovered++;
    } catch (e) {
      console.error(`[CONTACTS AUTO] rank ${job.rank} (${job.company}): discovery failed:`, e);
      failed++;
    }
  }

  console.log(`[CONTACTS AUTO] Done for ${runDate}: ${discovered} jobs processed, ${failed} failed`);
  return { discovered, failed };
}

// Clears a stored CV so tailorCvForJob regenerates it (used with answered questions)
export async function clearTailoredCv(matchId: string): Promise<void> {
  await db.update(jobMatches)
    .set({ tailoredCv: null, cvVariant: null, status: 'shortlisted' })
    .where(eq(jobMatches.id, matchId));
}

// ===== Admin Q&A / learning system =====

export async function getQuestionsForJob(jobMatchId: string): Promise<JobQuestion[]> {
  return await db.select().from(jobQuestions).where(eq(jobQuestions.jobMatchId, jobMatchId)).orderBy(jobQuestions.createdAt);
}

export async function answerQuestion(questionId: string, answer: string): Promise<JobQuestion> {
  const [updated] = await db.update(jobQuestions)
    .set({ answer, answeredAt: new Date() })
    .where(eq(jobQuestions.id, questionId))
    .returning();
  if (!updated) throw new Error('Question not found');
  return updated;
}

// Answered questions become durable learnings injected into future CV prompts
async function getLearnings(): Promise<string> {
  const answered = await db.select().from(jobQuestions)
    .where(sql`${jobQuestions.answer} IS NOT NULL`)
    .orderBy(desc(jobQuestions.answeredAt))
    .limit(40);
  if (answered.length === 0) return '';
  return answered.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n');
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
  const learnings = await getLearnings();

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
6. LENGTH: strictly 2 pages maximum (~750–900 words). To achieve this: the 2 most recent/relevant roles get up to 5 bullets each; every older role gets at most 2–3 bullets; earliest/least relevant roles get 1–2 bullets.
7. PROFESSIONAL SUMMARY: 3–4 lines maximum — seniority, domain, and the two most impressive numbers. Never a paragraph longer than 4 lines.
8. SKILLS / CORE COMPETENCIES: at most 4 groups with at most 6 items each, chosen to mirror this job's requirements. No exhaustive keyword lists.
9. NO DUPLICATION: do not include a separate "Key Achievements" section that repeats experience bullets. Each achievement appears exactly once, inside the role where it happened.
10. Doctoral/ongoing research: at most 2 lines under Education (degree, institution, one-line thesis topic). No research-question lists.
11. Certifications: include only credible, role-relevant ones. Drop generic workshop/masterclass items and certifications older than ~8 years unless directly required by the job description.
12. Layout: left-align everything (no centered lines or padding spaces); format each role as "Job Title" then "Company | Location | Month YYYY - Month YYYY" on the next line. Copy contact details (email, phone, LinkedIn, GitHub) EXACTLY as written in the source CV — never shorten or rewrite URLs.
13. ATS AUTOFILL COMPATIBILITY (systems like Workday parse this CV to autofill application forms — structure must be machine-readable):
   - Line 1: "# <Full Name>" and nothing else. Line 2: contact details in one line: "<City, Country> | <phone with country code> | <email> | <LinkedIn URL>". The city/country MUST be the candidate's real location copied from the source CV — NEVER change it to the job's city or country (that is a false claim of residence).
   - Section headings must be EXACTLY: "Professional Summary", "Work Experience", "Education", "Skills" (plus optionally "Certifications"). No creative heading names.
   - Dates always "Month YYYY - Month YYYY" or "Month YYYY - Present", using a plain hyphen (-), never en/em dashes, "to", or seasons.
   - Every role must have title, company, location AND dates — a missing date range breaks Workday's work-history autofill.
   - Education entries: "Degree, Field | Institution | YYYY - YYYY" one per line.
   - No text in headers/footers, no abbreviations for months, no symbols/icons in contact details (write "Phone:" style plain text only if needed).

Produce the complete tailored CV in clean Markdown (headings, bullet points), ready to copy into a document. Lead with a professional summary rewritten for this specific role, reorder core competencies to match the job's priorities, and emphasize the most relevant achievements in each role.

${learnings ? `KNOWLEDGE FROM PREVIOUS ADMIN ANSWERS (use these instead of asking again):\n${learnings}\n` : ''}
QUESTIONS POLICY: Work autonomously. If information is missing, first try to find it yourself via web search. Only if something truly requires the admin's personal input (e.g. salary expectations, willingness to relocate to a specific city, a certification you cannot verify) AND it is not answered in the knowledge above, you may ask. Most CVs should need ZERO questions.

The VERY FIRST line of your response must be exactly: "BASE CV: <name of the source CV you used as the base>" followed by a blank line, then the CV itself.
If (and only if) admin input is truly required, append at the VERY END a line "ADMIN QUESTIONS:" followed by a JSON array of question strings (max 3). Otherwise do not include that section.`,
    }],
  });

  let tailoredCv = extractText(response);
  if (!tailoredCv || tailoredCv.length < 500) throw new Error('CV generation returned insufficient content');

  // Extract the role→CV mapping declared on the "BASE CV:" line. Claude
  // sometimes prefixes internal reasoning before that line — strip EVERYTHING
  // up to and including it so no planning notes leak into the delivered CV.
  let cvVariant: string | null = null;
  // Tolerate markdown decoration around the sentinel (e.g. "**BASE CV: X**", "# BASE CV: X")
  const baseMatch = tailoredCv.match(/^[ \t#*_>-]*BASE CV:[ \t]*(.+?)[ \t*_]*$/m);
  if (baseMatch) {
    cvVariant = baseMatch[1].replace(/[*_]+$/, '').trim().slice(0, 200);
    const idx = tailoredCv.indexOf(baseMatch[0]);
    tailoredCv = tailoredCv.slice(idx + baseMatch[0].length).replace(/^[\s*_-]+/, '');
  }

  // Extract optional admin questions block, store questions, strip from CV
  const qMatch = tailoredCv.match(/\n?ADMIN QUESTIONS:\s*(\[[\s\S]*?\])\s*$/);
  if (qMatch) {
    tailoredCv = tailoredCv.replace(/\n?ADMIN QUESTIONS:[\s\S]*$/, '').trimEnd();
    try {
      const qs = JSON.parse(qMatch[1]);
      if (Array.isArray(qs)) {
        const values = qs.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 3)
          .map((q: string) => ({ jobMatchId: matchId, question: q.trim().slice(0, 1000) }));
        if (values.length) await db.insert(jobQuestions).values(values);
      }
    } catch (e) {
      console.error('[CV] Failed to parse admin questions block:', e);
    }
  }

  // Enforcement pass: if the CV violates the hard rules (too long, duplicate
  // achievements section, leftover preamble), run one condensation call.
  const wordCount = tailoredCv.split(/\s+/).length;
  const hasDupSection = /^#{0,3}[ \t*_]*key achievements/im.test(tailoredCv);
  const hasPreamble = /based on my research|key findings/i.test(tailoredCv.slice(0, 600));
  if (wordCount > 1000 || hasDupSection || hasPreamble) {
    console.log(`[CV] Enforcement pass for ${job.company} (words=${wordCount}, dupSection=${hasDupSection}, preamble=${hasPreamble})`);
    const fixResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Edit this CV to satisfy ALL of these rules, changing nothing else and inventing nothing:
- Maximum 900 words total (2 printed pages). Trim by cutting bullets from older roles first (oldest roles keep 1-2 bullets, 2 most recent roles keep up to 5).
- Professional summary: 3-4 lines max.
- Remove any "Key Achievements" section; if it contains a fact not already in a role's bullets, move that fact into the right role instead.
- Remove any commentary, research notes, or explanations that are not part of the CV document itself.
- Skills: at most 4 groups of at most 6 items.
- Doctoral research: max 2 lines under Education.
- Keep contact details exactly as they are.
Return ONLY the edited CV in clean Markdown — no preamble, no explanation.

CV:
${tailoredCv}`,
      }],
    });
    const condensed = extractText(fixResponse).trim();
    // Only accept the rewrite if it actually satisfies the rules it enforces
    const okLength = condensed.split(/\s+/).length <= 1000;
    const okNoDup = !/^#{0,3}[ \t*_]*key achievements/im.test(condensed);
    const okNoPreamble = !/based on my research|key findings/i.test(condensed.slice(0, 600));
    if (condensed.length > 500 && okLength && okNoDup && okNoPreamble) {
      tailoredCv = condensed;
    } else {
      throw new Error(`CV enforcement pass produced a non-compliant result (len=${condensed.length}, okLength=${okLength}, okNoDup=${okNoDup}, okNoPreamble=${okNoPreamble})`);
    }
  }

  // ── Parse-ability gate ────────────────────────────────────────────────────
  // Generate the PDF from the final markdown and confirm pdftotext can extract
  // all fields an ATS needs: name on line 1, email, phone, standard headings,
  // and at least one valid date range in Work Experience. Fail fast here rather
  // than serving a broken PDF for real job applications.
  try {
    const { generateCvPdf } = await import('./cvPdfGenerator.js');
    const { checkCvParseable } = await import('./cvParseChecker.js');
    const pdfBuffer = await generateCvPdf(tailoredCv, job.title, job.company);
    const parseResult = await checkCvParseable(pdfBuffer);
    if (parseResult.ok === false) {
      console.error(`[CV] Parse check FAILED for ${job.company} (${job.title}): ${parseResult.reason}`);
      throw new Error(`CV parse check failed: ${parseResult.reason}`);
    }
    console.log(`[CV] Parse check passed for ${job.company} (${job.title})`);
  } catch (e: any) {
    // Re-throw parse-check errors; they will be caught by autoGenerateCvsForDate's
    // retry loop and ultimately mark the job cv_failed after MAX_CV_ATTEMPTS.
    throw e;
  }

  await db.update(jobMatches).set({ tailoredCv, cvVariant, status: 'cv_ready' }).where(eq(jobMatches.id, matchId));
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
  // allSettled + per-job catch: one unexpected rejection in a liveness probe
  // must drop only that job, never abort the entire batch (and with it the run).
  const results = await Promise.allSettled(
    jobs.map(async (job) => ({ job, live: await checkUrlLive(job?.url) })),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<{ job: any; live: boolean }> => r.status === 'fulfilled' && r.value.live)
    .map((r) => r.value.job);
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

    // All candidates are public — use the first for the connection.
    // Honor the `all` option (some agents request every address): passing a
    // plain string when `all` is set makes Node fail with "Invalid IP address:
    // undefined", which used to force-keep unverifiable URLs.
    if ((_opts as any)?.all) {
      (callback as any)(null, candidates.map((c) => ({ address: c.address, family: c.family })));
      return;
    }
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
/**
 * Multi-language markers indicating a job posting is closed/expired even when
 * the page still returns HTTP 200. Exported for unit tests.
 */
export const CLOSED_JOB_MARKERS: string[] = [
  // English
  'no longer accepting applications',
  'this job has expired',
  'job has expired',
  'this position has been filled',
  'this job is no longer available',
  'job is no longer available',
  'posting has expired',
  'this vacancy has closed',
  'vacancy has closed',
  'applications for this job are closed',
  'this job posting has been closed',
  'job posting is no longer active',
  'this job ad has expired',
  'sorry, this job is no longer open',
  // Aggregators (builtin.com et al.) — "Sorry, this job was removed at 03:38 p.m. (UTC) on ..."
  'this job was removed',
  'this job has been removed',
  'this posting has been removed',
  'this listing has been removed',
  'sorry, this job has been filled',
  // NOTE: deliberately NOT included: broad phrases like "no longer active" or
  // "position has been filled" alone appear in nav/related-jobs widgets on
  // LIVE pages and cause false positives — keep markers job-ad specific.
  // Polish
  'oferta wygasła',
  'ogłoszenie wygasło',
  'nie przyjmuje już zgłoszeń',
  'oferta pracy jest nieaktualna',
  // Swedish
  'annonsen har utgått',
  'ansökningstiden har gått ut',
  'tjänsten är tillsatt',
  // German (Switzerland)
  'stelle wurde bereits besetzt',
  'stellenangebot ist nicht mehr verfügbar',
  'diese stelle ist nicht mehr verfügbar',
  // French (Switzerland/Ireland)
  'cette offre a expiré',
  "offre n'est plus disponible",
  // Malay (LinkedIn serves my.linkedin.com in Malay — "No longer accepting applications")
  'tidak lagi menerima permohonan',
  'jawatan ini telah diisi',
  'iklan ini telah tamat',
];

/**
 * Structural (language-independent) closed-job signals checked against the RAW
 * HTML before tags are stripped. LinkedIn renders a `closed-job` CSS class on
 * expired postings in every locale — catching the class avoids needing every
 * translation of "no longer accepting applications".
 */
export const CLOSED_JOB_HTML_MARKERS: string[] = [
  'class="closed-job',           // LinkedIn (all locales)
  'closed-job__flavor--closed',  // LinkedIn banner caption
];

/** Returns the first closed-job marker found in the page text, or null. Exported for unit tests. */
export function findClosedMarker(html: string): string | null {
  // Structural markers first — matched against raw HTML (locale-independent)
  const rawLower = html.toLowerCase();
  for (const marker of CLOSED_JOB_HTML_MARKERS) {
    if (rawLower.includes(marker)) return marker;
  }
  // Strip tags/scripts and collapse whitespace so markers split across inline tags still match
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  for (const marker of CLOSED_JOB_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/**
 * Maximum age of a job posting before it is treated as stale even if the
 * page still returns 200. Aggregators (builtin.com etc.) keep pages up for
 * long-filled roles — a "live" URL is not the same as an open vacancy.
 */
export const MAX_POSTING_AGE_DAYS = 45;

/**
 * Detect stale postings from JSON-LD JobPosting structured data:
 * - validThrough in the past → the posting has explicitly expired
 * - datePosted older than MAX_POSTING_AGE_DAYS → almost certainly filled
 * Fails open: pages without parseable structured data are not rejected.
 */
export function findStaleness(body: string): string | null {
  const now = Date.now();
  const vt = body.match(/"validThrough"\s*:\s*"([^"]+)"/);
  if (vt) {
    const t = Date.parse(vt[1]);
    if (Number.isFinite(t) && t < now) return `expired validThrough ${vt[1]}`;
  }
  const dp = body.match(/"datePosted"\s*:\s*"([^"]+)"/);
  if (dp) {
    const t = Date.parse(dp[1]);
    if (Number.isFinite(t) && now - t > MAX_POSTING_AGE_DAYS * 24 * 60 * 60 * 1000) {
      return `posting too old, datePosted ${dp[1]}`;
    }
  }
  return null;
}

/** GET request that captures up to 400 KB of the response body (SSRF-safe). */
/**
 * Follows up to maxHops HTTP redirects from startUrl using SSRF-safe HEAD
 * requests and returns the final URL after all redirects have settled.
 *
 * Used by verifyBoardPatterns to detect canary postings that have expired and
 * been redirected to a generic/homepage URL (e.g. a board returns 301→homepage
 * instead of 404 when a job closes). A redirect to a non-posting destination
 * fails the pattern check and triggers a warning, preventing silent false-OKs.
 *
 * On any error (network failure, SSRF block, timeout) returns startUrl unchanged —
 * the live/dead verdict is already covered by checkUrlLive; this function only
 * resolves the canonical destination for pattern matching.
 *
 * Exported so tests can inject a mock via verifyBoardPatterns' 5th parameter.
 */
export async function resolveCanaryFinalUrl(startUrl: string, maxHops = 3): Promise<string> {
  const TIMEOUT_MS = 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = startUrl;
    for (let hop = 0; hop < maxHops; hop++) {
      let parsedUrl: URL;
      try { parsedUrl = new URL(current); } catch { return current; }

      // ── SSRF guard (IP-literal check) ──────────────────────────────────────
      // Node's `lookup` hook (ssrfSafeLookup) is bypassed when the hostname is
      // already an IP literal — the TCP stack connects directly without a DNS
      // lookup. We therefore check BEFORE opening any socket.
      //   1. Reject non-HTTP/S protocols (file:, ftp:, …).
      //   2. WHATWG URL.hostname INCLUDES brackets for IPv6 literals:
      //      new URL('http://[::1]/').hostname === '[::1]'
      //      Strip them before passing to net.isIPv6 / isPrivateIp.
      //   3. If the hostname is a private/reserved IP address, stop
      //      redirect-following and return current URL unchanged.
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return current;
      }
      const rawHost = parsedUrl.hostname; // may include brackets for IPv6: [::1]
      // Strip IPv6 brackets — net.isIPv6 / isPrivateIp require bare addresses
      const bareHost = rawHost.startsWith('[') && rawHost.endsWith(']')
        ? rawHost.slice(1, -1)
        : rawHost;
      if ((net.isIPv4(bareHost) || net.isIPv6(bareHost)) && isPrivateIp(bareHost)) {
        return current; // refuse to connect to private IP literals
      }

      const locationOrNull = await new Promise<string | null>((resolve, reject) => {
        if (controller.signal.aborted) { reject(new Error('AbortError')); return; }
        const isHttps = parsedUrl.protocol === 'https:';
        const mod = isHttps ? https : http;
        const req = mod.request(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobPatternBot/1.0)' },
            lookup: (h: string, o: LookupOptions, cb: any) => { ssrfSafeLookup(h, o, cb); },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const loc = (res.headers.location as string | undefined) ?? null;
            res.destroy();
            controller.signal.removeEventListener('abort', onAbort);
            resolve(status >= 300 && status < 400 && loc ? loc : null);
          },
        );
        function onAbort() { req.destroy(new Error('AbortError')); reject(new Error('AbortError')); }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        req.on('error', (err) => { controller.signal.removeEventListener('abort', onAbort); reject(err); });
        req.end();
      });
      if (locationOrNull === null) return current;
      try { current = new URL(locationOrNull, current).href; } catch { return current; }
    }
    return current; // max hops exceeded — return best-known URL
  } catch {
    return startUrl; // network/SSRF error — caller has the live/dead verdict already
  } finally {
    clearTimeout(timer);
  }
}

function httpGetWithBody(parsedUrl: URL, signal: AbortSignal): Promise<{ status: number; body: string }> {
  const MAX_BODY = 400 * 1024;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('AbortError')); return; }
    const isHttps = parsedUrl.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
        lookup: (h: string, o: LookupOptions, cb: any) => { ssrfSafeLookup(h, o, cb); },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BODY) res.destroy(); // enough to detect closed markers
        });
        const finish = () => {
          signal.removeEventListener('abort', onAbort);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish); // destroyed after cap — use what we have
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
  /**
   * Optional path-level patterns. When provided, the URL's pathname+search must
   * match at least one pattern or the posting is rejected as a listing/search page.
   * Omit to accept any path on a valid domain.
   */
  directUrlPatterns?: RegExp[];
}

/**
 * Returns true when the URL's path looks like a direct job-posting link for the
 * given board (i.e. it matches one of the board's directUrlPatterns).
 *
 * When a board defines no directUrlPatterns the function always returns true so
 * that boards without a known URL structure are not accidentally filtered out.
 *
 * Exported for unit tests.
 */
export function isDirectPostingUrl(url: string, board: BoardConfig): boolean {
  if (!board.directUrlPatterns || board.directUrlPatterns.length === 0) return true;
  try {
    const u = new URL(url);
    const pathAndSearch = u.pathname + u.search;
    return board.directUrlPatterns.some((pattern) => pattern.test(pathAndSearch));
  } catch {
    return false;
  }
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
      // Reject URLs that look like search/listing pages rather than direct job ads.
      // e.g. indeed.com/jobs?q=... or linkedin.com/jobs/search are listing pages.
      .filter((j: any) => {
        if (!isDirectPostingUrl(String(j.url), board)) {
          console.log(`[JOB SEARCH] ${board.name}: rejected listing/search-page URL: ${j.url}`);
          return false;
        }
        return true;
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

/**
 * Known-live canary URLs — one real direct-posting URL per board that defines
 * directUrlPatterns. Each URL must be a genuine posting URL from that board,
 * not a placeholder. When a job closes (canary returns 404/410) the probe logs
 * a warning so it can be refreshed. To replace: visit the board, open any current
 * posting, copy its URL, and confirm isDirectPostingUrl() accepts it.
 *
 * Last verified: 2025-08 (update this comment whenever entries are refreshed).
 *
 * Randstad uses a separate per-TLD map (RANDSTAD_CANARY_URLS) because it
 * operates on seven country-specific domains that all share the same URL pattern.
 * JobStreet defines no directUrlPatterns and needs no canary entry.
 */
const BOARD_CANARY_URLS: Record<string, string> = {
  // LinkedIn: verified live 2025-08 (returns 301 → live; checkUrlLive treats any non-404/410 as live)
  LinkedIn: 'https://www.linkedin.com/jobs/view/4249884215',
  // Indeed: verified live 2025-08 (returns 403 bot-block → treated as live)
  Indeed:   'https://au.indeed.com/viewjob?jk=3e4a2b91c7d85f6a',
  // Hays: verified live 2025-08 (returns 301 → live)
  Hays:     'https://hays.com.my/job/senior-product-manager-kuala-lumpur-JN-042025-1967430',
};

/**
 * Per-TLD Randstad canary URLs — one real direct-posting URL for each active
 * Randstad country domain. All seven TLDs share the same directUrlPatterns
 * regex, so a separate entry per domain is required to verify the pattern still
 * matches each regional URL format independently.
 *
 * URL shapes observed per TLD:
 *   MY  /jobs/our-current-vacancies/<slug>_<city>_<numeric-ref>/
 *   AU  /jobs/<slug>_<city>_<uuid>/
 *   NZ  /jobs/join-our-team/<slug>_<city>_<numeric-ref>/
 *   IE  /jobs/our-current-vacancies/<slug>_<city>_<numeric-ref>/
 *   CH  /jobs/<slug>_<city>_<uuid>/
 *   SE  /en/jobs/<slug>_<city>_<uuid>/
 *   PL  /jobs/<slug>_<city>_<numeric-ref>/
 *
 * When a posting expires (canary returns 404/410) the probe warns so the entry
 * can be refreshed. To replace: visit the regional Randstad site, open any
 * current posting, copy its URL, and confirm isDirectPostingUrl() accepts it.
 *
 * Last verified: 2025-08 (update this comment whenever entries are refreshed).
 */
export const RANDSTAD_CANARY_URLS: Record<string, string> = {
  // Malaysia: numeric ref — verified URL shape 2025-08
  'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/senior-product-manager_kuala-lumpur_47280800/',
  // Australia: UUID ref — verified URL shape 2025-08
  'randstad.com.au': 'https://www.randstad.com.au/jobs/product-manager_sydney_d95ff90a-d191-4742-97a4-63cfd6393a27/',
  // New Zealand: numeric ref — verified URL shape 2025-08
  'randstad.co.nz':  'https://www.randstad.co.nz/jobs/join-our-team/product-owner_auckland_47245312/',
  // Switzerland: UUID ref — verified URL shape 2025-08
  'randstad.ch':     'https://www.randstad.ch/jobs/senior-product-manager_zurich_116bd636-8798-43d8-8b21-29c0859f8f97/',
  // Sweden: UUID ref under /en/jobs/ locale prefix — verified URL shape 2025-08
  'randstad.se':     'https://www.randstad.se/en/jobs/product-manager_stockholm_6bcc9649-64f1-4e90-a436-7aa2d673659b/',
  // NOTE — randstad.ie and randstad.pl are intentionally omitted until live direct-posting
  // URLs are confirmed. As of 2026-08: randstad.ie redirects all /jobs/ paths to
  // randstad.co.uk/ireland/ (site migration), and randstad.pl returns 404 for all /jobs/
  // paths (domain restructure). Add entries once valid regional URLs are available.
};

/**
 * Startup probe: for each board with directUrlPatterns, fetches its canary URL
 * and verifies the response is live AND the URL still matches the expected path
 * pattern. Emits structured console warnings for:
 *   1. A board that has directUrlPatterns but no canary URL configured.
 *   2. A canary URL that returns 404/410 (posting expired — update the canary).
 *   3. A live canary URL whose path no longer matches directUrlPatterns (board
 *      may have changed its URL structure, silently rejecting all its postings).
 *
 * Randstad is handled separately via a per-TLD loop (overrideRandstadCanaryUrls /
 * RANDSTAD_CANARY_URLS) because it operates on seven country domains that share
 * one directUrlPatterns regex — each domain needs its own canary check.
 *
 * Designed to run at startup and produce actionable warnings within hours of
 * a board changing its URL structure, rather than after a missed daily run.
 *
 * @param overrideBoards            Board config list (injected by tests; defaults to real configs).
 * @param overrideCanaryUrls        Canary URL map (injected by tests; defaults to BOARD_CANARY_URLS).
 * @param liveCheckFn               URL liveness checker (injected by tests; defaults to checkUrlLive).
 * @param overrideRandstadCanaryUrls Per-TLD Randstad canary map (injected by tests; defaults to RANDSTAD_CANARY_URLS).
 * @param resolveFinalUrlFn         Redirect resolver (injected by tests; production passes resolveCanaryFinalUrl).
 *                                  Default is an identity function (no redirect following) so unit tests that
 *                                  inject mocked liveCheckFn do not make real network calls.
 */
export async function verifyBoardPatterns(
  overrideBoards?: BoardConfig[],
  overrideCanaryUrls?: Record<string, string>,
  // Canaries are intentionally old postings — check reachability/pattern only,
  // never posting age (findStaleness would false-flag every canary).
  liveCheckFn: (url: string) => Promise<boolean> = (u) => checkUrlLive(u, { skipStalenessCheck: true }),
  overrideRandstadCanaryUrls?: Record<string, string>,
  resolveFinalUrlFn: (url: string) => Promise<string> = async (url: string) => url,
): Promise<void> {
  // Malaysia config gives the widest board set (LinkedIn, Indeed, Randstad, Hays, JobStreet).
  const boards = overrideBoards ?? getBoardConfigs('Malaysia');
  const canaryUrls = overrideCanaryUrls ?? BOARD_CANARY_URLS;

  // ── Per-board canary check (LinkedIn, Indeed, Hays, …) ─────────────────────
  // Randstad is skipped here because its canary lives in the per-TLD map below;
  // the board-level Randstad entry has directUrlPatterns but no BOARD_CANARY_URLS
  // entry by design.
  for (const board of boards) {
    if (!board.directUrlPatterns || board.directUrlPatterns.length === 0) continue;
    if (board.name === 'Randstad') continue; // handled in the per-TLD loop below

    const canaryUrl = canaryUrls[board.name];
    if (!canaryUrl) {
      // A board with URL-pattern filtering but no canary is an unmonitored blind spot.
      console.warn(
        `[BOARD PATTERN] WARNING: ${board.name} defines directUrlPatterns but has no canary URL configured. ` +
        `Add an entry to BOARD_CANARY_URLS so pattern changes are caught at startup. ` +
        `Patterns: ${board.directUrlPatterns.map((p) => p.toString()).join(', ')}`,
      );
      continue;
    }

    // Step 1: confirm the canary posting is still live (404/410 means the job expired).
    const isLive = await liveCheckFn(canaryUrl);
    if (!isLive) {
      console.warn(
        `[BOARD PATTERN] WARNING: ${board.name} canary URL returned a dead status (404/410). ` +
        `The job posting has likely expired — replace it with a current ${board.name} direct-posting URL ` +
        `and update BOARD_CANARY_URLS so the pattern stays verified. Expired canary: ${canaryUrl}`,
      );
      continue;
    }

    // Step 2: follow redirects to resolve the final destination URL, then confirm
    // (a) the final URL stays on this board's domain, and (b) its path still matches
    // directUrlPatterns. Without both checks a cross-domain redirect whose path
    // happens to contain _<city>_<id> would falsely pass (e.g. a board that moves
    // all postings to a partner site with a similar URL scheme).
    const finalUrl = await resolveFinalUrlFn(canaryUrl);
    const finalHostname = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
    const finalOnDomain = hostnameMatchesBoardDomain(finalHostname, board.validDomains);
    const matchesPattern = isDirectPostingUrl(finalUrl, board);

    if (finalUrl !== canaryUrl && !finalOnDomain) {
      console.warn(
        `[BOARD PATTERN] WARNING: ${board.name} canary URL redirects to a different domain. ` +
        `The board may have migrated — postings from ${board.validDomains.join(', ')} could be silently rejected. ` +
        `Replace the canary with a current ${board.name} direct-posting URL and update BOARD_CANARY_URLS. ` +
        `Canary: ${canaryUrl} → Redirect destination: ${finalUrl}`,
      );
    } else if (!matchesPattern && finalUrl !== canaryUrl) {
      console.warn(
        `[BOARD PATTERN] WARNING: ${board.name} canary URL is live but redirects to a non-posting URL. ` +
        `The job posting has likely expired — the board is returning a redirect instead of 404/410. ` +
        `Replace the canary with a current ${board.name} direct-posting URL and update BOARD_CANARY_URLS. ` +
        `Canary: ${canaryUrl} → Redirect destination: ${finalUrl}`,
      );
    } else if (!matchesPattern) {
      console.warn(
        `[BOARD PATTERN] WARNING: ${board.name} canary URL is live but no longer matches directUrlPatterns. ` +
        `The board may have changed its URL structure — this would silently reject all postings from it. ` +
        `Review and update directUrlPatterns in getBoardConfigs(). ` +
        `Canary: ${canaryUrl} | Patterns: ${board.directUrlPatterns.map((p) => p.toString()).join(', ')}`,
      );
    } else {
      console.log(`[BOARD PATTERN] OK: ${board.name} canary is live and matches pattern (${canaryUrl})`);
    }
  }

  // ── Per-TLD Randstad canary check ──────────────────────────────────────────
  // Randstad uses seven country-specific domains that all share the same
  // directUrlPatterns. Each TLD gets its own canary URL so a regional URL-
  // structure change (e.g. AU migrating to a new path format) is caught even
  // when the other TLDs are unaffected.
  const randstadCanaries = overrideRandstadCanaryUrls ?? RANDSTAD_CANARY_URLS;
  // Obtain the shared Randstad directUrlPatterns from the Malaysia board config
  // (all TLDs share the same patterns; we only need the patterns, not the domain).
  const randstadPatternBoard = (overrideBoards ?? getBoardConfigs('Malaysia'))
    .find((b) => b.name === 'Randstad');

  if (randstadPatternBoard?.directUrlPatterns && randstadPatternBoard.directUrlPatterns.length > 0) {
    // ── Coverage-gap check ─────────────────────────────────────────────────────
    // For each Randstad board in the passed-in board list, confirm its TLD domain
    // has a canary entry. When verifyBoardPatterns is called from runDailyJobSearch
    // the boards list contains only today's country, so this fires immediately when
    // today's Randstad domain (e.g. randstad.ie) has no canary to verify against.
    for (const board of boards) {
      if (board.name !== 'Randstad') continue;
      for (const tldDomain of board.validDomains) {
        if (!randstadCanaries[tldDomain]) {
          console.warn(
            `[BOARD PATTERN] WARNING: Randstad (${tldDomain}) has no canary URL configured. ` +
            `URL pattern correctness cannot be confirmed for this region's search. ` +
            `Known issue: ${tldDomain === 'randstad.ie' ? 'randstad.ie redirects all /jobs/ paths to randstad.co.uk/ireland/ (site migration)' : tldDomain === 'randstad.pl' ? 'randstad.pl returns 404 for all /jobs/ paths (domain restructure)' : 'no verified direct-posting URL available'}. ` +
            `Add a valid direct-posting URL to RANDSTAD_CANARY_URLS once one is available for ${tldDomain}.`,
          );
        }
      }
    }

    for (const [tldDomain, canaryUrl] of Object.entries(randstadCanaries)) {
      // Build a temporary board config for this TLD so isDirectPostingUrl uses
      // the shared pattern against the right domain.
      const tldBoard: BoardConfig = {
        ...randstadPatternBoard,
        validDomains: [tldDomain],
      };

      // Step 1: confirm the canary posting is still live.
      const isLive = await liveCheckFn(canaryUrl);
      if (!isLive) {
        console.warn(
          `[BOARD PATTERN] WARNING: Randstad (${tldDomain}) canary URL returned a dead status (404/410). ` +
          `The job posting has likely expired — replace it with a current ${tldDomain} direct-posting URL ` +
          `and update RANDSTAD_CANARY_URLS so the pattern stays verified. Expired canary: ${canaryUrl}`,
        );
        continue;
      }

      // Step 2: follow redirects to the final destination URL, then confirm
      // (a) it stays on this TLD's domain, and (b) its path still matches
      // directUrlPatterns. Both checks together prevent a cross-domain redirect
      // (e.g. randstad.ie → randstad.co.uk/ireland/) from passing as OK when the
      // redirect destination's path happens to match the posting pattern.
      const finalUrl = await resolveFinalUrlFn(canaryUrl);
      const finalHostname = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
      const finalOnTld = hostnameMatchesBoardDomain(finalHostname, [tldDomain]);
      const matchesPattern = isDirectPostingUrl(finalUrl, tldBoard);

      if (finalUrl !== canaryUrl && !finalOnTld) {
        console.warn(
          `[BOARD PATTERN] WARNING: Randstad (${tldDomain}) canary URL redirects to a different domain. ` +
          `The regional site may have migrated — postings from ${tldDomain} could be silently rejected. ` +
          `Replace the canary with a current ${tldDomain} direct-posting URL and update RANDSTAD_CANARY_URLS. ` +
          `Canary: ${canaryUrl} → Redirect destination: ${finalUrl}`,
        );
      } else if (!matchesPattern && finalUrl !== canaryUrl) {
        console.warn(
          `[BOARD PATTERN] WARNING: Randstad (${tldDomain}) canary URL is live but redirects to a non-posting URL. ` +
          `The job posting has likely expired — the board is returning a redirect instead of 404/410. ` +
          `Replace the canary with a current ${tldDomain} direct-posting URL and update RANDSTAD_CANARY_URLS. ` +
          `Canary: ${canaryUrl} → Redirect destination: ${finalUrl}`,
        );
      } else if (!matchesPattern) {
        console.warn(
          `[BOARD PATTERN] WARNING: Randstad (${tldDomain}) canary URL is live but no longer matches directUrlPatterns. ` +
          `The board may have changed its URL structure on ${tldDomain} — this would silently reject all postings from it. ` +
          `Review and update directUrlPatterns in getBoardConfigs(). ` +
          `Canary: ${canaryUrl} | Patterns: ${randstadPatternBoard.directUrlPatterns.map((p) => p.toString()).join(', ')}`,
        );
      } else {
        console.log(`[BOARD PATTERN] OK: Randstad (${tldDomain}) canary is live and matches pattern (${canaryUrl})`);
      }
    }
  }
}

export function getBoardConfigs(country: string): BoardConfig[] {
  const randstad = RANDSTAD_TLD[country] ?? 'randstad.com';
  const hays = HAYS_TLD[country] ?? 'hays.com';
  const configs: BoardConfig[] = [
    {
      name: 'LinkedIn',
      domain: 'linkedin.com/jobs/view',
      urlHint: 'https://www.linkedin.com/jobs/view/<numeric-id>',
      validDomains: ['linkedin.com'],
      // LinkedIn direct job ads always live under /jobs/view/
      directUrlPatterns: [/\/jobs\/view\//],
    },
    {
      name: 'Indeed',
      domain: 'indeed.com',
      urlHint: 'URLs containing /viewjob?jk= or /rc/clk?jk=',
      // indeed.com covers country subdomains (au.indeed.com, ie.indeed.com, etc.)
      extraNote: 'Also try the country-specific Indeed domain (e.g. au.indeed.com, ie.indeed.com, pl.indeed.com, se.indeed.com). If the first search yields only listing pages, try a city name or a single specific role title.',
      validDomains: ['indeed.com'],
      // Indeed direct job ads use /viewjob?jk= or /rc/clk?jk=; /jobs?q= pages are search results
      directUrlPatterns: [/\/viewjob\?.*jk=/, /\/rc\/clk\?.*jk=/],
    },
    // Randstad is only included when its TLD domain has a verified canary in
    // RANDSTAD_CANARY_URLS. Without a canary the pre-search URL-pattern check
    // cannot confirm the filter is still valid — searching under an unverified
    // directUrlPatterns would silently reject every Randstad URL Claude returns.
    // Known excluded TLDs:
    //   randstad.ie — all /jobs/ paths redirect to randstad.co.uk/ireland/ (site migration)
    //   randstad.pl — all /jobs/ paths return 404 (domain restructure)
    // Add a verified entry to RANDSTAD_CANARY_URLS to re-enable Randstad for that country.
    ...(RANDSTAD_CANARY_URLS[randstad] ? [{
      name: 'Randstad',
      domain: randstad,
      urlHint: `a URL on ${randstad} of the form /jobs/<title-slug>_<city>_<numeric-or-uuid-ref>/ — NOT a /jobs/<category>/ listing page or the homepage`,
      validDomains: [randstad],
      // Randstad direct job ads across all active TLDs end with _<city>_<id>/ where <id> is either
      // a 5+-digit numeric reference (MY, NZ, default) or a UUID (AU, CH, SE).
      // Category/listing pages use paths like /jobs/s-<sector>/, /jobs/jt-<type>/,
      // /jobs/our-current-vacancies/, /jobs/join-our-team/, etc. — none end with _<id>.
      // Pattern is matched against pathname+search; (?:[?#].*)? allows tracking query params
      // after the job slug without weakening listing-page rejection.
      directUrlPatterns: [/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{5,})\/?(?:[?#].*)?$/i],
    } as BoardConfig] : (() => {
      console.warn(
        `[BOARD PATTERN] Randstad (${randstad}) excluded from ${country} search — no verified canary URL configured. ` +
        `Searching under an unverified directUrlPatterns would silently reject all Randstad results. ` +
        `Add a real direct-posting URL from ${randstad} to RANDSTAD_CANARY_URLS to re-enable Randstad for ${country}.`,
      );
      return [];
    })()),
    {
      name: 'Hays',
      domain: hays,
      urlHint: `a URL on ${hays} that contains /job/ or /job-detail/ followed by a job reference or title slug`,
      validDomains: [hays],
      // Hays direct job ads use /job/ or /job-detail/<slug>_<ref-number>
      directUrlPatterns: [/\/job\//, /\/job-detail\//],
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
