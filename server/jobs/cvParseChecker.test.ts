/**
 * Unit + integration tests for cvParseChecker.ts
 *
 * Run with:  npm run test:cv-checker
 *
 * Uses Node's built-in test runner — no extra dependencies needed.
 * Unit tests target `assertCvText` (pure validator) — no pdftotext binary needed.
 * Integration test uses `checkCvParseable` + `generateCvPdf` and requires
 * pdftotext to be available in PATH; it is skipped automatically when absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertCvText, checkCvParseable, REQUIRED_HEADINGS } from './cvParseChecker.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build minimal passing CV text so tests only override the field under test. */
function passingText(overrides: {
  firstLine?: string;
  email?: string;
  phone?: string;
  headings?: string[];
  workSection?: string;
} = {}): string {
  const firstLine = overrides.firstLine ?? 'Ahmad Razali bin Zulkifli';
  const email = overrides.email ?? 'ahmad.razali@example.com';
  const phone = overrides.phone ?? '+60 12-345 6789';

  const headings =
    overrides.headings ??
    ['PROFESSIONAL SUMMARY', 'WORK EXPERIENCE', 'EDUCATION', 'SKILLS'];

  const workSection =
    overrides.workSection ??
    `Product Manager
Contoso Sdn Bhd | Kuala Lumpur, Malaysia | March 2021 - Present

Delivery Manager
Fabrikam Berhad | Penang, Malaysia | January 2018 - February 2021`;

  const headingMap: Record<string, string> = {
    'PROFESSIONAL SUMMARY': 'Senior product leader with 10 years of experience.',
    'WORK EXPERIENCE': workSection,
    'EDUCATION': 'MBA, Business | University of Malaya | 2015 - 2017',
    'SKILLS': 'Product Strategy | Agile | Stakeholder Management',
  };

  const sections = headings.map((h) => `${h}\n${headingMap[h] ?? 'Some content here.'}`).join('\n\n');

  return `${firstLine}\n${email} | ${phone} | linkedin.com/in/example\n\n${sections}`;
}

// ── Tests: passing case ───────────────────────────────────────────────────────

test('passes for a well-structured CV', () => {
  const result = assertCvText(passingText());
  assert.equal(result.ok, true, `Expected ok but got: ${!result.ok ? (result as any).reason : ''}`);
});

test('passes with "Month YYYY - Present" date', () => {
  const text = passingText({
    workSection: `Product Director\nAcme Corp | KL | June 2022 - Present`,
  });
  const result = assertCvText(text);
  assert.equal(result.ok, true, !result.ok ? (result as any).reason : '');
});

test('passes when page-break form-feed is present in text', () => {
  const base = passingText();
  const textWithFF = base.slice(0, 200) + '\f' + base.slice(200);
  const result = assertCvText(textWithFF);
  assert.equal(result.ok, true, !result.ok ? (result as any).reason : '');
});

// ── Tests: empty / blank input ────────────────────────────────────────────────

test('fails when text is completely empty', () => {
  const result = assertCvText('');
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /no text/i);
});

test('fails when text is only whitespace', () => {
  const result = assertCvText('   \n\n\t\n   ');
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /no text/i);
});

// ── Tests: name assertion ─────────────────────────────────────────────────────

test('fails when first line starts with a digit', () => {
  const result = assertCvText(passingText({ firstLine: '123 Not a Name' }));
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /first extracted line does not start with a letter/i);
});

test('fails when first line is a section heading', () => {
  const result = assertCvText(passingText({ firstLine: 'PROFESSIONAL SUMMARY' }));
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /section heading/i);
});

test('fails when first non-empty line is too short', () => {
  const result = assertCvText(passingText({ firstLine: 'A' }));
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /too short/i);
});

// ── Tests: email assertion ────────────────────────────────────────────────────

test('fails when no email is present', () => {
  // Build the text manually without an email address
  const text = [
    'Ahmad Razali bin Zulkifli',
    '+60 12-345 6789 | linkedin.com/in/example',
    '',
    'PROFESSIONAL SUMMARY',
    'Senior product leader.',
    '',
    'WORK EXPERIENCE',
    'Product Manager\nAcme | KL | March 2021 - Present',
    '',
    'EDUCATION',
    'MBA | UM | 2015 - 2017',
    '',
    'SKILLS',
    'Agile | Strategy',
  ].join('\n');
  const result = assertCvText(text);
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /email/i);
});

test('accepts various valid email formats', () => {
  for (const email of ['jane.doe+cv@company.co.uk', 'user123@example.org', 'a@b.io']) {
    const result = assertCvText(passingText({ email }));
    assert.equal(result.ok, true, `Failed for email "${email}": ${!result.ok ? (result as any).reason : ''}`);
  }
});

// ── Tests: phone assertion ────────────────────────────────────────────────────

test('fails when no phone with country code is present', () => {
  const text = [
    'Ahmad Razali bin Zulkifli',
    'ahmad@example.com | 012-345-6789',   // local format, no +
    '',
    'PROFESSIONAL SUMMARY',
    'Senior product leader.',
    '',
    'WORK EXPERIENCE',
    'Product Manager\nAcme | KL | March 2021 - Present',
    '',
    'EDUCATION',
    'MBA | UM | 2015 - 2017',
    '',
    'SKILLS',
    'Agile | Strategy',
  ].join('\n');
  const result = assertCvText(text);
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /phone/i);
});

test('accepts various international phone formats', () => {
  for (const phone of ['+1 (415) 555-0132', '+44 7911 123456', '+61 400 000 000', '+60 12-345 6789']) {
    const result = assertCvText(passingText({ phone }));
    assert.equal(result.ok, true, `Failed for phone "${phone}": ${!result.ok ? (result as any).reason : ''}`);
  }
});

// ── Tests: heading assertions ─────────────────────────────────────────────────

for (const heading of REQUIRED_HEADINGS) {
  test(`fails when "${heading}" heading is missing`, () => {
    const remaining = REQUIRED_HEADINGS.filter((h) => h !== heading) as string[];
    const result = assertCvText(passingText({ headings: remaining }));
    assert.equal(result.ok, false);
    assert.match((result as any).reason, new RegExp(heading, 'i'));
  });
}

// ── Tests: date range assertion ───────────────────────────────────────────────

test('fails when no valid date range exists in Work Experience', () => {
  const result = assertCvText(
    passingText({ workSection: 'Product Manager at Acme — 2019 to 2022' }),
  );
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /date range/i);
});

test('fails when date uses en dash instead of hyphen', () => {
  const result = assertCvText(
    passingText({ workSection: 'Product Manager\nAcme | KL | March 2021 – Present' }),
  );
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /date range/i);
});

test('fails when date uses "to" instead of hyphen', () => {
  const result = assertCvText(
    passingText({ workSection: 'Product Manager\nAcme | KL | March 2021 to Present' }),
  );
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /date range/i);
});

test('passes when date range uses "Month YYYY - Month YYYY"', () => {
  const result = assertCvText(
    passingText({ workSection: 'Product Manager\nAcme | KL | January 2019 - December 2022' }),
  );
  assert.equal(result.ok, true, !result.ok ? (result as any).reason : '');
});

test('date range in Work Experience section does not need to appear before Education', () => {
  // Dates only appear after "SKILLS" — they are NOT in the Work Experience section
  const text = [
    'Ahmad Razali',
    'ahmad@example.com | +60 12-345 6789',
    '',
    'PROFESSIONAL SUMMARY',
    'Senior product leader.',
    '',
    'WORK EXPERIENCE',
    'Product Manager at Acme (2019-2022)',  // malformed dates
    '',
    'EDUCATION',
    'MBA | UM | 2015 - 2017',
    '',
    'SKILLS',
    'Agile | Strategy',
    '',
    'January 2019 - December 2022',  // valid date but outside Work Experience
  ].join('\n');
  const result = assertCvText(text);
  // Should fail — date range is not in the Work Experience section
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /date range/i);
});

// ── Integration test: real PDF → pdftotext → assertCvText ────────────────────
// Requires pdftotext in PATH (available in the Replit Nix environment).
// Skipped automatically when the binary is absent so CI without pdftotext
// does not fail.

test('integration: a well-formed CV PDF passes checkCvParseable end-to-end', async () => {
  // pdftotext is declared as a system dependency (poppler in replit.nix/nix config).
  // This test must pass in the project's supported runtime — if pdftotext is missing,
  // it means the system dependency was not provisioned and the check will throw.
  await execFileAsync('pdftotext', ['-v'], { timeout: 5_000 });

  // Import generateCvPdf lazily (it depends on pdfkit which is a production dep)
  const { generateCvPdf } = await import('./cvPdfGenerator.js');

  // Realistic minimal CV markdown matching all CV rules (13 ATS rules)
  const markdown = [
    '# Ahmad Razali bin Zulkifli',
    'Kuala Lumpur, Malaysia | +60 12-345 6789 | ahmad.razali@example.com | linkedin.com/in/ahmad-razali',
    '',
    '## Professional Summary',
    'Senior Product Manager with 10+ years of experience driving digital transformation across fintech and e-commerce.',
    '',
    '## Work Experience',
    '',
    '### Product Manager',
    'Contoso Sdn Bhd | Kuala Lumpur, Malaysia | March 2021 - Present',
    '',
    '- Led cross-functional squad of 12 to deliver core banking platform, reducing onboarding time by 40%.',
    '- Defined and executed product roadmap aligned to OKRs across 3 business units.',
    '',
    '### Delivery Manager',
    'Fabrikam Berhad | Penang, Malaysia | January 2018 - February 2021',
    '',
    '- Managed end-to-end delivery of 5 enterprise software projects totalling RM 12M.',
    '- Introduced agile practices, improving sprint velocity by 30%.',
    '',
    '## Education',
    'MBA, Business Administration | University of Malaya | 2015 - 2017',
    '',
    '## Skills',
    '- Product Strategy | Roadmapping | Stakeholder Management',
    '- Agile / Scrum | JIRA | Confluence',
  ].join('\n');

  const pdfBuffer = await generateCvPdf(markdown, 'Product Manager', 'Contoso Sdn Bhd');
  assert.ok(pdfBuffer.length > 0, 'generateCvPdf should return a non-empty buffer');

  const result = await checkCvParseable(pdfBuffer);
  assert.equal(
    result.ok,
    true,
    `checkCvParseable failed: ${result.ok === false ? result.reason : ''}`,
  );
});

test('integration: a malformed CV PDF (no phone) fails checkCvParseable end-to-end', async () => {
  // pdftotext must be available — it is declared as a system dependency (poppler).
  await execFileAsync('pdftotext', ['-v'], { timeout: 5_000 });

  const { generateCvPdf } = await import('./cvPdfGenerator.js');

  // No phone number with country code in the contact line
  const markdown = [
    '# Jane Smith',
    'London, UK | jane.smith@example.com | linkedin.com/in/janesmith',
    '',
    '## Professional Summary',
    'Product leader with 8 years of experience.',
    '',
    '## Work Experience',
    '',
    '### Senior Product Manager',
    'Acme Corp | London, UK | June 2020 - Present',
    '',
    '- Delivered three major feature launches.',
    '',
    '## Education',
    'BSc Computer Science | UCL | 2010 - 2013',
    '',
    '## Skills',
    '- Agile | Roadmapping | Stakeholder Management',
  ].join('\n');

  const pdfBuffer = await generateCvPdf(markdown, 'Senior Product Manager', 'Acme Corp');
  const result = await checkCvParseable(pdfBuffer);
  assert.equal(result.ok, false, 'Expected checkCvParseable to fail for CV without phone number');
  assert.match(
    (result as any).reason,
    /phone/i,
    `Expected reason to mention phone, got: ${(result as any).reason}`,
  );
});
