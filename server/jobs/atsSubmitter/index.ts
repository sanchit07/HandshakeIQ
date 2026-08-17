/**
 * Headless ATS submission orchestrator (Phase 2 — Greenhouse/Lever/Ashby/
 * SmartRecruiters + generic best-effort).
 *
 * Guarantees:
 *  - Review-before-submit default: a fill-only run captures a pre-submit
 *    screenshot + every answer for user approval; submission is a second run.
 *  - Unknown/sensitive/CAPTCHA → needs_user with a reason + evidence screenshot.
 *  - Single-flight queue, bounded daily volume, 3 retries with 2–6 s jitter for
 *    transient failures; deterministic failures fail fast + liveness re-check.
 *  - Confirmation detection; otherwise `submitted_unconfirmed` (never a silent
 *    "submitted" claim without evidence).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../../db';
import {
  applications, applicationScreenshots, jobMatches,
  type Application, type JobMatch, type CandidateProfile,
} from '../../../shared/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { Page } from 'playwright-core';
import {
  transitionApplication, getProfile, workAuthBlockReason,
  type AssistedPacket, type PacketAnswer,
} from '../applyService.js';
import { probeUrlLive } from '../jobMatchService.js';
import {
  buildCanonicalValues, resolveField, classifyField, isTransientError,
  looksLikeConfirmation, jitterMs, RETRY_ATTEMPTS, RETRY_JITTER,
  DAILY_ATS_SUBMIT_CAP, SUPPORTED_ATS, LOGIN_WALLED_ATS, computeAnswersHash,
  classifySubmitOutcome,
} from './core.js';
import {
  launchHardenedSession, observeFields, resolveFormScope, humanType, humanPause, sleep,
  detectCaptcha, visiblePageText, bestOption, type DomField,
} from './browser.js';
import { getAdapter } from './adapters.js';

export { SUPPORTED_ATS, LOGIN_WALLED_ATS, DAILY_ATS_SUBMIT_CAP };

// ── Single-flight queue ──────────────────────────────────────────────────────

let queueTail: Promise<unknown> = Promise.resolve();

const ATS_LOCK_KEY = 731_442_017; // arbitrary stable app-wide advisory lock key

// Dedicated single-connection client for the advisory lock: session advisory
// locks are per-connection, so lock and unlock MUST run on the same session —
// never on a pooled connection that could differ between the two calls.
let lockClient: Awaited<ReturnType<typeof createLockClient>> | null = null;
async function createLockClient() {
  const postgres = (await import('postgres')).default;
  return postgres(process.env.DATABASE_URL!, { max: 1 });
}
async function getLockClient() {
  if (!lockClient) lockClient = await createLockClient();
  return lockClient;
}

/**
 * All browser runs execute strictly one at a time. Two layers:
 *  - in-process promise chain (fast path)
 *  - Postgres session advisory lock (correct across replicas in deployment;
 *    also makes the daily-cap check atomic — the count happens inside the lock)
 */
export function enqueueBrowserRun<T>(fn: () => Promise<T>): Promise<T> {
  const locked = async (): Promise<T> => {
    const lc = await getLockClient();
    await lc`SELECT pg_advisory_lock(${ATS_LOCK_KEY})`;
    try {
      return await fn();
    } finally {
      try { await lc`SELECT pg_advisory_unlock(${ATS_LOCK_KEY})`; } catch {}
    }
  };
  const run = queueTail.then(locked, locked);
  queueTail = run.catch(() => {});
  return run;
}

// ── Daily volume bound ──────────────────────────────────────────────────────

export async function countTodaysAtsSubmissions(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(applications)
    .where(sql`${applications.channel} = 'ats_auto'
      AND ${applications.state} IN ('submitted', 'submitted_unconfirmed')
      AND ${applications.submittedAt} >= date_trunc('day', now())`);
  return rows[0]?.n ?? 0;
}

// ── Screenshot persistence ───────────────────────────────────────────────────

async function saveScreenshot(appId: string, page: Page, kind: 'pre_submit' | 'confirmation' | 'failure'): Promise<string | null> {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true, timeout: 15000 });
    const [row] = await db.insert(applicationScreenshots).values({
      applicationId: appId, kind, mime: 'image/jpeg',
      dataBase64: buf.toString('base64'), pageUrl: page.url().slice(0, 2000),
    }).returning({ id: applicationScreenshots.id });
    return row?.id ?? null;
  } catch (e: any) {
    console.log(`[ATS] Screenshot capture failed (${kind}): ${e?.message}`);
    return null;
  }
}

export async function getScreenshotsMeta(appId: string) {
  return db.select({
    id: applicationScreenshots.id, kind: applicationScreenshots.kind,
    mime: applicationScreenshots.mime, pageUrl: applicationScreenshots.pageUrl,
    createdAt: applicationScreenshots.createdAt,
  }).from(applicationScreenshots).where(eq(applicationScreenshots.applicationId, appId));
}

export async function getScreenshot(appId: string, shotId: string) {
  const rows = await db.select().from(applicationScreenshots)
    .where(sql`${applicationScreenshots.id} = ${shotId} AND ${applicationScreenshots.applicationId} = ${appId}`);
  return rows[0] ?? null;
}

// ── Fill engine (shared by fill-only and submit runs) ────────────────────────

interface FillOutcome {
  status: 'filled' | 'needs_user' | 'captcha';
  reason?: string;
  answers: PacketAnswer[];
  page: Page;
  /** Unique selector of the resolved application form (set when filled). */
  formSelector?: string;
}

async function generateCvFile(job: JobMatch): Promise<string> {
  const { generateCvPdf } = await import('../cvPdfGenerator.js');
  const pdf = await generateCvPdf(job.tailoredCv!, job.title, job.company);
  const file = path.join(os.tmpdir(), `cv_${job.id.slice(0, 8)}_${Date.now()}.pdf`);
  fs.writeFileSync(file, pdf);
  return file;
}

/** Exported for integration tests (decoy-form PII-scoping fixtures). */
export async function fillForm(page: Page, app: Application, job: JobMatch, profile: CandidateProfile): Promise<FillOutcome> {
  const adapter = getAdapter(app.atsType);
  await page.goto(app.applyUrl!, { waitUntil: 'domcontentloaded' });
  await sleep(jitterMs(1500, 3500));

  if (await detectCaptcha(page)) {
    return { status: 'captcha', reason: 'The application page shows a CAPTCHA before the form. Complete this application manually via the apply link.', answers: [], page };
  }

  if (adapter.openForm) await adapter.openForm(page);
  if (await detectCaptcha(page)) {
    return { status: 'captcha', reason: 'A CAPTCHA appeared when opening the application form. Complete this application manually via the apply link.', answers: [], page };
  }

  // Bind the whole run (observe → fill → submit) to ONE resolved form element,
  // so a newsletter/search/login form on the same page can never be filled or
  // submitted by mistake.
  const formSelector = await resolveFormScope(page, adapter.formScope);
  if (!formSelector) {
    return { status: 'needs_user', reason: 'No fillable application form was found on the page — the posting may use an unsupported flow. Apply manually via the apply link.', answers: [], page };
  }
  const fields = await observeFields(page, formSelector);
  if (fields.length === 0) {
    return { status: 'needs_user', reason: 'No fillable application form was found on the page — the posting may use an unsupported flow. Apply manually via the apply link.', answers: [], page };
  }

  const canon = buildCanonicalValues(profile, job);
  const answers: PacketAnswer[] = [];
  let cvFile: string | null = null;
  const radioGroups = new Set<string>();
  // Every fill operation is located from the resolved FORM, never from the
  // document — a decoy form sharing field names (email, first_name, …) must
  // never receive candidate PII.
  const form = page.locator(formSelector);

  try {
    for (const field of fields) {
      // Radio groups: handle once per name
      if (field.kind === 'radio') {
        if (radioGroups.has(field.name)) continue;
        radioGroups.add(field.name);
      }

      if (field.kind === 'file') {
        const cls = classifyField(field.label, field.name);
        if (cls.key === 'coverLetter') continue; // optional; skip uploads for cover letters
        // Resume upload (also default for an unlabeled single file input)
        if (!job.tailoredCv) {
          return { status: 'needs_user', reason: 'This form requires a resume upload but no tailored CV exists yet. Generate the CV first ("Prepare Tailored CV"), then retry.', answers, page };
        }
        cvFile = cvFile ?? await generateCvFile(job);
        await form.locator(field.selector).first().setInputFiles(cvFile);
        answers.push({ label: field.label || 'Resume', value: 'Tailored CV PDF (uploaded)', source: 'cv' });
        await humanPause();
        continue;
      }

      const res = resolveField(field, canon);
      if (res.blockReason) {
        return { status: 'needs_user', reason: res.blockReason, answers, page };
      }
      if (res.value === null) {
        // Cover-letter textarea: use the drafted cover note when we have one
        const cls = classifyField(field.label, field.name);
        if (cls.key === 'coverLetter' && (app.packet as AssistedPacket | null)?.coverNote && field.kind === 'textarea') {
          const note = (app.packet as AssistedPacket).coverNote!;
          await humanType(form.locator(field.selector).first(), note);
          answers.push({ label: field.label || 'Cover letter', value: note, source: 'cv' });
          await humanPause();
        }
        continue;
      }

      const loc = form.locator(field.selector).first();
      if (field.kind === 'select') {
        const opt = bestOption(field.options ?? [], res.value);
        if (!opt) {
          if (field.required) {
            return { status: 'needs_user', reason: `The form's options for "${field.label}" don't match your saved answer ("${res.value}"). Answer this one manually via the apply link, or adjust your Profile Vault wording.`, answers, page };
          }
          continue;
        }
        await loc.selectOption({ label: opt });
        answers.push({ label: field.label, value: opt, source: res.source === 'vault' ? 'vault' : 'cv' });
      } else if (field.kind === 'radio') {
        // Click the radio in the group whose label matches (within the form)
        const groupLabels = await form.locator(`input[type="radio"][name="${field.name}"]`).evaluateAll((els) =>
          els.map((el) => {
            const i = el as HTMLInputElement;
            const l = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : i.closest('label');
            return (l as HTMLElement | null)?.innerText?.trim() || i.value;
          }));
        const opt = bestOption(groupLabels, res.value);
        if (!opt) {
          if (field.required) {
            return { status: 'needs_user', reason: `No option for "${field.label}" matches your saved answer ("${res.value}"). Answer it manually via the apply link.`, answers, page };
          }
          continue;
        }
        const idxOpt = groupLabels.indexOf(opt);
        await form.locator(`input[type="radio"][name="${field.name}"]`).nth(idxOpt).check({ force: true });
        answers.push({ label: field.label, value: opt, source: 'vault' });
      } else if (field.kind === 'checkbox') {
        if (/^yes$/i.test(res.value)) { await loc.check({ force: true }); answers.push({ label: field.label, value: 'Yes', source: 'vault' }); }
      } else {
        await humanType(loc, res.value);
        answers.push({ label: field.label, value: res.value, source: 'vault' });
      }
      await humanPause();
    }
  } finally {
    if (cvFile) { try { fs.unlinkSync(cvFile); } catch {} }
  }

  if (await detectCaptcha(page)) {
    return { status: 'captcha', reason: 'A CAPTCHA appeared after filling the form. Complete this application manually via the apply link — your answers are saved below.', answers, page };
  }
  return { status: 'filled', answers, page, formSelector };
}

// ── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || attempt === RETRY_ATTEMPTS) throw e;
      const wait = jitterMs(RETRY_JITTER.min, RETRY_JITTER.max);
      console.log(`[ATS] ${label} attempt ${attempt} failed transiently (${String((e as any)?.message).slice(0, 150)}); retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Fill-only run (review mode): fills the form, captures the pre-submit
 * screenshot and every answer, then pauses at ready_for_review. Nothing is
 * submitted here.
 */
export async function prepareAtsApplication(appId: string): Promise<Application> {
  return enqueueBrowserRun(() => runAtsPhase(appId, 'fill'));
}

/** Submission run (after user approval): re-fills and submits. */
export async function submitAtsApplication(appId: string): Promise<Application> {
  return enqueueBrowserRun(() => runAtsPhase(appId, 'submit'));
}

async function runAtsPhase(appId: string, phase: 'fill' | 'submit'): Promise<Application> {
  const [app] = await db.select().from(applications).where(eq(applications.id, appId));
  if (!app) throw new Error('Application not found');
  if (!app.applyUrl) throw new Error('Application has no apply route');
  const [job] = await db.select().from(jobMatches).where(eq(jobMatches.id, app.jobMatchId));
  if (!job) throw new Error('Job match not found');
  const profile = await getProfile();
  if (!profile) throw new Error('Profile vault is empty');

  // Sensitive gate re-check (belt-and-braces — prepare already gates this)
  const gap = workAuthBlockReason(profile, job.country);
  if (gap) {
    return transitionApplication(appId, 'needs_user', gap.step, undefined, { needsUserReason: gap.reason });
  }

  if (phase === 'submit') {
    const already = await countTodaysAtsSubmissions();
    if (already >= DAILY_ATS_SUBMIT_CAP) {
      return transitionApplication(appId, 'needs_user', 'daily_cap',
        `Daily ATS submission cap reached (${DAILY_ATS_SUBMIT_CAP})`, {
          needsUserReason: `Today's automatic-submission cap (${DAILY_ATS_SUBMIT_CAP}) is reached. Approve this application again tomorrow, or apply manually via the apply link.`,
        });
    }
  }

  let session: Awaited<ReturnType<typeof launchHardenedSession>> | null = null;
  try {
    const result = await withRetries(`${phase} ${appId.slice(0, 8)}`, async () => {
      if (session) { await session.close(); session = null; }
      session = await launchHardenedSession(app.applyUrl!);
      const outcome = await fillForm(session.page, app, job, profile);

      if (outcome.status !== 'filled') {
        const shotId = await saveScreenshot(appId, outcome.page, 'failure');
        return { kind: 'needs_user' as const, reason: outcome.reason!, answers: outcome.answers, shotId };
      }

      // The pre-submit screenshot is a hard requirement (review evidence in
      // the fill phase, audit evidence in the submit phase): if it cannot be
      // captured AND stored, the run fails closed — nothing proceeds.
      const preShotId = await saveScreenshot(appId, outcome.page, 'pre_submit');
      if (!preShotId) {
        throw new Error('Pre-submit screenshot could not be captured/stored — refusing to proceed without review evidence.');
      }

      if (phase === 'fill') {
        return { kind: 'filled' as const, answers: outcome.answers, shotId: preShotId };
      }

      // Approval binding: the user approved a specific reviewed answer set.
      // If the freshly filled form produced different answers (vault changed,
      // ATS form changed, option mapping shifted), do NOT submit — go back to
      // review with the new evidence.
      const reviewedHash = (app.packet as AssistedPacket | null)?.reviewHash;
      const currentHash = computeAnswersHash(app.applyUrl!, outcome.answers);
      if (!reviewedHash || reviewedHash !== currentHash) {
        return {
          kind: 'needs_user' as const,
          reason: 'The form answers changed between your review and submission (your Profile Vault or the ATS form was updated). Nothing was submitted — review the new pre-submit screenshot and approve again.',
          answers: outcome.answers, shotId: preShotId,
        };
      }

      // Submit — the button is searched ONLY within the resolved application
      // form, never globally (a newsletter/login form must not be clickable).
      const adapter = getAdapter(app.atsType);
      const submitBtn = session.page.locator(outcome.formSelector!).locator(adapter.submitSelector).first();
      if (await submitBtn.count() === 0) {
        const shotId = await saveScreenshot(appId, session.page, 'failure');
        return { kind: 'needs_user' as const, reason: 'The submit button could not be found after filling the form. Complete the submission manually via the apply link.', answers: outcome.answers, shotId };
      }
      await sleep(jitterMs(800, 2200));
      await submitBtn.click();
      // Wait for the page to settle, then look for confirmation
      await session.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await sleep(jitterMs(2000, 4000));

      if (await detectCaptcha(session.page)) {
        const shotId = await saveScreenshot(appId, session.page, 'failure');
        return { kind: 'needs_user' as const, reason: 'A CAPTCHA appeared at submission. Complete this application manually via the apply link.', answers: outcome.answers, shotId };
      }

      const text = await visiblePageText(session.page);
      const confirmed = looksLikeConfirmation(text, session.page.url());
      // Validation errors still on screen ⇒ not submitted
      const validationError = /(?:is required|required field|please (?:complete|fill|correct)|fix the errors)/i.test(text) && !confirmed;
      const confShotId = await saveScreenshot(appId, session.page, 'confirmation');
      // Pure, tested policy: a click is not proof of acceptance, and any
      // submitted-like state requires stored screenshot evidence. Missing
      // post-click evidence ⇒ manual verification, never "submitted".
      const verdict = classifySubmitOutcome({ confirmed, validationError, shotStored: !!confShotId });
      if (verdict === 'needs_user') {
        const reason = validationError
          ? 'The form reported validation errors after submission — some answers were rejected. Review the screenshot and complete the application manually via the apply link.'
          : 'Submit was clicked but the outcome evidence could not be captured — verify on the ATS whether the application went through before retrying. The pre-submit screenshot shows exactly what was filled.';
        return { kind: 'needs_user' as const, reason, answers: outcome.answers, shotId: confShotId };
      }
      return { kind: verdict, answers: outcome.answers, shotId: confShotId };
    });

    const packet: AssistedPacket = {
      applyUrl: app.applyUrl!, answers: result.answers,
      coverNote: (app.packet as AssistedPacket | null)?.coverNote ?? null, missing: [],
    };

    if (result.kind === 'needs_user') {
      return await transitionApplication(appId, 'needs_user', `${phase}_paused`, result.reason.slice(0, 300), {
        needsUserReason: result.reason, packet,
      });
    }
    if (result.kind === 'filled') {
      // Bind future approval to exactly these answers (see submit-phase check)
      packet.reviewHash = computeAnswersHash(app.applyUrl!, result.answers);
      return await transitionApplication(appId, 'ready_for_review', 'ats_form_filled',
        `Form filled with ${result.answers.length} answer(s); pre-submit screenshot captured`, { packet });
    }
    if (result.kind === 'submitted') {
      return await transitionApplication(appId, 'submitted', 'ats_submitted',
        'Submission confirmed by the ATS confirmation page', { packet });
    }
    return await transitionApplication(appId, 'submitted_unconfirmed', 'ats_submitted_unconfirmed',
      'Form was submitted but no confirmation message was detected — check the screenshot', { packet });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error(`[ATS] ${phase} failed for ${appId.slice(0, 8)}: ${msg}`, e?.stack ? `\n${String(e.stack).slice(0, 1500)}` : '');
    if (session) { try { await saveScreenshot(appId, (session as any).page, 'failure'); } catch {} }
    // Deterministic failure → re-check the route is still live; a dead route
    // becomes a clear needs_user instead of an opaque failure.
    if (!isTransientError(e)) {
      try {
        const probe = await probeUrlLive(app.applyUrl!);
        if (!probe.live) {
          return await transitionApplication(appId, 'needs_user', `${phase}_route_dead`, 'Apply route is no longer live', {
            needsUserReason: 'The application page is no longer live — the posting appears to have closed. This job cannot be applied to automatically.',
          });
        }
      } catch {}
    }
    return await transitionApplication(appId, 'failed', `${phase}_error`, msg.slice(0, 500), {
      errorReason: msg.slice(0, 1000),
    });
  } finally {
    if (session) await (session as any).close();
  }
}
