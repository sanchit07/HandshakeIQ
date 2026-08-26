/**
 * Live hand-off system: when a CAPTCHA / "verify you are human" puzzle blocks
 * an automated run (any adapter, any phase), the browser session is kept
 * alive and exposed to the user through a remote view — frame polling plus
 * click/type forwarding — so they can solve the puzzle in their own browser,
 * after which automation resumes. No third-party CAPTCHA solvers, ever.
 *
 * Replica safety: all shared state (session metadata, latest frame, pending
 * input events, resolution) lives in Postgres. The replica that owns the
 * Playwright page runs a pump loop that writes frames out and drains inputs
 * in, so the HTTP endpoints (list/frame/input/resolve) work from ANY replica
 * — they only touch the database.
 *
 * Timeout policy: if the user doesn't respond within HANDOFF_TIMEOUT_MS the
 * run is parked as needs_user with a saved screenshot and the session closes.
 */
import crypto from 'crypto';
import type { Page } from 'playwright-core';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../db.js';
import { handoffSessions, applications, jobMatches } from '../../../shared/schema.js';
import { getProfile } from '../applyService.js';
import { sendApplicationEmail } from '../emailSender.js';

export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to respond
const PUMP_INTERVAL_MS = 1200;

export type HandoffResolution = 'solved' | 'aborted' | 'timeout';

export interface HandoffSession {
  id: string;
  applicationId: string;
  reason: string;
  expiresAt: number;
  done: Promise<HandoffResolution>;
}

export type HandoffInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; deltaY: number };

const ALLOWED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/** Pure: validate + clamp a raw input event. Returns null when rejected. */
export function normalizeHandoffInput(input: any): HandoffInput | null {
  if (!input || typeof input !== 'object') return null;
  if (input.type === 'click') {
    const x = Number(input.x), y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { type: 'click', x: Math.max(0, Math.min(5000, Math.round(x))), y: Math.max(0, Math.min(5000, Math.round(y))) };
  }
  if (input.type === 'type') {
    const text = String(input.text ?? '');
    if (!text) return null;
    return { type: 'type', text: text.slice(0, 200) };
  }
  if (input.type === 'press') {
    const key = String(input.key ?? '');
    if (!ALLOWED_KEYS.has(key)) return null;
    return { type: 'press', key };
  }
  if (input.type === 'scroll') {
    const deltaY = Number(input.deltaY);
    if (!Number.isFinite(deltaY)) return null;
    return { type: 'scroll', deltaY: Math.max(-3000, Math.min(3000, Math.round(deltaY))) };
  }
  return null;
}

/** Owner-side: forward one already-normalized input event into the live page. */
export async function applyInputToPage(page: Page, input: HandoffInput): Promise<void> {
  if (input.type === 'click') await page.mouse.click(input.x, input.y);
  else if (input.type === 'type') await page.keyboard.type(input.text, { delay: 40 });
  else if (input.type === 'press') await page.keyboard.press(input.key);
  else if (input.type === 'scroll') await page.mouse.wheel(0, input.deltaY);
}

// Owner-replica local registry: only the pump machinery, never queried by the
// HTTP endpoints (which must work on non-owner replicas).
const localSessions = new Map<string, { resolve: (r: HandoffResolution) => void; pump: ReturnType<typeof setInterval> }>();

async function markStatus(id: string, resolution: HandoffResolution): Promise<boolean> {
  const res = await db.update(handoffSessions)
    .set({ status: resolution })
    .where(and(eq(handoffSessions.id, id), eq(handoffSessions.status, 'open')))
    .returning({ id: handoffSessions.id });
  return res.length > 0;
}

function settleLocal(id: string, resolution: HandoffResolution): void {
  const local = localSessions.get(id);
  if (!local) return;
  localSessions.delete(id);
  clearInterval(local.pump);
  local.resolve(resolution);
  console.log(`[HANDOFF] ${id.slice(0, 8)} finished: ${resolution}`);
}

/**
 * An unattended run (cron, or anyone not currently watching the app) has no
 * way to know a hand-off opened at all until it's already timed out — the
 * only prior signal was the in-app modal itself. Best-effort email through
 * the same Gmail connector already used for application emails; NEVER
 * allowed to affect the hand-off itself (Gmail may simply not be connected,
 * which is a normal, expected state here, not a failure to surface).
 * Fire-and-forget from the caller — never awaited, so a slow/failed send can
 * never delay publishing the hand-off's first frame.
 */
async function notifyHandoffOpened(applicationId: string, reason: string): Promise<void> {
  try {
    const profile = await getProfile();
    if (!profile?.email) return; // nothing configured to notify
    const [row] = await db.select({ title: jobMatches.title, company: jobMatches.company })
      .from(applications).innerJoin(jobMatches, eq(applications.jobMatchId, jobMatches.id))
      .where(eq(applications.id, applicationId));
    const jobLabel = row ? `${row.title} at ${row.company}` : 'an application';
    const minutes = Math.round(HANDOFF_TIMEOUT_MS / 60_000);
    await sendApplicationEmail({
      to: profile.email,
      subject: `Action needed: verification required — ${jobLabel}`,
      body: `HandshakeIQ hit a human-verification step (CAPTCHA or similar) while applying to ${jobLabel} and needs you to solve it.\n\n${reason}\n\nOpen HandshakeIQ and go to Job Opportunities to take over. You have about ${minutes} minutes before this hand-off expires and the application pauses for manual review instead.`,
    });
    console.log(`[HANDOFF] Notified ${profile.email} of a live hand-off for application ${applicationId}`);
  } catch (e) {
    console.warn(`[HANDOFF] Could not send hand-off notification (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Register a live hand-off for a blocked page and wait for the user (or the
 * timeout). Runs on the replica that owns the browser session; the returned
 * `done` promise settles when the user resolves it (from any replica) or the
 * timeout hits.
 */
export async function openHandoff(applicationId: string, page: Page, reason: string, timeoutMs: number = HANDOFF_TIMEOUT_MS, pumpIntervalMs: number = PUMP_INTERVAL_MS): Promise<HandoffSession> {
  // One live hand-off per application: abort any stale one (locally and in DB)
  const stale = await db.update(handoffSessions)
    .set({ status: 'aborted' })
    .where(and(eq(handoffSessions.applicationId, applicationId), eq(handoffSessions.status, 'open')))
    .returning({ id: handoffSessions.id });
  for (const s of stale) settleLocal(s.id, 'aborted');

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + timeoutMs;
  // Publish an initial frame WITH the row so a viewer opening the modal
  // before the first pump tick never sees a missing-frame 404.
  let initialFrame: string | null = null;
  try {
    initialFrame = (await page.screenshot({ type: 'jpeg', quality: 60, timeout: 8000 })).toString('base64');
  } catch { /* pump will publish one shortly */ }
  await db.insert(handoffSessions).values({
    id, applicationId, reason: reason.slice(0, 1000), status: 'open', expiresAt: new Date(expiresAt),
    frameB64: initialFrame, frameAt: initialFrame ? new Date() : null,
  });
  void notifyHandoffOpened(applicationId, reason);

  let resolveFn!: (r: HandoffResolution) => void;
  const done = new Promise<HandoffResolution>((r) => { resolveFn = r; });

  let pumping = false;
  const pump = setInterval(async () => {
    if (pumping) return; // never overlap pump ticks
    pumping = true;
    try {
      // 1. Read authoritative state (a resolve may have landed on any replica)
      const [row] = await db.select({ status: handoffSessions.status })
        .from(handoffSessions).where(eq(handoffSessions.id, id));
      if (!row || row.status !== 'open') {
        settleLocal(id, (row?.status as HandoffResolution) || 'aborted');
        return;
      }
      if (Date.now() > expiresAt) {
        await markStatus(id, 'timeout');
        settleLocal(id, 'timeout');
        return;
      }
      // 2. Drain pending inputs atomically (old queue out, empty queue in)
      const drained = await db.execute(sql`
        UPDATE handoff_sessions h SET input_queue = '[]'::jsonb
        FROM (SELECT input_queue AS old_queue FROM handoff_sessions WHERE id = ${id} FOR UPDATE) o
        WHERE h.id = ${id} AND h.status = 'open'
        RETURNING o.old_queue
      `);
      const events: HandoffInput[] = ((drained as any)[0])?.old_queue ?? [];
      for (const ev of events) {
        try { await applyInputToPage(page, ev); } catch { /* page may be mid-navigation */ }
      }
      // 3. Publish a fresh frame
      try {
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 8000 });
        await db.update(handoffSessions)
          .set({ frameB64: jpeg.toString('base64'), frameAt: new Date() })
          .where(eq(handoffSessions.id, id));
      } catch { /* transient screenshot failure: keep last frame */ }
    } catch (e) {
      console.error(`[HANDOFF] pump error for ${id.slice(0, 8)}:`, e);
    } finally {
      pumping = false;
    }
  }, pumpIntervalMs);

  localSessions.set(id, { resolve: resolveFn, pump });
  console.log(`[HANDOFF] Opened live hand-off ${id.slice(0, 8)} for application ${applicationId.slice(0, 8)}: ${reason.slice(0, 120)}`);
  return { id, applicationId, reason, expiresAt, done };
}

/**
 * Resolve a hand-off (works from ANY replica — writes the DB status; the
 * owner's pump picks it up within one tick).
 */
export async function finishHandoff(id: string, resolution: HandoffResolution): Promise<boolean> {
  const changed = await markStatus(id, resolution);
  if (changed && localSessions.has(id)) settleLocal(id, resolution); // same-replica fast path
  return changed;
}

export async function getHandoff(id: string): Promise<{ id: string; applicationId: string; reason: string; expiresAt: number } | null> {
  const [row] = await db.select().from(handoffSessions)
    .where(and(eq(handoffSessions.id, id), eq(handoffSessions.status, 'open')));
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return { id: row.id, applicationId: row.applicationId, reason: row.reason, expiresAt: row.expiresAt.getTime() };
}

export async function listHandoffs(): Promise<Array<{ id: string; applicationId: string; reason: string; expiresAt: number }>> {
  const rows = await db.select().from(handoffSessions)
    .where(and(eq(handoffSessions.status, 'open'), gt(handoffSessions.expiresAt, new Date())));
  return rows.map((r) => ({ id: r.id, applicationId: r.applicationId, reason: r.reason, expiresAt: r.expiresAt.getTime() }));
}

/** Latest published JPEG frame (any replica — reads the DB). */
export async function handoffFrame(id: string): Promise<Buffer | null> {
  const [row] = await db.select({ frameB64: handoffSessions.frameB64, status: handoffSessions.status })
    .from(handoffSessions).where(eq(handoffSessions.id, id));
  if (!row || row.status !== 'open' || !row.frameB64) return null;
  return Buffer.from(row.frameB64, 'base64');
}

/** Enqueue one user input event (any replica — appends to the DB queue). */
export async function handoffInput(id: string, input: any): Promise<boolean> {
  const normalized = normalizeHandoffInput(input);
  if (!normalized) return false;
  const res = await db.execute(sql`
    UPDATE handoff_sessions
    SET input_queue = input_queue || ${JSON.stringify([normalized])}::jsonb
    WHERE id = ${id} AND status = 'open' AND expires_at > now()
    RETURNING id
  `);
  return (res as any).length > 0;
}
