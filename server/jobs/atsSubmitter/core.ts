/**
 * Pure, testable core of the headless ATS submitter (no browser imports).
 *
 * Invariants (see .agents/memory/auto-apply-engine.md):
 *  - Sensitive questions (visa/sponsorship/EEO/demographics) are answered ONLY
 *    from the user-entered vault; a required sensitive field with no vault
 *    answer pauses the application (needs_user) — never guessed, never skipped.
 *  - Unknown required fields also pause — the engine never invents answers.
 */
import type { CandidateProfile, CountryAuthRecord, JobMatch, WorkHistoryEntry, EducationEntry } from '../../../shared/schema.js';
import { findCountryAuth } from '../applyService.js';

// ── Field model ──────────────────────────────────────────────────────────────

/** A form field as observed in the DOM by the browser layer. */
export interface ObservedField {
  /** Visible label / aria-label / placeholder text */
  label: string;
  /** name/id attribute (secondary classification signal) */
  name: string;
  kind: 'text' | 'textarea' | 'email' | 'tel' | 'url' | 'select' | 'multiselect' | 'combobox' | 'radio' | 'checkbox' | 'file' | 'unknown';
  required: boolean;
  /** For select/radio: available option labels */
  options?: string[];
  /**
   * combobox only: selector of the associated ARIA listbox (aria-controls/
   * aria-owns), if one could be resolved — where matching options are looked
   * for after typing.
   */
  listboxSelector?: string;
  /**
   * file only: true when the selector points at a JS-driven drop-zone
   * container (no underlying native file input at all — e.g. react-dropzone/
   * Dropzone.js/FilePond/Uppy) rather than a real `<input type=file>`. The
   * fill layer must use a simulated drop instead of setInputFiles for these.
   */
  isDropzone?: boolean;
}

export type CanonicalKey =
  | 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'location'
  | 'linkedin' | 'github' | 'portfolio' | 'noticePeriod' | 'resume' | 'coverLetter'
  | 'salary' | 'relocation' | 'rightToWork' | 'sponsorship' | 'eeo' | 'dataConsent';

export interface FieldClassification {
  key: CanonicalKey | null;
  sensitive: boolean;
}

const SENSITIVE_PATTERNS: Array<[RegExp, CanonicalKey]> = [
  [/sponsor|sponsorship/i, 'sponsorship'],
  [/right to work|work (?:authori[sz]ation|permit)|legally (?:authori[sz]ed|entitled|allowed) to work|authori[sz]ed to work|eligib\w* to work|visa status|require.*visa|work visa/i, 'rightToWork'],
  [/gender|race|ethnicit|hispanic|latin|veteran|disabilit|sexual orientation|lgbtq|pronouns|transgender|religio|demographic|equal employment|\beeo\b|diversity survey/i, 'eeo'],
  // GDPR/data-processing consent (near-universal on EU/Swiss/UK career sites):
  // a legally consequential yes/no the engine must never guess. Gated on the
  // profile's explicit dataConsent opt-in (see buildCanonicalValues) — this
  // pattern only decides WHICH field is asking, not the answer.
  [/consent.{0,40}(?:process|personal data|privacy)|(?:process|personal data).{0,40}consent|privacy policy.{0,30}(?:agree|accept|consent)|gdpr|data protection (?:notice|policy).{0,30}(?:agree|accept|consent)/i, 'dataConsent'],
];

const NON_SENSITIVE_PATTERNS: Array<[RegExp, CanonicalKey]> = [
  [/resume|\bcv\b|curriculum/i, 'resume'],
  [/cover\s*letter/i, 'coverLetter'],
  [/first[\s_-]*name|given[\s_-]*name/i, 'firstName'],
  [/last[\s_-]*name|family[\s_-]*name|surname/i, 'lastName'],
  [/full[\s_-]*name|^name$|your name/i, 'fullName'],
  [/e-?mail/i, 'email'],
  [/phone|mobile|telephone/i, 'phone'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/portfolio|personal website|website url/i, 'portfolio'],
  [/notice[\s_-]*period|earliest start|when can you start|availab\w* to start/i, 'noticePeriod'],
  [/salary|compensation|pay expectation|expected pay/i, 'salary'],
  [/relocat/i, 'relocation'],
  [/location|city|current address|where are you (?:located|based)/i, 'location'],
];

/** Classify a form field from its label + name. Sensitive patterns win. */
export function classifyField(label: string, name = ''): FieldClassification {
  const hay = `${label} ${name}`;
  for (const [re, key] of SENSITIVE_PATTERNS) {
    if (re.test(hay)) return { key, sensitive: true };
  }
  for (const [re, key] of NON_SENSITIVE_PATTERNS) {
    if (re.test(hay)) return { key, sensitive: false };
  }
  return { key: null, sensitive: false };
}

// ── Canonical values from the vault ─────────────────────────────────────────

export interface CanonicalValues {
  values: Partial<Record<CanonicalKey, string>>;
  auth: CountryAuthRecord | null;
  eeoAnswers: Record<string, string>;
  screeningAnswers: { question: string; answer: string }[];
}

export function buildCanonicalValues(profile: CandidateProfile, job: JobMatch): CanonicalValues {
  const auth = findCountryAuth(profile, job.country);
  const fullName = (profile.fullName ?? '').trim();
  const nameParts = fullName.split(/\s+/);
  const values: Partial<Record<CanonicalKey, string>> = {
    fullName: fullName || undefined,
    firstName: nameParts[0] || undefined,
    lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined,
    email: profile.email ?? undefined,
    phone: profile.phone ?? undefined,
    location: [profile.city, profile.country].filter(Boolean).join(', ') || undefined,
    linkedin: profile.linkedinUrl ?? undefined,
    github: profile.githubUrl ?? undefined,
    portfolio: profile.portfolioUrl ?? undefined,
    noticePeriod: profile.noticePeriod ?? undefined,
    salary: auth?.salaryExpectation ?? undefined,
    relocation: auth?.relocationWilling === undefined ? undefined : (auth.relocationWilling ? 'Yes' : 'No'),
    rightToWork: auth ? auth.rightToWork.replace(/_/g, ' ') : undefined,
    sponsorship: auth ? (auth.needsSponsorship ? 'Yes' : 'No') : undefined,
    dataConsent: profile.dataConsent ? 'Yes' : undefined,
  };
  return {
    values,
    auth,
    eeoAnswers: profile.eeoAnswers ?? {},
    screeningAnswers: profile.screeningAnswers ?? [],
  };
}

// ── Field resolution ─────────────────────────────────────────────────────────

export interface FieldResolution {
  /** Value to type/select, or null to leave the field untouched */
  value: string | null;
  source: 'vault' | 'unanswered';
  /** Non-null ⇒ the whole application must pause with this reason */
  blockReason: string | null;
  /**
   * True only for the generic screening-question fallthrough (not a known
   * canonical field, not sensitive) with no vault match — the sole case the
   * impure fill layer may attempt an AI-drafted answer for, via
   * isAiAnswerableField(), before honoring blockReason/pausing.
   */
  unmatchedScreening: boolean;
}

function matchVaultEeoAnswer(label: string, eeoAnswers: Record<string, string>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const l = norm(label);
  for (const [q, a] of Object.entries(eeoAnswers)) {
    if (!q.trim() || !a.trim()) continue;
    const nq = norm(q);
    if (l.includes(nq) || nq.includes(l)) return a;
  }
  return null;
}

/**
 * Free-text screening questions the AI must NEVER draft, even though they
 * are not "sensitive" in the visa/EEO/GDPR sense above — each is either a
 * legally consequential attestation or a fact the engine cannot verify from
 * the CV/job description, so it stays vault-only-or-pause exactly like a
 * sensitive field.
 */
const AI_DRAFTING_DENYLIST_RE = /salary|compensation|pay expectation|expected pay|remuneration|notice[\s_-]*period|earliest start|when (?:can|could) you start|availab\w* to start|certificat|licen[sc]|background check|criminal record|conviction|reference check|relative|related to (?:anyone|someone)|family member|friends? (?:or|and) (?:family|relatives)|conflict[\s_-]*of[\s_-]*interest/i;

/**
 * True only for a field the AI may draft an answer for when no vault match
 * exists: free-text/textarea only (never a radio/checkbox/dropdown, which
 * are far more likely to be a legal attestation than an open-ended answer),
 * and not one of the denylisted categories above. Sensitive fields never
 * reach this — resolveField() resolves or blocks them before the screening
 * fallthrough this feeds.
 */
export function isAiAnswerableField(field: ObservedField): boolean {
  if (field.kind !== 'text' && field.kind !== 'textarea') return false;
  if (AI_DRAFTING_DENYLIST_RE.test(field.label)) return false;
  return true;
}

function matchScreeningAnswer(label: string, screening: { question: string; answer: string }[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const l = norm(label);
  if (!l) return null;
  for (const s of screening) {
    const nq = norm(s.question);
    if (nq && (l.includes(nq) || nq.includes(l))) return s.answer;
  }
  return null;
}

/**
 * Decide what to do with one observed field. NEVER guesses:
 *  - sensitive field → vault answer or (if required) block
 *  - known non-sensitive field → canonical value or (if required+missing) block
 *  - unknown field → screening-answer match or (if required) block
 */
export function resolveField(field: ObservedField, canon: CanonicalValues): FieldResolution {
  const cls = classifyField(field.label, field.name);
  const pause = (reason: string, unmatchedScreening = false): FieldResolution =>
    ({ value: null, source: 'unanswered', blockReason: reason, unmatchedScreening });
  const skipOrPause = (reason: string, unmatchedScreening = false): FieldResolution =>
    field.required ? pause(reason, unmatchedScreening) : { value: null, source: 'unanswered', blockReason: null, unmatchedScreening };

  if (cls.sensitive) {
    if (cls.key === 'eeo') {
      const ans = matchVaultEeoAnswer(field.label, canon.eeoAnswers);
      if (ans) return { value: ans, source: 'vault', blockReason: null, unmatchedScreening: false };
      // EEO questions are optional-by-design on most forms; a REQUIRED one with
      // no vault answer must pause — "prefer not to say" is a user choice.
      return skipOrPause(`Required demographic question "${field.label}" has no answer in your Profile Vault. Add it (e.g. "Prefer not to say"), then retry — these answers are never guessed.`);
    }
    if (cls.key === 'dataConsent') {
      const v = canon.values.dataConsent;
      if (v) return { value: v, source: 'vault', blockReason: null, unmatchedScreening: false };
      return skipOrPause(`This form's data-processing/privacy consent ("${field.label}") requires your explicit approval. Enable "Data processing consent" in the Profile Vault, then retry — this is never auto-checked without it.`);
    }
    const v = cls.key ? canon.values[cls.key] : undefined;
    if (v) return { value: v, source: 'vault', blockReason: null, unmatchedScreening: false };
    return pause(`Sensitive question "${field.label}" has no matching Profile Vault answer for this country. Add your work-authorization record, then retry — visa/sponsorship answers are never guessed.`);
  }

  if (cls.key && cls.key !== 'resume' && cls.key !== 'coverLetter') {
    const v = canon.values[cls.key];
    if (v) return { value: v, source: 'vault', blockReason: null, unmatchedScreening: false };
    return skipOrPause(`Required field "${field.label}" is empty in your Profile Vault. Fill it in, then retry.`);
  }

  if (cls.key === 'resume' || cls.key === 'coverLetter') {
    // Handled specially by the browser layer (file upload / generated note)
    return { value: null, source: 'unanswered', blockReason: null, unmatchedScreening: false };
  }

  const screen = matchScreeningAnswer(field.label, canon.screeningAnswers);
  if (screen) return { value: screen, source: 'vault', blockReason: null, unmatchedScreening: false };
  // No exact/fuzzy vault match — the sole case the impure fill layer may
  // attempt an AI-drafted answer for (via isAiAnswerableField), before
  // honoring this pause/skip as a last resort.
  return skipOrPause(`The form asks "${field.label}" and there is no saved answer for it. Add it under Screening Answers in the Profile Vault, then retry — the engine never invents answers.`, true);
}

// ── Structured Work Experience / Education entry sections ───────────────────
//
// A Workday-style "My Experience" page renders a REPEATING fieldset per past
// job (Job Title, Company, Location, Start/End Date, Description) — often
// PRE-FILLED by the ATS's own resume parser, which is frequently wrong (a
// title paired with the wrong description, garbled dates, entries merged).
// classifyField()/resolveField() above only knows single scalar canonical
// fields; a bare "Location" label inside one of these entries would wrongly
// match the candidate's OWN location pattern and overwrite it with the wrong
// value. These fields must never reach the generic per-field path — instead
// they are grouped into per-entry indices here and filled from the vault's
// structured workHistory/education (verified once by the user), which always
// overwrites the ATS's own parse. Detection is gated on the page's visible
// section heading so an unrelated "Job Title" screening question elsewhere on
// the form is never mistaken for an experience entry.

export const EXPERIENCE_SECTION_HEADING_RE = /\bwork experience\b|\bemployment history\b|\bmy experience\b/i;
export const EDUCATION_SECTION_HEADING_RE = /\beducation\b/i;

/** "Add another" controls that create one more repeated entry block. */
export const ADD_ANOTHER_EXPERIENCE_RE = /add (?:another\s+)?(?:work experience|position|job|employer)/i;
export const ADD_ANOTHER_EDUCATION_RE = /add (?:another\s+)?(?:education|school)/i;

export type ExperienceRole =
  | 'jobTitle' | 'employer' | 'location'
  | 'startMonth' | 'startYear' | 'startDay' | 'startDate'
  | 'endMonth' | 'endYear' | 'endDay' | 'endDate'
  | 'current' | 'description';

export type EducationRole =
  | 'school' | 'degree' | 'fieldOfStudy'
  | 'startMonth' | 'startYear' | 'startDay' | 'startDate'
  | 'endMonth' | 'endYear' | 'endDay' | 'endDate'
  | 'current' | 'description';

/** Sub-role for a Start/End date that may be split across Month/Year/Day fields. */
function dateSubRole<R extends string>(label: string, kind: 'start' | 'end', startRole: R, endRole: R,
  monthRole: R, yearRole: R, dayRole: R): R | null {
  const re = kind === 'start' ? /\bstart\b/i : /\bend\b/i;
  if (!re.test(label)) return null;
  if (/\bmonth\b/i.test(label)) return monthRole;
  if (/\byear\b/i.test(label)) return yearRole;
  if (/\bday\b/i.test(label)) return dayRole;
  return kind === 'start' ? startRole : endRole;
}

/** Classify one field label as a role within a Work Experience entry, or null if unrelated. */
export function classifyExperienceRole(label: string): ExperienceRole | null {
  if (/\bjob title\b|\bposition(?:\s*title)?\b|\btitle\b/i.test(label)) return 'jobTitle';
  if (/\bcompany(?:\s*name)?\b|\bemployer\b|\borgani[sz]ation\b/i.test(label)) return 'employer';
  if (/\blocation\b|\bcity\b/i.test(label)) return 'location';
  if (/currently work here|current(?:ly)?\s*(?:position|role|job)|still work(?:ing)? here|\bpresent\b/i.test(label)) return 'current';
  if (/\bdescription\b|responsibilit/i.test(label)) return 'description';
  return dateSubRole(label, 'start', 'startDate', 'endDate', 'startMonth', 'startYear', 'startDay')
    ?? dateSubRole(label, 'end', 'startDate', 'endDate', 'endMonth', 'endYear', 'endDay');
}

/** Classify one field label as a role within an Education entry, or null if unrelated. */
export function classifyEducationRole(label: string): EducationRole | null {
  if (/\bschool\b|\buniversity\b|\bcollege\b|\binstitution(?:\s*name)?\b/i.test(label)) return 'school';
  if (/\bdegree\b/i.test(label)) return 'degree';
  if (/field of study|\bmajor\b|\bdiscipline\b/i.test(label)) return 'fieldOfStudy';
  if (/currently (?:attend|enrolled)|still (?:studying|enrolled)|\bpresent\b/i.test(label)) return 'current';
  if (/\bdescription\b/i.test(label)) return 'description';
  return dateSubRole(label, 'start', 'startDate', 'endDate', 'startMonth', 'startYear', 'startDay')
    ?? dateSubRole(label, 'end', 'startDate', 'endDate', 'endMonth', 'endYear', 'endDay');
}

export interface GroupedEntryField<R extends string> {
  selector: string;
  role: R;
  /** 0-based position of the repeated entry this field belongs to. */
  index: number;
}

/**
 * Groups a flat, DOM-order field list into per-entry roles: a new entry
 * starts each time `boundaryRole` (Job Title / School) is seen. Fields
 * appearing before the first boundary field belong to no entry and are
 * omitted — they fall through to the generic field path unchanged.
 */
export function groupEntryFields<R extends string>(
  fields: { label: string; selector: string }[],
  classify: (label: string) => R | null,
  boundaryRole: R,
): GroupedEntryField<R>[] {
  const out: GroupedEntryField<R>[] = [];
  let index = -1;
  for (const f of fields) {
    const role = classify(f.label);
    if (!role) continue;
    if (role === boundaryRole) index++;
    if (index < 0) continue;
    out.push({ selector: f.selector, role, index });
  }
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parses a "YYYY-MM" vault date into its numeric parts, or null if invalid/absent. */
export function parseMonthIso(iso: string | undefined | null): { year: string; month: number; monthName: string } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(iso.trim());
  if (!m) return null;
  const month = Number(m[2]);
  return { year: m[1], month, monthName: MONTH_NAMES[month - 1] };
}

/** "YYYY-MM" → "MM/YYYY" for a plain combined date text field; '' if invalid. */
export function formatMonthYear(iso: string | undefined | null): string {
  const p = parseMonthIso(iso);
  return p ? `${String(p.month).padStart(2, '0')}/${p.year}` : '';
}

/** Shared start/end date-role resolution; returns undefined (not null) when `role` isn't a date role at all. */
function dateRoleValue(role: string, startDate: string | undefined, endDate: string | undefined, isCurrent: boolean | undefined): string | null | undefined {
  switch (role) {
    case 'startDate': return formatMonthYear(startDate) || null;
    case 'startMonth': return parseMonthIso(startDate)?.monthName ?? null;
    case 'startYear': return parseMonthIso(startDate)?.year ?? null;
    case 'startDay': return startDate ? '1' : null;
    case 'endDate': return isCurrent ? null : (formatMonthYear(endDate) || null);
    case 'endMonth': return isCurrent ? null : (parseMonthIso(endDate)?.monthName ?? null);
    case 'endYear': return isCurrent ? null : (parseMonthIso(endDate)?.year ?? null);
    case 'endDay': return (!isCurrent && endDate) ? '1' : null;
    default: return undefined;
  }
}

/** Value to fill for one role within one Work Experience entry, or null to leave the field untouched. */
export function experienceRoleValue(entry: WorkHistoryEntry, role: ExperienceRole): string | null {
  const dateVal = dateRoleValue(role, entry.startDate, entry.endDate, entry.isCurrent);
  if (dateVal !== undefined) return dateVal;
  switch (role) {
    case 'jobTitle': return entry.jobTitle || null;
    case 'employer': return entry.employer || null;
    case 'location': return entry.location || null;
    case 'description': return entry.description || null;
    case 'current': return entry.isCurrent ? 'Yes' : null;
    default: return null;
  }
}

/** Value to fill for one role within one Education entry, or null to leave the field untouched. */
export function educationRoleValue(entry: EducationEntry, role: EducationRole): string | null {
  const dateVal = dateRoleValue(role, entry.startDate, entry.endDate, entry.isCurrent);
  if (dateVal !== undefined) return dateVal;
  switch (role) {
    case 'school': return entry.school || null;
    case 'degree': return entry.degree || null;
    case 'fieldOfStudy': return entry.fieldOfStudy || null;
    case 'description': return entry.description || null;
    case 'current': return entry.isCurrent ? 'Yes' : null;
    default: return null;
  }
}

// ── Error classification ─────────────────────────────────────────────────────

const TRANSIENT_RE = /timeout|timed out|net::ERR_(?:CONNECTION|NETWORK|TIMED|NAME_NOT|INTERNET|EMPTY_RESPONSE|SOCKET)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|429|50[0-4]|Target (?:closed|crashed)|browser has been closed|Navigation interrupted/i;

/** Transient (retryable with jitter) vs deterministic (fail fast + liveness re-check). */
export function isTransientError(err: unknown): boolean {
  return TRANSIENT_RE.test(String((err as any)?.message ?? err ?? ''));
}

// ── Detection patterns (used by the browser layer) ──────────────────────────

export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]',
  '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]', '#captcha',
];

/**
 * HTTP statuses consistent with an enterprise anti-bot vendor (Akamai Bot
 * Manager, PerimeterX, DataDome, Cloudflare) blocking automated traffic
 * outright — as opposed to a normal 4xx/5xx application error.
 */
export const BOT_BLOCK_HTTP_STATUSES = new Set([401, 403, 429]);

/**
 * Text signatures of an enterprise bot-detection block page. These vendors
 * typically render NO interactive CAPTCHA element at all (detectCaptcha()
 * correctly returns false for them) — without this separate check, such a
 * page was previously indistinguishable from "this posting just uses a form
 * layout we don't support", which meant it was never recorded as a block and
 * the domain guardrail cooldown/downgrade never engaged.
 */
const BOT_BLOCK_TEXT_RE = /access denied|request blocked|automated (?:access|requests?|traffic) (?:has been |was |is )?(?:blocked|detected|denied)|unusual traffic (?:from your|detected)|pardon our interruption|attention required[!.]?\s*\|?\s*cloudflare|checking your browser before accessing|ray id\s*:|reference (?:id|#)\s*[:#]?\s*\w{8,}.{0,30}(?:akamai|perimeterx|datadome|imperva)|please verify you are a human|bot detection/i;

/** True when visible page text matches a known bot-detection block pattern. */
export function looksLikeBotBlockText(text: string): boolean {
  return BOT_BLOCK_TEXT_RE.test(text);
}

const CONFIRMATION_TEXT_RE = /thank you for (?:applying|your application|your interest)|application (?:has been |was )?(?:submitted|received|sent)|we(?:'|’)?ve received your application|successfully (?:applied|submitted)|your application to .{0,80} (?:has been|was) (?:received|submitted)/i;

const CONFIRMATION_URL_RE = /confirmation|thank[-_]?you|application[-_]?(?:submitted|complete)/i;

/** True when a page's visible text or URL indicates a completed submission. */
export function looksLikeConfirmation(pageText: string, url: string): boolean {
  return CONFIRMATION_TEXT_RE.test(pageText) || CONFIRMATION_URL_RE.test(url);
}

/**
 * The ATS itself reporting a prior application on file for this exact job —
 * distinct from this app's own internal 90-day shortlisting dedup: the
 * candidate (or a previous partial run) may have applied once before through
 * a channel this system has no record of. Without this check such a page
 * shows zero fillable fields and was previously indistinguishable from an
 * unsupported layout or a bot block.
 */
const ALREADY_APPLIED_RE = /you(?:'|’)?(?:ve| have) already applied|already submitted (?:an|your) application (?:for|to) this|application already (?:submitted|received|exists|on file)|you (?:can|may) only apply once|duplicate application/i;

/** True when page text indicates the ATS considers this job already applied-to. */
export function looksLikeAlreadyApplied(text: string): boolean {
  return ALREADY_APPLIED_RE.test(text);
}

// ── Navigation allowlist ─────────────────────────────────────────────────────

/**
 * Multi-part public suffixes where "last two labels" would wrongly treat
 * unrelated registrants as the same site (e.g. a.co.uk vs b.co.uk).
 */
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'co.jp', 'co.in', 'co.id', 'co.th', 'com.my', 'com.sg', 'com.hk',
  'com.br', 'com.mx', 'com.ar', 'co.za', 'com.tr', 'com.cn', 'com.tw',
  'co.kr', 'com.ph', 'com.vn', 'co.il', 'com.sa', 'com.eg',
]);

/** Registrable base domain, aware of common multi-part public suffixes. */
export function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length >= 3 && MULTIPART_SUFFIXES.has(parts.slice(-2).join('.'))) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Hostnames where the ATS tenant is encoded in the URL PATH, not the
 * hostname — every customer on these platforms shares the exact same
 * hostname (e.g. all Greenhouse job boards live at boards.greenhouse.io/{company}).
 * Workday/iCIMS/Taleo/SuccessFactors are deliberately NOT here: each tenant
 * gets its own subdomain there, so the full hostname alone is already
 * tenant-specific (this matches how ats_credentials.portalDomain is keyed).
 */
const PATH_TENANT_HOSTS = new Set([
  'boards.greenhouse.io', 'job-boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'jobs.smartrecruiters.com', 'careers.smartrecruiters.com',
]);

/**
 * Guard-rail key for an apply URL: identifies the actual TENANT (employer)
 * being automated against, never just the ATS vendor's shared hosting
 * domain. A CAPTCHA/bot-block on one company's ATS instance must never cool
 * down or downgrade automation for every OTHER unrelated company hosted on
 * the same platform.
 *  - Path-tenant hosts (Greenhouse/Lever/Ashby/SmartRecruiters shared
 *    hostnames): hostname + first path segment (the company slug) — two
 *    different companies on the same host get different keys.
 *  - Everything else (Workday/iCIMS/Taleo/SuccessFactors per-tenant
 *    subdomains, and any company-owned custom domain): the full hostname,
 *    lowercased — already tenant-specific there.
 */
export function guardrailKeyForUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (PATH_TENANT_HOSTS.has(host)) {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${host}/${seg.toLowerCase()}` : host;
  }
  return host;
}

/**
 * Main-frame navigations are only allowed within the apply route's site (same
 * base domain) — a form that redirects the top frame elsewhere aborts the run.
 */
export function isNavigationAllowed(applyUrl: string, targetUrl: string): boolean {
  try {
    const a = new URL(applyUrl);
    const t = new URL(targetUrl);
    if (!['http:', 'https:'].includes(t.protocol)) return t.protocol === 'about:';
    return baseDomain(t.hostname) === baseDomain(a.hostname);
  } catch {
    return false;
  }
}

// ── Humanization parameters ──────────────────────────────────────────────────

export function jitterMs(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

export const RETRY_ATTEMPTS = 3;
export const RETRY_JITTER = { min: 2000, max: 6000 };
export const TYPE_DELAY = { min: 30, max: 95 };
export const FIELD_PAUSE = { min: 250, max: 900 };

/** ATS types the headless submitter supports (Phase 2 scope). */
export const SUPPORTED_ATS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);

/**
 * ATS types known to require login/multi-page flows — out of Phase 2 scope
 * (Task: Workday-class ATSs are the next phase); never routed to the
 * best-effort generic adapter.
 */
export const LOGIN_WALLED_ATS = new Set(['workday', 'icims', 'taleo', 'successfactors']);

/**
 * Post-click outcome policy (pure, unit-tested): a click alone is not proof
 * of acceptance, and a submission claim without stored screenshot evidence is
 * a lie. Missing post-click evidence therefore NEVER yields a submitted-like
 * state — it pauses for manual verification.
 */
export function classifySubmitOutcome(o: { confirmed: boolean; validationError: boolean; shotStored: boolean }):
  'submitted' | 'submitted_unconfirmed' | 'needs_user' {
  if (!o.shotStored) return 'needs_user';
  if (o.validationError) return 'needs_user';
  return o.confirmed ? 'submitted' : 'submitted_unconfirmed';
}

/**
 * Stable hash of the reviewed answer set + route. Approval is bound to this:
 * the submit run recomputes it from the freshly filled form and refuses to
 * click submit if it differs from what the user reviewed.
 */
export function computeAnswersHash(applyUrl: string, answers: { label: string; value: string }[]): string {
  const canonical = JSON.stringify({
    applyUrl,
    answers: [...answers].map((a) => ({ label: a.label, value: a.value }))
      .sort((x, y) => x.label.localeCompare(y.label) || x.value.localeCompare(y.value)),
  });
  // FNV-1a 64-bit (dependency-free, stable): collision-resistance needs are
  // "did the form/vault change since review", not cryptographic.
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c >> 8) ^ (c << 3)), 0x01000193) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}:${answers.length}`;
}

/** Hard daily cap on autonomous ATS submissions. */
export const DAILY_ATS_SUBMIT_CAP = 25;

export type ApplyChannelChoice = 'ats_supported' | 'ats_login_walled' | 'email' | 'ats_generic' | 'assisted';

/**
 * Channel selection order for a prepared application. A recognized ATS route
 * (supported OR login-walled) is the official channel and always wins over an
 * available contact email — emailing a recruiter is a fallback, not a
 * substitute for the employer's own apply flow.
 */
export function chooseApplyChannel(
  atsType: string | null | undefined,
  hasEmailTarget: boolean,
): ApplyChannelChoice {
  if (atsType && SUPPORTED_ATS.has(atsType)) return 'ats_supported';
  if (atsType && LOGIN_WALLED_ATS.has(atsType)) return 'ats_login_walled';
  if (hasEmailTarget) return 'email';
  if (atsType) return 'ats_generic';
  return 'assisted';
}
