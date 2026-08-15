/**
 * Fallback-path tests for intelligenceService
 *
 * Verifies that when Claude throws, the service falls through to Gemini,
 * and that when Gemini also throws the error surfaces cleanly.
 *
 * Run with:
 *   node --import tsx/esm --test services/intelligenceService.fallback.test.ts
 *
 * Uses Node's built-in test runner — no extra dependencies.
 * No real API calls are made; both providers are fully mocked.
 */

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntelligenceReport } from '../types';

// ── Shared mock state ─────────────────────────────────────────────────────────

const STUB_REPORT: IntelligenceReport = {
  summary: 'Mock summary from Gemini fallback',
  professionalBackground: { category: 'Professional Background', points: [] },
  recentActivities: { category: 'Recent Activities', points: [] },
  personalInterests: { category: 'Personal Interests', points: [] },
  discussionPoints: { category: 'Discussion Points', points: [] },
};

let claudeShouldThrow = false;
let geminiShouldThrow = false;

// ── Mock both provider modules before importing intelligenceService ────────────

mock.module('../services/anthropicService', {
  namedExports: {
    generateIntelligenceReportClaude: async (name: string, company: string) => {
      if (claudeShouldThrow) throw new Error('Simulated Claude failure (rate-limited)');
      return {
        report: { ...STUB_REPORT, summary: `Claude report for ${name} @ ${company}` },
        sources: [],
      };
    },
    extractTextFromImageClaude: async (_img: string) => {
      if (claudeShouldThrow) throw new Error('Simulated Claude OCR failure');
      return { name: 'Claude Name', company: 'Claude Co' };
    },
  },
});

mock.module('../services/geminiService', {
  namedExports: {
    generateIntelligenceReport: async (name: string, company: string) => {
      if (geminiShouldThrow) throw new Error('Simulated Gemini failure');
      return {
        report: { ...STUB_REPORT, summary: `Gemini fallback report for ${name} @ ${company}` },
        sources: [],
      };
    },
    extractTextFromImage: async (_img: string) => {
      if (geminiShouldThrow) throw new Error('Simulated Gemini OCR failure');
      return { name: 'Gemini Name', company: 'Gemini Co' };
    },
    crossCheckReport: async (report: IntelligenceReport) => ({
      overallAccuracyScore: 90,
      flags: [],
      summary: 'No issues found',
    }),
  },
});

// Import AFTER mocks are registered
const { generateIntelligenceReport, extractTextFromImage } =
  await import('../services/intelligenceService');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  claudeShouldThrow = false;
  geminiShouldThrow = false;
});

test('uses Claude when it succeeds', async () => {
  const { report } = await generateIntelligenceReport('Alice', 'Acme');
  assert.ok(report.summary.includes('Claude'), `Expected Claude summary, got: ${report.summary}`);
});

test('falls back to Gemini when Claude throws', async () => {
  claudeShouldThrow = true;
  const { report } = await generateIntelligenceReport('Bob', 'Beta Corp');
  assert.ok(
    report.summary.includes('Gemini fallback'),
    `Expected Gemini fallback summary, got: ${report.summary}`,
  );
});

test('propagates the error when both Claude and Gemini throw', async () => {
  claudeShouldThrow = true;
  geminiShouldThrow = true;
  // Note: the real geminiService catches errors internally and returns an
  // error-shaped report; this mock throws instead, so intelligenceService
  // must propagate the Gemini error rather than swallow it silently.
  await assert.rejects(
    () => generateIntelligenceReport('Eve', 'Error Inc'),
    /Simulated Gemini failure/,
  );
});

test('extractTextFromImage falls back to Gemini when Claude OCR throws', async () => {
  claudeShouldThrow = true;
  const result = await extractTextFromImage('base64data');
  assert.equal(result.name, 'Gemini Name');
  assert.equal(result.company, 'Gemini Co');
});
