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
  guardrailKeyForUrl, looksLikeBotBlockText, looksLikeAlreadyApplied,
  classifyExperienceRole, classifyEducationRole, groupEntryFields,
  parseMonthIso, formatMonthYear, experienceRoleValue, educationRoleValue,
  isAiAnswerableField,
  EXPERIENCE_SECTION_HEADING_RE, EDUCATION_SECTION_HEADING_RE,
  ADD_ANOTHER_EXPERIENCE_RE, ADD_ANOTHER_EDUCATION_RE,
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

// ── Password fields (session-expiry defense-in-depth) ────────────────────────

test('password/passphrase fields classify as sensitive, never as an ordinary field', () => {
  assert.deepEqual(classifyField('Password'), { key: 'password', sensitive: true });
  assert.deepEqual(classifyField('', 'password'), { key: 'password', sensitive: true });
  assert.equal(classifyField('Confirm Password').key, 'password');
  assert.equal(classifyField('Enter your passphrase').key, 'password');
});

test('a password field always pauses (required or not) and is never AI-eligible or vault-writable', () => {
  const req = resolveField(field({ label: 'Password', required: true }), canon);
  assert.ok(req.blockReason, 'must always pause — never typed automatically');
  assert.equal(req.value, null);
  assert.equal(req.unmatchedScreening, false, 'must never be treated as a generic unmatched screening question (never AI-drafted, never vault-reused)');
  assert.doesNotMatch(req.blockReason!, /Screening Answers/i, 'must never invite saving a real password into the globally-reused Screening Answers vault');

  const opt = resolveField(field({ label: 'Password', required: false }), canon);
  assert.ok(opt.blockReason, 'must pause even when the field is marked optional');
  assert.equal(opt.value, null);
});

// ── AI-drafted screening answers ─────────────────────────────────────────────

test('unmatchedScreening is true ONLY for the generic no-vault-match fallthrough', () => {
  // Unknown free-text question with no vault match → eligible for AI drafting.
  const unmatched = resolveField(field({ label: 'Why do you want to work here?', required: false }), canon);
  assert.equal(unmatched.unmatchedScreening, true);

  // A screening-answer vault match is NOT "unmatched".
  const matched = resolveField(field({ label: 'Years of experience with Python?' }), canon);
  assert.equal(matched.unmatchedScreening, false);

  // Sensitive fields are never AI-eligible, matched or not.
  const sensitive = resolveField(field({ label: 'Do you require sponsorship?' }), canon);
  assert.equal(sensitive.unmatchedScreening, false);

  // A known canonical field (even if missing from the vault) is not a
  // "screening question" — AI must never draft a phone number.
  const noPhone = buildCanonicalValues({ ...profile, phone: null } as any, job);
  const knownMissing = resolveField(field({ label: 'Phone' }), noPhone);
  assert.equal(knownMissing.unmatchedScreening, false);
});

test('isAiAnswerableField allows only free-text/textarea, open-ended questions', () => {
  assert.equal(isAiAnswerableField(field({ label: 'Why do you want to work here?', kind: 'text' })), true);
  assert.equal(isAiAnswerableField(field({ label: 'Describe a relevant project you led', kind: 'textarea' })), true);

  // Never for non-text-kind fields — more likely a legal attestation.
  assert.equal(isAiAnswerableField(field({ label: 'Why do you want to work here?', kind: 'select', options: ['A', 'B'] })), false);
  assert.equal(isAiAnswerableField(field({ label: 'I agree to the terms', kind: 'checkbox' })), false);
  assert.equal(isAiAnswerableField(field({ label: 'Preferred contact method', kind: 'radio' })), false);

  // Denylisted categories stay vault-only-or-pause even as free text.
  assert.equal(isAiAnswerableField(field({ label: 'What is your salary expectation?', kind: 'text' })), false);
  assert.equal(isAiAnswerableField(field({ label: 'What is your notice period?', kind: 'text' })), false);
  assert.equal(isAiAnswerableField(field({ label: 'List any professional certifications', kind: 'textarea' })), false);
  assert.equal(isAiAnswerableField(field({ label: 'Have you ever had a background check performed?', kind: 'text' })), false);
  assert.equal(isAiAnswerableField(field({ label: 'Do you have any relatives working at this company?', kind: 'textarea' })), false);
});

// ── GDPR / data-processing consent ───────────────────────────────────────────

test('GDPR consent checkboxes classify as sensitive dataConsent, never as generic fields', () => {
  assert.deepEqual(classifyField('I consent to the processing of my personal data'), { key: 'dataConsent', sensitive: true });
  assert.deepEqual(classifyField('I have read and agree to the Privacy Policy and consent to data processing'), { key: 'dataConsent', sensitive: true });
  assert.equal(classifyField('GDPR Declaration').key, 'dataConsent');
});

test('dataConsent auto-checks ONLY when the vault has explicitly opted in', () => {
  const consented = buildCanonicalValues({ ...profile, dataConsent: true } as any, job);
  const r = resolveField(field({ label: 'I consent to processing of my personal data', kind: 'checkbox' }), consented);
  assert.equal(r.value, 'Yes');
  assert.equal(r.blockReason, null);
});

test('dataConsent with no vault opt-in pauses a required checkbox and skips an optional one', () => {
  const noConsent = buildCanonicalValues({ ...profile, dataConsent: false } as any, job);
  const req = resolveField(field({ label: 'I consent to processing of my personal data', required: true }), noConsent);
  assert.ok(req.blockReason, 'must pause — consent is never auto-checked without explicit opt-in');
  assert.equal(req.value, null);
  const opt = resolveField(field({ label: 'I consent to processing of my personal data', required: false }), noConsent);
  assert.equal(opt.blockReason, null);
  assert.equal(opt.value, null, 'left unchecked, never guessed true');
});

// ── Structured Work Experience / Education entry grouping ───────────────────

test('classifyExperienceRole recognizes Workday-style field labels', () => {
  assert.equal(classifyExperienceRole('Job Title'), 'jobTitle');
  assert.equal(classifyExperienceRole('Company'), 'employer');
  assert.equal(classifyExperienceRole('Location'), 'location');
  assert.equal(classifyExperienceRole('Start Date'), 'startDate');
  assert.equal(classifyExperienceRole('Start Date - Month'), 'startMonth');
  assert.equal(classifyExperienceRole('Start Date - Year'), 'startYear');
  assert.equal(classifyExperienceRole('End Date - Month'), 'endMonth');
  assert.equal(classifyExperienceRole('I currently work here'), 'current');
  assert.equal(classifyExperienceRole('Role Description'), 'description');
  assert.equal(classifyExperienceRole('Something unrelated'), null);
});

test('classifyEducationRole recognizes school/degree field labels', () => {
  assert.equal(classifyEducationRole('School or University'), 'school');
  assert.equal(classifyEducationRole('Degree'), 'degree');
  assert.equal(classifyEducationRole('Field of Study'), 'fieldOfStudy');
  assert.equal(classifyEducationRole('End Date - Year'), 'endYear');
  assert.equal(classifyEducationRole('Something unrelated'), null);
});

test('groupEntryFields assigns each field to the entry started by the most recent boundary field', () => {
  const fields = [
    { label: 'Job Title', selector: '#t1' },
    { label: 'Company', selector: '#c1' },
    { label: 'Start Date', selector: '#s1' },
    { label: 'Job Title', selector: '#t2' },
    { label: 'Company', selector: '#c2' },
    { label: 'Unrelated question', selector: '#u' },
  ];
  const grouped = groupEntryFields(fields, classifyExperienceRole, 'jobTitle');
  assert.deepEqual(grouped.map((g) => [g.selector, g.role, g.index]), [
    ['#t1', 'jobTitle', 0], ['#c1', 'employer', 0], ['#s1', 'startDate', 0],
    ['#t2', 'jobTitle', 1], ['#c2', 'employer', 1],
  ]);
});

test('groupEntryFields drops fields that appear before the first boundary field', () => {
  const fields = [{ label: 'Company', selector: '#orphan' }, { label: 'Job Title', selector: '#t1' }];
  const grouped = groupEntryFields(fields, classifyExperienceRole, 'jobTitle');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].selector, '#t1');
});

test('section heading and add-another patterns match common Workday phrasing', () => {
  assert.ok(EXPERIENCE_SECTION_HEADING_RE.test('My Experience'));
  assert.ok(EDUCATION_SECTION_HEADING_RE.test('Education'));
  assert.ok(ADD_ANOTHER_EXPERIENCE_RE.test('Add Another Work Experience'));
  assert.ok(ADD_ANOTHER_EDUCATION_RE.test('Add Education'));
});

test('parseMonthIso/formatMonthYear round-trip valid vault dates and reject junk', () => {
  assert.deepEqual(parseMonthIso('2019-05'), { year: '2019', month: 5, monthName: 'May' });
  assert.equal(parseMonthIso('not-a-date'), null);
  assert.equal(parseMonthIso(undefined), null);
  assert.equal(formatMonthYear('2019-05'), '05/2019');
  assert.equal(formatMonthYear(undefined), '');
});

test('experienceRoleValue always sources from the vault entry, never leaves a guess', () => {
  const entry = { jobTitle: 'Forensic Scientist', employer: 'Acme Labs', location: 'Boston, MA', startDate: '2019-05', endDate: '2022-08', description: 'Casework analysis' };
  assert.equal(experienceRoleValue(entry, 'jobTitle'), 'Forensic Scientist');
  assert.equal(experienceRoleValue(entry, 'location'), 'Boston, MA');
  assert.equal(experienceRoleValue(entry, 'startMonth'), 'May');
  assert.equal(experienceRoleValue(entry, 'startYear'), '2019');
  assert.equal(experienceRoleValue(entry, 'endDate'), '08/2022');
  assert.equal(experienceRoleValue(entry, 'description'), 'Casework analysis');
});

test('experienceRoleValue suppresses end-date roles and reports isCurrent when the entry is ongoing', () => {
  const entry = { jobTitle: 'Engineer', employer: 'Acme', startDate: '2023-01', isCurrent: true };
  assert.equal(experienceRoleValue(entry, 'endDate'), null);
  assert.equal(experienceRoleValue(entry, 'endMonth'), null);
  assert.equal(experienceRoleValue(entry, 'current'), 'Yes');
});

test('experienceRoleValue returns null (not a guess) for an optional sub-field the vault never captured', () => {
  const entry = { jobTitle: 'Engineer', employer: 'Acme' };
  assert.equal(experienceRoleValue(entry, 'location'), null);
  assert.equal(experienceRoleValue(entry, 'description'), null);
});

test('educationRoleValue mirrors the same date/current handling for school entries', () => {
  const entry = { school: 'MIT', degree: 'PhD', fieldOfStudy: 'Computer Science', startDate: '2013-09', endDate: '2017-06' };
  assert.equal(educationRoleValue(entry, 'school'), 'MIT');
  assert.equal(educationRoleValue(entry, 'degree'), 'PhD');
  assert.equal(educationRoleValue(entry, 'endYear'), '2017');
  const ongoing = { school: 'MIT', startDate: '2021-09', isCurrent: true };
  assert.equal(educationRoleValue(ongoing, 'endDate'), null);
  assert.equal(educationRoleValue(ongoing, 'current'), 'Yes');
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

// ── Guardrail key: tenant isolation on shared ATS hosting ───────────────────

test('guardrailKeyForUrl: shared-hostname ATS platforms key on hostname + company slug', () => {
  const acme = guardrailKeyForUrl('https://boards.greenhouse.io/acme/jobs/123');
  const other = guardrailKeyForUrl('https://boards.greenhouse.io/othercorp/jobs/456');
  assert.notEqual(acme, other, 'two different companies on the same Greenhouse host must get different guardrail keys');
  assert.equal(acme, guardrailKeyForUrl('https://boards.greenhouse.io/acme/jobs/999'),
    'the same company must always key the same regardless of posting id');
});

test('guardrailKeyForUrl: covers Lever, Ashby, SmartRecruiters shared hosts', () => {
  assert.notEqual(
    guardrailKeyForUrl('https://jobs.lever.co/acme/abc'),
    guardrailKeyForUrl('https://jobs.lever.co/othercorp/def'),
  );
  assert.notEqual(
    guardrailKeyForUrl('https://jobs.ashbyhq.com/acme/abc'),
    guardrailKeyForUrl('https://jobs.ashbyhq.com/othercorp/def'),
  );
  assert.notEqual(
    guardrailKeyForUrl('https://jobs.smartrecruiters.com/Acme/abc'),
    guardrailKeyForUrl('https://jobs.smartrecruiters.com/OtherCorp/def'),
  );
});

test('guardrailKeyForUrl: Workday-style per-tenant subdomains already key correctly on hostname alone', () => {
  const acme = guardrailKeyForUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/123');
  const other = guardrailKeyForUrl('https://othercorp.wd5.myworkdayjobs.com/en-US/careers/job/456');
  assert.notEqual(acme, other, 'two different Workday tenants must never share a guardrail key');
  // Regression: the OLD implementation collapsed both to the shared
  // "myworkdayjobs.com" base domain — a block on one tenant would then
  // cascade cooldown/downgrade to every other unrelated Workday customer.
  assert.ok(!acme.match(/^myworkdayjobs\.com$/) && acme.includes('acme'));
});

test('guardrailKeyForUrl: custom/company-owned domains key on the full hostname', () => {
  assert.equal(guardrailKeyForUrl('https://careers.acme.com/jobs/1'), 'careers.acme.com');
  assert.notEqual(
    guardrailKeyForUrl('https://careers.acme.com/jobs/1'),
    guardrailKeyForUrl('https://careers.othercorp.com/jobs/2'),
  );
});

// ── Bot-block text detection ─────────────────────────────────────────────────

test('looksLikeBotBlockText: recognizes common enterprise bot-detection vendor pages', () => {
  assert.ok(looksLikeBotBlockText('Access Denied. You have been blocked.'));
  assert.ok(looksLikeBotBlockText('Request blocked. Reference ID: 182736451afcd (Akamai)'));
  assert.ok(looksLikeBotBlockText('Pardon Our Interruption while we verify you are human'));
  assert.ok(looksLikeBotBlockText('Attention Required! | Cloudflare'));
  assert.ok(looksLikeBotBlockText('Checking your browser before accessing the site...'));
  assert.ok(looksLikeBotBlockText('Our systems have detected unusual traffic from your network.'));
  assert.ok(looksLikeBotBlockText('Ray ID: 8b3f9c2a1e0d4f5a'));
});

test('looksLikeBotBlockText: does not flag ordinary application-page text', () => {
  assert.ok(!looksLikeBotBlockText('Apply now for this Senior Product Manager role at Acme Corp.'));
  assert.ok(!looksLikeBotBlockText('Please verify your email address to continue.'));
  assert.ok(!looksLikeBotBlockText(''));
});

// ── "Already applied" detection ──────────────────────────────────────────────

test('looksLikeAlreadyApplied: recognizes common ATS phrasing', () => {
  assert.ok(looksLikeAlreadyApplied('You have already applied to this position.'));
  assert.ok(looksLikeAlreadyApplied("You've already applied for this role."));
  assert.ok(looksLikeAlreadyApplied('An application already exists for this job.'));
  assert.ok(looksLikeAlreadyApplied('You can only apply once for a given requisition.'));
});

test('looksLikeAlreadyApplied: does not flag a normal blank application form', () => {
  assert.ok(!looksLikeAlreadyApplied('Apply for this Senior Product Manager role at Acme Corp.'));
  assert.ok(!looksLikeAlreadyApplied(''));
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
