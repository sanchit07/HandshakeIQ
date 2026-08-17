/**
 * Unit tests for the pure core of the headless ATS submitter:
 * field classification, never-guess resolution, error classification,
 * confirmation detection, navigation allowlist.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyField, buildCanonicalValues, resolveField, isTransientError,
  looksLikeConfirmation, isNavigationAllowed, baseDomain, jitterMs,
  SUPPORTED_ATS, LOGIN_WALLED_ATS, computeAnswersHash, classifySubmitOutcome,
  type ObservedField, type CanonicalValues,
} from './core.js';
import { canTransition, ALLOWED_TRANSITIONS } from '../applyService.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const profile: any = {
  fullName: 'Sanchit Neema', email: 's@example.com', phone: '+60123', city: 'Kuala Lumpur',
  country: 'Malaysia', linkedinUrl: 'https://linkedin.com/in/x', githubUrl: null, portfolioUrl: null,
  noticePeriod: '1 month',
  countryAuth: [{ country: 'Malaysia', rightToWork: 'work_visa', needsSponsorship: true, visaDetails: 'EP', salaryExpectation: 'RM 10k', relocationWilling: true }],
  eeoAnswers: { 'Gender': 'Prefer not to say' },
  screeningAnswers: [{ question: 'Years of experience with Python', answer: '5' }],
};
const job: any = { country: 'Malaysia' };
const canon: CanonicalValues = buildCanonicalValues(profile, job);
const field = (over: Partial<ObservedField>): ObservedField => ({ label: '', name: '', kind: 'text', required: true, ...over });

// ── Classification ───────────────────────────────────────────────────────────

test('sensitive patterns win over non-sensitive', () => {
  assert.deepEqual(classifyField('Are you legally authorized to work in Malaysia?'), { key: 'rightToWork', sensitive: true });
  assert.deepEqual(classifyField('Will you require visa sponsorship?'), { key: 'sponsorship', sensitive: true });
  assert.equal(classifyField('Gender identity').sensitive, true);
  assert.equal(classifyField('Race/Ethnicity').sensitive, true);
  assert.equal(classifyField('Veteran status').sensitive, true);
  assert.equal(classifyField('Disability status').sensitive, true);
});

test('classifies standard fields', () => {
  assert.equal(classifyField('First Name').key, 'firstName');
  assert.equal(classifyField('Email address').key, 'email');
  assert.equal(classifyField('Phone').key, 'phone');
  assert.equal(classifyField('LinkedIn Profile').key, 'linkedin');
  assert.equal(classifyField('Resume/CV').key, 'resume');
  assert.equal(classifyField('Cover Letter').key, 'coverLetter');
  assert.equal(classifyField('', 'job_application[first_name]').key, 'firstName');
});

// ── Never-guess resolution ───────────────────────────────────────────────────

test('sensitive field with vault answer is filled from vault', () => {
  const r = resolveField(field({ label: 'Do you require sponsorship?' }), canon);
  assert.equal(r.value, 'Yes');
  assert.equal(r.source, 'vault');
  assert.equal(r.blockReason, null);
});

test('sensitive field WITHOUT vault answer blocks even when optional', () => {
  const noAuth = buildCanonicalValues({ ...profile, countryAuth: [] } as any, job);
  const r = resolveField(field({ label: 'Are you authorized to work in Malaysia?', required: false }), noAuth);
  assert.ok(r.blockReason, 'must pause — sensitive answers are never guessed');
  assert.equal(r.value, null);
});

test('required EEO question without vault answer blocks; optional is skipped', () => {
  const req = resolveField(field({ label: 'Veteran Status', required: true }), canon);
  assert.ok(req.blockReason);
  const opt = resolveField(field({ label: 'Veteran Status', required: false }), canon);
  assert.equal(opt.blockReason, null);
  assert.equal(opt.value, null);
});

test('EEO question with matching vault answer is filled', () => {
  const r = resolveField(field({ label: 'Gender' }), canon);
  assert.equal(r.value, 'Prefer not to say');
});

test('unknown required question blocks unless a screening answer matches', () => {
  const blocked = resolveField(field({ label: 'What is your favorite database?' }), canon);
  assert.ok(blocked.blockReason);
  const matched = resolveField(field({ label: 'Years of experience with Python?' }), canon);
  assert.equal(matched.value, '5');
});

test('unknown optional question is left blank without blocking', () => {
  const r = resolveField(field({ label: 'Anything else to share?', required: false }), canon);
  assert.equal(r.blockReason, null);
  assert.equal(r.value, null);
});

test('required known field missing from vault blocks', () => {
  const noPhone = buildCanonicalValues({ ...profile, phone: null } as any, job);
  const r = resolveField(field({ label: 'Phone' }), noPhone);
  assert.ok(r.blockReason);
});

// ── Error classification ─────────────────────────────────────────────────────

test('transient vs deterministic errors', () => {
  assert.ok(isTransientError(new Error('page.goto: Timeout 45000ms exceeded')));
  assert.ok(isTransientError(new Error('net::ERR_CONNECTION_RESET')));
  assert.ok(isTransientError(new Error('server responded with 503')));
  assert.ok(isTransientError(new Error('Target closed')));
  assert.ok(!isTransientError(new Error('strict mode violation: locator resolved to 2 elements')));
  assert.ok(!isTransientError(new Error('404 Not Found')));
});

// ── Confirmation detection ───────────────────────────────────────────────────

test('detects confirmation text and URLs', () => {
  assert.ok(looksLikeConfirmation('Thank you for applying to Acme!', 'https://x.com/jobs/1'));
  assert.ok(looksLikeConfirmation('Your application has been submitted.', 'https://x.com/jobs/1'));
  assert.ok(looksLikeConfirmation("We've received your application", 'https://x.com/jobs/1'));
  assert.ok(looksLikeConfirmation('irrelevant', 'https://x.com/jobs/1/confirmation'));
  assert.ok(!looksLikeConfirmation('Please fill in all required fields', 'https://x.com/jobs/1/apply'));
});

// ── Navigation allowlist ─────────────────────────────────────────────────────

test('navigation allowlist: same base domain only', () => {
  const apply = 'https://boards.greenhouse.io/acme/jobs/1';
  assert.ok(isNavigationAllowed(apply, 'https://boards.greenhouse.io/acme/jobs/1/apply'));
  assert.ok(isNavigationAllowed(apply, 'https://job-boards.greenhouse.io/acme/confirmation'));
  assert.ok(!isNavigationAllowed(apply, 'https://evil.com/phish'));
  assert.ok(!isNavigationAllowed(apply, 'javascript:alert(1)'));
  assert.ok(!isNavigationAllowed(apply, 'not a url'));
  assert.equal(baseDomain('sub.deep.example.co'), 'example.co');
});

test('navigation allowlist is public-suffix aware for multi-part TLDs', () => {
  assert.equal(baseDomain('careers.acme.co.uk'), 'acme.co.uk');
  assert.ok(!isNavigationAllowed('https://acme.co.uk/jobs/1', 'https://evil.co.uk/x'),
    'sibling registrants under co.uk must NOT be treated as the same site');
  assert.ok(isNavigationAllowed('https://careers.acme.co.uk/jobs/1', 'https://apply.acme.co.uk/form'));
});

// ── Review-approval binding ──────────────────────────────────────────────────

test('answers hash is order-independent but value/route sensitive', () => {
  const a = [{ label: 'Email', value: 'x@y.z' }, { label: 'Name', value: 'S' }];
  const b = [{ label: 'Name', value: 'S' }, { label: 'Email', value: 'x@y.z' }];
  const url = 'https://boards.greenhouse.io/acme/jobs/1';
  assert.equal(computeAnswersHash(url, a), computeAnswersHash(url, b));
  assert.notEqual(computeAnswersHash(url, a), computeAnswersHash(url, [{ label: 'Email', value: 'CHANGED' }, { label: 'Name', value: 'S' }]));
  assert.notEqual(computeAnswersHash(url, a), computeAnswersHash('https://other.example/jobs/2', a));
  assert.notEqual(computeAnswersHash(url, a), computeAnswersHash(url, a.slice(0, 1)));
});

test('post-click policy: no evidence or validation errors never yield a submitted state', () => {
  // Missing screenshot evidence → manual verification, regardless of confirmation
  assert.equal(classifySubmitOutcome({ confirmed: true, validationError: false, shotStored: false }), 'needs_user');
  assert.equal(classifySubmitOutcome({ confirmed: false, validationError: false, shotStored: false }), 'needs_user');
  // Validation errors on screen → not submitted
  assert.equal(classifySubmitOutcome({ confirmed: false, validationError: true, shotStored: true }), 'needs_user');
  // With evidence: confirmed → submitted; unconfirmed → submitted_unconfirmed
  assert.equal(classifySubmitOutcome({ confirmed: true, validationError: false, shotStored: true }), 'submitted');
  assert.equal(classifySubmitOutcome({ confirmed: false, validationError: false, shotStored: true }), 'submitted_unconfirmed');
});

test('login-walled ATSs are excluded from generic headless routing', () => {
  for (const ats of ['workday', 'icims', 'taleo', 'successfactors']) assert.ok(LOGIN_WALLED_ATS.has(ats));
  for (const ats of SUPPORTED_ATS) assert.ok(!LOGIN_WALLED_ATS.has(ats));
});

// ── State machine additions ──────────────────────────────────────────────────

test('submitted_unconfirmed is terminal and reachable only from submitting', () => {
  assert.ok(canTransition('submitting', 'submitted_unconfirmed'));
  for (const to of Object.keys(ALLOWED_TRANSITIONS)) {
    assert.ok(!canTransition('submitted_unconfirmed', to as any), `submitted_unconfirmed → ${to} must be forbidden`);
  }
  for (const from of ['queued', 'route_resolved', 'ready_for_review', 'approved'] as const) {
    assert.ok(!canTransition(from, 'submitted_unconfirmed'), `${from} → submitted_unconfirmed must be forbidden`);
  }
});

// ── Misc ─────────────────────────────────────────────────────────────────────

test('jitter stays in range; supported ATS set matches phase scope', () => {
  for (let i = 0; i < 200; i++) {
    const j = jitterMs(2000, 6000);
    assert.ok(j >= 2000 && j < 6000);
  }
  assert.deepEqual([...SUPPORTED_ATS].sort(), ['ashby', 'greenhouse', 'lever', 'smartrecruiters']);
});
