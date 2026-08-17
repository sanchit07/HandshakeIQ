/**
 * Pure page-classification logic for login-walled ATSs (Workday, iCIMS,
 * Taleo, SuccessFactors). No browser dependency — fully unit-testable.
 */

export type AuthPageKind =
  | 'sign_in'         // existing-account login form
  | 'create_account'  // account-creation form
  | 'verify_email'    // "check your email / verify your address" interstitial
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

export function classifyAuthPage(s: PageSignals): AuthPageKind {
  const t = s.text.toLowerCase();

  if (/(application (was )?(submitted|received)|thank you for (applying|your application)|successfully submitted)/i.test(s.text)) {
    return 'confirmation';
  }
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
