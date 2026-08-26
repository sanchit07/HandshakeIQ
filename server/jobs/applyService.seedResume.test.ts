/**
 * Real-DB regression test for AI-assisted structured Work History/Education
 * extraction in seedProfileFromResume ("Fill from my CV"): the deterministic
 * regex fields (name/email/phone/etc.) already worked before this change —
 * these tests cover the new AI extraction specifically:
 *  - only attempted when the profile has no workHistory/education yet
 *  - never overwrites an admin's existing entries
 *  - never breaks the deterministic fields when the AI call fails
 *
 * candidateProfile is effectively a single-row table (no user scoping) — this
 * snapshots whatever real row is there before mutating it, and restores that
 * exact snapshot in after(), matching jobMatchService.schedule.test.ts's
 * convention for the same reason.
 *
 * Requires DATABASE_URL (real Postgres) — run standalone:
 *   DATABASE_URL=... npx tsx --test server/jobs/applyService.seedResume.test.ts
 */
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { db, client } from '../db.js';
import { candidateProfile } from '../../shared/schema.js';
import { seedProfileFromResume } from './applyService.js';

let snapshot: (typeof candidateProfile.$inferSelect)[] = [];

before(async () => {
  snapshot = await db.select().from(candidateProfile);
  await db.delete(candidateProfile);
});

after(async () => {
  await db.delete(candidateProfile);
  if (snapshot.length > 0) {
    await db.insert(candidateProfile).values(snapshot.map((r) => {
      const { id, ...rest } = r;
      return rest;
    }));
  }
  await client.end({ timeout: 5 }).catch(() => {});
});

beforeEach(async () => {
  await db.delete(candidateProfile);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => { mock.restoreAll(); });

function mockGeminiFetch(text: string): typeof fetch {
  return (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  })) as unknown as typeof fetch;
}

const EXTRACTED_JSON = JSON.stringify({
  workHistory: [{ jobTitle: 'Senior Product Manager', employer: 'Acme Corp', location: 'Remote', startDate: '2020-03', isCurrent: true, description: 'Led product strategy.' }],
  education: [{ school: 'ETH Zurich', degree: 'MSc', fieldOfStudy: 'Computer Science', startDate: '2013-09', endDate: '2015-06' }],
});

test('extracts structured work history/education via AI when the profile has none yet', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  mock.method(globalThis, 'fetch', mockGeminiFetch(EXTRACTED_JSON));

  const row = await seedProfileFromResume();
  assert.equal(row.workHistory?.length, 1);
  assert.equal(row.workHistory?.[0].employer, 'Acme Corp');
  assert.equal(row.education?.length, 1);
  assert.equal(row.education?.[0].school, 'ETH Zurich');
});

test('never overwrites existing work history/education — AI is not even called', async () => {
  await db.insert(candidateProfile).values({
    workHistory: [{ jobTitle: 'Existing Role', employer: 'Existing Co' }],
    education: [],
  });
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let fetchCalled = false;
  mock.method(globalThis, 'fetch', async (...args: any[]) => { fetchCalled = true; return mockGeminiFetch(EXTRACTED_JSON)(...(args as [any, any])); });

  const row = await seedProfileFromResume();
  assert.equal(fetchCalled, false, 'must not spend an AI call when workHistory already has entries');
  assert.equal(row.workHistory?.length, 1);
  assert.equal(row.workHistory?.[0].employer, 'Existing Co', 'the admin\'s existing entry must survive untouched');
});

test('a failed AI extraction never breaks the deterministic contact-field seeding', async () => {
  // Both ANTHROPIC_API_KEY and GEMINI_API_KEY left unset — completeWithFallback throws.
  const row = await seedProfileFromResume();
  assert.equal(row.workHistory?.length ?? 0, 0);
  assert.equal(row.education?.length ?? 0, 0);
  // Deterministic fields (from the real general.txt fixture) must still populate.
  assert.ok(row.fullName, 'deterministic name extraction must still work');
  assert.ok(row.email, 'deterministic email extraction must still work');
});
