/**
 * PII-scoping integration test: the real fill engine (fillForm) runs against a
 * page whose decoy forms (newsletter/login/poll) share field NAMES with the
 * application form (email, first_name, gender). The decoys must remain
 * untouched — candidate PII may only ever land in the resolved application
 * form.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, type HardenedSession } from './browser.js';
import { fillForm } from './index.js';

const HTML = `<!doctype html><html><body>
<form id="newsletter">
  <input type="email" name="email" placeholder="Newsletter email">
  <button type="submit">Subscribe</button>
</form>
<form id="login">
  <input name="first_name" placeholder="Username">
  <input type="password" name="pass">
  <button type="submit">Log in</button>
</form>
<form id="poll">
  <fieldset><legend>Gender</legend>
    <label><input type="radio" name="gender" value="m">Male</label>
    <label><input type="radio" name="gender" value="d">Prefer not to say</label>
  </fieldset>
  <button type="submit">Vote</button>
</form>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_ph">Phone *</label><input id="a_ph" type="tel" name="phone" required>
  <fieldset><legend>Gender</legend>
    <label><input type="radio" name="gender" value="m" class="app-gender">Male</label>
    <label><input type="radio" name="gender" value="d" class="app-gender">Prefer not to say</label>
  </fieldset>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <textarea name="cover_letter" placeholder="Cover Letter"></textarea>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

before(async () => {
  server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(HTML); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/jobs/1`);
});

after(async () => { await session?.close(); server?.close(); });

test('fillForm fills ONLY the application form; name-colliding decoy forms stay empty', async () => {
  const profile: any = {
    fullName: 'Sanchit Neema', email: 'sanchit@example.com', phone: '+60123456789',
    city: 'Kuala Lumpur', country: 'Malaysia', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
    noticePeriod: null,
    countryAuth: [{ country: 'Testland', rightToWork: 'work_visa', needsSponsorship: true }],
    eeoAnswers: { Gender: 'Prefer not to say' }, screeningAnswers: [],
  };
  const job: any = { id: 'testjob0-0000', title: 'Engineer', company: 'Acme', country: 'Testland', tailoredCv: '# Sanchit Neema\n\nCV body' };
  const app: any = { atsType: 'generic', applyUrl: `${base}/jobs/1`, packet: { coverNote: 'Hello Acme' } };

  const outcome = await fillForm(session.page, app, job, profile);
  assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);
  assert.equal(outcome.formSelector, '#application_form');

  const page = session.page;
  // Application form received the data
  assert.equal(await page.locator('#a_fn').inputValue(), 'Sanchit');
  assert.equal(await page.locator('#a_em').inputValue(), 'sanchit@example.com');
  assert.equal(await page.locator('#a_ph').inputValue(), '+60123456789');
  assert.equal(await page.locator('#application_form textarea[name="cover_letter"]').inputValue(), 'Hello Acme');
  assert.ok(await page.locator('#application_form input.app-gender[value="d"]').isChecked(), 'app-form EEO radio checked from vault');
  assert.equal(await page.locator('#a_cv').evaluate((el: any) => el.files.length), 1, 'resume uploaded to app form');

  // Decoy forms with colliding names are untouched — no PII leaked
  assert.equal(await page.locator('#newsletter input[name="email"]').inputValue(), '', 'newsletter email must stay empty');
  assert.equal(await page.locator('#login input[name="first_name"]').inputValue(), '', 'login username must stay empty');
  for (const v of ['m', 'd']) {
    assert.equal(await page.locator(`#poll input[name="gender"][value="${v}"]`).isChecked(), false, 'poll radios must stay unchecked');
  }
});
