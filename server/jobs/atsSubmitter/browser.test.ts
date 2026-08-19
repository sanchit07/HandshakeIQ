/**
 * Integration tests for the browser layer against a locally-served fixture
 * form (greenhouse-style). Verifies field observation, option matching,
 * CAPTCHA detection, and the main-frame navigation allowlist — no real ATS
 * is contacted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, observeFields, resolveFormScope, detectCaptcha, detectBotBlock, bestOption, humanType, pickOne, UA_POOL, VIEWPORT_POOL, type HardenedSession } from './browser.js';

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

const BOT_BLOCK_HTML = `<!doctype html><html><body><h1>Access Denied</h1><p>You have been blocked. Reference ID: 18273645abcd1234 (PerimeterX)</p></body></html>`;

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

const WIDGETS_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="school">School *</label>
  <input id="school" name="school" role="combobox" aria-autocomplete="list" aria-controls="school-listbox" aria-expanded="false">
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
  <button type="submit">Submit Application</button>
</form>
</body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url?.includes('forbidden')) { res.statusCode = 403; res.end(FORM_HTML); return; }
    res.end(
      req.url?.includes('blocked') ? BOT_BLOCK_HTML
        : req.url?.includes('captcha') ? CAPTCHA_HTML
        : req.url?.includes('widgets') ? WIDGETS_HTML
        : req.url?.includes('multi') ? MULTIFORM_HTML
        : FORM_HTML,
    );
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

test('detects an invisible enterprise bot-block page by text, distinct from a CAPTCHA', async () => {
  await session.page.goto(`${base}/blocked`);
  assert.equal(await detectCaptcha(session.page), false, 'a bot-block page has no interactive puzzle to detect');
  const reason = await detectBotBlock(session.page);
  assert.ok(reason, 'bot-block text must be detected');
  assert.match(reason!, /bot-detection block pattern/);
});

test('detects a bot-block via the main-document HTTP status alone', async () => {
  await session.page.goto(`${base}/jobs/1`); // plain 200 form page, no block text
  const reason = await detectBotBlock(session.page, 403);
  assert.ok(reason, 'a 403 main-document status must be treated as a likely bot block even with benign page text');
  assert.match(reason!, /HTTP 403/);
});

test('does not flag a normal application page as bot-blocked', async () => {
  await session.page.goto(`${base}/jobs/1`);
  assert.equal(await detectBotBlock(session.page, 200), null);
  assert.equal(await detectBotBlock(session.page), null);
});

test('stealth patches: navigator.webdriver is hidden and plugins/chrome are present', async () => {
  await session.page.goto(`${base}/jobs/1`);
  const fingerprint = await session.page.evaluate(() => ({
    webdriver: (navigator as any).webdriver,
    pluginsLength: navigator.plugins.length,
    languages: navigator.languages,
    hasChrome: !!(window as any).chrome,
  }));
  assert.equal(fingerprint.webdriver, undefined, 'navigator.webdriver must not read as true');
  assert.ok(fingerprint.pluginsLength > 0, 'a stock headless page reports an empty plugins list — must be patched');
  assert.deepEqual(fingerprint.languages, ['en-US', 'en']);
  assert.equal(fingerprint.hasChrome, true, 'window.chrome must be present, as in every real Chrome browser');
});

test('the session actually uses one of the UA-pool entries as its live user agent', async () => {
  await session.page.goto(`${base}/jobs/1`);
  const ua = await session.page.evaluate(() => navigator.userAgent);
  assert.ok(UA_POOL.includes(ua), `live user agent "${ua}" must be one of the declared pool entries`);
});

test('pickOne always returns a member of the pool (deterministic across many draws)', () => {
  for (let i = 0; i < 50; i++) {
    const ua = pickOne(UA_POOL);
    assert.ok(UA_POOL.includes(ua));
    const vp = pickOne(VIEWPORT_POOL);
    assert.ok(VIEWPORT_POOL.includes(vp));
  }
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

// ── Non-native widgets: combobox, multi-select, drop-zone upload ────────────

test('observeFields detects an ARIA combobox and resolves its listbox selector', async () => {
  await session.page.goto(`${base}/widgets`);
  const fields = await observeFields(session.page, '#application_form');
  const school = fields.find((f) => f.label.includes('School'));
  assert.ok(school, 'combobox field must be observed');
  assert.equal(school!.kind, 'combobox');
  assert.equal(school!.listboxSelector, '#school-listbox');
});

test('observeFields marks a native <select multiple> as multiselect and captures its options', async () => {
  await session.page.goto(`${base}/widgets`);
  const fields = await observeFields(session.page, '#application_form');
  const skills = fields.find((f) => f.label.includes('Skills'));
  assert.ok(skills, 'multiselect field must be observed');
  assert.equal(skills!.kind, 'multiselect');
  assert.deepEqual(skills!.options, ['JavaScript', 'TypeScript', 'Python', 'React']);
});

test('observeFields detects a JS-driven resume drop-zone with no native file input', async () => {
  await session.page.goto(`${base}/widgets`);
  const fields = await observeFields(session.page, '#application_form');
  const drop = fields.find((f) => f.isDropzone);
  assert.ok(drop, 'drop-zone must be observed as a synthetic file field');
  assert.equal(drop!.kind, 'file');
  assert.equal(drop!.selector, '#resumeDrop');
});

test('observeFields does not treat an ordinary element mentioning "resume" as a drop-zone', async () => {
  // FORM_HTML's real file input already covers the native case; confirm the
  // dropzone heuristic doesn't ALSO double-count a plain label/text mention.
  await session.page.goto(`${base}/jobs/1`);
  const fields = await observeFields(session.page, '#application_form');
  assert.equal(fields.filter((f) => f.isDropzone).length, 0);
});

test('dropFileOnElement dispatches a real drop event carrying the file to a JS drop-zone', async () => {
  await session.page.goto(`${base}/widgets`);
  await session.page.evaluate(() => {
    (window as any).__droppedFiles = [];
    document.getElementById('resumeDrop')!.addEventListener('drop', (e: any) => {
      e.preventDefault();
      (window as any).__droppedFiles.push({
        name: e.dataTransfer.files[0].name,
        type: e.dataTransfer.files[0].type,
        size: e.dataTransfer.files[0].size,
      });
    });
  });
  const { dropFileOnElement } = await import('./browser.js');
  const ok = await dropFileOnElement(session.page, '#resumeDrop', Buffer.from('%PDF-1.4 fake pdf content'), 'CV_Acme_Engineer.pdf', 'application/pdf');
  assert.equal(ok, true);
  const dropped = await session.page.evaluate(() => (window as any).__droppedFiles);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'CV_Acme_Engineer.pdf');
  assert.equal(dropped[0].type, 'application/pdf');
  assert.ok(dropped[0].size > 0);
});

test('dropFileOnElement returns false when the target selector does not exist', async () => {
  await session.page.goto(`${base}/widgets`);
  const { dropFileOnElement } = await import('./browser.js');
  const ok = await dropFileOnElement(session.page, '#does-not-exist', Buffer.from('x'), 'x.pdf', 'application/pdf');
  assert.equal(ok, false);
});
