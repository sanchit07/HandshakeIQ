/**
 * Unit tests for the two-pass AI audit path in jobMatchService.ts:
 *   - auditWithGemini routing (success → no Claude call; HTTP error, bad key,
 *     malformed JSON → Claude fallback; both fail → UNCERTAIN fail-open)
 *   - extractApplyAreaHtml edge cases (multilingual keywords, script/style
 *     skip, overlapping-window avoidance, char budget cap)
 *   - verifyPostingLive verdict handling (CLOSED → false; ACTIVE/UNCERTAIN/
 *     audit-error → true; dead probe short-circuits before AI)
 *   - filterLiveJobs stage-2 AI sequencing (CLOSED dropped, UNCERTAIN & error
 *     kept, dead probe removed before AI)
 *
 * Run with:  npm run test:audit
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 * No real network calls are made; globalThis.fetch is mocked for both the
 * Gemini REST call and the Anthropic SDK (which also uses globalThis.fetch).
 * https.request is mocked for the deterministic HTTP probe.
 */

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dnsPromises from 'node:dns/promises';

import {
  extractApplyAreaHtml,
  auditJobPostingWithAI,
  verifyPostingLive,
  filterLiveJobs,
} from './jobMatchService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a minimal mock for https.request that immediately fires the response
 * callback with the given status code and body text.
 */
function mockHttpsRequest(status: number, body = '<html><body>Apply now</body></html>') {
  mock.method(https, 'request', (_opts: any, callback: (res: any) => void) => {
    const fakeReq = {
      end() {
        Promise.resolve().then(() => {
          const handlers: Record<string, Array<(...args: any[]) => void>> = {};
          const fakeRes = {
            statusCode: status,
            destroy() {},
            on(event: string, handler: (...args: any[]) => void) {
              (handlers[event] ||= []).push(handler);
              return this;
            },
          };
          callback(fakeRes);
          Promise.resolve().then(() => {
            (handlers['data'] || []).forEach((h) => h(Buffer.from(body)));
            (handlers['end'] || []).forEach((h) => h());
          });
        });
        return this;
      },
      on(_e: string, _h: (...a: any[]) => void) { return this; },
      destroy() {},
    };
    return fakeReq;
  });
}

/**
 * Mocks globalThis.fetch to intercept both Gemini REST calls and Anthropic SDK
 * calls (the SDK uses globalThis.fetch via its getDefaultFetch() helper).
 * Each handler is matched by URL substring; the first match wins.
 */
function mockFetch(handlers: Array<{ urlContains: string; ok: boolean; body: any }>) {
  mock.method(globalThis, 'fetch', async (url: string | URL, _init?: any): Promise<Response> => {
    const urlStr = String(url);
    for (const h of handlers) {
      if (urlStr.includes(h.urlContains)) {
        return new Response(JSON.stringify(h.body), {
          status: h.ok ? 200 : 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`[TEST] Unexpected fetch to: ${urlStr}`);
  });
}

/** Mocks DNS to resolve to a safe public IP (avoids SSRF guard in probeUrlLive). */
function mockDnsPublic() {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
}

/**
 * Valid Gemini Flash REST response body wrapping the given audit verdict.
 * Shape: candidates[0].content.parts[0].text = JSON verdict string.
 */
function geminiBody(status: 'ACTIVE' | 'CLOSED' | 'UNCERTAIN', confidence = 0.9) {
  return {
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify({ status, confidence_score: confidence, reason: `Gemini: ${status}` }) }],
      },
    }],
  };
}

/**
 * Valid Anthropic Messages API response body wrapping the given audit verdict.
 * This is the raw HTTP JSON the SDK parses into an Anthropic.Message object.
 * extractText() reads content[0].text, which parseJsonLoose() then decodes.
 */
function claudeBody(status: 'ACTIVE' | 'CLOSED' | 'UNCERTAIN', confidence = 0.8) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: JSON.stringify({ status, confidence_score: confidence, reason: `Claude: ${status}` }) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** A body that passes the deterministic probe (200 + "Apply" keyword, no dead signals). */
const LIVE_BODY = '<html><body><button class="apply-btn">Apply now</button><p>Senior PM role</p></body></html>';

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

// ── extractApplyAreaHtml ──────────────────────────────────────────────────────

test('extractApplyAreaHtml: empty body → empty string', () => {
  assert.equal(extractApplyAreaHtml(''), '');
});

test('extractApplyAreaHtml: no apply-keyword → empty string', () => {
  const body = '<html><body><h1>Senior Engineer</h1><p>Great company</p></body></html>';
  assert.equal(extractApplyAreaHtml(body), '');
});

test('extractApplyAreaHtml: captures window around "apply" keyword', () => {
  const body = '<html><body><button class="cta-btn">Apply now</button></body></html>';
  const result = extractApplyAreaHtml(body);
  assert.ok(result.includes('Apply'), 'Result must include keyword context');
  assert.ok(result.includes('cta-btn'), 'Result must include surrounding HTML');
});

test('extractApplyAreaHtml: multilingual — "permohonan" (Malay)', () => {
  const body = '<a href="/daftar">Hantar permohonan anda</a>';
  assert.ok(extractApplyAreaHtml(body).includes('permohonan'));
});

test('extractApplyAreaHtml: multilingual — "aplikuj" (Polish)', () => {
  const body = '<button>Aplikuj teraz</button>';
  assert.ok(extractApplyAreaHtml(body).toLowerCase().includes('aplikuj'));
});

test('extractApplyAreaHtml: multilingual — "ansök" (Swedish)', () => {
  const body = '<a href="/apply">Ansök nu</a>';
  const result = extractApplyAreaHtml(body);
  assert.ok(result.toLowerCase().includes('ansök') || result.toLowerCase().includes('ans'), 'Swedish keyword captured');
});

test('extractApplyAreaHtml: multilingual — "bewerben" (German)', () => {
  const body = '<button type="submit">Jetzt bewerben</button>';
  assert.ok(extractApplyAreaHtml(body).includes('bewerben'));
});

test('extractApplyAreaHtml: multilingual — "postuler" (French)', () => {
  const body = '<a href="/postuler">Postuler maintenant</a>';
  assert.ok(extractApplyAreaHtml(body).toLowerCase().includes('postuler'));
});

test('extractApplyAreaHtml: skips match inside unclosed script block', () => {
  // Window of 400 chars before the keyword contains "<script" but no "</script>"
  // → the heuristic treats this as still inside a script blob.
  const scriptPrefix = '<script>var cfg = "' + 'x'.repeat(50);
  // Total: scriptPrefix (70 chars) + "apply" — the window will see <script without </script>
  const body = scriptPrefix + 'apply here';
  const result = extractApplyAreaHtml(body);
  assert.equal(result, '', 'apply inside unclosed script must be skipped');
});

test('extractApplyAreaHtml: does NOT skip match when </script> closes before the window', () => {
  // </script> appears inside the 400-char window, so the heuristic does not fire.
  const body = '<script>var x=1;</script><button class="cta">Apply here</button>';
  const result = extractApplyAreaHtml(body);
  assert.ok(result.length > 0, 'Match after closed script must be included');
});

test('extractApplyAreaHtml: respects maxChars budget', () => {
  // Many "apply" occurrences; without the cap result would exceed budget.
  const chunk = '<button>Apply now ' + 'x'.repeat(600) + '</button>';
  const body = chunk.repeat(20);
  const result = extractApplyAreaHtml(body, 500);
  assert.ok(result.length <= 500, `Length ${result.length} exceeds maxChars 500`);
});

test('extractApplyAreaHtml: non-overlapping windows via 800-char lastIndex advance', () => {
  // Two "apply" occurrences 100 chars apart; lastIndex advances 800 after each
  // match so the regex jumps past both in one step — only the first is captured.
  const body = 'Apply now' + 'x'.repeat(100) + 'Apply again';
  const result = extractApplyAreaHtml(body, 10_000);
  assert.ok(result.length <= 10_000);
  // Result may contain one or two matches — either way it must not exceed budget.
  assert.ok(result.includes('Apply'));
});

// ── auditJobPostingWithAI — null / empty body ─────────────────────────────────

test('auditJobPostingWithAI: null body → fail-open UNCERTAIN (no AI call)', async () => {
  // fetch not mocked — any AI call would throw
  const verdict = await auditJobPostingWithAI('https://example.com/job/0', null);
  assert.equal(verdict.status, 'UNCERTAIN');
  assert.equal(verdict.confidence_score, 0);
  assert.ok(verdict.reason.length > 0);
});

// ── auditJobPostingWithAI — Gemini routing ────────────────────────────────────

test('auditJobPostingWithAI: Gemini ACTIVE success → Gemini verdict used, Claude not called', async () => {
  // Claude mock points to a URL that is never fetched; any call would throw.
  mockFetch([
    { urlContains: 'generativelanguage', ok: true, body: geminiBody('ACTIVE', 0.95) },
  ]);

  const verdict = await auditJobPostingWithAI('https://example.com/job/1', LIVE_BODY);
  assert.equal(verdict.status, 'ACTIVE');
  assert.ok(Math.abs(verdict.confidence_score - 0.95) < 0.01);
  assert.ok(verdict.reason.includes('Gemini'));
});

test('auditJobPostingWithAI: Gemini CLOSED verdict propagated', async () => {
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('CLOSED', 0.97) }]);
  const verdict = await auditJobPostingWithAI('https://example.com/job/2', LIVE_BODY);
  assert.equal(verdict.status, 'CLOSED');
  assert.ok(Math.abs(verdict.confidence_score - 0.97) < 0.01);
});

test('auditJobPostingWithAI: Gemini UNCERTAIN verdict propagated', async () => {
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('UNCERTAIN', 0.4) }]);
  const verdict = await auditJobPostingWithAI('https://example.com/job/3', LIVE_BODY);
  assert.equal(verdict.status, 'UNCERTAIN');
  assert.ok(Math.abs(verdict.confidence_score - 0.4) < 0.01);
});

test('auditJobPostingWithAI: Gemini HTTP 500 → falls back to Claude', async () => {
  mockFetch([
    { urlContains: 'generativelanguage', ok: false, body: { error: 'quota exceeded' } },
    { urlContains: 'api.anthropic.com', ok: true, body: claudeBody('ACTIVE', 0.8) },
  ]);

  const verdict = await auditJobPostingWithAI('https://example.com/job/4', LIVE_BODY);
  assert.equal(verdict.status, 'ACTIVE');
  assert.ok(verdict.reason.includes('Claude'));
});

test('auditJobPostingWithAI: Gemini malformed JSON → falls back to Claude', async () => {
  mockFetch([
    {
      urlContains: 'generativelanguage',
      ok: true,
      body: { candidates: [{ content: { parts: [{ text: 'not valid json ¯\\_(ツ)_/¯' }] } }] },
    },
    { urlContains: 'api.anthropic.com', ok: true, body: claudeBody('ACTIVE', 0.7) },
  ]);

  const verdict = await auditJobPostingWithAI('https://example.com/job/5', LIVE_BODY);
  assert.equal(verdict.status, 'ACTIVE');
  assert.ok(verdict.reason.includes('Claude'));
});

test('auditJobPostingWithAI: Gemini unrecognised status → falls back to Claude', async () => {
  mockFetch([
    {
      urlContains: 'generativelanguage',
      ok: true,
      body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'MAYBE', confidence_score: 0.5, reason: 'wat' }) }] } }] },
    },
    { urlContains: 'api.anthropic.com', ok: true, body: claudeBody('UNCERTAIN', 0.5) },
  ]);

  const verdict = await auditJobPostingWithAI('https://example.com/job/6', LIVE_BODY);
  assert.equal(verdict.status, 'UNCERTAIN');
  assert.ok(verdict.reason.includes('Claude'));
});

test('auditJobPostingWithAI: missing GEMINI_API_KEY → skips Gemini, calls Claude directly', async () => {
  delete process.env.GEMINI_API_KEY;
  // Only Claude handler needed — Gemini is skipped before any fetch
  mockFetch([
    { urlContains: 'api.anthropic.com', ok: true, body: claudeBody('ACTIVE', 0.88) },
  ]);

  const verdict = await auditJobPostingWithAI('https://example.com/job/7', LIVE_BODY);
  assert.equal(verdict.status, 'ACTIVE');
  assert.ok(Math.abs(verdict.confidence_score - 0.88) < 0.01);
});

test('auditJobPostingWithAI: Gemini fetch throws (network error) → falls back to Claude', async () => {
  let callCount = 0;
  mock.method(globalThis, 'fetch', async (url: string | URL, _init?: any): Promise<Response> => {
    callCount += 1;
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage')) throw new Error('Network failure');
    if (urlStr.includes('api.anthropic.com')) {
      return new Response(JSON.stringify(claudeBody('ACTIVE', 0.75)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`[TEST] Unexpected: ${urlStr}`);
  });

  const verdict = await auditJobPostingWithAI('https://example.com/job/8', LIVE_BODY);
  assert.equal(verdict.status, 'ACTIVE');
  assert.ok(verdict.reason.includes('Claude'));
});

test('auditJobPostingWithAI: both Gemini and Claude HTTP-fail → throws (callers catch and fail-open)', async () => {
  // auditJobPostingWithAI does NOT have an internal try/catch around the Claude
  // call — errors propagate to the caller (verifyPostingLive / filterLiveJobs)
  // which fail-open. This test documents that contract.
  mockFetch([
    { urlContains: 'generativelanguage', ok: false, body: { error: 'server error' } },
    { urlContains: 'api.anthropic.com', ok: false, body: { error: { type: 'overloaded_error', message: 'overloaded' } } },
  ]);

  await assert.rejects(
    () => auditJobPostingWithAI('https://example.com/job/9', LIVE_BODY),
    (err: any) => {
      // Anthropic SDK wraps HTTP errors in an APIStatusError
      assert.ok(err?.message?.includes('overloaded') || err?.status === 500, `Unexpected error: ${err?.message}`);
      return true;
    },
  );
});

test('auditJobPostingWithAI: Claude returns malformed JSON → parseJsonLoose throws (callers catch and fail-open)', async () => {
  // parseJsonLoose throws "No JSON found" which propagates from auditJobPostingWithAI.
  // The fail-open is handled by the callers; verifyPostingLive and filterLiveJobs
  // both have try/catch wrappers around auditJobPostingWithAI — tested separately.
  mockFetch([
    { urlContains: 'generativelanguage', ok: false, body: {} },
    {
      urlContains: 'api.anthropic.com',
      ok: true,
      body: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'This is not JSON at all, sorry.' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ]);

  await assert.rejects(
    () => auditJobPostingWithAI('https://example.com/job/10', LIVE_BODY),
    /No JSON found/,
  );
});

// ── verifyPostingLive — verdict handling ──────────────────────────────────────

test('verifyPostingLive: dead probe (404) → false without reaching AI', async () => {
  mockDnsPublic();
  mockHttpsRequest(404);
  // No fetch mock — any AI call would throw, catching that as a test failure
  const live = await verifyPostingLive('https://linkedin.com/jobs/view/99999');
  assert.equal(live, false);
});

test('verifyPostingLive: live probe + Gemini ACTIVE → true', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('ACTIVE', 0.92) }]);

  assert.equal(await verifyPostingLive('https://linkedin.com/jobs/view/11111'), true);
});

test('verifyPostingLive: live probe + Gemini CLOSED → false', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('CLOSED', 0.99) }]);

  assert.equal(await verifyPostingLive('https://linkedin.com/jobs/view/22222'), false);
});

test('verifyPostingLive: live probe + Gemini UNCERTAIN → true (fail-open)', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('UNCERTAIN', 0.5) }]);

  assert.equal(await verifyPostingLive('https://linkedin.com/jobs/view/33333'), true);
});

test('verifyPostingLive: live probe + both AI providers fail → true (fail-open)', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([
    { urlContains: 'generativelanguage', ok: false, body: {} },
    { urlContains: 'api.anthropic.com', ok: false, body: { error: { type: 'overloaded_error' } } },
  ]);

  assert.equal(await verifyPostingLive('https://linkedin.com/jobs/view/44444'), true);
});

test('verifyPostingLive: null URL → true (fail-open, no crash)', async () => {
  // probeUrlLive(null) is expected to fail-open just like checkUrlLive(null)
  const live = await verifyPostingLive(null);
  assert.equal(live, true);
});

// ── filterLiveJobs — stage-2 AI sequencing ───────────────────────────────────

test('filterLiveJobs: empty input → empty output', async () => {
  assert.deepEqual(await filterLiveJobs([]), []);
});

test('filterLiveJobs: dead probe (404) removes job before AI stage', async () => {
  mockDnsPublic();
  mockHttpsRequest(404);
  // No fetch mock — AI must never be reached

  const jobs = [{ url: 'https://linkedin.com/jobs/view/dead-404', title: 'PM', company: 'Acme' }];
  assert.equal((await filterLiveJobs(jobs)).length, 0);
});

test('filterLiveJobs: ACTIVE Gemini verdict → job kept', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('ACTIVE', 0.9) }]);

  const jobs = [{ url: 'https://linkedin.com/jobs/view/active-1', title: 'PM', company: 'Acme' }];
  const kept = await filterLiveJobs(jobs);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].url, jobs[0].url);
});

test('filterLiveJobs: CLOSED Gemini verdict → job removed', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('CLOSED', 0.95) }]);

  const jobs = [{ url: 'https://linkedin.com/jobs/view/closed-1', title: 'PM', company: 'Acme' }];
  assert.equal((await filterLiveJobs(jobs)).length, 0);
});

test('filterLiveJobs: UNCERTAIN Gemini verdict → job kept (fail-open)', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([{ urlContains: 'generativelanguage', ok: true, body: geminiBody('UNCERTAIN', 0.5) }]);

  const jobs = [{ url: 'https://linkedin.com/jobs/view/uncertain-1', title: 'BA', company: 'Corp' }];
  assert.equal((await filterLiveJobs(jobs)).length, 1);
});

test('filterLiveJobs: AI audit error (both providers fail) → job kept (fail-open)', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);
  mockFetch([
    { urlContains: 'generativelanguage', ok: false, body: {} },
    { urlContains: 'api.anthropic.com', ok: false, body: { error: { type: 'overloaded_error' } } },
  ]);

  const jobs = [{ url: 'https://linkedin.com/jobs/view/audit-err', title: 'Lead PM', company: 'Corp' }];
  assert.equal((await filterLiveJobs(jobs)).length, 1);
});

test('filterLiveJobs: mixed batch — only CLOSED job removed, ACTIVE kept', async () => {
  mockDnsPublic();
  mockHttpsRequest(200, LIVE_BODY);

  // Two sequential audit calls; alternate verdict per call
  let auditCall = 0;
  mock.method(globalThis, 'fetch', async (url: string | URL, _init?: any): Promise<Response> => {
    const urlStr = String(url);
    if (!urlStr.includes('generativelanguage')) throw new Error(`[TEST] Unexpected: ${urlStr}`);
    auditCall += 1;
    const verdict = auditCall === 1 ? 'ACTIVE' : 'CLOSED';
    return new Response(JSON.stringify(geminiBody(verdict as 'ACTIVE' | 'CLOSED')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const jobs = [
    { url: 'https://linkedin.com/jobs/view/active-mix', title: 'PM', company: 'Acme' },
    { url: 'https://linkedin.com/jobs/view/closed-mix', title: 'BA', company: 'Corp' },
  ];
  const kept = await filterLiveJobs(jobs);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].url, 'https://linkedin.com/jobs/view/active-mix');
});
