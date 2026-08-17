/**
 * Per-company ATS credential vault.
 *
 * Invariants:
 *  - Every automated account creation writes here BEFORE the signup form is
 *    submitted — the user can always log in themselves (the AIApply lockout
 *    failure mode from the research doc is designed out).
 *  - Passwords are AES-256-GCM encrypted at rest with a key derived from
 *    SESSION_SECRET (scrypt). Plaintext is only produced on explicit reveal
 *    or when the automation logs in.
 */
import crypto from 'crypto';
import { db } from '../../db';
import { atsCredentials, type AtsCredential } from '../../../shared/schema.js';
import { eq, sql } from 'drizzle-orm';

// ── Crypto (pure, testable) ──────────────────────────────────────────────────

let cachedKey: Buffer | null = null;
function vaultKey(secret?: string): Buffer {
  const s = secret ?? process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not configured — cannot encrypt vault credentials.');
  if (secret) return crypto.scryptSync(secret, 'handshakeiq-ats-vault', 32);
  if (!cachedKey) cachedKey = crypto.scryptSync(s, 'handshakeiq-ats-vault', 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string, secret?: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(encoded: string, secret?: string): string {
  const [ivB64, tagB64, ctB64] = encoded.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Strong generated password satisfying common ATS complexity rules:
 * ≥16 chars, upper+lower+digit+symbol, no ambiguous characters.
 */
export function generateStrongPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^*-_+=';
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 18) chars.push(pick(all));
  // Fisher–Yates with crypto randomness
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface VaultEntryMeta {
  id: string; company: string; atsType: string; portalDomain: string; portalUrl: string;
  email: string; status: string; notes: string | null; createdAt: Date | null; lastUsedAt: Date | null;
}

function toMeta(row: AtsCredential): VaultEntryMeta {
  const { passwordEnc: _enc, ...meta } = row;
  return meta;
}

export async function listCredentials(): Promise<VaultEntryMeta[]> {
  const rows = await db.select().from(atsCredentials).orderBy(sql`${atsCredentials.createdAt} DESC`);
  return rows.map(toMeta);
}

/** Explicit reveal (Profile page "show password" action). */
export async function revealCredential(id: string): Promise<{ password: string } | null> {
  const [row] = await db.select().from(atsCredentials).where(eq(atsCredentials.id, id));
  if (!row) return null;
  return { password: decryptSecret(row.passwordEnc) };
}

export async function getCredentialByDomain(portalDomain: string): Promise<(VaultEntryMeta & { password: string }) | null> {
  const [row] = await db.select().from(atsCredentials).where(eq(atsCredentials.portalDomain, portalDomain));
  if (!row) return null;
  return { ...toMeta(row), password: decryptSecret(row.passwordEnc) };
}

/**
 * Record an account BEFORE the signup form is submitted. Upsert on domain:
 * a retried signup for the same portal reuses/overwrites the stored password.
 */
export async function saveCredential(opts: {
  company: string; atsType: string; portalDomain: string; portalUrl: string;
  email: string; password: string; notes?: string;
}): Promise<VaultEntryMeta> {
  const passwordEnc = encryptSecret(opts.password);
  const [row] = await db.insert(atsCredentials).values({
    company: opts.company, atsType: opts.atsType, portalDomain: opts.portalDomain,
    portalUrl: opts.portalUrl, email: opts.email, passwordEnc, notes: opts.notes ?? null,
  }).onConflictDoUpdate({
    target: atsCredentials.portalDomain,
    set: { passwordEnc, email: opts.email, portalUrl: opts.portalUrl, notes: opts.notes ?? null },
  }).returning();
  console.log(`[VAULT] Credential saved for ${opts.portalDomain} (${opts.company})`);
  return toMeta(row);
}

export async function markCredentialStatus(portalDomain: string, status: 'created' | 'verified' | 'login_failed'): Promise<void> {
  await db.update(atsCredentials)
    .set({ status, lastUsedAt: new Date() })
    .where(eq(atsCredentials.portalDomain, portalDomain));
}

export async function deleteCredential(id: string): Promise<boolean> {
  const rows = await db.delete(atsCredentials).where(eq(atsCredentials.id, id)).returning({ id: atsCredentials.id });
  return rows.length > 0;
}
