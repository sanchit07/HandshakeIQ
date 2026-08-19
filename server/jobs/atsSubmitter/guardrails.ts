/**
 * Ban-risk guard-rails, persisted per domain:
 *  - Cooldown between automated browser sessions to the same domain (no
 *    rapid-fire runs against one company; the global single-flight queue
 *    already prevents parallel sessions).
 *  - Block counting: CAPTCHA walls, bot-block responses, and login failures
 *    increment a counter with an escalating cooldown.
 *  - Automatic downgrade: after DOWNGRADE_AFTER_BLOCKS blocks, the domain is
 *    permanently switched to assisted mode (user can reset from the vault UI).
 */
import { db } from '../../db';
import { domainControls } from '../../../shared/schema.js';
import { eq } from 'drizzle-orm';
import { guardrailKeyForUrl } from './core.js';

export const DOMAIN_RUN_COOLDOWN_MS = 3 * 60 * 1000;       // min gap between runs to one domain
export const BLOCK_COOLDOWN_BASE_MS = 30 * 60 * 1000;      // first block: 30 min
export const DOWNGRADE_AFTER_BLOCKS = 3;                   // 3 blocks → assisted mode only

/** Pure: escalating cooldown for the Nth block (30m, 2h, 8h, capped at 24h). */
export function blockCooldownMs(blockCount: number): number {
  const ms = BLOCK_COOLDOWN_BASE_MS * Math.pow(4, Math.max(0, blockCount - 1));
  return Math.min(ms, 24 * 60 * 60 * 1000);
}

/** Pure decision: may an automated session run against this domain right now? */
export function evaluateDomainControl(
  ctl: { downgraded: boolean; cooldownUntil: Date | null; lastRunAt: Date | null } | null,
  now: Date = new Date(),
  opts: { ignoreRunGap?: boolean } = {},
): { allowed: boolean; reason?: string } {
  if (!ctl) return { allowed: true };
  if (ctl.downgraded) {
    return { allowed: false, reason: 'This company\'s site has repeatedly blocked automation, so it has been switched to assisted mode: use the prepared packet and apply manually.' };
  }
  if (ctl.cooldownUntil && ctl.cooldownUntil.getTime() > now.getTime()) {
    const mins = Math.ceil((ctl.cooldownUntil.getTime() - now.getTime()) / 60000);
    return { allowed: false, reason: `This company's site recently blocked automation — cooling down for ~${mins} more minute(s) to protect your account. Retry later or apply manually via the apply link.` };
  }
  if (!opts.ignoreRunGap && ctl.lastRunAt && now.getTime() - ctl.lastRunAt.getTime() < DOMAIN_RUN_COOLDOWN_MS) {
    const mins = Math.ceil((DOMAIN_RUN_COOLDOWN_MS - (now.getTime() - ctl.lastRunAt.getTime())) / 60000);
    return { allowed: false, reason: `An automated session ran against this company's site moments ago — waiting ~${mins} minute(s) between sessions to avoid bot detection. Retry shortly.` };
  }
  return { allowed: true };
}

export function domainForUrl(url: string): string {
  try { return guardrailKeyForUrl(url); } catch { return 'unknown'; }
}

export async function checkDomainAllowed(applyUrl: string, opts: { ignoreRunGap?: boolean } = {}): Promise<{ allowed: boolean; reason?: string }> {
  const domain = domainForUrl(applyUrl);
  const [ctl] = await db.select().from(domainControls).where(eq(domainControls.domain, domain));
  return evaluateDomainControl(ctl ?? null, new Date(), opts);
}

export async function recordDomainRun(applyUrl: string): Promise<void> {
  const domain = domainForUrl(applyUrl);
  await db.insert(domainControls).values({ domain, lastRunAt: new Date(), updatedAt: new Date() })
    .onConflictDoUpdate({ target: domainControls.domain, set: { lastRunAt: new Date(), updatedAt: new Date() } });
}

/**
 * Record a block event (CAPTCHA wall, bot-block page, login failure).
 * Returns true when the domain was just downgraded to assisted mode.
 */
export async function recordDomainBlock(applyUrl: string, kind: string): Promise<boolean> {
  const domain = domainForUrl(applyUrl);
  const [existing] = await db.select().from(domainControls).where(eq(domainControls.domain, domain));
  const blockCount = (existing?.blockCount ?? 0) + 1;
  const downgraded = blockCount >= DOWNGRADE_AFTER_BLOCKS;
  const cooldownUntil = new Date(Date.now() + blockCooldownMs(blockCount));
  await db.insert(domainControls)
    .values({ domain, blockCount, lastBlockAt: new Date(), cooldownUntil, downgraded, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: domainControls.domain,
      set: { blockCount, lastBlockAt: new Date(), cooldownUntil, downgraded, updatedAt: new Date() },
    });
  console.log(`[GUARDRAIL] Block #${blockCount} (${kind}) recorded for ${domain}${downgraded ? ' — DOWNGRADED to assisted mode' : ''}`);
  return downgraded;
}

/** User-facing reset (vault UI): clear blocks/downgrade for a domain. */
export async function resetDomainControl(domain: string): Promise<void> {
  await db.update(domainControls)
    .set({ blockCount: 0, cooldownUntil: null, downgraded: false, updatedAt: new Date() })
    .where(eq(domainControls.domain, domain));
}

export async function listDomainControls() {
  return db.select().from(domainControls);
}
