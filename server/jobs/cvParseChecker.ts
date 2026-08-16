/**
 * CV parse-ability checker.
 *
 * After a tailored CV is rendered to PDF, this module extracts its text via
 * pdftotext and asserts that every field an ATS needs to autofill (name,
 * contact details, standard headings, date ranges) is machine-readable.
 *
 * Design:
 *   - `checkCvParseable(pdfBuffer)`  — full end-to-end check; needs pdftotext
 *   - `assertCvText(text)`           — pure validator on already-extracted text;
 *                                       used by the unit tests without pdftotext
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

/** Headings required by CV rule 13 — must appear verbatim (case-insensitive). */
export const REQUIRED_HEADINGS = [
  'PROFESSIONAL SUMMARY',
  'WORK EXPERIENCE',
  'EDUCATION',
  'SKILLS',
] as const;

/** Month names accepted in date ranges. */
const MONTH_ALT =
  'January|February|March|April|May|June|July|August|September|October|November|December';

/** Matches "Month YYYY - Month YYYY" or "Month YYYY - Present". */
const DATE_RANGE_RE = new RegExp(
  `(${MONTH_ALT})\\s+\\d{4}\\s+-\\s+(?:Present|(${MONTH_ALT})\\s+\\d{4})`,
  'i',
);

// ── Pure validator ───────────────────────────────────────────────────────────

export interface CvParseResult {
  ok: true;
  /** Extracted text that passed all assertions (useful for debugging). */
  text?: string;
}

export interface CvParseFailure {
  ok: false;
  /** Human-readable description of what failed. */
  reason: string;
}

export type CvParseOutcome = CvParseResult | CvParseFailure;

/**
 * Validate already-extracted CV text (e.g. from pdftotext).
 * Returns `{ ok: true }` when all assertions pass; `{ ok: false, reason }` otherwise.
 *
 * Exported for unit testing without needing pdftotext.
 */
export function assertCvText(text: string): CvParseOutcome {
  // Strip form-feed characters pdftotext emits at page boundaries, then split.
  const cleaned = text.replace(/\f/g, '\n');
  const nonEmptyLines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  if (nonEmptyLines.length === 0) {
    return { ok: false, reason: 'pdftotext extracted no text from the CV' };
  }

  // ── 1. Name is the first non-empty line ───────────────────────────────────
  const firstLine = nonEmptyLines[0];
  if (firstLine.length < 2) {
    return { ok: false, reason: `First line is too short to be a name: "${firstLine}"` };
  }
  if (!/^[A-Za-z]/.test(firstLine)) {
    return {
      ok: false,
      reason: `First extracted line does not start with a letter (expected candidate name): "${firstLine}"`,
    };
  }
  // A section heading on line 1 means the name was not parsed correctly.
  if (REQUIRED_HEADINGS.some((h) => firstLine.toUpperCase() === h)) {
    return {
      ok: false,
      reason: `First extracted line is a section heading, not the candidate name: "${firstLine}"`,
    };
  }

  // ── 2. Email extractable ──────────────────────────────────────────────────
  const emailMatch = cleaned.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (!emailMatch) {
    return { ok: false, reason: 'No email address found in extracted CV text' };
  }

  // ── 3. Phone with country code extractable ────────────────────────────────
  // Matches "+60 12-345 6789", "+44 7911 123456", "+1 (415) 555-0132" etc.
  const phoneMatch = cleaned.match(/\+\d[\d\s\-().]{6,25}/);
  if (!phoneMatch) {
    return {
      ok: false,
      reason: 'No phone number with country code (e.g. +60 12-345 6789) found in extracted CV text',
    };
  }

  // ── 4. All standard headings present ─────────────────────────────────────
  const upperText = cleaned.toUpperCase();
  for (const heading of REQUIRED_HEADINGS) {
    if (!upperText.includes(heading)) {
      return { ok: false, reason: `Required section heading not found: "${heading}"` };
    }
  }

  // ── 5. At least one valid date range in the Work Experience section ───────
  const workExpStart = upperText.indexOf('WORK EXPERIENCE');
  // Look until the next major heading or end of document.
  const nextHeadingAfterWork = REQUIRED_HEADINGS
    .filter((h) => h !== 'WORK EXPERIENCE')
    .map((h) => upperText.indexOf(h, workExpStart + 1))
    .filter((i) => i > workExpStart)
    .reduce((min, i) => (i < min ? i : min), Infinity);

  const workSection =
    workExpStart === -1
      ? ''
      : cleaned.slice(
          workExpStart,
          Number.isFinite(nextHeadingAfterWork) ? nextHeadingAfterWork : undefined,
        );

  if (!DATE_RANGE_RE.test(workSection)) {
    return {
      ok: false,
      reason:
        'No valid "Month YYYY - Month YYYY" or "Month YYYY - Present" date range found in the Work Experience section',
    };
  }

  return { ok: true, text: cleaned };
}

// ── End-to-end checker ───────────────────────────────────────────────────────

/**
 * Renders the CV PDF to a temporary file, extracts its text via pdftotext,
 * and runs `assertCvText`.
 *
 * Throws if pdftotext is unavailable or if the temp file cannot be written.
 * Returns `{ ok: false, reason }` for parse failures without throwing.
 */
export async function checkCvParseable(pdfBuffer: Buffer): Promise<CvParseOutcome> {
  const tmpFile = path.join(
    os.tmpdir(),
    `cv-check-${Date.now()}-${randomBytes(4).toString('hex')}.pdf`,
  );

  try {
    await fs.writeFile(tmpFile, pdfBuffer);

    // -q suppresses info messages; '-' writes extracted text to stdout
    const { stdout } = await execFileAsync('pdftotext', ['-q', tmpFile, '-'], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024, // 4 MB — more than enough for a 2-page CV
    });

    return assertCvText(stdout);
  } finally {
    await fs.unlink(tmpFile).catch(() => {/* best-effort cleanup */});
  }
}
