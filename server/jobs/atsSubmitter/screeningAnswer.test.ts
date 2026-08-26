/**
 * AI-drafted screening answers: the real fill engine (fillForm) runs against
 * a page with an open-ended textarea question ("Why do you want to work
 * here?") that has NO Screening Answers vault match. The engine must draft
 * an answer from the candidate's own work history/education and this job's
 * own title/company/description — never invent facts, never draft for a
 * denylisted category (salary here), and never draft for a non-text field —
 * falling back to the existing pause behavior whenever drafting isn't
 * possible. Claude is left unconfigured (no ANTHROPIC_API_KEY in this
 * sandbox) so the Gemini fallback path is exercised via a mocked fetch,
 * matching the convention in aiClient.test.ts.
 */
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { launchHardenedSession, type HardenedSession } from './browser.js';
import { fillForm } from './index.js';

const FORM_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <label for="why">Why do you want to work at this company? *</label>
  <textarea id="why" name="why_company" required></textarea>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

const DENYLIST_FORM_HTML = `<!doctype html><html><body>
<form id="application_form">
  <label for="a_fn">First Name *</label><input id="a_fn" name="first_name" required>
  <label for="a_em">Email *</label><input id="a_em" type="email" name="email" required>
  <label for="a_cv">Resume/CV *</label><input id="a_cv" type="file" name="resume" required>
  <label for="salary">What is your salary expectation? *</label>
  <input id="salary" name="salary_expectation" required>
  <button type="submit" id="apply_submit">Submit Application</button>
</form>
</body></html>`;

let server: http.Server;
let base = '';
let session: HardenedSession;

const profile: any = {
  fullName: 'Jamie Doe', email: 'jamie@example.com', phone: null,
  city: 'Zurich', country: 'Switzerland', linkedinUrl: null, githubUrl: null, portfolioUrl: null,
  noticePeriod: null, countryAuth: [], eeoAnswers: {}, screeningAnswers: [],
  workHistory: [{ jobTitle: 'Senior Product Manager', employer: 'Real Corp', location: 'Zurich, Switzerland', startDate: '2018-03', isCurrent: true, description: 'Led B2B SaaS product strategy.' }],
  education: [{ school: 'ETH Zurich', degree: 'MSc', fieldOfStudy: 'Computer Science' }],
};
const job: any = {
  id: 'testjob0-0003', title: 'Senior Product Manager', company: 'Acme AI', country: 'Switzerland',
  description: 'Acme AI builds developer tools for machine-learning teams.', matchReason: 'Strong product + technical background match.',
  tailoredCv: '# Jamie Doe\n\nCV body',
};

function mockGeminiFetch(text: string): typeof fetch {
  return (async (_url: any, _init?: any) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  })) as unknown as typeof fetch;
}

const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const savedGeminiKey = process.env.GEMINI_API_KEY;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url?.startsWith('/denylist') ? DENYLIST_FORM_HTML : FORM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  session = await launchHardenedSession(`${base}/apply`);
});

after(async () => { await session?.close(); server?.close(); });

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  mock.restoreAll();
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGeminiKey;
});

test('drafts and fills an unmatched open-ended screening question, flagged ai_drafted', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const drafted = 'I am drawn to Acme AI because it builds developer tools for machine-learning teams, which lines up directly with my product leadership at Real Corp.';
  mock.method(globalThis, 'fetch', mockGeminiFetch(drafted));

  const app: any = { atsType: 'generic', applyUrl: `${base}/apply`, packet: {} };
  const outcome = await fillForm(session.page, app, job, profile);

  assert.equal(outcome.status, 'filled', `expected filled, got ${outcome.status}: ${outcome.reason ?? ''}`);
  assert.equal(await session.page.locator('#why').inputValue(), drafted);
  const ans = outcome.answers.find((a) => a.label.includes('Why do you want to work'));
  assert.ok(ans, 'drafted answer must appear in the reviewable answer set');
  assert.equal(ans!.source, 'ai_drafted');
});

test('never AI-drafts a denylisted field (salary) — a required unmatched salary question still pauses', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  // Even though the mock WOULD happily answer if called, the denylist must
  // stop drafting from ever being attempted for this field.
  mock.method(globalThis, 'fetch', mockGeminiFetch('RM 15,000 per month'));

  const app: any = { atsType: 'generic', applyUrl: `${base}/denylist`, packet: {} };
  const outcome = await fillForm(session.page, app, job, profile);

  assert.equal(outcome.status, 'needs_user');
  assert.match(outcome.reason ?? '', /salary expectation/i);
  assert.equal(await session.page.locator('#salary').inputValue(), '', 'a denylisted field must never be auto-filled by AI');
});

test('falls back to the existing pause when AI drafting is unavailable (no provider configured)', async () => {
  // beforeEach() already left both API keys unset — Claude and Gemini both unusable.
  const app: any = { atsType: 'generic', applyUrl: `${base}/apply`, packet: {} };
  const outcome = await fillForm(session.page, app, job, profile);

  assert.equal(outcome.status, 'needs_user', 'a required unmatched question must still pause, never silently skip, when drafting fails');
  assert.match(outcome.reason ?? '', /why do you want to work/i);
});
