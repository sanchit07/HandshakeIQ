/**
 * Hand-off system tests. The registry is DB-mediated (replica-safe): the
 * list/frame/input/resolve functions only touch Postgres, while the replica
 * owning the Playwright page pumps frames out and drains inputs in. These
 * tests exercise both the pure input validation and the DB-mediated
 * "non-owner" request path (list/frame/input/resolve never touch the page).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import {
  openHandoff, finishHandoff, getHandoff, listHandoffs, handoffInput, handoffFrame,
  normalizeHandoffInput,
} from './handoff.js';
import { submitCaptchaGuard } from './index.js';
import { db, client } from '../../db.js';
import { handoffSessions } from '../../../shared/schema.js';
import { inArray } from 'drizzle-orm';

const TEST_APPS = ['handoff-test-app-1', 'handoff-test-app-2', 'handoff-test-app-3', 'handoff-test-app-4'];

after(async () => {
  await db.delete(handoffSessions).where(inArray(handoffSessions.applicationId, TEST_APPS));
  await client.end({ timeout: 5 }).catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal stub of the Playwright Page surface the hand-off system touches. */
function stubPage() {
  const events: any[] = [];
  return {
    events,
    page: {
      screenshot: async () => Buffer.from('jpeg-bytes'),
      mouse: {
        click: async (x: number, y: number) => events.push({ click: [x, y] }),
        wheel: async (dx: number, dy: number) => events.push({ wheel: [dx, dy] }),
      },
      keyboard: {
        type: async (text: string) => events.push({ type: text }),
        press: async (key: string) => events.push({ press: key }),
      },
    } as any,
  };
}

describe('input validation (pure)', () => {
  it('clamps and normalizes valid events', () => {
    assert.deepStrictEqual(normalizeHandoffInput({ type: 'click', x: -5, y: 99999 }), { type: 'click', x: 0, y: 5000 });
    assert.deepStrictEqual(normalizeHandoffInput({ type: 'type', text: 'x'.repeat(500) }), { type: 'type', text: 'x'.repeat(200) });
    assert.deepStrictEqual(normalizeHandoffInput({ type: 'press', key: 'Enter' }), { type: 'press', key: 'Enter' });
    assert.deepStrictEqual(normalizeHandoffInput({ type: 'scroll', deltaY: 99999 }), { type: 'scroll', deltaY: 3000 });
  });

  it('rejects disallowed or malformed events', () => {
    assert.strictEqual(normalizeHandoffInput({ type: 'press', key: 'F12' }), null);
    assert.strictEqual(normalizeHandoffInput({ type: 'click', x: 'a', y: 1 }), null);
    assert.strictEqual(normalizeHandoffInput({ type: 'type', text: '' }), null);
    assert.strictEqual(normalizeHandoffInput({ type: 'evaluate', code: '1' }), null);
    assert.strictEqual(normalizeHandoffInput(null), null);
  });
});

describe('submit-boundary CAPTCHA guard (regular ATS path)', () => {
  const page = {} as any;

  it('passes through when no CAPTCHA is present (no block, no hand-off)', async () => {
    let blocked = 0, handoffs = 0;
    const clear = await submitCaptchaGuard('app-x', 'https://x.example/apply', page, 'submitting the application', {
      detect: async () => false,
      block: async () => { blocked++; },
      handoff: async () => { handoffs++; return 'solved'; },
    });
    assert.strictEqual(clear, true);
    assert.strictEqual(blocked, 0);
    assert.strictEqual(handoffs, 0);
  });

  it('opens the live hand-off and resumes when the user solves it', async () => {
    let blocked = 0;
    const detections = [true, false]; // blocked → solved → clear on recheck
    const clear = await submitCaptchaGuard('app-x', 'https://x.example/apply', page, 'submitting the application', {
      detect: async () => detections.shift() ?? false,
      block: async () => { blocked++; },
      handoff: async () => 'solved',
    });
    assert.strictEqual(clear, true);
    assert.strictEqual(blocked, 1); // guard-rail block recorded
  });

  it('fails closed when the hand-off times out or is aborted', async () => {
    for (const resolution of ['timeout', 'aborted'] as const) {
      const clear = await submitCaptchaGuard('app-x', 'https://x.example/apply', page, 'confirming the submission', {
        detect: async () => true,
        block: async () => {},
        handoff: async () => resolution,
      });
      assert.strictEqual(clear, false);
    }
  });

  it('fails closed when the puzzle persists after a claimed solve', async () => {
    const clear = await submitCaptchaGuard('app-x', 'https://x.example/apply', page, 'submitting the application', {
      detect: async () => true, // still blocked on recheck
      block: async () => {},
      handoff: async () => 'solved',
    });
    assert.strictEqual(clear, false);
  });
});

describe('fill→submit continuation vs guard-rails (DB)', () => {
  const url = 'https://guardrail-continuation-test.example/apply';
  const domain = 'guardrail-continuation-test.example';

  it('an immediate approved submit proceeds; genuine blocks still gate it', async () => {
    const { recordDomainRun, recordDomainBlock, resetDomainControl, checkDomainAllowed } = await import('./guardrails.js');
    await resetDomainControl(domain);
    try {
      // Prepare/fill records a run…
      await recordDomainRun(url);
      // …a fresh (non-continuation) run is gated by the inter-run gap…
      assert.strictEqual((await checkDomainAllowed(url)).allowed, false);
      // …but the approved submit continuation proceeds immediately.
      assert.strictEqual((await checkDomainAllowed(url, { ignoreRunGap: true })).allowed, true);
      // A genuine CAPTCHA block still gates even the continuation.
      await recordDomainBlock(url, 'captcha:test');
      assert.strictEqual((await checkDomainAllowed(url, { ignoreRunGap: true })).allowed, false);
    } finally {
      await resetDomainControl(domain);
    }
  });
});

describe('hand-off registry (DB-mediated)', () => {
  it('opens, lists, and resolves as solved', async () => {
    const { page } = stubPage();
    const s = await openHandoff(TEST_APPS[0], page, 'captcha blocked', 60_000, 100);
    assert.strictEqual((await listHandoffs()).some((h) => h.id === s.id && h.applicationId === TEST_APPS[0]), true);
    assert.notStrictEqual(await getHandoff(s.id), null);
    assert.strictEqual(await finishHandoff(s.id, 'solved'), true);
    assert.strictEqual(await s.done, 'solved');
    assert.strictEqual(await getHandoff(s.id), null);
    assert.strictEqual(await finishHandoff(s.id, 'solved'), false); // idempotent
  });

  it('times out and resolves as timeout', async () => {
    const { page } = stubPage();
    const s = await openHandoff(TEST_APPS[1], page, 'captcha', 150, 50);
    assert.strictEqual(await s.done, 'timeout');
    assert.strictEqual(await getHandoff(s.id), null);
  });

  it('replaces an existing hand-off for the same application', async () => {
    const { page } = stubPage();
    const a = await openHandoff(TEST_APPS[2], page, 'first', 60_000, 100);
    const b = await openHandoff(TEST_APPS[2], page, 'second', 60_000, 100);
    assert.strictEqual(await a.done, 'aborted'); // superseded
    assert.strictEqual(await getHandoff(a.id), null);
    assert.notStrictEqual(await getHandoff(b.id), null);
    await finishHandoff(b.id, 'aborted');
    await b.done;
  });

  it('relays frames and inputs through the DB (non-owner path)', async () => {
    const { page, events } = stubPage();
    const s = await openHandoff(TEST_APPS[3], page, 'captcha', 60_000, 60);
    // The initial frame is published with the row — available BEFORE any pump tick
    assert.deepStrictEqual(await handoffFrame(s.id), Buffer.from('jpeg-bytes'));
    // Enqueue from the "other replica" side — these calls only touch the DB
    assert.strictEqual(await handoffInput(s.id, { type: 'click', x: 100, y: 200 }), true);
    assert.strictEqual(await handoffInput(s.id, { type: 'type', text: 'hello' }), true);
    assert.strictEqual(await handoffInput(s.id, { type: 'press', key: 'Enter' }), true);
    assert.strictEqual(await handoffInput(s.id, { type: 'press', key: 'F12' }), false); // not allowlisted
    assert.strictEqual(await handoffInput(s.id, { type: 'scroll', deltaY: 99999 }), true); // clamped

    // Wait for the owner's pump to drain the queue and publish a frame
    for (let i = 0; i < 50 && (events.length < 4 || !(await handoffFrame(s.id))); i++) await sleep(100);
    assert.deepStrictEqual(events, [
      { click: [100, 200] }, { type: 'hello' }, { press: 'Enter' }, { wheel: [0, 3000] },
    ]);
    assert.deepStrictEqual(await handoffFrame(s.id), Buffer.from('jpeg-bytes'));

    await finishHandoff(s.id, 'aborted');
    await s.done;
    assert.strictEqual(await handoffInput(s.id, { type: 'click', x: 1, y: 1 }), false); // gone
    assert.strictEqual(await handoffFrame(s.id), null);
  });
});
