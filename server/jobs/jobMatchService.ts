import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { jobMatches, type JobMatch } from '../../shared/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

const MODEL = 'claude-sonnet-4-5';

const COUNTRIES = [
  'Malaysia', 'New Zealand', 'Australia', 'Sweden',
  'Switzerland', 'Ireland', 'Poland', 'Portugal',
];

const BOARDS = ['LinkedIn', 'Indeed', 'JobStreet', 'Randstad', 'Hays'];

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

    console.log(`[JOB SEARCH] Starting daily job search for ${runDate}`);

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

    // Phase 2: search each country group with web search (batch countries to limit calls)
    const countryGroups = [
      ['Malaysia', 'Australia', 'New Zealand'],
      ['Sweden', 'Switzerland', 'Ireland'],
      ['Poland', 'Portugal'],
    ];

    const allFindings: string[] = [];
    for (const group of countryGroups) {
      try {
        const searchResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `Search for CURRENTLY OPEN job vacancies posted recently (within the last 2 weeks) in ${group.join(', ')} for these roles: ${roles.join(', ')}.
Prioritize listings on these job boards: ${BOARDS.join(', ')} (e.g. use searches like "site:linkedin.com/jobs", "site:indeed.com", "site:jobstreet.com", "site:randstad.com", "site:hays.com" combined with role and country).
For each vacancy found, report: exact job title, company, city/location, country, source job board, the direct URL to the posting, and a 1-2 sentence description of requirements.
Only include postings that appear to be genuinely live (skip expired or generic search-page links). Find as many distinct real vacancies as you can.`,
          }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 } as any],
        });
        allFindings.push(`=== Findings for ${group.join(', ')} ===\n${extractText(searchResponse)}`);
      } catch (e) {
        console.error(`[JOB SEARCH] Search failed for ${group.join(', ')}:`, e);
      }
    }

    if (allFindings.length === 0) throw new Error('All country searches failed');

    // Phase 3: rank and shortlist top 10 against the profile
    const rankResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are shortlisting job opportunities for this candidate.

CANDIDATE PROFILE:
${profile}

VACANCIES FOUND TODAY:
${allFindings.join('\n\n')}

Select the 10 BEST matching opportunities. Judge match on: seniority fit (11+ yrs, lead/head level), domain fit (B2B SaaS, AI products, platform architecture, AdTech), role fit, and location (${COUNTRIES.join(', ')}).
Discard anything without a real company name and plausible direct URL. Prefer diversity across countries and boards.

Return ONLY a JSON array (no markdown) of up to 10 objects, best match first:
[{"title": "...", "company": "...", "location": "city", "country": "...", "source": "LinkedIn|Indeed|JobStreet|Randstad|Hays|Other", "url": "https://...", "description": "1-3 sentence summary of the role and key requirements", "matchScore": <0-100>, "matchReason": "1-2 sentences on why this fits the candidate"}]`,
      }],
    });

    const ranked = parseJsonLoose(extractText(rankResponse));
    if (!Array.isArray(ranked) || ranked.length === 0) throw new Error('Ranking step returned no results');

    const rows = ranked
      .filter((j: any) => j && typeof j.title === 'string' && typeof j.company === 'string')
      .slice(0, 10)
      .map((j: any, i: number) => ({
        runDate,
        rank: i + 1,
        title: String(j.title).slice(0, 250),
        company: String(j.company).slice(0, 250),
        location: j.location ? String(j.location).slice(0, 250) : null,
        country: j.country ? String(j.country).slice(0, 100) : null,
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
    messages: [{
      role: 'user',
      content: `You are an expert CV writer. Prepare a tailored CV for this job opportunity, drawing on the candidate's real experience from the source CVs below. NEVER invent experience, employers, dates, or qualifications the candidate does not have — only reframe, reorder, and emphasize genuinely existing experience to fit the job description.

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || ''}, ${job.country || ''}
Description / requirements: ${job.description || 'Not available — tailor based on the job title and typical requirements for this role.'}

SOURCE CVs (choose the most relevant as the base, blend strengths from others):
${resumes.map((r) => `--- ${r.name} ---\n${r.text}`).join('\n\n')}

Produce the complete tailored CV in clean Markdown (headings, bullet points), ready to copy into a document. Lead with a professional summary rewritten for this specific role, reorder core competencies to match the job's priorities, and emphasize the most relevant achievements in each role.`,
    }],
  });

  const tailoredCv = extractText(response);
  if (!tailoredCv || tailoredCv.length < 500) throw new Error('CV generation returned insufficient content');

  await db.update(jobMatches).set({ tailoredCv }).where(eq(jobMatches.id, matchId));
  return { ...job, tailoredCv };
}
