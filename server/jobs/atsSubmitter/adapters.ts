/**
 * Per-ATS adapters: where the form lives, how to reach it, how to submit.
 * The heavy lifting (field observation/classification/filling) is shared —
 * adapters only supply selectors and an optional "open the form" step.
 */
import type { Page } from 'playwright-core';
import { sleep } from './browser.js';
import { jitterMs } from './core.js';

export interface AtsAdapter {
  ats: string;
  /** CSS scope containing the application form */
  formScope: string;
  /** Submit button selector (within the page) */
  submitSelector: string;
  /** Optional step to reach the form (e.g. click an Apply tab/button) */
  openForm?: (page: Page) => Promise<void>;
}

async function clickIfVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
        await el.click();
        await sleep(jitterMs(1200, 2500));
        return true;
      }
    } catch {}
  }
  return false;
}

const greenhouse: AtsAdapter = {
  ats: 'greenhouse',
  formScope: '#application-form, #application_form, form[action*="greenhouse"], #main_fields, form',
  submitSelector: '#submit_app, button[type="submit"], input[type="submit"]',
  openForm: async (page) => {
    // Embedded boards sometimes need an "Apply" click to reveal the form
    if (await page.locator('#application-form, #application_form').count() === 0) {
      await clickIfVisible(page, ['a:has-text("Apply")', 'button:has-text("Apply")']);
    }
  },
};

const lever: AtsAdapter = {
  ats: 'lever',
  formScope: 'form#application-form, .application-form, form[action*="lever"], form',
  submitSelector: 'button[type="submit"].postings-btn, #btn-submit, button[type="submit"]',
  openForm: async (page) => {
    // Posting pages link to /apply; the form page has .application-form
    if (await page.locator('.application-form, form#application-form').count() === 0) {
      await clickIfVisible(page, [
        'a.postings-btn:has-text("Apply")', 'a:has-text("Apply for this job")', 'a:has-text("Apply")',
      ]);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  },
};

const ashby: AtsAdapter = {
  ats: 'ashby',
  formScope: 'form, [class*="application-form"], [class*="ApplicationForm"]',
  submitSelector: 'button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit")',
  openForm: async (page) => {
    // Ashby job pages have an "Application" tab / "Apply" button (SPA)
    await clickIfVisible(page, [
      'a:has-text("Application")', 'button:has-text("Apply for this Job")', 'button:has-text("Apply")', 'a:has-text("Apply")',
    ]);
    await page.waitForSelector('form input, form textarea', { timeout: 15000 }).catch(() => {});
  },
};

const smartrecruiters: AtsAdapter = {
  ats: 'smartrecruiters',
  formScope: 'form',
  submitSelector: 'button[type="submit"]:has-text("Apply"), button[type="submit"], button:has-text("Submit")',
  openForm: async (page) => {
    await clickIfVisible(page, [
      'a:has-text("I\'m interested")', 'button:has-text("I\'m interested")', 'a:has-text("Apply")', 'button:has-text("Apply")',
    ]);
    await page.waitForSelector('form input, form textarea', { timeout: 15000 }).catch(() => {});
  },
};

/** Best-effort adapter for unrecognized-but-simple career forms. */
const generic: AtsAdapter = {
  ats: 'generic',
  formScope: 'form',
  submitSelector: 'button[type="submit"], input[type="submit"], button:has-text("Submit")',
  openForm: async (page) => {
    if (await page.locator('form input, form textarea').count() === 0) {
      await clickIfVisible(page, ['a:has-text("Apply")', 'button:has-text("Apply")']);
    }
  },
};

const ADAPTERS: Record<string, AtsAdapter> = { greenhouse, lever, ashby, smartrecruiters };

export function getAdapter(atsType: string | null | undefined): AtsAdapter {
  return ADAPTERS[atsType ?? ''] ?? generic;
}
