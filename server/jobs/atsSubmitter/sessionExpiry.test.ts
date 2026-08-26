/**
 * Regression test for the mid-wizard session-expiry gap: a Workday-class
 * portal session dropping (timeout, forced re-auth) mid-application
 * silently returns to a sign-in page. Without re-checking auth status on
 * every wizard step, that page's password field would be observed and
 * filled exactly like any other wizard field — pausing with a message that
 * invites the admin to save the REAL portal password into Screening
 * Answers (a vault reused, via fuzzy match, across every future
 * application on every other employer's portal).
 *
 * fillWizardPage now re-verifies authentication (ensureAuthenticated) on
 * every step before observing fields — a genuine wizard page pays only the
 * cost of one classification call; a page that's reverted to sign-in gets
 * silently re-authenticated with the vaulted credential instead.
 *
 * Requires DATABASE_URL (real Postgres) — run standalone:
 *   DATABASE_URL=... npx tsx --test server/jobs/atsSubmitter/sessionExpiry.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { launchHardenedSession, type HardenedSession } from './browser.js';
import { fillWizardPage, type FlowCtx } from './loginWalled.js';
import { saveCredential, generateStrongPassword } from './credentialVault.js';
import { db, client } from '../../db.js';
import { atsCredentials } from '../../../shared/schema.js';
import { eq } from 'drizzle-orm';

const PORTAL_DOMAIN = 'fixture.session-expiry.test';
const KNOWN_PASSWORD = generateStrongPassword();

const LOGIN_HTML = `<!doctype html><html><body>
<form method="GET" action="/wizard-content">
  <input type="email" name="email">
  <input type="password" name="password">
  <button type="submit">Sign In</button>
</form>
</body></html>`;

// No form/inputs and no "Continue"/"Next"/"Save and Continue" control here —
// fillWizardPage performs a full step (re-auth check, then fill, then click
// Continue) in one call, so a further advance-control on THIS page would
// have it click past this page (re-submitting the login form with no
// password) before the test ever gets to inspect it. Shaped to classify as
// a terminal "review" page (see classifyAuthPage) so fillWizardPage returns
// cleanly right after the auth check, with no further action of its own —
// what it did to GET here is what's being verified, not what it does next.
const WIZARD_LANDING_HTML = `<!doctype html><html><body>
<p>Review your application before submitting.</p>
<button type="button">Submit Application</button>
</body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;
let capturedPassword = '';
const savedSessionSecret = process.env.SESSION_SECRET;

before(async () => {
  // saveCredential encrypts with SESSION_SECRET — set a throwaway one if this
  // sandbox doesn't already have one configured (matches vault.test.ts's
  // convention of an explicit test secret).
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'test-session-secret-for-vault-fixture';

  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/wizard-content') {
      capturedPassword = u.searchParams.get('password') ?? '';
      return res.end(WIZARD_LANDING_HTML);
    }
    return res.end(LOGIN_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/session-expired`);

  await saveCredential({
    company: 'Acme', atsType: 'workday', portalDomain: PORTAL_DOMAIN,
    portalUrl: base, email: 'sanchit@example.com', password: KNOWN_PASSWORD,
  });
});

after(async () => {
  await session?.close();
  server?.close();
  await db.delete(atsCredentials).where(eq(atsCredentials.portalDomain, PORTAL_DOMAIN));
  await client.end({ timeout: 5 }).catch(() => {});
  if (savedSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = savedSessionSecret;
});

function makeCtx(): FlowCtx {
  return {
    app: {} as any, job: { company: 'Acme', title: 'Engineer' } as any,
    profile: { email: 'sanchit@example.com' } as any,
    applyUrl: `${base}/session-expired`, portalDomain: PORTAL_DOMAIN, atsType: 'workday', answers: [],
  };
}

test('a mid-wizard session-expiry page is silently re-authenticated with the vaulted credential, never filled as a screening question', async () => {
  await session.page.goto(`${base}/session-expired`);
  capturedPassword = '';
  const outcome = await fillWizardPage(makeCtx(), session.page);

  assert.equal(outcome, 'review', 'must sign back in and reach the next page, not pause on the password field');
  assert.equal(capturedPassword, KNOWN_PASSWORD, 'the exact vaulted password must have been used to sign back in — never left blank, never guessed');
});
