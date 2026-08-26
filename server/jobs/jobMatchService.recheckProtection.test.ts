/**
 * Real-DB regression test for the recheck-cascade-delete data-loss fix:
 * a job_matches row with a submitted/in-flight application must NEVER be
 * a candidate for deletion by recheckRecentShortlist, however dead its
 * posting URL later becomes — applications.jobMatchId (and, from there,
 * application_screenshots.applicationId) cascade ON DELETE, so deleting the
 * job would silently destroy the application's record and its screenshot
 * evidence. This exercises the REAL default query (queryFn/deleteFn NOT
 * injected), unlike recheckShortlist.test.ts's fully-offline unit tests —
 * so, unlike that file, this one touches the real database and is scoped as
 * tightly as possible (a 2-day lookback window, one specific fixture date)
 * to avoid ever treating unrelated real rows as "dead" and deleting them.
 * It refuses to run at all if that narrow window isn't already empty.
 *
 * Requires DATABASE_URL (real Postgres) — run standalone:
 *   DATABASE_URL=... npx tsx --test server/jobs/jobMatchService.recheckProtection.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, client } from '../db.js';
import { jobMatches, applications } from '../../shared/schema.js';
import { eq, sql } from 'drizzle-orm';
import { recheckRecentShortlist, todayKL } from './jobMatchService.js';

const LOOKBACK_DAYS = 2;
// Yesterday (KL) — inside the 2-day lookback window, excluded from "today".
const FIXTURE_RUN_DATE = new Date(new Date(`${todayKL()}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
  .toISOString().slice(0, 10);

let protectedJobId: string;
let unprotectedJobId: string;
let noAppJobId: string;

before(async () => {
  // Refuse to run against a window that already has other data — this test
  // deliberately marks every URL in its window as dead; running it against
  // real rows it doesn't own would delete them.
  const preexisting = await db.select({ n: sql<number>`count(*)::int` }).from(jobMatches)
    .where(sql`${jobMatches.runDate}::date >= (${todayKL()}::date - (${String(LOOKBACK_DAYS)} || ' days')::interval)::date
                AND ${jobMatches.runDate}::date < ${todayKL()}::date`);
  if ((preexisting[0]?.n ?? 0) > 0) {
    throw new Error(
      `Refusing to run: ${preexisting[0].n} pre-existing job_matches row(s) already fall inside this test's ` +
      `${LOOKBACK_DAYS}-day recheck window — this test would mark them dead and delete them. Aborting.`,
    );
  }

  const [protectedJob] = await db.insert(jobMatches).values({
    runDate: FIXTURE_RUN_DATE, rank: 9001, title: 'Protected Role', company: 'ProtectedCo',
    country: 'Malaysia', url: 'https://example.com/protected-job-fixture',
  }).returning();
  protectedJobId = protectedJob.id;
  await db.insert(applications).values({
    jobMatchId: protectedJobId, channel: 'ats_auto', state: 'submitted',
  });

  const [unprotectedJob] = await db.insert(jobMatches).values({
    runDate: FIXTURE_RUN_DATE, rank: 9002, title: 'Unprotected Role', company: 'UnprotectedCo',
    country: 'Malaysia', url: 'https://example.com/unprotected-job-fixture',
  }).returning();
  unprotectedJobId = unprotectedJob.id;
  await db.insert(applications).values({
    jobMatchId: unprotectedJobId, channel: 'ats_auto', state: 'failed',
  });

  const [noAppJob] = await db.insert(jobMatches).values({
    runDate: FIXTURE_RUN_DATE, rank: 9003, title: 'No-Application Role', company: 'NoAppCo',
    country: 'Malaysia', url: 'https://example.com/no-app-job-fixture',
  }).returning();
  noAppJobId = noAppJob.id;
});

after(async () => {
  // Only the protected job should still exist; delete defensively either way.
  await db.delete(applications).where(eq(applications.jobMatchId, protectedJobId));
  await db.delete(jobMatches).where(eq(jobMatches.id, protectedJobId));
  await db.delete(applications).where(eq(applications.jobMatchId, unprotectedJobId));
  await db.delete(jobMatches).where(eq(jobMatches.id, unprotectedJobId));
  await db.delete(jobMatches).where(eq(jobMatches.id, noAppJobId));
  await client.end({ timeout: 5 }).catch(() => {});
});

test('a job with a submitted application is never even considered for deletion, even when its posting is dead', async () => {
  // Real defaultQuery + defaultDelete (not injected) — only liveCheckFn is
  // injected, and it reports EVERY url as dead, to isolate the protection
  // logic from real network calls. The `before` hook guarantees this
  // lookback window contains only this test's own 3 fixture rows.
  const result = await recheckRecentShortlist(LOOKBACK_DAYS, async () => false);

  const removedIds = result.removed.map((r) => r.id);
  assert.ok(!removedIds.includes(protectedJobId), 'the submitted-application job must never be a delete candidate');
  assert.ok(removedIds.includes(unprotectedJobId), 'a job whose only application is failed (no irreversible action taken) is still safe to remove');
  assert.ok(removedIds.includes(noAppJobId), 'a job with no application at all is still safe to remove');

  const [stillThere] = await db.select().from(jobMatches).where(eq(jobMatches.id, protectedJobId));
  assert.ok(stillThere, 'protected job row must still exist in the database');

  const [gone] = await db.select().from(jobMatches).where(eq(jobMatches.id, unprotectedJobId));
  assert.equal(gone, undefined, 'unprotected job row must actually be deleted');

  // Its application row must also still exist — proof the CASCADE never fired.
  const [appStillThere] = await db.select().from(applications).where(eq(applications.jobMatchId, protectedJobId));
  assert.ok(appStillThere, 'the submitted application record must survive intact');
  assert.equal(appStillThere.state, 'submitted');
});
