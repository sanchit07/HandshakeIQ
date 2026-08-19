/**
 * Hardened Playwright browser layer for the ATS submitter.
 *
 *  - Nix chromium, --no-sandbox, fresh incognito context per run.
 *  - Main-frame navigation allowlist: only within the apply route's site.
 *  - Humanized typing/delays (see core.ts parameters).
 *  - Generic form observation + fill that per-ATS adapters build on.
 *
 * IMPORTANT — writing code for page.evaluate()/addInitScript() in this file:
 * this app runs under tsx (dev AND prod — see package.json), whose esbuild
 * transform injects a call to an outer-scope `__name(fn, "name")` helper
 * wherever it can attach a name to a function — a `const x = () => {}`, a
 * nested `function x() {}` declaration, or an object-literal method/getter —
 * even when nested inside another function. Playwright serializes an
 * evaluate/addInitScript callback via .toString(), which captures that
 * `__name(...)` call WITHOUT the outer scope that defines it, so it throws
 * `ReferenceError: __name is not defined` INSIDE THE PAGE the first time such
 * a nested named function runs — silently aborting the rest of the callback,
 * not just that one statement. Only fully anonymous, unnamed functions escape
 * this (an inline `.map(x => ...)`, or the top-level callback passed directly
 * to evaluate/addInitScript itself). Inside any evaluate/addInitScript body:
 * never write `const helper = () => {}` or a nested `function helper() {}` —
 * inline the logic instead (this exact bug silently broke the stealth init
 * script below; caught only by testing it against a real page, not by
 * reasoning about the code — always verify anything new the same way).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright-core';
import {
  type ObservedField, isNavigationAllowed, jitterMs, TYPE_DELAY, FIELD_PAUSE,
  CAPTCHA_SELECTORS, BOT_BLOCK_HTTP_STATUSES, looksLikeBotBlockText,
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

// A small pool of realistic desktop Chrome fingerprints, one picked per
// session rather than a single fixed UA/viewport used on every run — an
// unvarying fingerprint across every automated visit is itself a signal
// enterprise bot-detection vendors (Akamai/PerimeterX/DataDome/Cloudflare)
// key on, independent of anything else about the request.
export const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
];
export const VIEWPORT_POOL = [
  { width: 1366, height: 900 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

export function pickOne<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Patches the small set of well-known, low-risk automation tells that a
 * stock Playwright/headless-Chromium page exposes by default:
 *  - navigator.webdriver === true (the single most-checked automation flag)
 *  - an empty navigator.plugins/mimeTypes list (real browsers always have some)
 *  - navigator.languages not matching the context locale
 *  - window.chrome missing entirely (present in every real Chrome browser)
 *  - the permissions API leaking a headless-specific quirk for "notifications"
 * This is deliberately narrow — not a full stealth-plugin reimplementation —
 * covering the checks cheap enterprise bot-detection heuristics actually run,
 * without pretending to defeat a determined fingerprinting stack.
 *
 * Passed to addInitScript as a STRING, not a function reference: this app
 * runs under tsx (dev AND production — see package.json), whose esbuild
 * transform rewrites arrow-function object properties to call an injected
 * `__name(...)` helper that only exists in the outer module scope. Serializing
 * a function via .toString() for the page loses that scope, so the helper
 * call throws inside the page and silently aborts the whole init script,
 * leaving navigator.webdriver unpatched. A plain string has no such artifact.
 */
const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
Object.defineProperty(navigator, 'languages', { get: function () { return ['en-US', 'en']; } });
Object.defineProperty(navigator, 'plugins', { get: function () { return [1, 2, 3, 4, 5]; } });
if (!window.chrome) window.chrome = { runtime: {} };
(function () {
  var perms = window.navigator.permissions;
  if (perms && perms.query) {
    var originalQuery = perms.query.bind(perms);
    perms.query = function (params) {
      return (params && params.name === 'notifications')
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);
    };
  }
})();
`;

export async function launchHardenedSession(applyUrl: string): Promise<HardenedSession> {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: pickOne(UA_POOL),
    viewport: pickOne(VIEWPORT_POOL),
    locale: 'en-US',
    acceptDownloads: false,
  });
  await context.addInitScript(STEALTH_INIT_SCRIPT);
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

/**
 * Detects an enterprise anti-bot vendor block (Akamai/PerimeterX/DataDome/
 * Cloudflare) that renders no interactive CAPTCHA widget — a plain
 * "Access Denied" page or a 401/403/429 main-document response. Distinct
 * from detectCaptcha(): there is nothing here for a human to solve via
 * hand-off, so callers should record the block and degrade straight to
 * needs_user with an accurate reason instead of offering a hand-off.
 * `mainResponseStatus` is the main-frame navigation response status when the
 * caller has one to hand (a fresh page.goto); omit it for a mid-flow check
 * (e.g. mid-wizard) where only the page's current text is available.
 */
export async function detectBotBlock(page: Page, mainResponseStatus?: number | null): Promise<string | null> {
  if (typeof mainResponseStatus === 'number' && BOT_BLOCK_HTTP_STATUSES.has(mainResponseStatus)) {
    return `the page returned HTTP ${mainResponseStatus}, consistent with an automated-traffic block`;
  }
  const text = await visiblePageText(page);
  if (looksLikeBotBlockText(text)) {
    return 'the page text matches a known bot-detection block pattern (e.g. Akamai/PerimeterX/DataDome/Cloudflare)';
  }
  return null;
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
      if (el.tagName === 'SELECT' && (el as HTMLSelectElement).multiple) kind = 'multiselect';

      let options: string[] | undefined;
      if (el.tagName === 'SELECT') {
        options = Array.from((el as HTMLSelectElement).options).map((o) => o.label || o.text).filter((t) => t.trim());
      }

      // JS-driven combobox/typeahead: a plain text input wired to an ARIA
      // listbox (role=combobox / aria-autocomplete, aria-controls/aria-owns
      // pointing at the option list). Without this it's indistinguishable
      // from a plain text field and gets typed into blind, with no attempt
      // to open/select from the resulting option list.
      let listboxSelector: string | undefined;
      if (kind === 'text' && (input.getAttribute('role') === 'combobox' || input.getAttribute('aria-autocomplete'))) {
        kind = 'combobox';
        const listboxId = (input.getAttribute('aria-controls') || input.getAttribute('aria-owns') || '').split(/\s+/)[0];
        if (listboxId) listboxSelector = `#${CSS.escape(listboxId)}`;
      }

      // Unique selector: prefer id, then name, then a stable per-element
      // fallback marker. The marker is stable ACROSS repeated observeFields
      // calls on the same live page (reused if already set, not reassigned
      // from a fresh idx each time) — fillFieldsInScope re-scans mid-fill to
      // catch conditionally-revealed fields, and an unstable idx-based
      // selector would make an already-filled field look "new" (or a
      // genuinely new field collide with an old selector) if the visible
      // field count/order shifted between scans.
      let selector = '';
      if (id) selector = `#${CSS.escape(id)}`;
      else {
        const name = input.getAttribute('name');
        if (name) selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        else {
          let marker = input.getAttribute('data-ats-idx');
          if (marker === null) { marker = String(idx); input.setAttribute('data-ats-idx', marker); }
          selector = `[data-ats-idx="${marker}"]`;
        }
      }
      idx++;

      out.push({ label, name: input.getAttribute('name') || id || '', kind, required, options, selector, listboxSelector });
    }

    // JS-driven drop-zone upload widgets (react-dropzone/Dropzone.js/
    // FilePond/Uppy, etc.) render no native <input type=file> at all in some
    // configurations — without this they are invisible to observeFields
    // entirely (setInputFiles has nothing to target). Matched narrowly on the
    // "dropzone" naming convention these libraries actually use, so this
    // never fires on an unrelated draggable element.
    const dropzoneCandidates = root.querySelectorAll('[class*="dropzone" i], [class*="drop-zone" i], [data-dropzone]');
    for (const dz of Array.from(dropzoneCandidates)) {
      if (dz.querySelector('input[type="file"]')) continue; // has a real input — already handled above
      const dzStyle = window.getComputedStyle(dz as HTMLElement);
      if (dzStyle.display === 'none' || dzStyle.visibility === 'hidden') continue;
      const dzText = (dz as HTMLElement).innerText || '';
      if (!/resume|\bcv\b|curriculum|upload|attach/i.test(dzText)) continue;
      let dzSelector = '';
      if ((dz as HTMLElement).id) dzSelector = `#${CSS.escape((dz as HTMLElement).id)}`;
      else {
        let marker = dz.getAttribute('data-ats-idx');
        if (marker === null) { marker = String(idx); dz.setAttribute('data-ats-idx', marker); }
        dzSelector = `[data-ats-idx="${marker}"]`;
      }
      idx++;
      out.push({
        label: dzText.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Resume upload',
        name: '', kind: 'file', required: true, selector: dzSelector, isDropzone: true,
      });
      break; // one resume drop-zone per form is the realistic case
    }

    return out;
  }, formScope);
}

/**
 * Simulates dropping a file onto a JS-driven drop-zone element (no native
 * `<input type=file>` to target with setInputFiles). Constructs a real
 * File/DataTransfer inside the page and dispatches dragenter/dragover/drop —
 * the same event sequence a real browser fires for an actual OS-level drop.
 */
export async function dropFileOnElement(page: Page, selector: string, fileBuffer: Buffer, fileName: string, mimeType: string): Promise<boolean> {
  const base64 = fileBuffer.toString('base64');
  return page.evaluate(
    ([sel, b64, name, type]) => {
      const target = document.querySelector(sel);
      if (!target) return false;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      target.dispatchEvent(new DragEvent('dragenter', opts));
      target.dispatchEvent(new DragEvent('dragover', opts));
      target.dispatchEvent(new DragEvent('drop', opts));
      return true;
    },
    [selector, base64, fileName, mimeType] as [string, string, string, string],
  );
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
