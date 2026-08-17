/**
 * Integration tests for the browser layer against a locally-served fixture
 * form (greenhouse-style). Verifies field observation, option matching,
 * CAPTCHA detection, and the main-frame navigation allowlist — no real ATS
 * is contacted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, observeFields, resolveFormScope, detectCaptcha, bestOption, humanType, type HardenedSession } from './browser.js';

const FORM_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="first_name">First Name *</label><input id="first_name" name="job_application[first_name]" required>
  <label for="email">Email *</label><input id="email" type="email" name="job_application[email]" required>
  <label for="phone">Phone</label><input id="phone" type="tel" name="job_application[phone]">
  <label for="resume">Resume/CV *</label><input id="resume" type="file" name="resume" style="display:none" required>
  <label for="sponsor">Will you require visa sponsorship? *</label>
  <select id="sponsor" name="sponsorship" required>
    <option value="">Select…</option><option>Yes</option><option>No</option>
  </select>
  <fieldset><legend>Gender</legend>
    <label><input type="radio" name="gender" value="m">Male</label>
    <label><input type="radio" name="gender" value="d">Prefer not to say</label>
  </fieldset>
  <textarea name="cover_letter" placeholder="Cover Letter"></textarea>
  <button type="submit" id="submit_app">Submit Application</button>
</form>
</body></html>`;

const CAPTCHA_HTML = `<!doctype html><html><body><form><div class="g-recaptcha" data-sitekey="x">captcha</div></form></body></html>`;

// A page whose FIRST form is a newsletter signup and whose second form is the
// real application form — form resolution must pick the application form and
// the submit click must be scoped to it.
const MULTIFORM_HTML = `<!doctype html><html><body>
<form id="newsletter"><input type="email" name="nl_email" placeholder="Newsletter email">
  <button type="submit" id="nl_submit">Subscribe</button></form>
<form id="login"><input name="user"><input type="password" name="pass"><button type="submit">Log in</button></form>
<form id="apply_form">
  <label for="afn">First Name *</label><input id="afn" name="first_name" required>
  <label for="aem">Email *</label><input id="aem" type="email" name="email" required>
  <label for="acv">Resume/CV *</label><input id="acv" type="file" name="resume" required>
  <textarea name="cover_letter" placeholder="Cover Letter"></textarea>
  <button type="submit" id="apply_submit">Submit Application</button>
</form></body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url?.includes('captcha') ? CAPTCHA_HTML : req.url?.includes('multi') ? MULTIFORM_HTML : FORM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/jobs/1`);
});

after(async () => {
  await session?.close();
  server?.close();
});

test('observes fields with labels, kinds, required flags, and options', async () => {
  await session.page.goto(`${base}/jobs/1`);
  const fields = await observeFields(session.page, '#application_form');
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]));

  assert.ok(byLabel['First Name'], 'strips trailing asterisk from label');
  assert.equal(byLabel['First Name'].required, true);
  assert.equal(byLabel['Email'].kind, 'email');
  assert.equal(byLabel['Phone'].required, false);
  assert.equal(byLabel['Resume/CV'].kind, 'file', 'hidden file inputs are still observed');
  assert.equal(byLabel['Will you require visa sponsorship?'].kind, 'select');
  assert.deepEqual(byLabel['Will you require visa sponsorship?'].options?.filter(Boolean).slice(-2), ['Yes', 'No']);
  const radio = fields.find((f) => f.kind === 'radio');
  assert.ok(radio && /gender/i.test(radio.label), 'radio group labeled from fieldset legend');
  const ta = fields.find((f) => f.kind === 'textarea');
  assert.equal(ta?.label, 'Cover Letter', 'placeholder used as label fallback');
});

test('humanized typing fills a field', async () => {
  await session.page.goto(`${base}/jobs/1`);
  await humanType(session.page.locator('#first_name'), 'Sanchit');
  assert.equal(await session.page.locator('#first_name').inputValue(), 'Sanchit');
});

test('bestOption matches values to form options', () => {
  assert.equal(bestOption(['Select…', 'Yes', 'No'], 'Yes'), 'Yes');
  assert.equal(bestOption(['Yes, I will require sponsorship', 'No, I will not'], 'Yes'), 'Yes, I will require sponsorship');
  assert.equal(bestOption(['Male', 'Prefer not to say'], 'Prefer not to say'), 'Prefer not to say');
  assert.equal(bestOption(['A', 'B'], 'Z'), null);
});

test('detects CAPTCHA widgets', async () => {
  await session.page.goto(`${base}/jobs/1`);
  assert.equal(await detectCaptcha(session.page), false);
  await session.page.goto(`${base}/captcha`);
  assert.equal(await detectCaptcha(session.page), true);
});

test('form resolution picks the application form, not an earlier newsletter/login form', async () => {
  await session.page.goto(`${base}/multi`);
  const sel = await resolveFormScope(session.page, 'form');
  assert.equal(sel, '#apply_form', 'the richest fillable form must win over newsletter/login forms');

  // Observation is bound to that form only
  const fields = await observeFields(session.page, sel!);
  assert.ok(fields.every((f) => !/nl_email|^user$|^pass$/.test(f.name)), 'no newsletter/login fields observed');
  assert.ok(fields.some((f) => f.name === 'first_name'));

  // Submit selector scoped to the resolved form finds the right button
  const scoped = session.page.locator(sel!).locator('button[type="submit"], input[type="submit"]').first();
  assert.equal(await scoped.getAttribute('id'), 'apply_submit');
});

test('main-frame navigation outside the apply site is blocked', async () => {
  await session.page.goto(`${base}/jobs/1`);
  let blocked = false;
  try {
    await session.page.goto('https://example.com/', { timeout: 8000 });
  } catch (e: any) {
    blocked = /blockedbyclient|ERR_BLOCKED_BY_CLIENT|net::/i.test(String(e?.message));
  }
  assert.ok(blocked, 'navigation to a foreign site must be aborted');
  // Same-site navigation still works (fresh page — the old one is in an error state)
  const page2 = await session.context.newPage();
  await page2.goto(`${base}/jobs/2`);
  assert.ok(page2.url().startsWith(base));
  await page2.close();
});
