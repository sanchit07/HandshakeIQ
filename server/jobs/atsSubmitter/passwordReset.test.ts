/**
 * Integration test for the automated password-reset flow (attemptPasswordReset):
 * click "Forgot password", submit the account email, follow the reset link
 * (injected — this test never touches the real Gmail API), and set a fresh
 * password on the portal's reset form. Runs against a real Playwright
 * session and a locally-served fixture site — no real ATS is contacted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, type HardenedSession } from './browser.js';
import { attemptPasswordReset, type FlowCtx } from './loginWalled.js';

const LOGIN_HTML = `<!doctype html><html><body>
<form>
  <input type="email" name="email">
  <input type="password" name="password">
  <button type="submit">Sign In</button>
</form>
<a href="/login/reset-request">Forgot password?</a>
</body></html>`;

const RESET_REQUEST_HTML = `<!doctype html><html><body>
<form method="GET" action="/login/reset-sent">
  <input type="email" name="email" placeholder="Email">
  <button type="submit">Send</button>
</form>
</body></html>`;

const RESET_SENT_HTML = `<!doctype html><html><body><p>Check your email for a reset link.</p></body></html>`;

const RESET_FORM_HTML = `<!doctype html><html><body>
<form method="GET" action="/login/reset-success">
  <input type="password" name="password">
  <input type="password" name="password_confirm">
  <button type="submit">Reset Password</button>
</form>
</body></html>`;

const RESET_SUCCESS_HTML = `<!doctype html><html><body><p>Your password has been reset. You are now signed in.</p></body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const url = req.url || '';
    if (url.startsWith('/login/reset-success')) return res.end(RESET_SUCCESS_HTML);
    if (url.startsWith('/login/reset-form')) return res.end(RESET_FORM_HTML);
    if (url.startsWith('/login/reset-sent')) return res.end(RESET_SENT_HTML);
    if (url.startsWith('/login/reset-request')) return res.end(RESET_REQUEST_HTML);
    return res.end(LOGIN_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/login`);
});

after(async () => { await session?.close(); server?.close(); });

function makeCtx(): FlowCtx {
  return {
    app: {} as any, job: { company: 'Acme', title: 'Engineer' } as any,
    profile: { email: 'sanchit@example.com' } as any,
    applyUrl: `${base}/login`, portalDomain: '127.0.0.1', atsType: 'workday', answers: [],
  };
}

test('attemptPasswordReset clicks Forgot password, submits the email, follows the reset link, and sets a fresh password', async () => {
  await session.page.goto(`${base}/login`);
  let polledDomain: string | null = null;
  const newPassword = await attemptPasswordReset(makeCtx(), session.page, {
    pollLink: async (domain) => { polledDomain = domain; return `${base}/login/reset-form`; },
  });

  assert.ok(newPassword, 'must return a freshly generated password on success');
  assert.equal(typeof newPassword, 'string');
  assert.ok(newPassword!.length >= 16, 'reuses generateStrongPassword — must meet its complexity length');
  assert.equal(polledDomain, '127.0.0.1', 'polls using the portal domain from the flow context');
  assert.match(session.page.url(), /reset-success/, 'must have walked all the way to the post-reset page');
  assert.match(await session.page.locator('body').innerText(), /password has been reset/i);
});

test('attemptPasswordReset returns null when no forgot-password control exists on the page', async () => {
  await session.page.goto(`${base}/login/reset-success`); // no "Forgot password" link on this page
  const result = await attemptPasswordReset(makeCtx(), session.page, { pollLink: async () => `${base}/login/reset-form` });
  assert.equal(result, null);
});

test('attemptPasswordReset returns null when the reset link never arrives (pollLink resolves null)', async () => {
  await session.page.goto(`${base}/login`);
  const result = await attemptPasswordReset(makeCtx(), session.page, { pollLink: async () => null });
  assert.equal(result, null);
});

test('attemptPasswordReset rejects a reset link on an unexpected domain (never navigates there)', async () => {
  await session.page.goto(`${base}/login`);
  const result = await attemptPasswordReset(makeCtx(), session.page, { pollLink: async () => 'https://evil.example.com/reset' });
  assert.equal(result, null, 'a link on a domain other than the portal must be rejected, not followed');
});

test('attemptPasswordReset returns null when the "reset link" page has no password field', async () => {
  await session.page.goto(`${base}/login`);
  // Points the injected link at a page with no password inputs at all (e.g. a
  // stale/consumed link, or a page shape this code doesn't recognize) — must
  // stop rather than guess at what to click next.
  const result = await attemptPasswordReset(makeCtx(), session.page, { pollLink: async () => `${base}/login/reset-sent` });
  assert.equal(result, null);
});
