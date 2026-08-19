/**
 * DB-backed tests for outreach hygiene added to the auto-apply engine:
 *  - wasContactRecentlyEmailed: don't cold-email the same contact for two
 *    different jobs within the cooldown window.
 *  - countTodaysEmailSends: the daily Gmail send-volume cap.
 *
 * Both read real `applications`/`job_matches` rows, so this runs against a
 * real Postgres connection (like handoff.test.ts) rather than mocking the DB.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, client } from '../db.js';
import { jobMatches, applications } from '../../shared/schema.js';
import { inArray } from 'drizzle-orm';
import { wasContactRecentlyEmailed, countTodaysEmailSends, DAILY_EMAIL_SEND_CAP } from './applyService.js';

const RUN_DATE = '2026-01-01';
const jobIds: string[] = [];
const appIds: string[] = [];

async function makeJob(rank: number): Promise<string> {
  const [row] = await db.insert(jobMatches).values({
    runDate: RUN_DATE, rank, title: 'Test Role', company: `TestCo-${rank}`, country: 'Testland',
  }).returning({ id: jobMatches.id });
  jobIds.push(row.id);
  return row.id;
}

async function makeEmailApp(jobMatchId: string, emailTo: string, state: string, opts: { createdAt?: Date; submittedAt?: Date } = {}): Promise<string> {
  const [row] = await db.insert(applications).values({
    jobMatchId, channel: 'email', state, emailTo,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.submittedAt ? { submittedAt: opts.submittedAt } : {}),
  }).returning({ id: applications.id });
  appIds.push(row.id);
  return row.id;
}

after(async () => {
  await db.delete(applications).where(inArray(applications.jobMatchId, jobIds));
  await db.delete(jobMatches).where(inArray(jobMatches.id, jobIds));
  await client.end({ timeout: 5 }).catch(() => {});
});

describe('wasContactRecentlyEmailed', () => {
  it('is false when the contact has never been emailed', async () => {
    const job = await makeJob(1001);
    assert.equal(await wasContactRecentlyEmailed('nobody@nowhere.example', job), false);
  });

  it('is true when the same email was contacted for a DIFFERENT job within the window', async () => {
    const jobA = await makeJob(1002);
    const jobB = await makeJob(1003);
    await makeEmailApp(jobA, 'jane@acme.example', 'submitted');
    assert.equal(await wasContactRecentlyEmailed('jane@acme.example', jobB), true);
    // Case-insensitive match
    assert.equal(await wasContactRecentlyEmailed('JANE@ACME.EXAMPLE', jobB), true);
  });

  it('is false for the SAME job — re-preparing its own application never blocks itself', async () => {
    const job = await makeJob(1004);
    await makeEmailApp(job, 'jane2@acme.example', 'ready_for_review');
    assert.equal(await wasContactRecentlyEmailed('jane2@acme.example', job), false);
  });

  it('counts an in-flight (not-yet-sent) email application, not just a sent one', async () => {
    const jobA = await makeJob(1005);
    const jobB = await makeJob(1006);
    await makeEmailApp(jobA, 'pending@acme.example', 'ready_for_review');
    assert.equal(await wasContactRecentlyEmailed('pending@acme.example', jobB), true);
  });

  it('ignores a contact outside the cooldown window', async () => {
    const jobA = await makeJob(1007);
    const jobB = await makeJob(1008);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    await makeEmailApp(jobA, 'old@acme.example', 'submitted', { createdAt: old });
    assert.equal(await wasContactRecentlyEmailed('old@acme.example', jobB, 21), false);
  });

  it('ignores a non-email-channel application to the same address', async () => {
    const jobA = await makeJob(1009);
    const jobB = await makeJob(1010);
    // channel is 'email' only for email-channel apps; assisted packets don't set emailTo the same way,
    // but guard the query's channel filter explicitly with a non-email row.
    await db.insert(applications).values({ jobMatchId: jobA, channel: 'assisted', state: 'submitted', emailTo: 'assisted-only@acme.example' });
    assert.equal(await wasContactRecentlyEmailed('assisted-only@acme.example', jobB), false);
  });
});

describe('countTodaysEmailSends', () => {
  it('counts only submitted email-channel applications sent today', async () => {
    const job = await makeJob(1011);
    const before = await countTodaysEmailSends();
    await makeEmailApp(job, 'sent-today@acme.example', 'submitted', { submittedAt: new Date() });
    assert.equal(await countTodaysEmailSends(), before + 1);
  });

  it('does not count a ready_for_review (unsent) email application', async () => {
    const job = await makeJob(1012);
    const before = await countTodaysEmailSends();
    await makeEmailApp(job, 'unsent@acme.example', 'ready_for_review');
    assert.equal(await countTodaysEmailSends(), before);
  });

  it('does not count an email submitted on a previous day', async () => {
    const job = await makeJob(1013);
    const before = await countTodaysEmailSends();
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await makeEmailApp(job, 'yesterday@acme.example', 'submitted', { submittedAt: yesterday });
    assert.equal(await countTodaysEmailSends(), before);
  });

  it('DAILY_EMAIL_SEND_CAP is a sane positive bound', () => {
    assert.ok(DAILY_EMAIL_SEND_CAP > 0 && DAILY_EMAIL_SEND_CAP < 100);
  });
});
