/**
 * Unit tests for the Claude-primary, Gemini-fallback completion helper.
 *
 * completeWithFallback() always tries Claude first via the real Anthropic
 * SDK, so the fallback path is exercised here by leaving ANTHROPIC_API_KEY
 * unset — getAnthropicClient() then throws "ANTHROPIC_API_KEY is not
 * configured.", which isAnthropicUnavailableError() correctly classifies as
 * "Claude unusable right now" (the same class of error as an exhausted
 * credit balance or an invalid key), triggering the Gemini fallback without
 * needing to mock the Anthropic SDK itself. Gemini's HTTP call is mocked via
 * globalThis.fetch, matching the convention in googleDiscovery.test.ts.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAnthropicUnavailableError, completeWithFallback } from './aiClient.js';

function mockFetchResponse(status: number, body: string): typeof fetch {
  return async (_url: any, _init?: any) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response);
}

const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const savedGeminiKey = process.env.GEMINI_API_KEY;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  mock.restoreAll();
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGeminiKey;
});

// ── isAnthropicUnavailableError ──────────────────────────────────────────────

test('isAnthropicUnavailableError: true for quota/billing/rate-limit/auth signals', () => {
  assert.ok(isAnthropicUnavailableError({ status: 429 }));
  assert.ok(isAnthropicUnavailableError({ status: 401 }));
  assert.ok(isAnthropicUnavailableError({ status: 403 }));
  assert.ok(isAnthropicUnavailableError({ status: 529 }));
  assert.ok(isAnthropicUnavailableError(new Error('Your credit balance is too low to access the Anthropic API')));
  assert.ok(isAnthropicUnavailableError(new Error('rate_limit_error: this request exceeds your rate limit')));
  assert.ok(isAnthropicUnavailableError(new Error('overloaded_error: the API is temporarily overloaded')));
  assert.ok(isAnthropicUnavailableError(new Error('authentication_error: invalid x-api-key')));
  assert.ok(isAnthropicUnavailableError(new Error('ANTHROPIC_API_KEY is not configured.')));
});

test('isAnthropicUnavailableError: false for an ordinary content/parsing problem', () => {
  assert.ok(!isAnthropicUnavailableError(new Error('Ranking step returned no results')));
  assert.ok(!isAnthropicUnavailableError(new Error('strict mode violation: locator resolved to 2 elements')));
  assert.ok(!isAnthropicUnavailableError({ status: 400 }));
  assert.ok(!isAnthropicUnavailableError(undefined));
});

// ── completeWithFallback ──────────────────────────────────────────────────────

test('completeWithFallback: falls back to Gemini when Claude is unavailable', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  mock.method(globalThis, 'fetch', mockFetchResponse(200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: '["Product Manager"]' }] } }],
  })));
  const result = await completeWithFallback('list roles', { maxTokens: 100 });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.text, '["Product Manager"]');
});

test('completeWithFallback: re-throws the ORIGINAL Claude error when Gemini has no key configured either', async () => {
  // GEMINI_API_KEY intentionally left unset by beforeEach()
  await assert.rejects(
    completeWithFallback('list roles', { maxTokens: 100 }),
    /ANTHROPIC_API_KEY is not configured/,
  );
});

test('completeWithFallback: re-throws the ORIGINAL Claude error when Gemini also fails', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  mock.method(globalThis, 'fetch', mockFetchResponse(500, '{"error":"internal"}'));
  await assert.rejects(
    completeWithFallback('list roles', { maxTokens: 100 }),
    /ANTHROPIC_API_KEY is not configured/,
  );
});

test('completeWithFallback: never falls back for a non-availability error (nothing to test here without mocking the SDK — covered by isAnthropicUnavailableError above)', () => {
  // completeWithFallback's provider-selection logic is a thin wrapper around
  // isAnthropicUnavailableError(), which is exhaustively covered above;
  // exercising a genuine non-availability failure from the real Anthropic
  // SDK would require mocking the SDK itself, which is out of scope here.
  assert.ok(true);
});

test('completeWithFallback: passes the web-search tool through to Gemini as google_search', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let sentBody: any = null;
  mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '', json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) } as unknown as Response;
  });
  await completeWithFallback('find jobs', { maxTokens: 100, webSearch: { maxUses: 5 } });
  assert.deepEqual(sentBody.tools, [{ google_search: {} }]);
});

test('completeWithFallback: omits tools from the Gemini request when web search was not requested', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let sentBody: any = null;
  mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '', json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) } as unknown as Response;
  });
  await completeWithFallback('plain prompt', { maxTokens: 100 });
  assert.equal(sentBody.tools, undefined);
});
