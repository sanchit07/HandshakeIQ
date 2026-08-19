/**
 * Unit tests for the pure parts of the auto-apply engine:
 * state machine, ATS classification, vault validation, packet building.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  canTransition, ALLOWED_TRANSITIONS, classifyAtsFromUrl, isValidHttpUrl,
  validateCountryAuth, buildPacketAnswers, findCountryAuth,
  workAuthBlockReason, packetBlocksReview, pickApplicationContact,
  type ContactCandidate,
} from './applyService.js';
import { buildMimeMessage, assertNoHeaderInjection } from './emailSender.js';

// ── State machine ────────────────────────────────────────────────────────────

test('happy path transitions are allowed', () => {
  const path = ['queued', 'route_resolved', 'ready_for_review', 'approved', 'submitting', 'submitted'] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]} should be allowed`);
  }
});

test('submitted is terminal', () => {
  for (const to of Object.keys(ALLOWED_TRANSITIONS)) {
    assert.ok(!canTransition('submitted', to as any), `submitted → ${to} must be forbidden`);
  }
});

test('skipping review is forbidden', () => {
  assert.ok(!canTransition('queued', 'submitting'));
  assert.ok(!canTransition('route_resolved', 'approved'));
  assert.ok(!canTransition('route_resolved', 'submitted'));
  assert.ok(!canTransition('ready_for_review', 'submitted'));
});

test('needs_user and failed are recoverable', () => {
  assert.ok(canTransition('needs_user', 'queued'));
  assert.ok(canTransition('failed', 'queued'));
  assert.ok(!canTransition('needs_user', 'submitted'));
});

test('every state can reach needs_user or failed except terminal', () => {
  for (const from of ['queued', 'route_resolved', 'ready_for_review', 'approved', 'submitting'] as const) {
    assert.ok(canTransition(from, 'needs_user'), `${from} → needs_user`);
    assert.ok(canTransition(from, 'failed'), `${from} → failed`);
  }
});

// ── ATS classification ───────────────────────────────────────────────────────

test('classifies known ATS URLs', () => {
  assert.equal(classifyAtsFromUrl('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.equal(classifyAtsFromUrl('https://jobs.lever.co/acme/abc'), 'lever');
  assert.equal(classifyAtsFromUrl('https://jobs.ashbyhq.com/acme/xyz'), 'ashby');
  assert.equal(classifyAtsFromUrl('https://jobs.smartrecruiters.com/Acme/1'), 'smartrecruiters');
  assert.equal(classifyAtsFromUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1'), 'workday');
  assert.equal(classifyAtsFromUrl('https://careers.icims.com/jobs/123'), 'icims');
  assert.equal(classifyAtsFromUrl('https://acme.taleo.net/careersection/1'), 'taleo');
  assert.equal(classifyAtsFromUrl('https://career5.successfactors.eu/careers'), 'successfactors');
  assert.equal(classifyAtsFromUrl('https://apply.workable.com/acme/j/1'), 'workable');
  assert.equal(classifyAtsFromUrl('https://acme.bamboohr.com/careers/1'), 'bamboohr');
  assert.equal(classifyAtsFromUrl('https://jobs.jobvite.com/acme/job/1'), 'jobvite');
});

test('unknown / missing URLs classify as unknown', () => {
  assert.equal(classifyAtsFromUrl('https://www.acme.com/careers/software-engineer'), 'unknown');
  assert.equal(classifyAtsFromUrl(null), 'unknown');
  assert.equal(classifyAtsFromUrl(undefined), 'unknown');
  assert.equal(classifyAtsFromUrl(''), 'unknown');
});

test('only parseable HTTP(S) URLs qualify as apply routes', () => {
  assert.ok(isValidHttpUrl('https://acme.com/careers/1'));
  assert.ok(isValidHttpUrl('http://acme.com/jobs'));
  assert.ok(!isValidHttpUrl('ftp://acme.com/jobs'));
  assert.ok(!isValidHttpUrl('javascript:alert(1)'));
  assert.ok(!isValidHttpUrl('not a url'));
  assert.ok(!isValidHttpUrl('https://')); // scheme-only — parses nowhere, must never reach the probe
  assert.ok(!isValidHttpUrl(''));
  assert.ok(!isValidHttpUrl(null));
});

// ── Vault validation ─────────────────────────────────────────────────────────

test('validateCountryAuth keeps only well-formed records', () => {
  const out = validateCountryAuth([
    { country: 'Malaysia', rightToWork: 'work_visa', needsSponsorship: false, visaDetails: 'Employment Pass' },
    { country: '', rightToWork: 'citizen', needsSponsorship: false },           // empty country
    { country: 'Singapore', rightToWork: 'maybe', needsSponsorship: false },     // invalid enum
    { country: 'UK', rightToWork: 'needs_sponsorship', needsSponsorship: 'yes' }, // non-boolean
    { country: 'India', rightToWork: 'citizen', needsSponsorship: false },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.country), ['Malaysia', 'India']);
});

test('validateCountryAuth handles non-array input', () => {
  assert.deepEqual(validateCountryAuth(null), []);
  assert.deepEqual(validateCountryAuth('nope'), []);
});

test('findCountryAuth is case-insensitive', () => {
  const profile: any = { countryAuth: [{ country: 'Malaysia', rightToWork: 'work_visa', needsSponsorship: false }] };
  assert.ok(findCountryAuth(profile, 'malaysia'));
  assert.equal(findCountryAuth(profile, 'Singapore'), null);
  assert.equal(findCountryAuth(null, 'Malaysia'), null);
});

// ── Packet building (sensitive answers never guessed) ────────────────────────

const baseProfile: any = {
  fullName: 'Sanchit Neema', email: 's@example.com', phone: '+60 13 000 0000',
  city: 'Puchong', country: 'Malaysia', linkedinUrl: 'https://linkedin.com/in/x',
  githubUrl: null, portfolioUrl: null, noticePeriod: '1 month', languages: 'English (fluent)',
  countryAuth: [{ country: 'Malaysia', rightToWork: 'work_visa', needsSponsorship: false, salaryExpectation: 'RM 10k' }],
  screeningAnswers: [{ question: 'Years of experience?', answer: '8' }],
};
const jobMY: any = { country: 'Malaysia', title: 'PM', company: 'Acme' };
const jobSG: any = { country: 'Singapore', title: 'PM', company: 'Acme' };

test('packet includes vault work-auth answers for a matching country', () => {
  const { answers, missing } = buildPacketAnswers(baseProfile, jobMY);
  assert.ok(answers.find((a) => a.label === 'Right to work in Malaysia' && a.value === 'work visa'));
  assert.ok(answers.find((a) => a.label === 'Requires visa sponsorship' && a.value === 'No'));
  assert.ok(answers.find((a) => a.label === 'Salary expectation'));
  assert.ok(answers.find((a) => a.label === 'Years of experience?' && a.value === '8'));
  assert.ok(!missing.some((m) => m.includes('Work-authorization')));
});

test('packet NEVER guesses work-auth for an unlisted country — flags it missing', () => {
  const { answers, missing } = buildPacketAnswers(baseProfile, jobSG);
  assert.ok(!answers.some((a) => a.label.startsWith('Right to work')));
  assert.ok(!answers.some((a) => a.label === 'Requires visa sponsorship'));
  assert.ok(missing.some((m) => m.includes('Singapore')));
});

test('work-auth gate pauses country-less jobs and uncovered countries; passes covered ones', () => {
  // No country on the job → always blocks (no per-country record can be selected)
  assert.ok(workAuthBlockReason(baseProfile, null));
  assert.ok(workAuthBlockReason(baseProfile, ''));
  assert.ok(workAuthBlockReason(baseProfile, '  '));
  // Country present but no vault record → blocks
  assert.ok(workAuthBlockReason(baseProfile, 'Germany'));
  assert.ok(workAuthBlockReason(null, 'Malaysia'));
  // Covered country → passes
  assert.equal(workAuthBlockReason(baseProfile, 'Malaysia'), null);
  assert.equal(workAuthBlockReason(baseProfile, 'malaysia'), null);
});

test('packets missing work-auth answers are blocked from review/submission', () => {
  assert.ok(packetBlocksReview({ missing: ['Work-authorization answers for Germany (add in Profile vault — the engine never guesses visa/sponsorship answers)'] }));
  assert.ok(!packetBlocksReview({ missing: ['Phone number'] }));
  assert.ok(!packetBlocksReview({ missing: [] }));
  assert.ok(!packetBlocksReview(null));
});

test('EEO answers appear in the packet only when the user entered them', () => {
  const withEeo = { ...baseProfile, eeoAnswers: { Gender: 'Male', Ethnicity: 'Prefer not to say', '': 'ignored', Veteran: '  ' } };
  const { answers } = buildPacketAnswers(withEeo, jobMY);
  assert.ok(answers.find((a) => a.label === 'EEO: Gender' && a.value === 'Male'));
  assert.ok(answers.find((a) => a.label === 'EEO: Ethnicity' && a.value === 'Prefer not to say'));
  assert.ok(!answers.some((a) => a.label === 'EEO: ' || a.label === 'EEO: Veteran'));
  // No EEO entries in the vault → zero EEO answers in the packet (never guessed)
  const { answers: none } = buildPacketAnswers(baseProfile, jobMY);
  assert.ok(!none.some((a) => a.label.startsWith('EEO:')));
});

test('packet flags missing basics when vault is empty', () => {
  const { answers, missing } = buildPacketAnswers(null, jobMY);
  assert.equal(answers.length, 0);
  assert.ok(missing.includes('Full name'));
  assert.ok(missing.includes('Email'));
});

// ── MIME building ────────────────────────────────────────────────────────────

test('plain email MIME has headers and body', () => {
  const mime = buildMimeMessage({ to: 'hr@acme.com', subject: 'Application', body: 'Hello' });
  assert.ok(mime.includes('To: hr@acme.com'));
  assert.ok(mime.includes('Subject: Application'));
  assert.ok(mime.includes('Hello'));
  assert.ok(!mime.includes('multipart/mixed'));
});

test('email with attachment is multipart with base64 PDF part', () => {
  const mime = buildMimeMessage({
    to: 'hr@acme.com', subject: 'Application', body: 'Hello',
    attachment: { filename: 'CV.pdf', content: Buffer.from('%PDF-1.4 test') },
  });
  assert.ok(mime.includes('multipart/mixed'));
  assert.ok(mime.includes('Content-Type: application/pdf; name="CV.pdf"'));
  assert.ok(mime.includes(Buffer.from('%PDF-1.4 test').toString('base64')));
});

test('header injection via subject/recipient/filename is rejected', () => {
  assert.throws(() => buildMimeMessage({ to: 'hr@acme.com', subject: 'Hi\r\nBcc: evil@x.com', body: 'x' }), /forbidden/);
  assert.throws(() => buildMimeMessage({ to: 'hr@acme.com\r\nBcc: evil@x.com', subject: 'Hi', body: 'x' }), /forbidden/);
  assert.throws(() => buildMimeMessage({
    to: 'hr@acme.com', subject: 'Hi', body: 'x',
    attachment: { filename: 'cv"\r\n.pdf', content: Buffer.from('x') },
  }), /forbidden/);
  assert.throws(() => assertNoHeaderInjection('Subject', 'a\nb'), /forbidden/);
  assert.doesNotThrow(() => assertNoHeaderInjection('Subject', 'Application — PM role'));
});

test('non-ASCII subject is RFC 2047 encoded', () => {
  const mime = buildMimeMessage({ to: 'hr@acme.com', subject: 'Application — PM role', body: 'Hi' });
  assert.ok(mime.includes('=?UTF-8?B?'));
});

// ── Application contact selection ────────────────────────────────────────────

const contact = (over: Partial<ContactCandidate>): ContactCandidate =>
  ({ email: 'x@acme.com', emailStatus: 'not_found', evidenceStatus: 'ok', fullName: 'Someone', ...over });

test('pickApplicationContact prefers a verified named contact over a posting-listed mailbox alias', () => {
  const contacts = [
    contact({ email: 'careers@acme.com', emailStatus: 'listed_in_posting', fullName: 'Application mailbox (careers@acme.com)' }),
    contact({ email: 'jane@acme.com', emailStatus: 'verified', fullName: 'Jane Doe' }),
  ];
  const picked = pickApplicationContact(contacts);
  assert.deepStrictEqual(picked, { email: 'jane@acme.com', status: 'verified', who: 'Jane Doe' });
});

test('pickApplicationContact falls back to the posting-listed mailbox when no named contact exists', () => {
  const contacts = [contact({ email: 'careers@acme.com', emailStatus: 'listed_in_posting', fullName: 'Application mailbox (careers@acme.com)' })];
  const picked = pickApplicationContact(contacts);
  assert.deepStrictEqual(picked, { email: 'careers@acme.com', status: 'listed_in_posting', who: 'Application mailbox (careers@acme.com)' });
});

test('pickApplicationContact excludes a contact with stale evidence entirely', () => {
  const contacts = [
    contact({ email: 'jane@acme.com', emailStatus: 'verified', evidenceStatus: 'stale', fullName: 'Jane Doe' }),
    contact({ email: 'careers@acme.com', emailStatus: 'listed_in_posting', evidenceStatus: 'stale', fullName: 'Application mailbox (careers@acme.com)' }),
  ];
  assert.strictEqual(pickApplicationContact(contacts), null, 'a stale verified contact must not fall through to being used anyway');
});

test('pickApplicationContact skips a stale verified contact in favor of a fresh listed mailbox', () => {
  const contacts = [
    contact({ email: 'jane@acme.com', emailStatus: 'verified', evidenceStatus: 'stale', fullName: 'Jane Doe' }),
    contact({ email: 'careers@acme.com', emailStatus: 'listed_in_posting', evidenceStatus: 'ok', fullName: 'Application mailbox (careers@acme.com)' }),
  ];
  const picked = pickApplicationContact(contacts);
  assert.deepStrictEqual(picked, { email: 'careers@acme.com', status: 'listed_in_posting', who: 'Application mailbox (careers@acme.com)' });
});

test('pickApplicationContact returns null when no eligible contact exists', () => {
  assert.strictEqual(pickApplicationContact([]), null);
  assert.strictEqual(pickApplicationContact([contact({ email: null, emailStatus: 'verified' })]), null);
  assert.strictEqual(pickApplicationContact([contact({ emailStatus: 'not_found' })]), null);
});
