/**
 * Login-walled ATS flow: Workday (primary target), with iCIMS / Taleo /
 * SuccessFactors handled best-effort behind the same contract.
 *
 * Invariants (non-negotiable):
 *  - Credentials are written to the vault BEFORE any signup form is submitted
 *    — the user can always log in themselves.
 *  - CAPTCHAs are never solved by third parties: a live hand-off keeps the
 *    session alive for the user; timeout parks the run as needs_user with a
 *    screenshot.
 *  - Review mode pauses at the ATS review page (pre-submit screenshot +
 *    answers). Submission only happens after explicit approval, re-verified
 *    by review hash.
 *  - Every unsupported/blocked situation degrades to an assisted packet with
 *    the account already created and credentials in the vault — never a
 *    silent failure.
 */
import type { Page } from 'playwright-core';
import { db } from '../../db';
import { applications, jobMatches, candidateProfile, type Application, type JobMatch, type CandidateProfile } from '../../../shared/schema.js';
import { eq } from 'drizzle-orm';
import { transitionApplication, type AssistedPacket, type PacketAnswer } from '../applyService.js';
import {
  launchHardenedSession, detectCaptcha, visiblePageText, resolveFormScope, observeFields, sleep, humanType, type HardenedSession,
} from './browser.js';
import { computeAnswersHash, jitterMs, DAILY_ATS_SUBMIT_CAP, looksLikeConfirmation, classifySubmitOutcome } from './core.js';
import {
  enqueueBrowserRun, countTodaysAtsSubmissions, saveScreenshot, fillFieldsInScope,
} from './index.js';
import { classifyAuthPage, extractVerificationLink, isSafeVerificationLink, isAutoCheckableConsent, type PageSignals } from './loginPages.js';
import { getCredentialByDomain, saveCredential, markCredentialStatus, generateStrongPassword } from './credentialVault.js';
import { checkDomainAllowed, recordDomainRun, recordDomainBlock } from './guardrails.js';
import { openHandoff } from './handoff.js';

const MAX_WIZARD_STEPS = 14;

// ── Page signal gathering ────────────────────────────────────────────────────

export async function getPageSignals(page: Page): Promise<PageSignals> {
  const text = await visiblePageText(page);
  let hasPasswordField = false, hasConfirmPasswordField = false;
  let buttons: string[] = [];
  try {
    const pw = await page.locator('input[type="password"]:visible').count();
    hasPasswordField = pw > 0;
    hasConfirmPasswordField = pw > 1;
    buttons = (await page.locator('button:visible, a[role="button"]:visible, input[type="submit"]:visible').allInnerTexts())
      .map((b) => b.trim().toLowerCase()).filter(Boolean).slice(0, 60);
  } catch {}
  return { text, hasPasswordField, hasConfirmPasswordField, buttons };
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
        await el.click();
        await sleep(jitterMs(1500, 2800));
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return true;
      }
    } catch {}
  }
  return false;
}

// ── CAPTCHA live hand-off ────────────────────────────────────────────────────

/**
 * Blocks on a live hand-off. Returns true when the user solved the puzzle
 * (automation may continue); false when timed out / aborted (caller parks).
 */
async function captchaHandoff(app: Application, page: Page, applyUrl: string, context: string): Promise<boolean> {
  await recordDomainBlock(applyUrl, `captcha:${context}`);
  const session = await openHandoff(app.id, page,
    `A human-verification puzzle appeared while ${context}. Open the live view and solve it to let the application continue.`);
  const resolution = await session.done;
  if (resolution === 'solved') {
    await sleep(1500);
    if (await detectCaptcha(page)) return false; // still blocked
    return true;
  }
  return false;
}

// ── Email verification ───────────────────────────────────────────────────────

async function pollGmailForVerification(portalDomain: string, timeoutMs = 90_000): Promise<string | null> {
  let token: string;
  try {
    const { getGmailAccessToken } = await import('../emailSender.js');
    token = await getGmailAccessToken();
  } catch {
    return null; // Gmail not connected — manual paste-link fallback applies
  }
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Bearer ${token}` };
  while (Date.now() < deadline) {
    try {
      const q = encodeURIComponent(`newer_than:1d (verify OR verification OR activate OR confirm) ${portalDomain.split('.')[0]}`);
      const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`, { headers });
      if (list.ok) {
        const data = await list.json();
        for (const m of data.messages ?? []) {
          const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers });
          if (!msg.ok) continue;
          const full = await msg.json();
          const parts: string[] = [];
          const walk = (p: any) => {
            if (p?.body?.data) parts.push(Buffer.from(p.body.data, 'base64').toString('utf8'));
            (p?.parts ?? []).forEach(walk);
          };
          walk(full.payload);
          const link = extractVerificationLink(parts.join('\n'), portalDomain);
          if (link) return link;
        }
      }
    } catch {}
    await sleep(10_000);
  }
  return null;
}

// ── Account handling ─────────────────────────────────────────────────────────

async function performSignIn(page: Page, email: string, password: string): Promise<void> {
  const emailLoc = page.locator('input[type="email"]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible, input[type="text"][autocomplete="username"]:visible').first();
  const pwLoc = page.locator('input[type="password"]:visible').first();
  await humanType(emailLoc, email);
  await humanType(pwLoc, password);
  await clickFirst(page, [
    'button[type="submit"]:has-text("Sign In")', 'button:has-text("Sign In")', 'button:has-text("Log In")',
    'button:has-text("Sign in")', 'button[type="submit"]', 'input[type="submit"]',
  ]);
  await sleep(jitterMs(2000, 3500));
}

async function performCreateAccount(page: Page, email: string, password: string): Promise<void> {
  const emailLoc = page.locator('input[type="email"]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible').first();
  await humanType(emailLoc, email);
  const pwLocs = page.locator('input[type="password"]:visible');
  const n = await pwLocs.count();
  for (let i = 0; i < n; i++) await humanType(pwLocs.nth(i), password);
  // Consent checkboxes: ONLY explicitly-identified terms-of-use / privacy
  // acknowledgements are auto-checked. Marketing consent, attestations, and
  // anything ambiguous is never asserted on the user's behalf — if the portal
  // requires more, the signup submit fails and the flow degrades to assisted.
  try {
    const boxes = page.locator('input[type="checkbox"]:visible');
    const bc = await boxes.count();
    for (let i = 0; i < bc; i++) {
      const box = boxes.nth(i);
      const label = await box.evaluate((el) => {
        const i2 = el as HTMLInputElement;
        const l = i2.id ? document.querySelector(`label[for="${CSS.escape(i2.id)}"]`) : i2.closest('label');
        return (l as HTMLElement | null)?.innerText?.trim() ?? '';
      }).catch(() => '');
      if (isAutoCheckableConsent(label)) await box.check({ force: true }).catch(() => {});
    }
  } catch {}
  await clickFirst(page, [
    'button:has-text("Create Account")', 'button:has-text("Sign Up")', 'button:has-text("Register")',
    'button[type="submit"]', 'input[type="submit"]',
  ]);
  await sleep(jitterMs(2500, 4000));
}

function looksLikeLoginFailure(text: string): boolean {
  return /(incorrect (email|username|password)|invalid (credentials|email or password)|unable to sign in|authentication failed|account (is )?locked)/i.test(text);
}

// ── Main flow ────────────────────────────────────────────────────────────────

interface FlowCtx {
  app: Application; job: JobMatch; profile: CandidateProfile;
  applyUrl: string; portalDomain: string; atsType: string;
  answers: PacketAnswer[];
}

async function loadCtx(appId: string): Promise<FlowCtx> {
  const [app] = await db.select().from(applications).where(eq(applications.id, appId));
  if (!app) throw new Error('Application not found');
  const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, app.jobMatchId));
  const [profile] = await db.select().from(candidateProfile);
  if (!job || !profile) throw new Error('Job or profile missing');
  if (!app.applyUrl) throw new Error('Application has no resolved apply URL');
  const portalDomain = new URL(app.applyUrl).hostname;
  return { app, job, profile, applyUrl: app.applyUrl, portalDomain, atsType: app.atsType ?? 'other', answers: [] };
}

/** Degrade to assisted packet, preserving any created account note. */
async function degradeToAssisted(ctx: FlowCtx, why: string, vaultNote?: string): Promise<Application> {
  const packet = (ctx.app.packet as AssistedPacket | null) ?? { applyUrl: ctx.applyUrl, answers: [], coverNote: null, missing: [] };
  return transitionApplication(ctx.app.id, 'needs_user', 'assisted_fallback', why.slice(0, 400), {
    channel: 'assisted', packet: { ...packet, applyUrl: ctx.applyUrl },
    needsUserReason: `${why}${vaultNote ? ` ${vaultNote}` : ''} Use the prepared packet to apply manually via the apply link.`,
  });
}

/**
 * Ensure a signed-in session on the portal. Returns 'ok' when authenticated
 * (or no auth wall encountered), otherwise a terminal Application.
 */
async function ensureAuthenticated(ctx: FlowCtx, page: Page): Promise<'ok' | Application> {
  for (let i = 0; i < 6; i++) {
    if (await detectCaptcha(page)) {
      const solved = await captchaHandoff(ctx.app, page, ctx.applyUrl, 'signing in to the employer portal');
      if (!solved) {
        await saveScreenshot(ctx.app.id, page, 'failure');
        return transitionApplication(ctx.app.id, 'needs_user', 'captcha_parked',
          'CAPTCHA hand-off expired', { needsUserReason: 'A human-verification puzzle blocked the sign-in and the live hand-off expired. Retry to get a new hand-off window, or apply manually via the apply link.' });
      }
      continue;
    }
    const signals = await getPageSignals(page);
    const kind = classifyAuthPage(signals);

    if (kind === 'sign_in') {
      const cred = await getCredentialByDomain(ctx.portalDomain);
      if (cred) {
        await performSignIn(page, cred.email, cred.password);
        const after = await visiblePageText(page);
        if (looksLikeLoginFailure(after)) {
          await markCredentialStatus(ctx.portalDomain, 'login_failed');
          await recordDomainBlock(ctx.applyUrl, 'login_failed');
          await saveScreenshot(ctx.app.id, page, 'failure');
          return degradeToAssisted(ctx, 'The saved portal password was rejected — it may have been changed on the site.',
            `Your account email is ${cred.email}; use "forgot password" on the portal, then update the vault entry.`);
        }
        await markCredentialStatus(ctx.portalDomain, 'verified');
        return 'ok';
      }
      // No stored account: navigate to account creation
      const moved = await clickFirst(page, [
        'a:has-text("Create Account")', 'button:has-text("Create Account")',
        'a:has-text("Sign Up")', 'a:has-text("Register")', 'button:has-text("Sign Up")',
        'a:has-text("Don\'t have an account")',
      ]);
      if (!moved) {
        return degradeToAssisted(ctx, 'This portal requires an account but no account-creation option could be found automatically.');
      }
      continue;
    }

    if (kind === 'create_account') {
      const existing = await getCredentialByDomain(ctx.portalDomain);
      const password = existing?.password ?? generateStrongPassword();
      // INVARIANT: vault write happens BEFORE the signup form is submitted.
      await saveCredential({
        company: ctx.job.company, atsType: ctx.atsType, portalDomain: ctx.portalDomain,
        portalUrl: ctx.applyUrl, email: ctx.profile.email!, password,
        notes: `Auto-created for ${ctx.job.title}`,
      });
      await performCreateAccount(page, ctx.profile.email!, password);
      continue;
    }

    if (kind === 'verify_email') {
      // 1) User-pasted link takes precedence
      const packet = ctx.app.packet as (AssistedPacket & { verificationLink?: string }) | null;
      let link = packet?.verificationLink ?? null;
      if (link && !isSafeVerificationLink(link, ctx.portalDomain)) link = null;
      // 2) Otherwise poll the connected mailbox
      if (!link) link = await pollGmailForVerification(ctx.portalDomain);
      if (link && isSafeVerificationLink(link, ctx.portalDomain)) {
        await page.goto(link, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(jitterMs(2000, 3500));
        // Clear a consumed pasted link
        if (packet?.verificationLink) {
          await db.update(applications).set({ packet: { ...packet, verificationLink: undefined }, updatedAt: new Date() })
            .where(eq(applications.id, ctx.app.id));
        }
        continue;
      }
      await saveScreenshot(ctx.app.id, page, 'failure');
      return transitionApplication(ctx.app.id, 'needs_user', 'verify_email',
        'Awaiting email verification link', {
          needsUserReason: `The portal sent a verification email to ${ctx.profile.email}. Open it, copy the verification link, paste it into this application's "Verification link" box, then retry — the account password is already saved in your vault.`,
        });
    }

    return 'ok'; // no auth wall (or already past it)
  }
  return degradeToAssisted(ctx, 'The portal kept looping through sign-in/verification pages.');
}

/** Advance the wizard by one page: fill visible fields, then click next. */
async function fillWizardPage(ctx: FlowCtx, page: Page): Promise<'advanced' | 'review' | Application> {
  const scope = (await resolveFormScope(page, 'form, [role="main"], main')) ?? 'body';
  const fields = await observeFields(page, scope);
  if (fields.length > 0) {
    const res = await fillFieldsInScope(page, scope, fields, ctx.app, ctx.job, ctx.profile);
    ctx.answers.push(...res.answers);
    if (res.status === 'needs_user') {
      await saveScreenshot(ctx.app.id, page, 'failure');
      return transitionApplication(ctx.app.id, 'needs_user', 'wizard_blocked', res.reason?.slice(0, 300), {
        needsUserReason: res.reason,
      });
    }
  }
  const signals = await getPageSignals(page);
  if (classifyAuthPage(signals) === 'review') return 'review';
  const advanced = await clickFirst(page, [
    'button:has-text("Save and Continue")', 'button:has-text("Continue")', 'button:has-text("Next")',
    'button[type="submit"]:not(:has-text("Submit"))',
  ]);
  if (!advanced) {
    // No next button: maybe this page IS review-like (submit present)
    if (signals.buttons.some((b) => /^submit( application)?$/i.test(b))) return 'review';
    return transitionApplication(ctx.app.id, 'needs_user', 'wizard_stuck',
      'No continue/next control found', { needsUserReason: 'The application wizard page had no recognizable Continue button. Finish this application manually via the apply link — your portal account and password are saved in the vault.' });
  }
  return 'advanced';
}

/** Walk the wizard until review page / confirmation / block. */
async function walkWizard(ctx: FlowCtx, page: Page, phase: 'fill' | 'submit'): Promise<'review' | Application> {
  for (let step = 0; step < MAX_WIZARD_STEPS; step++) {
    if (await detectCaptcha(page)) {
      const solved = await captchaHandoff(ctx.app, page, ctx.applyUrl, 'completing the application wizard');
      if (!solved) {
        await saveScreenshot(ctx.app.id, page, 'failure');
        return transitionApplication(ctx.app.id, 'needs_user', 'captcha_parked',
          'CAPTCHA hand-off expired mid-wizard', { needsUserReason: 'A human-verification puzzle blocked the application wizard and the live hand-off expired. Retry to resume — progress is saved as a draft in your portal account (credentials in the vault).' });
      }
    }
    const outcome = await fillWizardPage(ctx, page);
    if (outcome === 'review') return 'review';
    if (outcome !== 'advanced') return outcome;
    await sleep(jitterMs(1200, 2200));
  }
  return degradeToAssisted(ctx, `The application wizard exceeded ${MAX_WIZARD_STEPS} pages without reaching a review step.`,
    'Your portal account is created and any progress is saved as a draft; credentials are in the vault.');
}

/**
 * CAPTCHA boundary guard: checks the page and, if blocked, runs the live
 * hand-off. Returns null when clear/solved; otherwise a parked Application.
 */
async function guardCaptcha(ctx: FlowCtx, page: Page, context: string): Promise<Application | null> {
  if (!(await detectCaptcha(page))) return null;
  const solved = await captchaHandoff(ctx.app, page, ctx.applyUrl, context);
  if (solved) return null;
  await saveScreenshot(ctx.app.id, page, 'failure');
  return transitionApplication(ctx.app.id, 'needs_user', 'captcha_parked',
    `CAPTCHA hand-off expired while ${context}`, {
      needsUserReason: `A human-verification puzzle appeared while ${context} and the live hand-off window expired. Retry to get a new hand-off, or finish manually via the portal (credentials in your vault).`,
    });
}

async function runLoginWalledPhase(appId: string, phase: 'fill' | 'submit'): Promise<Application> {
  const ctx = await loadCtx(appId);
  // A saved verification link means the user is actively continuing a signup
  // that just ran — bypass only the between-runs gap, never block/downgrade
  // controls.
  const hasPastedLink = !!((ctx.app.packet as any)?.verificationLink);
  // Continuations bypass only the inter-run gap, never block cooldowns or
  // downgrades: the submit phase follows the fill run the user just reviewed,
  // and a pasted verification link continues the signup that just ran.
  const gate = await checkDomainAllowed(ctx.applyUrl, { ignoreRunGap: phase === 'submit' || hasPastedLink });
  if (!gate.allowed) {
    return transitionApplication(appId, 'needs_user', 'guardrail_block', gate.reason?.slice(0, 200), { needsUserReason: gate.reason });
  }
  if (phase === 'submit' && await countTodaysAtsSubmissions() >= DAILY_ATS_SUBMIT_CAP) {
    return transitionApplication(appId, 'needs_user', 'daily_cap',
      'Daily submission cap reached', { needsUserReason: `The daily automated submission cap (${DAILY_ATS_SUBMIT_CAP}) is reached. This application will be retried tomorrow, or submit it manually.` });
  }
  await recordDomainRun(ctx.applyUrl);

  let session: HardenedSession | null = null;
  try {
    session = await launchHardenedSession(ctx.applyUrl);
    const { page } = session;
    await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded' });
    await sleep(jitterMs(2000, 3500));
    await clickFirst(page, ['a:has-text("Apply")', 'button:has-text("Apply")', 'a:has-text("Apply Now")', 'button:has-text("Apply Now")']);

    const auth = await ensureAuthenticated(ctx, page);
    if (auth !== 'ok') return auth;

    // Some portals re-ask which apply method — prefer manual/autofill-less path
    await clickFirst(page, ['a:has-text("Apply Manually")', 'button:has-text("Apply Manually")']);

    const wiz = await walkWizard(ctx, page, phase);
    if (wiz !== 'review') return wiz;

    // ── Review page reached ──
    // CAPTCHA boundary check: a puzzle appearing ON the review page must be
    // handed off before any screenshot/submit decision.
    const reviewBlocked = await guardCaptcha(ctx, page, 'reviewing the application');
    if (reviewBlocked) return reviewBlocked;

    const reviewHash = computeAnswersHash(ctx.applyUrl, ctx.answers.map((a) => ({ label: a.label, value: a.value })));
    if (phase === 'fill') {
      const shotId = await saveScreenshot(appId, page, 'pre_submit');
      if (!shotId) {
        return transitionApplication(appId, 'needs_user', 'screenshot_failed',
          'Pre-submit screenshot could not be captured', { needsUserReason: 'The application reached the review page but the evidence screenshot failed — review and submit manually via the portal (credentials in your vault).' });
      }
      const packet: AssistedPacket = {
        applyUrl: ctx.applyUrl, answers: ctx.answers, coverNote: (ctx.app.packet as AssistedPacket | null)?.coverNote ?? null,
        missing: [], reviewHash,
      };
      // Review-mode pause: close the session; the draft lives in the portal
      // account. On approval we re-login and walk the wizard again.
      return transitionApplication(appId, 'ready_for_review', 'review_page_reached',
        'Paused at the portal review page', { packet, needsUserReason: null });
    }

    // Submit phase: hash-bind approval to the answers now on the review page
    const storedHash = (ctx.app.packet as AssistedPacket | null)?.reviewHash;
    if (!storedHash || storedHash !== reviewHash) {
      await saveScreenshot(appId, page, 'failure');
      return transitionApplication(appId, 'needs_user', 'review_hash_mismatch',
        'Answers changed between review and submit', { needsUserReason: 'The answers on the portal review page no longer match what you approved. Re-run preparation to review again before submitting.' });
    }
    // Final boundary check immediately before the submit click
    const preSubmitBlocked = await guardCaptcha(ctx, page, 'submitting the application');
    if (preSubmitBlocked) return preSubmitBlocked;

    const submitted = await clickFirst(page, ['button:has-text("Submit Application")', 'button:has-text("Submit")']);
    if (!submitted) {
      return transitionApplication(appId, 'needs_user', 'submit_control_missing',
        'No submit button on review page', { needsUserReason: 'The review page had no recognizable Submit button. Submit manually via the portal — everything is filled in.' });
    }
    await sleep(jitterMs(3000, 5000));
    // A CAPTCHA can also gate the post-submit step — hand off before judging
    // the outcome unconfirmed.
    const postSubmitBlocked = await guardCaptcha(ctx, page, 'confirming the submission');
    if (postSubmitBlocked) return postSubmitBlocked;
    const confText = await visiblePageText(page);
    const confirmed = looksLikeConfirmation(confText, page.url());
    const confShotId = await saveScreenshot(appId, page, 'confirmation');
    const verdict = classifySubmitOutcome({ confirmed, validationError: null, shotStored: !!confShotId });
    if (verdict === 'submitted') {
      return transitionApplication(appId, 'submitted', 'confirmed', 'Portal confirmation detected');
    }
    return transitionApplication(appId, 'submitted_unconfirmed', 'unconfirmed',
      'Submitted but no confirmation message detected — verify in the portal (credentials in your vault).');
  } catch (e: any) {
    if (session) { try { await saveScreenshot(appId, session.page, 'failure'); } catch {} }
    return transitionApplication(appId, phase === 'submit' ? 'needs_user' : 'failed', 'error', String(e?.message ?? e).slice(0, 400), {
      needsUserReason: phase === 'submit' ? `Automated submission failed: ${String(e?.message ?? e).slice(0, 200)}. Your portal account and credentials are in the vault — submit manually.` : undefined,
    });
  } finally {
    if (session) await session.close();
  }
}

export async function prepareLoginWalledApplication(appId: string): Promise<Application> {
  return enqueueBrowserRun(() => runLoginWalledPhase(appId, 'fill'));
}

export async function submitLoginWalledApplication(appId: string): Promise<Application> {
  return enqueueBrowserRun(() => runLoginWalledPhase(appId, 'submit'));
}

/** Store a user-pasted verification link and retry preparation. */
export async function setVerificationLink(appId: string, link: string): Promise<void> {
  const [app] = await db.select().from(applications).where(eq(applications.id, appId));
  if (!app) throw new Error('Application not found');
  const portalDomain = app.applyUrl ? new URL(app.applyUrl).hostname : '';
  if (!isSafeVerificationLink(link, portalDomain)) {
    throw new Error('That link does not belong to this employer\'s portal domain — paste the exact link from the verification email.');
  }
  const packet = (app.packet as any) ?? {};
  await db.update(applications).set({ packet: { ...packet, verificationLink: link }, updatedAt: new Date() })
    .where(eq(applications.id, appId));
}
