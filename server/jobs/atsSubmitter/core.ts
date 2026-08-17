/**
 * Pure, testable core of the headless ATS submitter (no browser imports).
 *
 * Invariants (see .agents/memory/auto-apply-engine.md):
 *  - Sensitive questions (visa/sponsorship/EEO/demographics) are answered ONLY
 *    from the user-entered vault; a required sensitive field with no vault
 *    answer pauses the application (needs_user) — never guessed, never skipped.
 *  - Unknown required fields also pause — the engine never invents answers.
 */
import type { CandidateProfile, CountryAuthRecord, JobMatch } from '../../../shared/schema.js';
import { findCountryAuth } from '../applyService.js';

// ── Field model ──────────────────────────────────────────────────────────────

/** A form field as observed in the DOM by the browser layer. */
export interface ObservedField {
  /** Visible label / aria-label / placeholder text */
  label: string;
  /** name/id attribute (secondary classification signal) */
  name: string;
  kind: 'text' | 'textarea' | 'email' | 'tel' | 'url' | 'select' | 'radio' | 'checkbox' | 'file' | 'unknown';
  required: boolean;
  /** For select/radio: available option labels */
  options?: string[];
}

export type CanonicalKey =
  | 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'location'
  | 'linkedin' | 'github' | 'portfolio' | 'noticePeriod' | 'resume' | 'coverLetter'
  | 'salary' | 'relocation' | 'rightToWork' | 'sponsorship' | 'eeo';

export interface FieldClassification {
  key: CanonicalKey | null;
  sensitive: boolean;
}

const SENSITIVE_PATTERNS: Array<[RegExp, CanonicalKey]> = [
  [/sponsor|sponsorship/i, 'sponsorship'],
  [/right to work|work (?:authori[sz]ation|permit)|legally (?:authori[sz]ed|entitled|allowed) to work|authori[sz]ed to work|eligib\w* to work|visa status|require.*visa|work visa/i, 'rightToWork'],
  [/gender|race|ethnicit|hispanic|latin|veteran|disabilit|sexual orientation|lgbtq|pronouns|transgender|religio|demographic|equal employment|\beeo\b|diversity survey/i, 'eeo'],
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
  const pause = (reason: string): FieldResolution => ({ value: null, source: 'unanswered', blockReason: reason });
  const skipOrPause = (reason: string): FieldResolution =>
    field.required ? pause(reason) : { value: null, source: 'unanswered', blockReason: null };

  if (cls.sensitive) {
    if (cls.key === 'eeo') {
      const ans = matchVaultEeoAnswer(field.label, canon.eeoAnswers);
      if (ans) return { value: ans, source: 'vault', blockReason: null };
      // EEO questions are optional-by-design on most forms; a REQUIRED one with
      // no vault answer must pause — "prefer not to say" is a user choice.
      return skipOrPause(`Required demographic question "${field.label}" has no answer in your Profile Vault. Add it (e.g. "Prefer not to say"), then retry — these answers are never guessed.`);
    }
    const v = cls.key ? canon.values[cls.key] : undefined;
    if (v) return { value: v, source: 'vault', blockReason: null };
    return pause(`Sensitive question "${field.label}" has no matching Profile Vault answer for this country. Add your work-authorization record, then retry — visa/sponsorship answers are never guessed.`);
  }

  if (cls.key && cls.key !== 'resume' && cls.key !== 'coverLetter') {
    const v = canon.values[cls.key];
    if (v) return { value: v, source: 'vault', blockReason: null };
    return skipOrPause(`Required field "${field.label}" is empty in your Profile Vault. Fill it in, then retry.`);
  }

  if (cls.key === 'resume' || cls.key === 'coverLetter') {
    // Handled specially by the browser layer (file upload / generated note)
    return { value: null, source: 'unanswered', blockReason: null };
  }

  const screen = matchScreeningAnswer(field.label, canon.screeningAnswers);
  if (screen) return { value: screen, source: 'vault', blockReason: null };
  return skipOrPause(`The form asks "${field.label}" and there is no saved answer for it. Add it under Screening Answers in the Profile Vault, then retry — the engine never invents answers.`);
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

const CONFIRMATION_TEXT_RE = /thank you for (?:applying|your application|your interest)|application (?:has been |was )?(?:submitted|received|sent)|we(?:'|’)?ve received your application|successfully (?:applied|submitted)|your application to .{0,80} (?:has been|was) (?:received|submitted)/i;

const CONFIRMATION_URL_RE = /confirmation|thank[-_]?you|application[-_]?(?:submitted|complete)/i;

/** True when a page's visible text or URL indicates a completed submission. */
export function looksLikeConfirmation(pageText: string, url: string): boolean {
  return CONFIRMATION_TEXT_RE.test(pageText) || CONFIRMATION_URL_RE.test(url);
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
