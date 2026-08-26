/**
 * Real-DB regression test for the stuck-'submitting'-state recovery sweep
 * (§9b of the enterprise gap audit): a process crash/restart while an
 * application was mid-submit previously had no recovery path at all — the
 * row just stayed in 'submitting' forever, with no retry and no way back to
 * review. recoverStuckSubmissions() finds applications stuck past the
 * timeout and transitions them back to needs_user with a reason that
 * explicitly warns the submission's real-world outcome is unknown (to avoid
 * a duplicate re-application), while leaving a genuinely recent/in-flight
 * 'submitting' row (e.g. mid CAPTCHA-hand-off) untouched.
 *
 * Requires DATABASE_URL (real Postgres) — run standalone:
 *   DATABASE_URL=... npx tsx --test server/jobs/applyService.recoverStuck.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, client } from '../db.js';
import { jobMatches, applications } from '../../shared/schema.js';
import { eq } from 'drizzle-orm';
import { recoverStuckSubmissions, STUCK_SUBMITTING_TIMEOUT_MINUTES } from './applyService.js';

let jobId: string;
let stuckAppId: string;
let recentAppId: string;

before(async () => {
  const [job] = await db.insert(jobMatches).values({
    runDate: '2020-01-01', rank: 8001, title: 'Fixture Role', company: 'FixtureCo', country: 'Malaysia',
  }).returning();
  jobId = job.id;

  const wellPastTimeout = new Date(Date.now() - (STUCK_SUBMITTING_TIMEOUT_MINUTES + 5) * 60 * 1000);
  const [stuckApp] = await db.insert(applications).values({
    jobMatchId: jobId, channel: 'ats_auto', state: 'submitting', updatedAt: wellPastTimeout,
  }).returning();
  stuckAppId = stuckApp.id;

  // A second job for the "recent" fixture — the partial unique index only
  // allows one non-terminal application per job.
  const [job2] = await db.insert(jobMatches).values({
    runDate: '2020-01-01', rank: 8002, title: 'Fixture Role 2', company: 'FixtureCo2', country: 'Malaysia',
  }).returning();
  const [recentApp] = await db.insert(applications).values({
    jobMatchId: job2.id, channel: 'ats_auto', state: 'submitting', updatedAt: new Date(),
  }).returning();
  recentAppId = recentApp.id;
});

after(async () => {
  await db.delete(applications).where(eq(applications.jobMatchId, jobId));
  await db.delete(jobMatches).where(eq(jobMatches.id, jobId));
  const [recentApp] = await db.select().from(applications).where(eq(applications.id, recentAppId));
  if (recentApp) {
    await db.delete(applications).where(eq(applications.id, recentAppId));
    await db.delete(jobMatches).where(eq(jobMatches.id, recentApp.jobMatchId));
  }
  await client.end({ timeout: 5 }).catch(() => {});
});

test('recovers an application stuck in submitting past the timeout, with a reason warning the outcome is unknown', async () => {
  const result = await recoverStuckSubmissions();
  assert.ok(result.recovered >= 1, 'must recover at least the stuck fixture');

  const [row] = await db.select().from(applications).where(eq(applications.id, stuckAppId));
  assert.equal(row.state, 'needs_user');
  assert.match(row.needsUserReason ?? '', /interrupted/i);
  assert.match(row.needsUserReason ?? '', /duplicate/i, 'must warn about the risk of a duplicate application before retrying');
});

test('leaves a recent (not-yet-timed-out) submitting application untouched', async () => {
  await recoverStuckSubmissions();
  const [row] = await db.select().from(applications).where(eq(applications.id, recentAppId));
  assert.equal(row.state, 'submitting', 'a submission still genuinely in flight (e.g. mid CAPTCHA hand-off) must not be yanked back');
});
