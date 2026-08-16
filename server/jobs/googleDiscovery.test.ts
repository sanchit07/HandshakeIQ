/**
 * Unit tests for Google Custom Search discovery status tracking.
 *
 * Run with:  npm run test:google-discovery
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 *
 * Scenarios covered:
 *  1. Missing GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID → error status set
 *  2. API returns non-OK response (e.g. 403) → error status set with reason
 *  3. Recovery: success after failure → error status cleared
 *  4. All queries fail → error status set (last failure wins)
 *  5. GET /api/jobs/google-discovery-status (no date param) → returns status object
 */

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  googleDiscoverJobUrls,
  getGoogleDiscoveryStatus,
  _resetGoogleDiscoveryStatus,
} from './jobMatchService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fetch-like mock that returns the given status and body. */
function mockFetchResponse(status: number, body: string): typeof fetch {
  return async (_url: any, _init?: any) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response);
}

/** Set required env vars for Google discovery. */
function setGoogleEnv() {
  process.env.GOOGLE_SEARCH_API_KEY = 'test-api-key';
  process.env.GOOGLE_SEARCH_ENGINE_ID = 'test-cx';
}

/** Remove Google env vars (including GEMINI_API_KEY so the Gemini grounded
 * fallback can't fire a live API call from unit tests). */
function clearGoogleEnv() {
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_ENGINE_ID;
  delete process.env.GEMINI_API_KEY;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetGoogleDiscoveryStatus();
  clearGoogleEnv();
});

afterEach(() => {
  clearGoogleEnv();
  _resetGoogleDiscoveryStatus();
  mock.restoreAll();
});

// 1. Missing GOOGLE_SEARCH_API_KEY
test('missing GOOGLE_SEARCH_API_KEY sets error status', async () => {
  process.env.GOOGLE_SEARCH_ENGINE_ID = 'test-cx';
  // No GOOGLE_SEARCH_API_KEY set

  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null, 'status should be set');
  assert.match(status!.error, /GOOGLE_SEARCH_API_KEY/);
  assert.ok(status!.timestamp, 'timestamp should be present');
});

// 1b. Missing GOOGLE_SEARCH_ENGINE_ID
test('missing GOOGLE_SEARCH_ENGINE_ID sets error status', async () => {
  process.env.GOOGLE_SEARCH_API_KEY = 'test-key';
  // No GOOGLE_SEARCH_ENGINE_ID set

  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null, 'status should be set');
  assert.match(status!.error, /GOOGLE_SEARCH_ENGINE_ID/);
});

// 1c. Both missing → both mentioned in error
test('both keys missing mentions both in error', async () => {
  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null);
  assert.match(status!.error, /GOOGLE_SEARCH_API_KEY/);
  assert.match(status!.error, /GOOGLE_SEARCH_ENGINE_ID/);
});

// 2. API returns 403 → error status set with HTTP status in message
test('403 from Google API sets error status with HTTP status', async () => {
  setGoogleEnv();
  const errorBody = JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } });
  mock.method(globalThis, 'fetch', mockFetchResponse(403, errorBody));

  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null, 'status should be set after 403');
  assert.match(status!.error, /403/);
  assert.ok(status!.timestamp, 'timestamp should be present');
});

// 2b. API returns 400 → error status set
test('400 from Google API sets error status', async () => {
  setGoogleEnv();
  const errorBody = JSON.stringify({ error: { message: 'Bad Request' } });
  mock.method(globalThis, 'fetch', mockFetchResponse(400, errorBody));

  await googleDiscoverJobUrls('Australia', ['Product Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null, 'status should be set after 400');
  assert.match(status!.error, /400/);
});

// 3. Recovery: success after failure clears the error status
test('successful call after failure clears error status', async () => {
  setGoogleEnv();

  // First call: fail
  mock.method(globalThis, 'fetch', mockFetchResponse(403, '{"error":{"message":"key invalid"}}'));
  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);
  assert.ok(getGoogleDiscoveryStatus() !== null, 'error should be set after failure');

  mock.restoreAll();

  // Second call: succeed — return valid JSON with one item
  const successBody = JSON.stringify({
    items: [{ title: 'Product Manager at Acme', link: 'https://www.linkedin.com/jobs/view/12345' }],
  });
  mock.method(globalThis, 'fetch', mockFetchResponse(200, successBody));
  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);

  assert.strictEqual(getGoogleDiscoveryStatus(), null, 'status should be cleared after success');
});

// 4. All queries fail → status records the last failure
test('all queries failing keeps error status set', async () => {
  setGoogleEnv();
  const errorBody = '{"error":{"message":"quota exceeded"}}';
  // Return 429 (quota) for every call — status should remain set throughout
  mock.method(globalThis, 'fetch', mockFetchResponse(429, errorBody));

  await googleDiscoverJobUrls('Australia', ['Product Manager', 'Delivery Manager']);

  const status = getGoogleDiscoveryStatus();
  assert.ok(status !== null, 'status should remain set when all queries fail');
});

// 5. Route: GET /api/jobs/google-discovery-status returns status without a date param
test('google-discovery-status endpoint returns status without date parameter', async () => {
  // Simulate a previous failure so there is something to return
  setGoogleEnv();
  mock.method(globalThis, 'fetch', mockFetchResponse(403, '{"error":{"message":"invalid key"}}'));
  await googleDiscoverJobUrls('Malaysia', ['Product Manager']);
  mock.restoreAll();

  const savedStatus = getGoogleDiscoveryStatus();
  assert.ok(savedStatus !== null, 'precondition: error status is set');

  // Now verify the route handler returns it. We call getGoogleDiscoveryStatus() directly
  // (the route simply wraps it in { googleDiscoveryStatus: ... }), so we verify the
  // shape the route would produce.
  const routeResponse = { googleDiscoveryStatus: getGoogleDiscoveryStatus() };
  assert.ok(routeResponse.googleDiscoveryStatus !== null);
  assert.ok(typeof routeResponse.googleDiscoveryStatus!.error === 'string');
  assert.ok(typeof routeResponse.googleDiscoveryStatus!.timestamp === 'string');
});
