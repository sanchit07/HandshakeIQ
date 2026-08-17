/**
 * Unit tests for recheckRecentShortlist in jobMatchService.ts
 *
 * Run with:  npm run test:recheck
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 *
 * All DB operations and the liveness-check function are injected so these
 * tests are fully offline and deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recheckRecentShortlist,
  RECHECK_LOOKBACK_DAYS,
} from './jobMatchService.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makeJob = (
  overrides: Partial<{ id: string; title: string; company: string; url: string | null; runDate: string }> = {},
) => ({
  id: 'job-1',
  title: 'Product Manager',
  company: 'Acme Corp',
  url: 'https://linkedin.com/jobs/view/12345',
  runDate: '2026-08-10',
  ...overrides,
});

/** A query function that returns the given jobs unchanged. */
const queryReturning = (jobs: ReturnType<typeof makeJob>[]) =>
  async (_days: number, _exclude: string) => jobs;

/** A delete spy that records deleted IDs. */
const makeSpy = () => {
  const deletedIds: string[] = [];
  return {
    deletedIds,
    fn: async (id: string) => { deletedIds.push(id); },
  };
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test('RECHECK_LOOKBACK_DAYS is 7', () => {
  assert.equal(RECHECK_LOOKBACK_DAYS, 7);
});

test('returns checked=0 and no removals when there are no recent jobs', async () => {
  const result = await recheckRecentShortlist(
    7,
    async () => true,      // liveness (not called)
    queryReturning([]),    // no jobs
    async () => {},        // delete (not called)
  );

  assert.equal(result.checked, 0);
  assert.deepEqual(result.removed, []);
});

test('keeps jobs whose URL is still live', async () => {
  const job = makeJob();
  const spy = makeSpy();

  const result = await recheckRecentShortlist(
    7,
    async () => true,          // all live
    queryReturning([job]),
    spy.fn,
  );

  assert.equal(result.checked, 1);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(spy.deletedIds, []);  // nothing deleted
});

test('removes jobs whose URL is dead (liveCheck returns false)', async () => {
  const job = makeJob({ id: 'dead-job', url: 'https://linkedin.com/jobs/view/99999' });
  const spy = makeSpy();

  const result = await recheckRecentShortlist(
    7,
    async () => false,          // all dead
    queryReturning([job]),
    spy.fn,
  );

  assert.equal(result.checked, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].id, 'dead-job');
  assert.equal(result.removed[0].company, 'Acme Corp');
  assert.equal(result.removed[0].url, 'https://linkedin.com/jobs/view/99999');
  assert.ok(result.removed[0].reason.length > 0);
  assert.deepEqual(spy.deletedIds, ['dead-job']);
});

test('removes only the dead jobs when a batch has mixed results', async () => {
  const live1 = makeJob({ id: 'live-1', company: 'AliveInc' });
  const dead1 = makeJob({ id: 'dead-1', company: 'DeadCo', url: 'https://linkedin.com/jobs/view/1' });
  const live2 = makeJob({ id: 'live-2', company: 'StillGoing' });
  const dead2 = makeJob({ id: 'dead-2', company: 'GoneCo', url: 'https://linkedin.com/jobs/view/2' });

  const deadUrls = new Set([dead1.url, dead2.url]);
  const spy = makeSpy();

  const result = await recheckRecentShortlist(
    7,
    async (url) => !deadUrls.has(url ?? ''),
    queryReturning([live1, dead1, live2, dead2]),
    spy.fn,
  );

  assert.equal(result.checked, 4);
  assert.equal(result.removed.length, 2);
  const removedIds = result.removed.map((r) => r.id).sort();
  assert.deepEqual(removedIds, ['dead-1', 'dead-2']);
  const deletedSorted = spy.deletedIds.slice().sort();
  assert.deepEqual(deletedSorted, ['dead-1', 'dead-2']);
});

test('keeps a job when liveCheck throws (network error — conservative policy)', async () => {
  const job = makeJob({ id: 'flaky-job' });
  const spy = makeSpy();

  const result = await recheckRecentShortlist(
    7,
    async () => { throw new Error('ECONNRESET'); },
    queryReturning([job]),
    spy.fn,
  );

  assert.equal(result.checked, 1);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(spy.deletedIds, []);  // conservative: don't delete on network error
});

test('passes lookbackDays and excludeDate to the query function', async () => {
  let capturedDays = 0;
  let capturedExclude = '';

  await recheckRecentShortlist(
    14,
    async () => true,
    async (days, exclude) => {
      capturedDays = days;
      capturedExclude = exclude;
      return [];
    },
    async () => {},
  );

  assert.equal(capturedDays, 14);
  // excludeDate should look like a YYYY-MM-DD date string (today in KL time)
  assert.match(capturedExclude, /^\d{4}-\d{2}-\d{2}$/);
});

test('handles a job with a null URL gracefully (query function filters nulls in production)', async () => {
  // In production the SQL query filters out NULL urls, but if an injected
  // query returns a null-url job we must not crash.
  const job = makeJob({ id: 'no-url', url: null });
  const spy = makeSpy();

  // checkUrlLive returns true for null URLs — simulate that
  const result = await recheckRecentShortlist(
    7,
    async (url) => url === null,   // null → live (mirrors real checkUrlLive)
    queryReturning([job]),
    spy.fn,
  );

  assert.equal(result.checked, 1);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(spy.deletedIds, []);
});

test('processes all jobs even when some deletions are slow (sequential, non-aborting)', async () => {
  // All dead: ensure all 5 are checked and deleted even if each takes a tick
  const jobs = Array.from({ length: 5 }, (_, i) =>
    makeJob({ id: `job-${i}`, url: `https://linkedin.com/jobs/view/${i}` }),
  );
  const spy = makeSpy();
  let callCount = 0;

  const result = await recheckRecentShortlist(
    7,
    async () => { callCount++; return false; },
    queryReturning(jobs),
    spy.fn,
  );

  assert.equal(callCount, 5);
  assert.equal(result.checked, 5);
  assert.equal(result.removed.length, 5);
  assert.equal(spy.deletedIds.length, 5);
});

test('removed jobs carry the correct title, company, url, and reason fields', async () => {
  const job = makeJob({
    id: 'detailed-job',
    title: 'Head of Product',
    company: 'MegaCorp',
    url: 'https://seek.com.au/job/12345678',
  });
  const spy = makeSpy();

  const result = await recheckRecentShortlist(
    7,
    async () => false,
    queryReturning([job]),
    spy.fn,
  );

  const r = result.removed[0];
  assert.equal(r.id, 'detailed-job');
  assert.equal(r.title, 'Head of Product');
  assert.equal(r.company, 'MegaCorp');
  assert.equal(r.url, 'https://seek.com.au/job/12345678');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

// ── Contact evidence recheck ─────────────────────────────────────────────────

import { recheckContactEvidence, checkEvidenceUrlAlive } from './jobMatchService.js';

const makeContact = (overrides: Partial<{ id: string; fullName: string; company: string; evidenceUrl: string | null }> = {}) => ({
  id: 'c-1',
  fullName: 'Jane Doe',
  company: 'Acme Corp',
  evidenceUrl: 'https://example.com/team/jane',
  ...overrides,
});

test('recheckContactEvidence marks contacts stale when evidence is gone', async () => {
  const marked: string[] = [];
  const result = await recheckContactEvidence(
    7,
    async (url) => url !== 'https://gone.example.com/x',
    async () => [
      makeContact({ id: 'c-live' }),
      makeContact({ id: 'c-dead', evidenceUrl: 'https://gone.example.com/x' }),
    ],
    async (id) => { marked.push(id); },
  );
  assert.equal(result.checked, 2);
  assert.equal(result.markedStale, 1);
  assert.deepEqual(marked, ['c-dead']);
});

test('recheckContactEvidence keeps contacts on checker errors (fail open)', async () => {
  const marked: string[] = [];
  const result = await recheckContactEvidence(
    7,
    async () => { throw new Error('network blip'); },
    async () => [makeContact()],
    async (id) => { marked.push(id); },
  );
  assert.equal(result.markedStale, 0);
  assert.equal(marked.length, 0);
});

test('recheckContactEvidence with no contacts is a no-op', async () => {
  const result = await recheckContactEvidence(7, async () => true, async () => [], async () => {});
  assert.equal(result.checked, 0);
});

test('checkEvidenceUrlAlive: 404 → stale, bot-block 999 → keep, 200 → keep', async () => {
  const mk = (status: number) => async () => ({ status, body: '', location: null });
  assert.equal(await checkEvidenceUrlAlive('https://example.com/p', mk(404)), false);
  assert.equal(await checkEvidenceUrlAlive('https://example.com/p', mk(410)), false);
  assert.equal(await checkEvidenceUrlAlive('https://linkedin.com/in/x', mk(999)), true);
  assert.equal(await checkEvidenceUrlAlive('https://example.com/p', mk(403)), true);
  assert.equal(await checkEvidenceUrlAlive('https://example.com/p', mk(200)), true);
});

test('checkEvidenceUrlAlive: follows redirect to a 404 → stale', async () => {
  let call = 0;
  const fn = async () => (call++ === 0
    ? { status: 301, body: '', location: 'https://example.com/moved' }
    : { status: 404, body: '', location: null });
  assert.equal(await checkEvidenceUrlAlive('https://example.com/old', fn), false);
});

test('checkEvidenceUrlAlive: private-IP redirect target → stale (SSRF)', async () => {
  const fn = async () => ({ status: 301, body: '', location: 'http://169.254.169.254/x' });
  assert.equal(await checkEvidenceUrlAlive('https://example.com/old', fn), false);
});

test('checkEvidenceUrlAlive: missing or non-http URL → keep', async () => {
  assert.equal(await checkEvidenceUrlAlive(null), true);
  assert.equal(await checkEvidenceUrlAlive('not a url'), true);
});
