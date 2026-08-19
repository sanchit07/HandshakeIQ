/**
 * Pure page-classification logic for login-walled ATSs (Workday, iCIMS,
 * Taleo, SuccessFactors). No browser dependency — fully unit-testable.
 */

export type AuthPageKind =
  | 'sign_in'         // existing-account login form
  | 'create_account'  // account-creation form
  | 'account_exists'  // signup rejected: an account with this email already exists
  | 'verify_email'    // "check your email / verify your address" interstitial (click a link)
  | 'verify_email_code' // email-delivered numeric code interstitial (type a code) — same trust boundary as verify_email, different UI
  | 'mfa_challenge'   // true second factor (authenticator app / SMS) — cannot be automated, no phone/TOTP access
  | 'wizard'          // an application wizard page (fillable form + next/continue)
  | 'review'          // final review page (submit button + review language)
  | 'confirmation'    // post-submit confirmation
  | 'unknown';

export interface PageSignals {
  /** Visible page text (lowercased ok; matching is case-insensitive). */
  text: string;
  /** Whether a password input is present. */
  hasPasswordField: boolean;
  /** Whether a "confirm/verify password" second password input is present. */
  hasConfirmPasswordField: boolean;
  /** Lowercased labels of visible buttons/links. */
  buttons: string[];
}

const has = (labels: string[], re: RegExp) => labels.some((b) => re.test(b));

/**
 * Email-delivered numeric code interstitial — still just proving email
 * ownership (same trust boundary as the link-based verify_email flow, just a
 * different UI: type a code instead of clicking a link), so it CAN be
 * automated the same way (poll the connected inbox). Requires "code"/"pin"
 * in close proximity to "email"/"inbox" so it doesn't swallow a plain
 * "check your inbox" (link-based) or a true phone/authenticator 2FA page.
 */
const EMAIL_CODE_RE = /(?:email|inbox)[^.]{0,60}(?:code|pin)\b|(?:code|pin)[^.]{0,60}(?:email|inbox)/i;

/**
 * True second-factor challenge — authenticator app, SMS/phone code, or a
 * generic "verification/security code" with no email context. Cannot be
 * automated (no phone number or TOTP secret access) — must degrade to
 * assisted immediately rather than loop or, worse, silently fall through as
 * "no auth wall" and proceed unauthenticated.
 */
const MFA_RE = /two[- ]factor|\b2fa\b|multi[- ]factor authentication|\bmfa\b|authenticator app|google authenticator|\botp\b|one[- ]time (?:password|passcode)|text message (?:with|containing) a code|sms code|sent (?:a code |it )?to your phone|enter (?:the |your )?(?:\d[- ]?digit )?(?:verification |security )?code|verification code|security code/i;

/**
 * Signup rejected because an account already exists for this email — a real
 * scenario when the candidate previously created a portal account manually,
 * or a prior automated run partially completed without being recorded. Left
 * unrecognized, a retry would resubmit the same signup with the same email
 * forever (or be misread as a generic create_account page).
 */
const ACCOUNT_EXISTS_RE = /(?:email|account) (?:address )?(?:is )?already (?:exists?|registered|in use|taken)|an account (?:with this email )?already exists|you already have an account/i;

export function classifyAuthPage(s: PageSignals): AuthPageKind {
  const t = s.text.toLowerCase();

  if (/(application (was )?(submitted|received)|thank you for (applying|your application)|successfully submitted)/i.test(s.text)) {
    return 'confirmation';
  }
  // Checked before create_account below: a signup-retry page still LOOKS like
  // create_account (has password fields) but carries a rejection message —
  // must not be treated as a fresh signup attempt.
  if (ACCOUNT_EXISTS_RE.test(t)) return 'account_exists';
  // Checked before the generic verify_email/link regex below so the more
  // specific, more actionable classifications win: an email-delivered code
  // is automatable the same way a link is; a true 2FA/MFA step is not
  // automatable at all and must stop immediately rather than be mistaken for
  // the (solvable) email-link case.
  if (EMAIL_CODE_RE.test(t)) return 'verify_email_code';
  if (MFA_RE.test(t)) return 'mfa_challenge';
  if (/(verify your email|verification (e-?mail|link) (has been )?sent|check your (inbox|email)|confirm your email address|activate your account)/i.test(s.text)) {
    return 'verify_email';
  }
  // Review page: review language + a final submit control, no password fields
  if (!s.hasPasswordField && /review/i.test(t) && has(s.buttons, /^submit( application)?$|^apply$/i)
      && /(review (your )?(application|information)|review and submit)/i.test(s.text)) {
    return 'review';
  }
  if (s.hasConfirmPasswordField || (s.hasPasswordField && /(create (an )?account|sign up|new user|register|don'?t have an account)/i.test(t) && has(s.buttons, /create account|sign up|register/i))) {
    return 'create_account';
  }
  if (s.hasPasswordField) return 'sign_in';
  if (has(s.buttons, /^(next|continue|save and continue)$/i)) return 'wizard';
  return 'unknown';
}

/** Workday-style progress: does the page look like a mid-wizard step? */
export function looksLikeWizardStep(text: string): boolean {
  return /(step \d+ of \d+|my information|my experience|application questions|voluntary disclosures|self[- ]identify)/i.test(text);
}

/** Extract the first verification-style link from an email body/HTML. */
export function extractVerificationLink(body: string, portalDomain: string): string | null {
  const urls = body.match(/https?:\/\/[^\s"'<>()\]]+/g) ?? [];
  const domainRoot = portalDomain.split('.').slice(-3).join('.'); // e.g. wd3.myworkdayjobs.com tail
  const scored = urls
    .map((u) => {
      let score = 0;
      if (/verif|confirm|activate|token|validate/i.test(u)) score += 2;
      try {
        const h = new URL(u).hostname;
        if (h === portalDomain) score += 3;
        else if (h.endsWith(domainRoot)) score += 2;
      } catch { return null; }
      return { u, score };
    })
    .filter((x): x is { u: string; score: number } => !!x && x.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.u ?? null;
}

/**
 * Extract a numeric verification code (4-8 digits) from an email body. Prefers
 * a digit sequence immediately following an explicit code-labeling phrase;
 * falls back to any standalone 4-8 digit token within 60 characters of the
 * word "code" (guards against grabbing an unrelated number — order IDs,
 * years, phone numbers — elsewhere in the email).
 */
export function extractVerificationCode(body: string): string | null {
  const labeled = body.match(/(?:verification code|confirmation code|security code|one-time code|one-time passcode|\botp\b|pin code|your code is|code)\s*(?:is|:)?\s*[:\-]?\s*(\d{4,8})\b/i);
  if (labeled) return labeled[1];
  const idx = body.search(/\bcode\b/i);
  if (idx >= 0) {
    const window = body.slice(Math.max(0, idx - 60), idx + 60);
    const m = window.match(/\b(\d{4,8})\b/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Signup consent checkboxes: ONLY plain terms-of-use / privacy-policy
 * acknowledgements may be auto-checked during account creation — anything
 * marketing-related, ambiguous, or consequential (references, background
 * checks, legal attestations beyond the terms) is never asserted on the
 * user's behalf.
 */
export function isAutoCheckableConsent(label: string): boolean {
  const l = label.trim();
  if (!l) return false;
  if (/(marketing|newsletter|promotional|job alerts?|updates|offers|contact me|text me|sms|phone calls|recruit(er|ing) outreach|talent (community|network|pool))/i.test(l)) return false;
  if (/(background check|reference|attest|certify|swear|under penalty|criminal|drug)/i.test(l)) return false;
  return /(terms (of (use|service)|and conditions)|privacy (policy|statement|notice)|user agreement|acceptable use)/i.test(l);
}

/** Only http(s) links on the expected portal's registrable domain may be opened. */
export function isSafeVerificationLink(link: string, portalDomain: string): boolean {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const root = portalDomain.split('.').slice(-2).join('.');
    return u.hostname === portalDomain || u.hostname.endsWith(`.${root}`) || u.hostname === root;
  } catch { return false; }
}
