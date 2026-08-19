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

// ── Conditionally-revealed fields ────────────────────────────────────────────

const CONDITIONAL_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_more">Do you have anything else to add? *</label>
  <select id="a_more" name="more" required onchange="document.getElementById('extra_wrap').style.display = this.value === 'Yes' ? 'block' : 'none'">
    <option value="">Select…</option><option>Yes</option><option>No</option>
  </select>
  <div id="extra_wrap" style="display:none">
    <label for="a_notice">Notice period</label><input id="a_notice" name="notice_period">
  </div>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

test('fillFieldsInScope re-scans and fills a field revealed only after answering an earlier one', async () => {
  const server2 = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(CONDITIONAL_HTML); });
  await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${(server2.address() as any).port}`;
  try {
    const profile: any = {
      fullName: 'Sanchit Neema', email: 'sanchit@example.com', phone: '+60123456789',
      city: 'Kuala Lumpur', country: 'Malaysia', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
      noticePeriod: '1 month',
      countryAuth: [{ country: 'Testland', rightToWork: 'work_visa', needsSponsorship: true }],
      eeoAnswers: {},
      // Answers the gating question so the field-fill loop proceeds far enough
      // to select "Yes" and trigger the reveal within the same pass.
      screeningAnswers: [{ question: 'Do you have anything else to add?', answer: 'Yes' }],
    };
    const job: any = { id: 'testjob0-0001', title: 'Engineer', company: 'Acme', country: 'Testland', tailoredCv: '# Sanchit Neema\n\nCV body' };
    const app: any = { atsType: 'generic', applyUrl: `${base2}/jobs/1`, packet: {} };

    const outcome = await fillForm(session.page, app, job, profile);
    assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);

    const page = session.page;
    assert.equal(await page.locator('#a_more').inputValue(), 'Yes', 'gating select answered');
    assert.equal(await page.locator('#extra_wrap').evaluate((el: any) => el.style.display), 'block', 'reveal actually fired');
    assert.equal(
      await page.locator('#a_notice').inputValue(), '1 month',
      'a field that only existed in the DOM AFTER answering an earlier one must still be observed and filled',
    );
    assert.ok(outcome.answers.some((a) => a.label === 'Notice period' && a.value === '1 month'));
  } finally {
    server2.close();
  }
});

// ── Multi-page (non-login-walled) wizard walk ────────────────────────────────

const MULTIPAGE_STEP1_HTML = `<!doctype html><html><body>
<form id="application_form" method="GET" action="/jobs/1/step2">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <button type="submit" id="next_btn">Continue</button>
</form>
</body></html>`;

const MULTIPAGE_STEP2_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

test('fillForm walks a multi-page application (own Continue button, no login wall) across pages', async () => {
  const server3 = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url?.includes('step2') ? MULTIPAGE_STEP2_HTML : MULTIPAGE_STEP1_HTML);
  });
  await new Promise<void>((r) => server3.listen(0, '127.0.0.1', r));
  const base3 = `http://127.0.0.1:${(server3.address() as any).port}`;
  try {
    const profile: any = {
      fullName: 'Sanchit Neema', email: 'sanchit@example.com', phone: '+60123456789',
      city: 'Kuala Lumpur', country: 'Malaysia', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
      noticePeriod: null,
      countryAuth: [{ country: 'Testland', rightToWork: 'work_visa', needsSponsorship: true }],
      eeoAnswers: {}, screeningAnswers: [],
    };
    const job: any = { id: 'testjob0-0002', title: 'Engineer', company: 'Acme', country: 'Testland', tailoredCv: '# Sanchit Neema\n\nCV body' };
    const app: any = { atsType: 'generic', applyUrl: `${base3}/jobs/1`, packet: {} };

    const outcome = await fillForm(session.page, app, job, profile);
    assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);
    assert.match(session.page.url(), /step2/, 'must have navigated past the first page to reach the real submit control');
    assert.equal(await session.page.locator('#a_em').inputValue(), 'sanchit@example.com', 'second-page field must be filled');
    assert.equal(await session.page.locator('#a_cv').evaluate((el: any) => el.files.length), 1, 'resume uploaded on the final page');
    assert.ok(outcome.answers.some((a) => a.label.includes('First Name')), 'first-page answer preserved across the page walk');
    assert.ok(outcome.answers.some((a) => a.label.includes('Email')), 'second-page answer captured too');
  } finally {
    server3.close();
  }
});

// ── Non-native widgets through the real fillForm orchestration ──────────────

const WIDGETS_APPLY_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="school">School *</label>
  <input id="school" name="school" role="combobox" aria-autocomplete="list" aria-controls="school-listbox" aria-expanded="false" required>
  <ul id="school-listbox" role="listbox">
    <li role="option">Harvard University</li>
    <li role="option">Stanford University</li>
    <li role="option">MIT</li>
  </ul>
  <label for="skills">Skills *</label>
  <select id="skills" name="skills" multiple required>
    <option>JavaScript</option>
    <option>TypeScript</option>
    <option>Python</option>
    <option>React</option>
  </select>
  <label for="resumeDrop">Resume/CV</label>
  <div id="resumeDrop" class="dropzone">Drag and drop your resume here, or click to upload</div>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

test('fillForm fills a combobox (type + click matching option), selects multiple options, and drops the CV on a JS drop-zone', async () => {
  const server4 = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(WIDGETS_APPLY_HTML); });
  await new Promise<void>((r) => server4.listen(0, '127.0.0.1', r));
  const base4 = `http://127.0.0.1:${(server4.address() as any).port}`;
  try {
    const profile: any = {
      fullName: 'Sanchit Neema', email: 'sanchit@example.com', phone: '+60123456789',
      city: 'Kuala Lumpur', country: 'Malaysia', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
      noticePeriod: null,
      countryAuth: [{ country: 'Testland', rightToWork: 'work_visa', needsSponsorship: true }],
      eeoAnswers: {},
      screeningAnswers: [
        { question: 'School', answer: 'Stanford University' },
        { question: 'Skills', answer: 'JavaScript, React' },
      ],
    };
    const job: any = { id: 'testjob0-0003', title: 'Engineer', company: 'Acme', country: 'Testland', tailoredCv: '# Sanchit Neema\n\nCV body' };
    const app: any = { atsType: 'generic', applyUrl: `${base4}/jobs/1`, packet: {} };

    // fillForm does its own page.goto — attach the drop listener via an
    // init script so it survives that navigation.
    await session.context.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const dz = document.getElementById('resumeDrop');
        if (!dz) return;
        (window as any).__droppedFiles = [];
        dz.addEventListener('drop', (e: any) => {
          e.preventDefault();
          (window as any).__droppedFiles.push(e.dataTransfer.files[0].name);
        });
      });
    });

    const outcome = await fillForm(session.page, app, job, profile);
    assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);

    const page = session.page;
    assert.equal(await page.locator('#school').inputValue(), 'Stanford University', 'combobox typed the resolved value');

    const selectedSkills = await page.locator('#skills').evaluate((el: any) => Array.from(el.selectedOptions).map((o: any) => o.value));
    assert.deepEqual(selectedSkills.sort(), ['JavaScript', 'React'].sort(), 'both comma-separated skills must be selected');

    const dropped = await page.evaluate(() => (window as any).__droppedFiles);
    assert.equal(dropped?.length, 1, 'the CV must have been dropped onto the JS drop-zone');
    assert.match(dropped[0], /\.pdf$/i);

    assert.ok(outcome.answers.some((a) => a.label.includes('School') && a.value === 'Stanford University'));
    assert.ok(outcome.answers.some((a) => a.label.includes('Skills') && a.value.includes('JavaScript') && a.value.includes('React')));
    assert.ok(outcome.answers.some((a) => a.value.includes('dropped')));
  } finally {
    server4.close();
  }
});
