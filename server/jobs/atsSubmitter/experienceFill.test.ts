/**
 * Structured Work Experience / Education entry fill: reproduces the exact
 * real-world failure this feature fixes — a Workday-style "My Experience"
 * page whose own resume-parser pre-filled an entry with the WRONG title,
 * employer, location and dates (e.g. a "Forensic Scientist" entry whose
 * description is actually a DBA thesis, with garbled start/end dates). The
 * fill engine must overwrite this pre-filled content with the vault's
 * structured work history — never trust the ATS's own parse — and must grow
 * the repeated section via its "Add Another" control to fit every vaulted
 * entry, while an entry the vault has no record for pauses instead of being
 * silently left with unverified content.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, type HardenedSession } from './browser.js';
import { fillForm } from './index.js';

const MISPARSED_FORM_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>

  <h2>My Experience</h2>
  <div id="exp-container">
    <div class="exp-entry">
      <label for="jt1">Job Title *</label><input id="jt1" required value="Forensic Scientist">
      <label for="co1">Company *</label><input id="co1" required value="Acme Labs">
      <label for="loc1">Location</label><input id="loc1" value="Somewhereville">
      <label for="sd1">Start Date</label><input id="sd1" value="01/2099">
      <label for="ed1">End Date</label><input id="ed1" value="02/2099">
      <label><input type="checkbox" id="cur1" checked> I currently work here</label>
      <label for="desc1">Description</label><textarea id="desc1">My DBA thesis explored distributed transaction logs.</textarea>
    </div>
  </div>
  <button type="button" id="add-exp">Add Another Work Experience</button>

  <h2>Education</h2>
  <div id="edu-container">
    <div class="edu-entry">
      <label for="sc1">School *</label><input id="sc1" required value="Wrong University">
      <label for="deg1">Degree</label><input id="deg1" value="Wrong Degree">
      <label for="fos1">Field of Study</label><input id="fos1" value="Wrong Field">
    </div>
  </div>

  <button type="submit" id="apply_submit">Submit Application</button>
</form>
<script>
document.getElementById('add-exp').addEventListener('click', function () {
  var container = document.getElementById('exp-container');
  var n = container.children.length + 1;
  var div = document.createElement('div');
  div.className = 'exp-entry';
  div.innerHTML =
    '<label for="jt' + n + '">Job Title *</label><input id="jt' + n + '" required>' +
    '<label for="co' + n + '">Company *</label><input id="co' + n + '" required>' +
    '<label for="loc' + n + '">Location</label><input id="loc' + n + '">' +
    '<label for="sd' + n + '">Start Date</label><input id="sd' + n + '">' +
    '<label for="ed' + n + '">End Date</label><input id="ed' + n + '">' +
    '<label><input type="checkbox" id="cur' + n + '"> I currently work here</label>' +
    '<label for="desc' + n + '">Description</label><textarea id="desc' + n + '"></textarea>';
  container.appendChild(div);
});
</script>
</body></html>`;

const EXTRA_ENTRY_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <h2>My Experience</h2>
  <label for="jt1">Job Title *</label><input id="jt1" required value="Real Role">
  <label for="co1">Company *</label><input id="co1" required value="Real Corp">
  <label for="jt2">Job Title *</label><input id="jt2" required value="Mystery Role">
  <label for="co2">Company *</label><input id="co2" required value="Mystery Corp">
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url?.startsWith('/extra') ? EXTRA_ENTRY_HTML : MISPARSED_FORM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/jobs/1`);
});

after(async () => { await session?.close(); server?.close(); });

test('fillForm overwrites a mis-parsed Work Experience/Education entry and grows the section to fit the vault', async () => {
  const profile: any = {
    fullName: 'Jamie Doe', email: 'jamie@example.com', phone: null,
    city: 'Zurich', country: 'Switzerland', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
    noticePeriod: null, countryAuth: [], eeoAnswers: {}, screeningAnswers: [],
    workHistory: [
      { jobTitle: 'Senior Database Administrator', employer: 'Real Corp', location: 'Zurich, Switzerland', startDate: '2018-03', endDate: '2021-07', description: 'Administered production databases.' },
      { jobTitle: 'Forensic Data Analyst', employer: 'Second Corp', location: 'Geneva, Switzerland', startDate: '2021-08', isCurrent: true, description: 'Led forensic data analysis engagements.' },
    ],
    education: [{ school: 'ETH Zurich', degree: 'MSc', fieldOfStudy: 'Computer Science', startDate: '2013-09', endDate: '2015-06' }],
  };
  const job: any = { id: 'testjob0-0001', title: 'Engineer', company: 'Acme', country: 'Switzerland', tailoredCv: '# Jamie Doe\n\nCV body' };
  const app: any = { atsType: 'generic', applyUrl: `${base}/jobs/1`, packet: {} };

  const outcome = await fillForm(session.page, app, job, profile);
  assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);
  const page = session.page;

  // Entry #1: the ATS's own (wrong) pre-fill is fully overwritten by vault entry 0
  assert.equal(await page.locator('#jt1').inputValue(), 'Senior Database Administrator');
  assert.equal(await page.locator('#co1').inputValue(), 'Real Corp');
  assert.equal(await page.locator('#loc1').inputValue(), 'Zurich, Switzerland', 'must NOT be overwritten with the candidate\'s own current location');
  assert.equal(await page.locator('#sd1').inputValue(), '03/2018');
  assert.equal(await page.locator('#ed1').inputValue(), '07/2021');
  assert.equal(await page.locator('#cur1').isChecked(), false, 'wrongly-pre-checked "currently work here" must be corrected to unchecked');
  assert.equal(await page.locator('#desc1').inputValue(), 'Administered production databases.');

  // Entry #2: created via "Add Another Work Experience" and filled from vault entry 1
  assert.equal(await page.locator('#jt2').inputValue(), 'Forensic Data Analyst');
  assert.equal(await page.locator('#co2').inputValue(), 'Second Corp');
  assert.equal(await page.locator('#sd2').inputValue(), '08/2021');
  assert.equal(await page.locator('#ed2').inputValue(), '', 'end date stays blank while isCurrent is true');
  assert.equal(await page.locator('#cur2').isChecked(), true);

  // Education entry: same overwrite behavior
  assert.equal(await page.locator('#sc1').inputValue(), 'ETH Zurich');
  assert.equal(await page.locator('#deg1').inputValue(), 'MSc');
  assert.equal(await page.locator('#fos1').inputValue(), 'Computer Science');
});

test('fillForm pauses when the form has more Work Experience entries than the vault has records for', async () => {
  const profile: any = {
    fullName: 'Jamie Doe', email: 'jamie@example.com', phone: null,
    city: 'Zurich', country: 'Switzerland', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
    noticePeriod: null, countryAuth: [], eeoAnswers: {}, screeningAnswers: [],
    workHistory: [{ jobTitle: 'Real Role', employer: 'Real Corp' }],
    education: [],
  };
  const job: any = { id: 'testjob0-0002', title: 'Engineer', company: 'Acme', country: 'Switzerland', tailoredCv: '# Jamie Doe\n\nCV body' };
  const app: any = { atsType: 'generic', applyUrl: `${base}/extra`, packet: {} };

  const outcome = await fillForm(session.page, app, job, profile);
  assert.equal(outcome.status, 'needs_user');
  assert.match(outcome.reason ?? '', /more Work Experience entries than your Profile Vault/);
  // The matched entry (#1) is still filled correctly before the pause is hit
  assert.equal(await session.page.locator('#jt1').inputValue(), 'Real Role');
});
