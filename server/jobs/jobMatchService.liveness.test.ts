/**
 * Unit tests for the liveness-check helpers in jobMatchService.ts
 *
 * Run with:  npm run test:liveness
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 *
 * Security design being tested:
 *   The SSRF protection lives entirely inside ssrfSafeLookup, which is passed
 *   as the `lookup` callback to Node's https.request. This means the IP that
 *   is validated IS the IP used for the TCP connection — there is no
 *   TOCTOU/DNS-rebinding window between a pre-check and the actual connect.
 */

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dnsPromises from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import type { LookupOptions } from 'node:dns';

import {
  isAllowedJobBoardDomain,
  isPrivateIp,
  ssrfSafeLookup,
  checkUrlLive,
  filterLiveJobs,
  enforceSlotCoverage,
  ALLOWED_JOB_BOARD_DOMAINS,
  hostnameMatchesBoardDomain,
  deriveSourceFromUrl,
  type BoardConfig,
} from './jobMatchService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wraps ssrfSafeLookup's callback interface in a Promise for easy testing. */
function lookup(hostname: string): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    ssrfSafeLookup(hostname, {} as LookupOptions, (err, address, family) => {
      if (err) reject(err); else resolve({ address, family });
    });
  });
}

/**
 * Builds a minimal mock for https.request / http.request that immediately
 * fires the response callback with a given status code.
 */
function mockRequest(mod: typeof https | typeof http, status: number) {
  mock.method(mod, 'request', (_opts: any, callback: (res: any) => void) => {
    // Call the response handler on next tick to simulate async behaviour
    const fakeReq = {
      end() { Promise.resolve().then(() => callback({ statusCode: status, destroy() {} })); return this; },
      on(_event: string, _handler: (...args: any[]) => void) { return this; },
      destroy() {},
    };
    return fakeReq;
  });
}

afterEach(() => mock.restoreAll());

// ── isAllowedJobBoardDomain ───────────────────────────────────────────────────

test('isAllowedJobBoardDomain: exact match', () => {
  assert.equal(isAllowedJobBoardDomain('linkedin.com'), true);
  assert.equal(isAllowedJobBoardDomain('indeed.com'), true);
  assert.equal(isAllowedJobBoardDomain('randstad.com'), true);
});

test('isAllowedJobBoardDomain: subdomain match', () => {
  assert.equal(isAllowedJobBoardDomain('uk.indeed.com'), true);
  assert.equal(isAllowedJobBoardDomain('my.randstad.com'), true);
  assert.equal(isAllowedJobBoardDomain('jobs.lever.co'), true);
});

test('isAllowedJobBoardDomain: strips leading www', () => {
  assert.equal(isAllowedJobBoardDomain('www.linkedin.com'), true);
  assert.equal(isAllowedJobBoardDomain('www.seek.com'), true);
});

test('isAllowedJobBoardDomain: unknown domain rejected', () => {
  assert.equal(isAllowedJobBoardDomain('evil.com'), false);
  assert.equal(isAllowedJobBoardDomain('169.254.169.254'), false);
  assert.equal(isAllowedJobBoardDomain('internal.corp'), false);
});

// ── isPrivateIp ───────────────────────────────────────────────────────────────

test('isPrivateIp: loopback 127.0.0.1', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('127.255.255.255'), true);
});

test('isPrivateIp: RFC1918 10.x', () => assert.equal(isPrivateIp('10.0.0.1'), true));
test('isPrivateIp: RFC1918 172.16–31.x', () => {
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('172.15.0.1'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
});
test('isPrivateIp: RFC1918 192.168.x', () => assert.equal(isPrivateIp('192.168.1.1'), true));
test('isPrivateIp: link-local / cloud metadata 169.254.169.254', () => assert.equal(isPrivateIp('169.254.169.254'), true));
test('isPrivateIp: multicast 224.0.0.1', () => assert.equal(isPrivateIp('224.0.0.1'), true));
test('isPrivateIp: IPv6 loopback ::1', () => assert.equal(isPrivateIp('::1'), true));
test('isPrivateIp: IPv6 ULA fc00::/7', () => {
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd12:3456::1'), true);
});
test('isPrivateIp: IPv6 link-local fe80::', () => assert.equal(isPrivateIp('fe80::1'), true));
test('isPrivateIp: IPv4-mapped IPv6 ::ffff:192.168.1.1 is private', () => assert.equal(isPrivateIp('::ffff:192.168.1.1'), true));
test('isPrivateIp: public IPv4 is not private', () => assert.equal(isPrivateIp('1.2.3.4'), false));
test('isPrivateIp: public IPv6 is not private', () => assert.equal(isPrivateIp('2001:db8::1'), false));

// ── ssrfSafeLookup (integration: DNS resolution + IP validation in one step) ──

test('ssrfSafeLookup: public A record resolves successfully', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  const { address, family } = await lookup('linkedin.com');
  assert.equal(address, '1.2.3.4');
  assert.equal(family, 4);
});

test('ssrfSafeLookup: private A record → SSRF blocked (single private record)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['127.0.0.1']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  await assert.rejects(() => lookup('localhost'), /SSRF blocked/);
});

test('ssrfSafeLookup: metadata IP → SSRF blocked', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['169.254.169.254']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  await assert.rejects(() => lookup('metadata.internal'), /SSRF blocked/);
});

test('ssrfSafeLookup: mixed public+private A records → SSRF blocked (any private = reject all)', async () => {
  // This is the key DNS-rebinding scenario: attacker returns a public IP to pass
  // any pre-check AND a private IP in the same answer set. ssrfSafeLookup must
  // reject the connection because one of the candidates is private.
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4', '192.168.1.1']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  await assert.rejects(() => lookup('rebinding-attack.example'), /SSRF blocked/);
});

test('ssrfSafeLookup: mixed public IPv4 + private IPv6 → SSRF blocked', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => ['fc00::1']);
  await assert.rejects(() => lookup('mixed.example'), /SSRF blocked/);
});

test('ssrfSafeLookup: AAAA-only resolution resolves to public IPv6', async () => {
  mock.method(dnsPromises, 'resolve4', async () => { throw new Error('ENODATA'); });
  mock.method(dnsPromises, 'resolve6', async () => ['2001:db8::1']);
  const { address, family } = await lookup('ipv6only.example');
  assert.equal(address, '2001:db8::1');
  assert.equal(family, 6);
});

test('ssrfSafeLookup: all DNS resolution fails → ENOTFOUND', async () => {
  mock.method(dnsPromises, 'resolve4', async () => { throw new Error('ENOTFOUND'); });
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(() => lookup('nxdomain.example'), /DNS lookup failed/);
});

// ── checkUrlLive ─────────────────────────────────────────────────────────────

test('checkUrlLive: null URL → live (keep)', async () => {
  assert.equal(await checkUrlLive(null), true);
});

test('checkUrlLive: non-http URL → live (keep)', async () => {
  assert.equal(await checkUrlLive('ftp://example.com/file'), true);
});

test('checkUrlLive: non-allowlisted domain → live (no network call)', async () => {
  let requested = false;
  mock.method(https, 'request', () => { requested = true; return { end() {}, on() {} }; });
  const live = await checkUrlLive('https://evil.com/job/123');
  assert.equal(live, true);
  assert.equal(requested, false, 'https.request must NOT be called for non-allowlisted domains');
});

test('checkUrlLive: 200 → live', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200);
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/view/123'), true);
});

test('checkUrlLive: 301 redirect → live (not followed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 301);
  assert.equal(await checkUrlLive('https://indeed.com/viewjob?jk=abc'), true);
});

test('checkUrlLive: 403 → live (bot-blocking board)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 403);
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/view/999'), true);
});

test('checkUrlLive: 404 → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 404);
  assert.equal(await checkUrlLive('https://indeed.com/viewjob?jk=expired'), false);
});

test('checkUrlLive: 410 → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 410);
  assert.equal(await checkUrlLive('https://randstad.com/jobs/gone'), false);
});

test('checkUrlLive: 500 → live (transient error)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 500);
  assert.equal(await checkUrlLive('https://hays.com/job/1'), true);
});

test('checkUrlLive: 429 → live (rate-limited)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 429);
  assert.equal(await checkUrlLive('https://seek.com/job/1'), true);
});

test('checkUrlLive: HEAD 405 → retries GET, 200 → live', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  let callCount = 0;
  mock.method(https, 'request', (_opts: any, callback: (res: any) => void) => {
    const status = callCount++ === 0 ? 405 : 200;
    const fakeReq = {
      end() { Promise.resolve().then(() => callback({ statusCode: status, destroy() {} })); return this; },
      on() { return this; },
      destroy() {},
    };
    return fakeReq;
  });
  assert.equal(await checkUrlLive('https://greenhouse.io/jobs/1'), true);
  assert.equal(callCount, 2);
});

test('checkUrlLive: HEAD 405 → GET 404 → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  let callCount = 0;
  mock.method(https, 'request', (_opts: any, callback: (res: any) => void) => {
    const status = callCount++ === 0 ? 405 : 404;
    const fakeReq = {
      end() { Promise.resolve().then(() => callback({ statusCode: status, destroy() {} })); return this; },
      on() { return this; },
      destroy() {},
    };
    return fakeReq;
  });
  assert.equal(await checkUrlLive('https://greenhouse.io/jobs/expired'), false);
});

test('checkUrlLive: network error → live (keep, transient failure)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mock.method(https, 'request', (_opts: any, _callback: any) => {
    const fakeReq = {
      end() {
        Promise.resolve().then(() => this._errorHandler(new Error('ECONNREFUSED')));
        return this;
      },
      _errorHandler: (_e: Error) => {},
      on(event: string, handler: (...args: any[]) => void) {
        if (event === 'error') this._errorHandler = handler;
        return this;
      },
      destroy() {},
    };
    return fakeReq;
  });
  assert.equal(await checkUrlLive('https://jobstreet.com/job/1'), true);
});

test('checkUrlLive: SSRF blocked (private IP from ssrfSafeLookup) → dead', async () => {
  // Simulates a DNS rebinding or prompt-injection attack where an allowlisted
  // hostname resolves to a private address. The ssrfSafeLookup callback
  // rejects the connection, and checkUrlLive interprets it as dead (blocked).
  mock.method(dnsPromises, 'resolve4', async () => ['192.168.1.1']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  // https.request will call our lookup callback, which will call back with an error.
  // We need to propagate that through the request's error handler.
  mock.method(https, 'request', (opts: any, _callback: any) => {
    const fakeReq = {
      _errorHandler: (_e: Error) => {},
      end() {
        // Simulate what Node does: invoke lookup, and if it errors, emit 'error'
        opts.lookup('linkedin.com', {}, (err: Error | null) => {
          if (err) Promise.resolve().then(() => this._errorHandler(err));
        });
        return this;
      },
      on(event: string, handler: (...args: any[]) => void) {
        if (event === 'error') this._errorHandler = handler as (e: Error) => void;
        return this;
      },
      destroy() {},
    };
    return fakeReq;
  });
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/1'), false);
});

test('checkUrlLive: mixed public+private DNS answers → dead (SSRF protection active)', async () => {
  // The attacker's DNS returns BOTH a public IP (to evade a pre-check) and a
  // private IP. ssrfSafeLookup must reject the whole set.
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4', '10.0.0.1']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mock.method(https, 'request', (opts: any, _callback: any) => {
    const fakeReq = {
      _errorHandler: (_e: Error) => {},
      end() {
        opts.lookup('linkedin.com', {}, (err: Error | null) => {
          if (err) Promise.resolve().then(() => this._errorHandler(err));
        });
        return this;
      },
      on(event: string, handler: (...args: any[]) => void) {
        if (event === 'error') this._errorHandler = handler as (e: Error) => void;
        return this;
      },
      destroy() {},
    };
    return fakeReq;
  });
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/1'), false);
});

// ── filterLiveJobs ────────────────────────────────────────────────────────────

test('filterLiveJobs: removes dead (404) jobs, keeps live ones', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mock.method(https, 'request', (opts: any, callback: (res: any) => void) => {
    const status = (opts.path as string).includes('dead') ? 404 : 200;
    const fakeReq = {
      end() { Promise.resolve().then(() => callback({ statusCode: status, destroy() {} })); return this; },
      on() { return this; },
      destroy() {},
    };
    return fakeReq;
  });

  const jobs = [
    { title: 'PM', company: 'Acme', url: 'https://linkedin.com/jobs/live1' },
    { title: 'BA', company: 'Beta', url: 'https://indeed.com/dead-posting' },
    { title: 'Head of Product', company: 'Gamma', url: 'https://seek.com/jobs/live2' },
  ];

  const result = await filterLiveJobs(jobs);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'PM');
  assert.equal(result[1].title, 'Head of Product');
});

test('filterLiveJobs: job with no URL is kept', async () => {
  const jobs = [{ title: 'Director', company: 'Corp', url: null }];
  const result = await filterLiveJobs(jobs);
  assert.equal(result.length, 1);
});

test('filterLiveJobs: empty input returns empty', async () => {
  const result = await filterLiveJobs([]);
  assert.equal(result.length, 0);
});

// ── hostnameMatchesBoardDomain ────────────────────────────────────────────────

test('hostnameMatchesBoardDomain: exact match', () => {
  assert.equal(hostnameMatchesBoardDomain('hays.com.au', ['hays.com.au']), true);
  assert.equal(hostnameMatchesBoardDomain('randstad.pl', ['randstad.pl']), true);
});

test('hostnameMatchesBoardDomain: www. prefix stripped', () => {
  assert.equal(hostnameMatchesBoardDomain('www.hays.com.au', ['hays.com.au']), true);
  assert.equal(hostnameMatchesBoardDomain('www.jobstreet.com.my', ['jobstreet.com.my']), true);
});

test('hostnameMatchesBoardDomain: subdomain matches base domain', () => {
  // au.indeed.com should match indeed.com (indeed covers country subdomains)
  assert.equal(hostnameMatchesBoardDomain('au.indeed.com', ['indeed.com']), true);
  assert.equal(hostnameMatchesBoardDomain('ie.indeed.com', ['indeed.com']), true);
  assert.equal(hostnameMatchesBoardDomain('pl.indeed.com', ['indeed.com']), true);
});

test('hostnameMatchesBoardDomain: no cross-board match', () => {
  // A Hays URL must not match the LinkedIn board's validDomains
  assert.equal(hostnameMatchesBoardDomain('hays.com.au', ['linkedin.com']), false);
  assert.equal(hostnameMatchesBoardDomain('randstad.ie', ['hays.ie']), false);
  // A greenhouse.io URL must not match any board's validDomains when only board domains are listed
  assert.equal(hostnameMatchesBoardDomain('lever.co', ['linkedin.com', 'indeed.com']), false);
});

test('hostnameMatchesBoardDomain: multiple validDomains — any match suffices', () => {
  const jobstreetDomains = ['jobstreet.com.my', 'jobstreet.com.au'];
  assert.equal(hostnameMatchesBoardDomain('jobstreet.com.my', jobstreetDomains), true);
  assert.equal(hostnameMatchesBoardDomain('jobstreet.com.au', jobstreetDomains), true);
  assert.equal(hostnameMatchesBoardDomain('linkedin.com', jobstreetDomains), false);
});

// ── deriveSourceFromUrl ───────────────────────────────────────────────────────

const MOCK_BOARD_CONFIGS: BoardConfig[] = [
  { name: 'LinkedIn',  domain: 'linkedin.com/jobs/view', urlHint: '', validDomains: ['linkedin.com'] },
  { name: 'Indeed',    domain: 'indeed.com',              urlHint: '', validDomains: ['indeed.com'] },
  { name: 'Randstad',  domain: 'randstad.pl',             urlHint: '', validDomains: ['randstad.pl'] },
  { name: 'Hays',      domain: 'hays.pl',                 urlHint: '', validDomains: ['hays.pl'] },
];

test('deriveSourceFromUrl: LinkedIn URL → LinkedIn', () => {
  assert.equal(deriveSourceFromUrl('https://www.linkedin.com/jobs/view/12345', MOCK_BOARD_CONFIGS), 'LinkedIn');
});

test('deriveSourceFromUrl: indeed.com URL → Indeed', () => {
  assert.equal(deriveSourceFromUrl('https://indeed.com/viewjob?jk=abc', MOCK_BOARD_CONFIGS), 'Indeed');
});

test('deriveSourceFromUrl: au.indeed.com (country subdomain) → Indeed', () => {
  assert.equal(deriveSourceFromUrl('https://au.indeed.com/viewjob?jk=xyz', MOCK_BOARD_CONFIGS), 'Indeed');
});

test('deriveSourceFromUrl: Randstad regional URL → Randstad', () => {
  assert.equal(deriveSourceFromUrl('https://www.randstad.pl/jobs/pm-warsaw-123', MOCK_BOARD_CONFIGS), 'Randstad');
});

test('deriveSourceFromUrl: Hays regional URL → Hays', () => {
  assert.equal(deriveSourceFromUrl('https://hays.pl/job/product-manager-456', MOCK_BOARD_CONFIGS), 'Hays');
});

test('deriveSourceFromUrl: greenhouse.io URL → Other (not a tracked board)', () => {
  assert.equal(deriveSourceFromUrl('https://boards.greenhouse.io/acme/jobs/789', MOCK_BOARD_CONFIGS), 'Other');
});

test('deriveSourceFromUrl: ranker-mislabelled Hays URL is correctly identified as LinkedIn', () => {
  // Simulates the case where the ranker returns source: "Hays" but the URL is linkedin.com
  assert.equal(deriveSourceFromUrl('https://www.linkedin.com/jobs/view/999', MOCK_BOARD_CONFIGS), 'LinkedIn');
});

test('deriveSourceFromUrl: null / undefined URL → Other', () => {
  assert.equal(deriveSourceFromUrl(null, MOCK_BOARD_CONFIGS), 'Other');
  assert.equal(deriveSourceFromUrl(undefined, MOCK_BOARD_CONFIGS), 'Other');
});

// ── Regional board domain allowlist coverage ──────────────────────────────────

test('isAllowedJobBoardDomain: regional Hays domains are all allowlisted', () => {
  const hays = ['hays.com.my', 'hays.com.au', 'hays.net.nz', 'hays.ie', 'hays.ch', 'hays.se', 'hays.pl'];
  for (const d of hays) {
    assert.equal(isAllowedJobBoardDomain(d), true, `Expected ${d} to be allowlisted`);
    assert.equal(isAllowedJobBoardDomain(`www.${d}`), true, `Expected www.${d} to be allowlisted`);
  }
});

test('isAllowedJobBoardDomain: regional Randstad domains are all allowlisted', () => {
  const randstad = ['randstad.com.my', 'randstad.com.au', 'randstad.co.nz', 'randstad.ie', 'randstad.ch', 'randstad.se', 'randstad.pl'];
  for (const d of randstad) {
    assert.equal(isAllowedJobBoardDomain(d), true, `Expected ${d} to be allowlisted`);
    assert.equal(isAllowedJobBoardDomain(`www.${d}`), true, `Expected www.${d} to be allowlisted`);
  }
});

test('isAllowedJobBoardDomain: jobstreet.com.my is allowlisted (Malaysia only)', () => {
  // jobstreet.com.au was shut down — AU/NZ use SEEK; only .com.my is active
  assert.equal(isAllowedJobBoardDomain('jobstreet.com.my'), true);
  assert.equal(isAllowedJobBoardDomain('www.jobstreet.com.my'), true);
  // jobstreet.com.au is removed from the allowlist since the domain is shut down
  assert.equal(isAllowedJobBoardDomain('jobstreet.com.au'), false);
});

test('ALLOWED_JOB_BOARD_DOMAINS: every generated board domain is present', () => {
  // Verify the constant covers every domain the per-board search configs can generate.
  // jobstreet.com.au is intentionally absent — that domain was shut down; only .com.my is active.
  const required = [
    'hays.com.my', 'hays.com.au', 'hays.net.nz', 'hays.ie', 'hays.ch', 'hays.se', 'hays.pl',
    'randstad.com.my', 'randstad.com.au', 'randstad.co.nz', 'randstad.ie', 'randstad.ch', 'randstad.se', 'randstad.pl',
    'jobstreet.com.my',
  ];
  for (const d of required) {
    assert.ok(ALLOWED_JOB_BOARD_DOMAINS.includes(d), `Missing from allowlist: ${d}`);
  }
  assert.ok(!ALLOWED_JOB_BOARD_DOMAINS.includes('jobstreet.com.au'), 'jobstreet.com.au must not be allowlisted — domain is shut down');
});

// Proves liveness probing actually fires for a regional domain (not skipped as non-allowlisted)
test('checkUrlLive: hays.com.au 404 → dead (regional domain is probed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 404);
  assert.equal(await checkUrlLive('https://hays.com.au/job/expired-123'), false);
});

test('checkUrlLive: randstad.co.nz 410 → dead (regional domain is probed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 410);
  assert.equal(await checkUrlLive('https://randstad.co.nz/jobs/gone-456'), false);
});

test('checkUrlLive: jobstreet.com.my 200 → live (Malaysia JobStreet is probed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200);
  assert.equal(await checkUrlLive('https://jobstreet.com.my/job/12345'), true);
});

test('checkUrlLive: jobstreet.com.au → not probed (domain shut down, not allowlisted)', async () => {
  let requested = false;
  mock.method(https, 'request', () => { requested = true; return { end() {}, on() {} }; });
  // jobstreet.com.au is no longer in the allowlist; checkUrlLive must skip and return true (keep)
  const live = await checkUrlLive('https://jobstreet.com.au/job/12345');
  assert.equal(live, true, 'Unallowlisted domain must be kept without probing');
  assert.equal(requested, false, 'https.request must NOT fire for unallowlisted domain');
});

// ── Slot-fill liveness guarantee ──────────────────────────────────────────────

// ── enforceSlotCoverage — multi-board slot enforcement ───────────────────────

test('enforceSlotCoverage: three missing boards all appear when all candidates are live', async () => {
  // Simulates the worst case: 10 LinkedIn-only rows in the ranked list, but Indeed,
  // Randstad, and Hays each have one live candidate in the raw findings pool.
  // All three must appear in the final list.
  const linkedInRows = Array.from({ length: 10 }, (_, i) => ({
    title: `Product Manager ${i}`, company: `LinkedIn Co ${i}`,
    url: `https://www.linkedin.com/jobs/view/${i}`, source: 'LinkedIn',
    location: 'Warsaw', description: 'PM role', matchScore: 90 - i, matchReason: '',
  }));

  const findingsByBoard = new Map([
    ['LinkedIn', []],
    ['Indeed',   [{ title: 'PM Indeed',   company: 'IndeedCo',   location: 'Warsaw', url: 'https://indeed.com/viewjob?jk=abc', description: '', source: 'Indeed' }]],
    ['Randstad', [{ title: 'PM Randstad', company: 'RandstadCo', location: 'Warsaw', url: 'https://randstad.pl/jobs/pm-123',   description: '', source: 'Randstad' }]],
    ['Hays',     [{ title: 'PM Hays',     company: 'HaysCo',     location: 'Warsaw', url: 'https://hays.pl/job/pm-456',        description: '', source: 'Hays' }]],
  ]);

  const alwaysLive = async (_url: string) => true;
  const result = await enforceSlotCoverage(
    linkedInRows,
    ['LinkedIn', 'Indeed', 'Randstad', 'Hays'],
    findingsByBoard,
    new Set(), new Set(), new Set(),
    10,
    alwaysLive,
  );

  assert.equal(result.length, 10, 'Must have exactly 10 rows');
  const sources = new Set(result.map((r: any) => r.source));
  assert.ok(sources.has('Indeed'),   'Indeed must appear in final shortlist');
  assert.ok(sources.has('Randstad'), 'Randstad must appear in final shortlist');
  assert.ok(sources.has('Hays'),     'Hays must appear in final shortlist');
  assert.ok(sources.has('LinkedIn'), 'LinkedIn must still appear in final shortlist');
});

test('enforceSlotCoverage: dead first candidate is skipped; second live candidate fills slot', async () => {
  const linkedInRows = Array.from({ length: 10 }, (_, i) => ({
    title: `PM ${i}`, company: `Co ${i}`,
    url: `https://www.linkedin.com/jobs/view/${i}`, source: 'LinkedIn',
    location: 'Dublin', description: '', matchScore: 80, matchReason: '',
  }));

  const findingsByBoard = new Map([
    ['LinkedIn', []],
    ['Indeed', [
      { title: 'Dead Indeed',  company: 'DeadCo',  location: 'Dublin', url: 'https://indeed.com/viewjob?jk=dead', description: '', source: 'Indeed' },
      { title: 'Live Indeed',  company: 'LiveCo',  location: 'Dublin', url: 'https://indeed.com/viewjob?jk=live', description: '', source: 'Indeed' },
    ]],
  ]);

  const mockLive = async (url: string) => !url.includes('dead');
  const result = await enforceSlotCoverage(
    linkedInRows, ['LinkedIn', 'Indeed'], findingsByBoard,
    new Set(), new Set(), new Set(), 10, mockLive,
  );

  const indeed = result.find((r: any) => r.source === 'Indeed');
  assert.ok(indeed, 'Indeed must appear');
  assert.ok(indeed.url.includes('live'), 'Dead candidate must be skipped; live one used');
});

test('enforceSlotCoverage: no cross-board candidate pollution across multiple fills', async () => {
  // Both Indeed and Randstad have the same single posting in their pool.
  // Only the first missing board (Indeed) should claim it; Randstad must log a warning and get no slot.
  const linkedInRows = Array.from({ length: 10 }, (_, i) => ({
    title: `PM ${i}`, company: `Co ${i}`,
    url: `https://www.linkedin.com/jobs/view/${i}`, source: 'LinkedIn',
    location: 'Dublin', description: '', matchScore: 80, matchReason: '',
  }));

  const sharedPosting = { title: 'Shared PM', company: 'SharedCo', location: 'Dublin', url: 'https://indeed.com/viewjob?jk=shared', description: '', source: 'Indeed' };

  const findingsByBoard = new Map([
    ['LinkedIn', []],
    ['Indeed',   [sharedPosting]],
    ['Randstad', [{ ...sharedPosting, source: 'Randstad' }]], // same URL, different label
  ]);

  const alwaysLive = async (_url: string) => true;
  const result = await enforceSlotCoverage(
    linkedInRows, ['LinkedIn', 'Indeed', 'Randstad'], findingsByBoard,
    new Set(), new Set(), new Set(), 10, alwaysLive,
  );

  // The URL should appear at most once (Indeed claimed it; Randstad's clone is deduped)
  const urlCounts = result.reduce((acc: Record<string, number>, r: any) => {
    acc[r.url] = (acc[r.url] ?? 0) + 1;
    return acc;
  }, {});
  assert.ok((urlCounts['https://indeed.com/viewjob?jk=shared'] ?? 0) <= 1, 'Same URL must not appear twice');
});

test('filterLiveJobs: dead candidate from regional Randstad domain is excluded', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mock.method(https, 'request', (opts: any, callback: (res: any) => void) => {
    // randstad.com.au URL returns 404; hays.ie URL returns 200
    const status = (opts.hostname as string).includes('randstad') ? 404 : 200;
    const fakeReq = {
      end() { Promise.resolve().then(() => callback({ statusCode: status, destroy() {} })); return this; },
      on() { return this; },
      destroy() {},
    };
    return fakeReq;
  });
  const jobs = [
    { title: 'PM', company: 'Acme', url: 'https://randstad.com.au/jobs/dead-randstad' },
    { title: 'BA', company: 'Beta', url: 'https://hays.ie/job/live-hays' },
  ];
  const result = await filterLiveJobs(jobs);
  assert.equal(result.length, 1, 'Dead randstad.com.au posting must be removed');
  assert.equal(result[0].company, 'Beta');
});
