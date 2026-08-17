import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlockedBoardUrl,
  pickJSearchApplyUrl,
  adzunaDiscoverJobs,
  googleJobsDiscoverJobs,
} from './jobMatchService.js';

// ---------------------------------------------------------------------------
// isBlockedBoardUrl
// ---------------------------------------------------------------------------

describe('isBlockedBoardUrl', () => {
  test('blocks seek.com.au, indeed.com, glassdoor.com (incl. subdomains)', () => {
    assert.equal(isBlockedBoardUrl('https://www.seek.com.au/job/12345678'), true);
    assert.equal(isBlockedBoardUrl('https://www.seek.co.nz/job/12345678'), true);
    assert.equal(isBlockedBoardUrl('https://au.indeed.com/viewjob?jk=abc123def456'), true);
    assert.equal(isBlockedBoardUrl('https://www.glassdoor.com/job-listing/x-JV_IC123.htm'), true);
  });

  test('allows ATS and employer URLs', () => {
    assert.equal(isBlockedBoardUrl('https://boards.greenhouse.io/acme/jobs/4681234'), false);
    assert.equal(isBlockedBoardUrl('https://jobs.lever.co/acme/9f1c-uuid'), false);
    assert.equal(isBlockedBoardUrl('https://careers.acme.com/roles/product-manager-1234'), false);
    assert.equal(isBlockedBoardUrl('https://www.linkedin.com/jobs/view/378123456'), false);
  });

  test('treats unparseable URLs as blocked', () => {
    assert.equal(isBlockedBoardUrl('not a url'), true);
  });
});

// ---------------------------------------------------------------------------
// pickJSearchApplyUrl
// ---------------------------------------------------------------------------

describe('pickJSearchApplyUrl', () => {
  test('prefers direct ATS link over board links', () => {
    const job = {
      job_apply_link: 'https://www.linkedin.com/jobs/view/378123456',
      apply_options: [
        { publisher: 'LinkedIn', apply_link: 'https://www.linkedin.com/jobs/view/378123456' },
        { publisher: 'Greenhouse', apply_link: 'https://boards.greenhouse.io/acme/jobs/4681234' },
      ],
    };
    assert.equal(pickJSearchApplyUrl(job), 'https://boards.greenhouse.io/acme/jobs/4681234');
  });

  test('prefers employer career page over known board when no ATS link', () => {
    const job = {
      apply_options: [
        { apply_link: 'https://www.linkedin.com/jobs/view/378123456' },
        { apply_link: 'https://careers.acme.com/roles/pm-1234' },
      ],
    };
    assert.equal(pickJSearchApplyUrl(job), 'https://careers.acme.com/roles/pm-1234');
  });

  test('returns null when only blocked-board URLs are offered', () => {
    const job = {
      job_apply_link: 'https://www.seek.com.au/job/12345678',
      apply_options: [
        { apply_link: 'https://au.indeed.com/viewjob?jk=abc123def456' },
        { apply_link: 'https://www.glassdoor.com/job-listing/x-JV_IC123.htm' },
      ],
    };
    assert.equal(pickJSearchApplyUrl(job), null);
  });

  test('falls back to a verifiable board URL when nothing better exists', () => {
    const job = { job_apply_link: 'https://www.linkedin.com/jobs/view/378123456' };
    assert.equal(pickJSearchApplyUrl(job), 'https://www.linkedin.com/jobs/view/378123456');
  });

  test('rejects listing pages', () => {
    const job = { job_apply_link: 'https://careers.acme.com/jobs' };
    assert.equal(pickJSearchApplyUrl(job), null);
  });
});

// ---------------------------------------------------------------------------
// adzunaDiscoverJobs
// ---------------------------------------------------------------------------

function mockFetchOk(payload: any): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => payload, text: async () => '' })) as unknown as typeof fetch;
}

describe('adzunaDiscoverJobs', () => {
  const origId = process.env.ADZUNA_APP_ID;
  const origKey = process.env.ADZUNA_APP_KEY;
  beforeEach(() => { process.env.ADZUNA_APP_ID = 'test-id'; process.env.ADZUNA_APP_KEY = 'test-key'; });
  afterEach(() => {
    if (origId === undefined) delete process.env.ADZUNA_APP_ID; else process.env.ADZUNA_APP_ID = origId;
    if (origKey === undefined) delete process.env.ADZUNA_APP_KEY; else process.env.ADZUNA_APP_KEY = origKey;
  });

  test('returns configured:false when keys are missing', async () => {
    delete process.env.ADZUNA_APP_ID;
    const res = await adzunaDiscoverJobs('Australia', ['Product Manager'], mockFetchOk({ results: [] }));
    assert.equal(res.configured, false);
    assert.equal(res.findings.length, 0);
  });

  test('skips countries without an Adzuna market (configured, zero findings, no fetch)', async () => {
    let called = false;
    const fetchFn = (async () => { called = true; throw new Error('should not fetch'); }) as unknown as typeof fetch;
    const res = await adzunaDiscoverJobs('Malaysia', ['Product Manager'], fetchFn);
    assert.equal(res.configured, true);
    assert.equal(res.findings.length, 0);
    assert.equal(called, false);
  });

  test('maps results, resolves redirect wrappers, rejects blocked-board destinations', async () => {
    const payload = {
      results: [
        {
          title: 'Senior <strong>Product</strong> Manager',
          company: { display_name: 'Acme Corp' },
          location: { display_name: 'Sydney, NSW' },
          redirect_url: 'https://www.adzuna.com.au/land/ad/111',
          description: 'Great   role\nwith responsibilities',
        },
        {
          title: 'Delivery Manager',
          company: { display_name: 'SeekOnly Pty' },
          location: { display_name: 'Melbourne' },
          redirect_url: 'https://www.adzuna.com.au/land/ad/222',
        },
      ],
    };
    const resolver = async (url: string) =>
      url.endsWith('111') ? 'https://boards.greenhouse.io/acme/jobs/4681234' : 'https://www.seek.com.au/job/12345678';
    const res = await adzunaDiscoverJobs('Australia', ['Product Manager'], mockFetchOk(payload), resolver);
    assert.equal(res.configured, true);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].title, 'Senior Product Manager');
    assert.equal(res.findings[0].company, 'Acme Corp');
    assert.equal(res.findings[0].url, 'https://boards.greenhouse.io/acme/jobs/4681234');
    assert.equal(res.findings[0].source, 'Adzuna');
    assert.match(res.findings[0].description, /Great role with responsibilities/);
  });

  test('throws on HTTP failure so the caller can alert', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) })) as unknown as typeof fetch;
    await assert.rejects(
      () => adzunaDiscoverJobs('Australia', ['Product Manager'], fetchFn),
      /Adzuna HTTP 401/,
    );
  });
});

// ---------------------------------------------------------------------------
// googleJobsDiscoverJobs
// ---------------------------------------------------------------------------

describe('googleJobsDiscoverJobs', () => {
  const orig = process.env.JSEARCH_API_KEY;
  beforeEach(() => { process.env.JSEARCH_API_KEY = 'test-key'; });
  afterEach(() => {
    if (orig === undefined) delete process.env.JSEARCH_API_KEY; else process.env.JSEARCH_API_KEY = orig;
  });

  test('returns configured:false when key is missing', async () => {
    delete process.env.JSEARCH_API_KEY;
    const res = await googleJobsDiscoverJobs('Australia', ['Product Manager'], mockFetchOk({ data: [] }));
    assert.equal(res.configured, false);
  });

  test('maps jobs preferring direct links; drops blocked-board-only jobs', async () => {
    const payload = {
      data: [
        {
          job_title: 'Head of Product',
          employer_name: 'Acme Corp',
          job_city: 'Auckland',
          job_country: 'NZ',
          job_description: 'Lead the product org.',
          job_apply_link: 'https://www.seek.co.nz/job/12345678',
          apply_options: [
            { apply_link: 'https://www.seek.co.nz/job/12345678' },
            { apply_link: 'https://jobs.lever.co/acme/9f1c2345-aaaa-bbbb-cccc-121212121212' },
          ],
        },
        {
          job_title: 'Product Owner',
          employer_name: 'BlockedCo',
          job_apply_link: 'https://www.glassdoor.com/job-listing/x-JV_IC123.htm',
        },
      ],
    };
    const res = await googleJobsDiscoverJobs('New Zealand', ['Product Manager'], mockFetchOk(payload));
    assert.equal(res.configured, true);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].url, 'https://jobs.lever.co/acme/9f1c2345-aaaa-bbbb-cccc-121212121212');
    assert.equal(res.findings[0].source, 'Google Jobs');
    assert.equal(res.findings[0].location, 'Auckland, NZ');
  });

  test('throws on HTTP failure so the caller can alert', async () => {
    const fetchFn = (async () => ({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) })) as unknown as typeof fetch;
    await assert.rejects(
      () => googleJobsDiscoverJobs('Australia', ['Product Manager'], fetchFn),
      /JSearch HTTP 429/,
    );
  });
});
