/**
 * Hardened Playwright browser layer for the ATS submitter.
 *
 *  - Nix chromium, --no-sandbox, fresh incognito context per run.
 *  - Main-frame navigation allowlist: only within the apply route's site.
 *  - Humanized typing/delays (see core.ts parameters).
 *  - Generic form observation + fill that per-ATS adapters build on.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright-core';
import {
  type ObservedField, isNavigationAllowed, jitterMs, TYPE_DELAY, FIELD_PAUSE,
  CAPTCHA_SELECTORS,
} from './core.js';

// ── Launcher ─────────────────────────────────────────────────────────────────

let cachedExecutable: string | null = null;

export function findChromium(): string {
  if (cachedExecutable && fs.existsSync(cachedExecutable)) return cachedExecutable;
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...(() => { try { return [execSync('which chromium 2>/dev/null').toString().trim()]; } catch { return []; } })(),
    ...(() => { try { return [execSync('which chromium-browser 2>/dev/null').toString().trim()]; } catch { return []; } })(),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  if (candidates.length === 0) {
    throw new Error('Chromium executable not found — install the chromium system dependency (set CHROMIUM_PATH to override).');
  }
  cachedExecutable = candidates[0];
  return cachedExecutable;
}

export interface HardenedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export async function launchHardenedSession(applyUrl: string): Promise<HardenedSession> {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    acceptDownloads: false,
  });
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(45_000);

  // Main-frame navigation allowlist: any attempt to leave the apply route's
  // site in the top frame is aborted (subresources — CDNs, fonts — may load
  // from anywhere over https; http subresources are blocked).
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) {
      if (!isNavigationAllowed(applyUrl, url)) {
        console.log(`[ATS BROWSER] Blocked main-frame navigation outside apply site: ${url.slice(0, 200)}`);
        return route.abort('blockedbyclient');
      }
    } else if (url.startsWith('http:')) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const page = await context.newPage();
  const close = async () => { try { await context.close(); } catch {} try { await browser.close(); } catch {} };
  return { browser, context, page, close };
}

// ── Humanization ─────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const humanPause = () => sleep(jitterMs(FIELD_PAUSE.min, FIELD_PAUSE.max));

export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click();
  await locator.fill(''); // clear any prefill
  await locator.pressSequentially(text, { delay: jitterMs(TYPE_DELAY.min, TYPE_DELAY.max) });
}

// ── Detection ────────────────────────────────────────────────────────────────

export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}

export async function visiblePageText(page: Page): Promise<string> {
  try {
    return (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 20000);
  } catch { return ''; }
}

// ── Form observation ─────────────────────────────────────────────────────────

export interface DomField extends ObservedField {
  /** Playwright-usable unique selector */
  selector: string;
}

/**
 * Observe fillable fields inside the given form scope (CSS selector) — labels,
 * kinds, required flags, select options. Runs in the page; returns plain data.
 */
/**
 * Resolve the adapter's formScope (a comma list of candidate selectors) to ONE
 * concrete application form: among all matches, pick the element containing
 * the most fillable controls (a newsletter/search/login form earlier in the
 * DOM must never win over the real application form). Returns a unique
 * selector so observation, filling, and the submit click all bind to the SAME
 * element.
 */
export async function resolveFormScope(page: Page, formScope: string): Promise<string | null> {
  return page.evaluate((scope) => {
    const candidates = Array.from(document.querySelectorAll(scope));
    let best: Element | null = null;
    let bestScore = 0;
    for (const el of candidates) {
      // Skip candidates nested inside an already-considered candidate
      const controls = el.querySelectorAll('input, textarea, select');
      let score = 0;
      for (const c of Array.from(controls)) {
        const t = (c.getAttribute('type') || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(t)) continue;
        score++;
        // Application forms have file/textarea fields; weight them
        if (t === 'file' || c.tagName === 'TEXTAREA') score += 3;
        if (t === 'email' || t === 'tel') score += 1;
      }
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (!best || bestScore === 0) return null;
    if (best.id) return `#${CSS.escape(best.id)}`;
    // Stable unique path selector
    const path: string[] = [];
    let cur: Element | null = best;
    while (cur && cur !== document.body) {
      const parent: Element | null = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      path.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      if (parent.id) { path.unshift(`#${CSS.escape(parent.id)}`); break; }
      cur = parent;
    }
    return path.length ? path.join(' > ') : null;
  }, formScope);
}

export async function observeFields(page: Page, formScope: string): Promise<DomField[]> {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope) ?? document.body;
    const out: any[] = [];
    const seen = new Set<Element>();
    const els = root.querySelectorAll('input, textarea, select');
    let idx = 0;
    for (const el of Array.from(els)) {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === 'none' || style.visibility === 'hidden') {
        if (type !== 'file') continue; // file inputs are often visually hidden but functional
      }
      if (seen.has(el)) continue;
      seen.add(el);

      // Label resolution: <label for>, wrapping label, aria-label/labelledby, placeholder
      let label = '';
      const id = input.id;
      // Radio buttons: the GROUP label (fieldset legend) is what matters for
      // classification — the wrapping label is just the option text.
      if (type === 'radio') {
        const fsr = el.closest('fieldset');
        const legendR = fsr?.querySelector('legend');
        if (legendR) label = (legendR as HTMLElement).innerText || '';
      }
      if (id) {
        const l = root.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l) label = (l as HTMLElement).innerText || l.textContent || '';
      }
      if (!label) {
        const wrap = el.closest('label');
        if (wrap) label = (wrap as HTMLElement).innerText || '';
      }
      if (!label) label = input.getAttribute('aria-label') || '';
      if (!label) {
        const lb = input.getAttribute('aria-labelledby');
        if (lb) label = lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ');
      }
      if (!label) label = input.getAttribute('placeholder') || '';
      // Fieldset legend fallback (radio groups)
      if (!label) {
        const fs = el.closest('fieldset');
        const legend = fs?.querySelector('legend');
        if (legend) label = (legend as HTMLElement).innerText || '';
      }
      label = label.replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim().slice(0, 300);

      const required = input.required || input.getAttribute('aria-required') === 'true'
        || /\*\s*$/.test(label) || !!el.closest('[class*="required"]');

      let kind = type;
      if (!['text', 'textarea', 'email', 'tel', 'url', 'select', 'radio', 'checkbox', 'file'].includes(kind)) kind = 'text';

      let options: string[] | undefined;
      if (el.tagName === 'SELECT') {
        options = Array.from((el as HTMLSelectElement).options).map((o) => o.label || o.text).filter((t) => t.trim());
      }

      // Unique selector: prefer id, then name+index
      let selector = '';
      if (id) selector = `#${CSS.escape(id)}`;
      else {
        const name = input.getAttribute('name');
        if (name) selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        else { input.setAttribute('data-ats-idx', String(idx)); selector = `[data-ats-idx="${idx}"]`; }
      }
      idx++;

      out.push({ label, name: input.getAttribute('name') || id || '', kind, required, options, selector });
    }
    return out;
  }, formScope);
}

/** Pick the select/radio option whose label best matches the desired value. */
export function bestOption(options: string[], value: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nv = norm(value);
  const yesNo: Record<string, RegExp> = { yes: /^yes\b/i, no: /^no\b/i };
  for (const o of options) {
    if (norm(o) === nv) return o;
  }
  if (nv === 'yes' || nv === 'no') {
    const m = options.find((o) => yesNo[nv].test(o.trim()));
    if (m) return m;
  }
  for (const o of options) {
    const no = norm(o);
    if (no && (no.includes(nv) || nv.includes(no))) return o;
  }
  return null;
}
