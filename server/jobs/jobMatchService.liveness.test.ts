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
  isDirectPostingUrl,
  verifyBoardPatterns,
  RANDSTAD_CANARY_URLS,
  resolveCanaryFinalUrl,
  getBoardConfigs,
  findStaleness,
  MAX_POSTING_AGE_DAYS,
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
function mockRequest(mod: typeof https | typeof http, status: number, body = '<html><body>Apply now</body></html>') {
  mock.method(mod, 'request', (_opts: any, callback: (res: any) => void) => {
    // Call the response handler on next tick to simulate async behaviour
    const fakeReq = {
      end() {
        Promise.resolve().then(() => {
          const handlers: Record<string, Array<(...args: any[]) => void>> = {};
          const fakeRes = {
            statusCode: status,
            destroy() {},
            on(event: string, handler: (...args: any[]) => void) {
              (handlers[event] ||= []).push(handler);
              return this;
            },
          };
          callback(fakeRes);
          // Emit body + end on the following tick, after handlers are attached
          Promise.resolve().then(() => {
            (handlers['data'] || []).forEach((h) => h(Buffer.from(body)));
            (handlers['end'] || []).forEach((h) => h());
          });
        });
        return this;
      },
      on(_event: string, _handler: (...args: any[]) => void) { return this; },
      destroy() {},
    };
    return fakeReq;
  });
}

/** Body-capable fake request for per-URL status mocks. */
function fakeBodyReq(callback: (res: any) => void, status: number, body = '<body>Apply now</body>') {
  const fakeReq = {
    end() {
      Promise.resolve().then(() => {
        const handlers: Record<string, Array<(...args: any[]) => void>> = {};
        callback({
          statusCode: status,
          destroy() {},
          on(event: string, handler: (...args: any[]) => void) { (handlers[event] ||= []).push(handler); return this; },
        });
        Promise.resolve().then(() => {
          (handlers['data'] || []).forEach((h) => h(Buffer.from(body)));
          (handlers['end'] || []).forEach((h) => h());
        });
      });
      return this;
    },
    on() { return this; },
    destroy() {},
  };
  return fakeReq;
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

test('checkUrlLive: non-allowlisted public domain IS probed (200 → live)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200);
  assert.equal(await checkUrlLive('https://some-regional-board.com/job/123'), true);
});

test('checkUrlLive: non-allowlisted domain 404 → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 404);
  assert.equal(await checkUrlLive('https://some-regional-board.com/job/123'), false);
});

test('checkUrlLive: 200 with "no longer accepting applications" → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200, '<html><body><div>No longer accepting applications</div></body></html>');
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/view/123'), false);
});

test('checkUrlLive: 200 with Polish expired marker → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200, '<html><body>Oferta wygasła</body></html>');
  assert.equal(await checkUrlLive('https://pracuj.pl/praca/oferta,123'), false);
});

test('checkUrlLive: marker split across inline tags still detected', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200, '<span>This job has</span> <b>expired</b>');
  assert.equal(await checkUrlLive('https://indeed.com/viewjob?jk=x'), false);
});

test('checkUrlLive: marker inside script tag ignored', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 200, '<script>var t="this job has expired";</script><body>Apply today</body>');
  assert.equal(await checkUrlLive('https://indeed.com/viewjob?jk=y'), true);
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

test('checkUrlLive: 403 → rejected (bot-blocked = unverifiable, fail closed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 403);
  assert.equal(await checkUrlLive('https://linkedin.com/jobs/view/999'), false);
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

test('checkUrlLive: 429 → rejected (bot-blocked = unverifiable, fail closed)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 429);
  assert.equal(await checkUrlLive('https://seek.com/job/1'), false);
});

test('checkUrlLive: 405 (method quirk) → live (conservative keep)', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 405);
  assert.equal(await checkUrlLive('https://greenhouse.io/jobs/1'), true);
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
  mock.method(https, 'request', (opts: any, callback: (res: any) => void) =>
    fakeBodyReq(callback, (opts.path as string).includes('dead') ? 404 : 200));

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

test('checkUrlLive: jobstreet.com.au (shut-down domain) → probed, 404 → dead', async () => {
  mock.method(dnsPromises, 'resolve4', async () => ['1.2.3.4']);
  mock.method(dnsPromises, 'resolve6', async () => { throw new Error('ENODATA'); });
  mockRequest(https, 404);
  assert.equal(await checkUrlLive('https://jobstreet.com.au/job/12345'), false);
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
  // randstad.com.au URL returns 404; hays.ie URL returns 200
  mock.method(https, 'request', (opts: any, callback: (res: any) => void) =>
    fakeBodyReq(callback, (opts.hostname as string).includes('randstad') ? 404 : 200));
  const jobs = [
    { title: 'PM', company: 'Acme', url: 'https://randstad.com.au/jobs/dead-randstad' },
    { title: 'BA', company: 'Beta', url: 'https://hays.ie/job/live-hays' },
  ];
  const result = await filterLiveJobs(jobs);
  assert.equal(result.length, 1, 'Dead randstad.com.au posting must be removed');
  assert.equal(result[0].company, 'Beta');
});

// ── isDirectPostingUrl — per-board URL path-pattern detection ─────────────────
//
// These tests guard against silent regressions when a board changes its URL
// structure: if a board starts serving individual ads on a different path the
// pattern tests will fail, making the breakage visible before it silently
// degrades search quality.

/** Minimal board fixtures that mirror the real getBoardConfigs() output. */
const INDEED_BOARD: BoardConfig = {
  name: 'Indeed',
  domain: 'indeed.com',
  urlHint: 'URLs containing /viewjob?jk= or /rc/clk?jk=',
  validDomains: ['indeed.com'],
  directUrlPatterns: [/\/viewjob\?.*jk=/, /\/rc\/clk\?.*jk=/],
};

const HAYS_MY_BOARD: BoardConfig = {
  name: 'Hays',
  domain: 'hays.com.my',
  urlHint: 'a URL on hays.com.my that contains /job/ followed by a job reference or title slug',
  validDomains: ['hays.com.my'],
  directUrlPatterns: [/\/job\//],
};

const HAYS_AU_BOARD: BoardConfig = {
  name: 'Hays',
  domain: 'hays.com.au',
  urlHint: 'a URL on hays.com.au that contains /job/ followed by a job reference or title slug',
  validDomains: ['hays.com.au'],
  directUrlPatterns: [/\/job\//],
};

const LINKEDIN_BOARD: BoardConfig = {
  name: 'LinkedIn',
  domain: 'linkedin.com/jobs/view',
  urlHint: 'https://www.linkedin.com/jobs/view/<numeric-id>',
  validDomains: ['linkedin.com'],
  directUrlPatterns: [/\/jobs\/view\//],
};

const RANDSTAD_BOARD: BoardConfig = {
  name: 'Randstad',
  domain: 'randstad.com.my',
  urlHint: 'a URL on randstad.com.my of the form /jobs/<title-slug>_<city>_<numeric-or-uuid-ref>/',
  validDomains: ['randstad.com.my'],
  // Real Randstad URL pattern: path ends with _<city>_<id>/ where id is numeric (MY, NZ) or UUID (AU, CH, SE)
  // (?:[?#].*)? allows tracking query params without weakening listing-page rejection
  directUrlPatterns: [/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{5,})\/?(?:[?#].*)?$/i],
};

// ── Indeed: /viewjob?jk= ──────────────────────────────────────────────────────

test('isDirectPostingUrl: Indeed /viewjob?jk= is accepted (direct job ad)', () => {
  assert.equal(
    isDirectPostingUrl('https://indeed.com/viewjob?jk=abc123', INDEED_BOARD),
    true,
    '/viewjob?jk= must be accepted as a direct posting',
  );
});

test('isDirectPostingUrl: Indeed country-subdomain /viewjob?jk= is accepted', () => {
  // au.indeed.com, ie.indeed.com, etc. use the same path pattern
  assert.equal(
    isDirectPostingUrl('https://au.indeed.com/viewjob?jk=xyz789', INDEED_BOARD),
    true,
  );
  assert.equal(
    isDirectPostingUrl('https://ie.indeed.com/viewjob?jk=def456', INDEED_BOARD),
    true,
  );
});

test('isDirectPostingUrl: Indeed /rc/clk?jk= redirect link is accepted', () => {
  assert.equal(
    isDirectPostingUrl('https://indeed.com/rc/clk?jk=abc123&fccid=xyz&vjs=3', INDEED_BOARD),
    true,
    '/rc/clk?jk= is a valid direct-posting redirect used by Indeed',
  );
});

test('isDirectPostingUrl: Indeed /jobs?q= search-results page is rejected', () => {
  // The classic generic search page — must NOT be treated as a direct posting
  assert.equal(
    isDirectPostingUrl('https://indeed.com/jobs?q=product+manager&l=sydney', INDEED_BOARD),
    false,
    'Search-results page /jobs?q= must be rejected',
  );
});

test('isDirectPostingUrl: Indeed homepage is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://indeed.com/', INDEED_BOARD),
    false,
  );
});

test('isDirectPostingUrl: Indeed /companies/ page is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://indeed.com/companies/google', INDEED_BOARD),
    false,
  );
});

// ── Hays: /job/ ───────────────────────────────────────────────────────────────

test('isDirectPostingUrl: Hays /job/<slug> is accepted (Malaysia domain)', () => {
  assert.equal(
    isDirectPostingUrl('https://hays.com.my/job/senior-product-manager-kuala-lumpur-12345', HAYS_MY_BOARD),
    true,
    '/job/<slug> must be accepted as a direct Hays posting',
  );
});

test('isDirectPostingUrl: Hays /job/<slug> is accepted (Australia domain)', () => {
  assert.equal(
    isDirectPostingUrl('https://hays.com.au/job/product-manager-sydney-67890', HAYS_AU_BOARD),
    true,
  );
});

test('isDirectPostingUrl: Hays /job/<ref-number> is accepted', () => {
  // Hays sometimes uses numeric job reference codes
  assert.equal(
    isDirectPostingUrl('https://hays.com.my/job/4567890', HAYS_MY_BOARD),
    true,
  );
});

test('isDirectPostingUrl: Hays homepage is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://hays.com.my/', HAYS_MY_BOARD),
    false,
    'Homepage must not be treated as a direct posting',
  );
});

test('isDirectPostingUrl: Hays /jobs category page is rejected', () => {
  // /jobs (plural) is the listing page; /job/ (singular) is a direct posting
  assert.equal(
    isDirectPostingUrl('https://hays.com.my/jobs/product-management', HAYS_MY_BOARD),
    false,
    '/jobs category page must be rejected; only /job/ (singular) is a direct posting',
  );
});

test('isDirectPostingUrl: Hays /search?q= page is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://hays.com.au/search?q=product+manager', HAYS_AU_BOARD),
    false,
  );
});

// ── LinkedIn: /jobs/view/ ─────────────────────────────────────────────────────

test('isDirectPostingUrl: LinkedIn /jobs/view/<id> is accepted', () => {
  assert.equal(
    isDirectPostingUrl('https://www.linkedin.com/jobs/view/3987654321', LINKEDIN_BOARD),
    true,
  );
});

test('isDirectPostingUrl: LinkedIn /jobs/search is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.linkedin.com/jobs/search/?keywords=product+manager', LINKEDIN_BOARD),
    false,
    '/jobs/search must be rejected as a listing page',
  );
});

test('isDirectPostingUrl: LinkedIn homepage is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.linkedin.com/', LINKEDIN_BOARD),
    false,
  );
});

// ── Randstad: _<city>_<numeric-or-uuid-ref> ───────────────────────────────────
//
// Real Randstad direct-posting URLs observed across active TLDs:
//   MY  /jobs/our-current-vacancies/<slug>_<city>_<numeric-ref>/   (e.g. _kuala-lumpur_47280800/)
//   NZ  /jobs/join-our-team/<slug>_<city>_<numeric-ref>/           (e.g. _wellington_47245312/)
//   AU  /jobs/<slug>_<city>_<uuid>/                                (e.g. _sydney_d95ff90a-d191-...-63cfd6393a27/)
//   CH  /jobs/<slug>_<city>_<uuid>/                                (e.g. _schaffhausen_116bd636-.../)
//   SE  /en/jobs/<slug>_<city>_<uuid>/                             (e.g. _motala_6bcc9649-.../)
//   default (randstad.com) /jobs/<slug>_<city>_<numeric-ref>/      (e.g. _flussbach_47287033/)
// Category/listing pages: /jobs/s-<sector>/, /jobs/jt-<type>/, /jobs/our-current-vacancies/ (bare), etc.
// None of those end with _<city>_<id>, so anchoring the pattern to $ reliably rejects them.

test('isDirectPostingUrl: Randstad MY /jobs/our-current-vacancies/<slug>_<city>_<ref>/ is accepted', () => {
  // Real shape observed on randstad.com.my
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.com.my/jobs/our-current-vacancies/senior-product-manager_kuala-lumpur_47280800/',
      RANDSTAD_BOARD,
    ),
    true,
    'MY direct posting with numeric ref must be accepted',
  );
});

test('isDirectPostingUrl: Randstad AU /jobs/<slug>_<city>_<uuid>/ is accepted', () => {
  // Real shape observed on randstad.com.au (UUID job ref)
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.com.au', validDomains: ['randstad.com.au'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.com.au/jobs/product-manager_sydney_d95ff90a-d191-4742-97a4-63cfd6393a27/',
      board,
    ),
    true,
    'AU direct posting with UUID ref must be accepted',
  );
});

test('isDirectPostingUrl: Randstad NZ /jobs/join-our-team/<slug>_<city>_<ref>/ is accepted', () => {
  // Real shape observed on randstad.co.nz
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.co.nz', validDomains: ['randstad.co.nz'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.co.nz/jobs/join-our-team/product-owner_auckland_47245312/',
      board,
    ),
    true,
    'NZ direct posting with numeric ref must be accepted',
  );
});

test('isDirectPostingUrl: Randstad IE /jobs/our-current-vacancies/<slug>_<city>_<ref>/ is accepted', () => {
  // IE uses same structure as MY/NZ (numeric ref)
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.ie', validDomains: ['randstad.ie'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.ie/jobs/our-current-vacancies/product-owner_dublin_47299876/',
      board,
    ),
    true,
  );
});

test('isDirectPostingUrl: Randstad CH /jobs/<slug>_<city>_<uuid>/ is accepted', () => {
  // Real shape observed on randstad.ch (UUID job ref)
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.ch', validDomains: ['randstad.ch'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.ch/jobs/senior-product-manager_zurich_116bd636-8798-43d8-8b21-29c0859f8f97/',
      board,
    ),
    true,
    'CH direct posting with UUID ref must be accepted',
  );
});

test('isDirectPostingUrl: Randstad SE /en/jobs/<slug>_<city>_<uuid>/ is accepted', () => {
  // Real shape observed on randstad.se — Swedish site uses /en/jobs/ locale prefix
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.se', validDomains: ['randstad.se'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.se/en/jobs/product-manager_stockholm_6bcc9649-64f1-4e90-a436-7aa2d673659b/',
      board,
    ),
    true,
    'SE direct posting with UUID ref under /en/jobs/ must be accepted',
  );
});

test('isDirectPostingUrl: Randstad PL /jobs/<slug>_<city>_<ref>/ is accepted', () => {
  // PL assumed to follow same pattern as default randstad.com (numeric ref)
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.pl', validDomains: ['randstad.pl'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.pl/jobs/product-manager_warsaw_47301234/',
      board,
    ),
    true,
  );
});

test('isDirectPostingUrl: Randstad /jobs/s-<sector>/ listing page is rejected', () => {
  // Sector listing pages — real observed pattern on all TLDs
  assert.equal(
    isDirectPostingUrl('https://www.randstad.com.my/jobs/s-accounting-finance/', RANDSTAD_BOARD),
    false,
    '/jobs/s-<sector>/ listing page must be rejected',
  );
});

test('isDirectPostingUrl: Randstad /jobs/jt-<type>/ listing page is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.randstad.com.au/jobs/jt-permanent/', RANDSTAD_BOARD),
    false,
    '/jobs/jt-<type>/ listing page must be rejected',
  );
});

test('isDirectPostingUrl: Randstad bare /jobs/our-current-vacancies/ listing is rejected', () => {
  // The base sub-listing page (no job slug) must be rejected; only the full slug path is a direct ad
  assert.equal(
    isDirectPostingUrl('https://www.randstad.com.my/jobs/our-current-vacancies/', RANDSTAD_BOARD),
    false,
    'Bare /jobs/our-current-vacancies/ must be rejected',
  );
});

test('isDirectPostingUrl: Randstad bare /jobs/join-our-team/ listing is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.randstad.co.nz/jobs/join-our-team/', RANDSTAD_BOARD),
    false,
    'Bare /jobs/join-our-team/ must be rejected',
  );
});

test('isDirectPostingUrl: Randstad homepage is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.randstad.com.my/', RANDSTAD_BOARD),
    false,
    'Homepage must not be treated as a direct posting',
  );
});

test('isDirectPostingUrl: Randstad bare /jobs/ listing is rejected', () => {
  assert.equal(
    isDirectPostingUrl('https://www.randstad.com.my/jobs/', RANDSTAD_BOARD),
    false,
    'Bare /jobs/ listing page must be rejected',
  );
});

test('isDirectPostingUrl: Randstad default randstad.com /jobs/<slug>_<city>_<ref>/ is accepted', () => {
  // Real shape observed on randstad.com (default fallback domain used when country has no TLD mapping)
  // e.g. /jobs/fertigungsmitarbeiter-mwd_flussbach_47287033/ observed in the wild
  const board: BoardConfig = { ...RANDSTAD_BOARD, domain: 'randstad.com', validDomains: ['randstad.com'] };
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.com/jobs/fertigungsmitarbeiter-mwd_flussbach_47287033/',
      board,
    ),
    true,
    'Default randstad.com direct posting with numeric ref must be accepted',
  );
});

test('isDirectPostingUrl: Randstad direct posting URL with tracking query params is accepted', () => {
  // Randstad URLs sometimes include tracking params; the slug+ref precedes them in the path,
  // so the pattern must tolerate query strings without falsely rejecting real job ads.
  assert.equal(
    isDirectPostingUrl(
      'https://www.randstad.com.my/jobs/our-current-vacancies/senior-product-manager_kuala-lumpur_47280800/?source=email&utm_medium=cpc',
      RANDSTAD_BOARD,
    ),
    true,
    'Direct posting URL with tracking query params must not be rejected',
  );
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('isDirectPostingUrl: malformed URL returns false', () => {
  assert.equal(isDirectPostingUrl('not-a-url', INDEED_BOARD), false);
  assert.equal(isDirectPostingUrl('', INDEED_BOARD), false);
});

test('isDirectPostingUrl: Indeed /viewjob with extra query params is accepted', () => {
  // Boards sometimes add tracking params after jk=; the pattern must still match
  assert.equal(
    isDirectPostingUrl('https://indeed.com/viewjob?jk=abc123&from=serp&vjs=3', INDEED_BOARD),
    true,
  );
});

// ── verifyBoardPatterns — startup canary checks ───────────────────────────────
//
// The probe makes a real network request to each canary URL via the injected
// liveCheckFn, then confirms the URL matches the board's directUrlPatterns.
// Tests inject an instant mock for liveCheckFn to avoid real network calls.

/** Minimal board fixtures for verifyBoardPatterns tests. */
const VERIFY_INDEED_BOARD: BoardConfig = {
  name: 'Indeed',
  domain: 'indeed.com',
  urlHint: 'URLs containing /viewjob?jk=',
  validDomains: ['indeed.com'],
  directUrlPatterns: [/\/viewjob\?.*jk=/, /\/rc\/clk\?.*jk=/],
};

const VERIFY_HAYS_BOARD: BoardConfig = {
  name: 'Hays',
  domain: 'hays.com.my',
  urlHint: 'a URL on hays.com.my that contains /job/',
  validDomains: ['hays.com.my'],
  directUrlPatterns: [/\/job\//],
};

const VERIFY_RANDSTAD_BOARD: BoardConfig = {
  name: 'Randstad',
  domain: 'randstad.com.my',
  urlHint: 'any URL on randstad.com.my',
  validDomains: ['randstad.com.my'],
  // No directUrlPatterns — probe must skip this board entirely
};

test('verifyBoardPatterns: canary is live and matches pattern → no warning', async () => {
  const alwaysLive = async (_url: string) => true;

  const boards = [VERIFY_INDEED_BOARD];
  const canaryUrls = { Indeed: 'https://indeed.com/viewjob?jk=abc123def456' };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, canaryUrls, alwaysLive);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnings.length, 0, `No warnings expected when canary is live and matches. Got: ${warnings.join('\n')}`);
});

test('verifyBoardPatterns: dead canary (404) → warns canary is stale', async () => {
  // Models: a job posting expires; the canary URL now returns 404.
  // The probe must warn so the canary can be refreshed before the next pattern change goes undetected.
  const alwaysDead = async (_url: string) => false;

  const boards = [VERIFY_INDEED_BOARD];
  const canaryUrls = { Indeed: 'https://indeed.com/viewjob?jk=expired12345678' };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, canaryUrls, alwaysDead);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the dead canary URL');
  assert.ok(
    warnings.some((w) => w.includes('Indeed') && w.includes('dead')),
    `Warning must mention the board name and dead status. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: canary is live but URL structure changed → warns pattern is broken', async () => {
  // Models the key failure mode: the board changed its URL structure from /viewjob?jk=
  // to a new path, but the canary was updated to the new format while the regex was not.
  // The canary is live (200) but no longer matches directUrlPatterns → warning.
  const alwaysLive = async (_url: string) => true;

  const boards = [VERIFY_INDEED_BOARD]; // regex still expects /viewjob?jk=
  const canaryUrls = {
    // Canary updated to board's new hypothetical URL format, but regex not updated yet
    Indeed: 'https://indeed.com/apply?job_id=abc123def456',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, canaryUrls, alwaysLive);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the pattern mismatch');
  assert.ok(
    warnings.some((w) => w.includes('Indeed') && w.includes('no longer matches')),
    `Warning must name the board and report pattern mismatch. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: board has directUrlPatterns but no canary URL → warns about blind spot', async () => {
  // A board with URL filtering but no canary configured is silently unmonitored.
  // The probe must warn so the gap is closed.
  const alwaysLive = async (_url: string) => true;

  const boards = [VERIFY_HAYS_BOARD];
  const emptyCanary: Record<string, string> = {}; // Hays not configured

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, emptyCanary, alwaysLive);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the missing canary URL');
  assert.ok(
    warnings.some((w) => w.includes('Hays') && w.includes('no canary URL')),
    `Warning must name the board and report missing canary. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: boards without directUrlPatterns are silently skipped', async () => {
  // Randstad-style boards (no path constraints) must produce no output — no warning, no OK log.
  const alwaysLive = async (_url: string) => true;

  const boards = [VERIFY_RANDSTAD_BOARD];
  const canary = { Randstad: 'https://randstad.com.my/jobs/product-manager-kl-ref123' };

  const logged: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => { logged.push(args.join(' ')); };
  console.warn = (...args: any[]) => { logged.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, canary, alwaysLive);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  assert.equal(logged.length, 0, 'No output expected for boards without directUrlPatterns');
});

test('verifyBoardPatterns: multiple boards — only the broken one emits a warning', async () => {
  // Indeed canary is dead; Hays canary is live and correct. Only Indeed warns.
  const mockLive = async (url: string) => url.includes('hays'); // Hays lives, Indeed dead

  const boards = [VERIFY_INDEED_BOARD, VERIFY_HAYS_BOARD];
  const canaryUrls = {
    Indeed: 'https://indeed.com/viewjob?jk=expired00000000',
    Hays:   'https://hays.com.my/job/senior-product-manager-kl-4500143',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, canaryUrls, mockLive);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.some((w) => w.includes('Indeed')), 'Indeed dead canary must warn');
  assert.ok(!warnings.some((w) => w.includes('Hays')), 'Hays live+matching canary must not warn');
});

// ── RANDSTAD_CANARY_URLS — fixture validity ────────────────────────────────────
//
// These tests confirm that every entry in RANDSTAD_CANARY_URLS matches the
// shared Randstad directUrlPatterns regex. They catch a misconfigured fixture
// (e.g. someone pasting a listing-page URL as the canary) before it reaches CI.

const RANDSTAD_PATTERN_BOARD: BoardConfig = {
  name: 'Randstad',
  domain: 'randstad.com.my',
  urlHint: 'a Randstad direct-posting URL ending with _<city>_<numeric-or-uuid-ref>/',
  validDomains: ['randstad.com.my'],
  directUrlPatterns: [/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{5,})\/?(?:[?#].*)?$/i],
};

test('RANDSTAD_CANARY_URLS: every entry matches the shared directUrlPatterns regex', () => {
  // Each canary URL must be a direct-posting URL (not a listing page) so the
  // verifyBoardPatterns probe can actually detect a URL-structure change.
  for (const [domain, url] of Object.entries(RANDSTAD_CANARY_URLS)) {
    const tldBoard: BoardConfig = { ...RANDSTAD_PATTERN_BOARD, validDomains: [domain] };
    assert.equal(
      isDirectPostingUrl(url, tldBoard),
      true,
      `RANDSTAD_CANARY_URLS['${domain}'] = '${url}' must match directUrlPatterns`,
    );
  }
});

test('RANDSTAD_CANARY_URLS: covers all active Randstad TLDs with verified live URLs', () => {
  // IE and PL are intentionally omitted — randstad.ie migrated to co.uk/ireland/
  // and randstad.pl removed its /jobs/ path as of 2026-08. Add them back once
  // valid regional direct-posting URLs are confirmed.
  const expected = [
    'randstad.com.my',
    'randstad.com.au',
    'randstad.co.nz',
    'randstad.ch',
    'randstad.se',
  ];
  for (const domain of expected) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(RANDSTAD_CANARY_URLS, domain),
      `Missing canary for Randstad TLD: ${domain}`,
    );
  }
  // Confirm the known-broken TLDs are absent so no false-OK is logged for them
  assert.ok(
    !Object.prototype.hasOwnProperty.call(RANDSTAD_CANARY_URLS, 'randstad.ie'),
    'randstad.ie must not be in RANDSTAD_CANARY_URLS until a live IE URL is confirmed',
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(RANDSTAD_CANARY_URLS, 'randstad.pl'),
    'randstad.pl must not be in RANDSTAD_CANARY_URLS until a live PL URL is confirmed',
  );
});

test('RANDSTAD_CANARY_URLS: no entry is a listing-page URL (numeric ref must be 5+ digits or UUID)', () => {
  // Guard against accidentally storing a category page (e.g. /jobs/our-current-vacancies/)
  // as the canary. The pattern requires either a 5+ digit numeric ref or a full UUID.
  for (const [domain, url] of Object.entries(RANDSTAD_CANARY_URLS)) {
    assert.ok(
      !url.endsWith('/jobs/') &&
      !url.endsWith('/jobs/our-current-vacancies/') &&
      !url.endsWith('/jobs/join-our-team/'),
      `RANDSTAD_CANARY_URLS['${domain}'] looks like a listing page: ${url}`,
    );
  }
});

// ── verifyBoardPatterns — Randstad per-TLD canary checks ──────────────────────

/** Minimal board fixture with Randstad's shared directUrlPatterns — used in
 *  verifyBoardPatterns tests that exercise the per-TLD Randstad loop. */
const VERIFY_RANDSTAD_WITH_PATTERNS: BoardConfig = {
  name: 'Randstad',
  domain: 'randstad.com.my',
  urlHint: 'a Randstad direct-posting URL',
  validDomains: ['randstad.com.my'],
  directUrlPatterns: [/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{5,})\/?(?:[?#].*)?$/i],
};

test('verifyBoardPatterns: all Randstad TLD canaries live and matching → no warning, OK logs emitted', async () => {
  const alwaysLive = async (_url: string) => true;

  const randstadCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/senior-product-manager_kuala-lumpur_47280800/',
    'randstad.com.au': 'https://www.randstad.com.au/jobs/product-manager_sydney_d95ff90a-d191-4742-97a4-63cfd6393a27/',
  };

  const warnings: string[] = [];
  const logs: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  console.log  = (...args: any[]) => { logs.push(args.join(' ')); };
  try {
    await verifyBoardPatterns([VERIFY_RANDSTAD_WITH_PATTERNS], {}, alwaysLive, randstadCanaries);
  } finally {
    console.warn = origWarn;
    console.log  = origLog;
  }

  assert.equal(warnings.length, 0, `No warnings expected when all Randstad canaries are live and matching. Got: ${warnings.join('\n')}`);
  assert.equal(logs.filter((l) => l.includes('[BOARD PATTERN] OK')).length, 2, 'Expected one OK log per TLD');
});

test('verifyBoardPatterns: dead Randstad TLD canary (404) → warns with TLD domain name', async () => {
  // Models: the randstad.com.au posting expires; the other TLD canary is still live.
  const mockLive = async (url: string) => !url.includes('randstad.com.au');

  const randstadCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/pm_kuala-lumpur_47280800/',
    'randstad.com.au': 'https://www.randstad.com.au/jobs/pm_sydney_d95ff90a-d191-4742-97a4-63cfd6393a27/',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns([VERIFY_RANDSTAD_WITH_PATTERNS], {}, mockLive, randstadCanaries);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the dead AU canary');
  assert.ok(
    warnings.some((w) => w.includes('randstad.com.au') && w.includes('dead')),
    `Warning must name the TLD domain and report dead status. Got: ${warnings.join('\n')}`,
  );
  assert.ok(
    !warnings.some((w) => w.includes('randstad.com.my')),
    'Live MY canary must not produce a warning',
  );
});

test('verifyBoardPatterns: live Randstad TLD canary that no longer matches pattern → warns with TLD domain name', async () => {
  // Models: Randstad AU changes its URL structure to a new path that the regex does not match.
  // The canary posting is still live (returns 200) but isDirectPostingUrl now returns false.
  const alwaysLive = async (_url: string) => true;

  const randstadCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/pm_kuala-lumpur_47280800/',
    // AU has switched to a hypothetical new URL format that does not end with _<id>
    'randstad.com.au': 'https://www.randstad.com.au/jobs/all-jobs/product-manager/',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns([VERIFY_RANDSTAD_WITH_PATTERNS], {}, alwaysLive, randstadCanaries);
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the pattern mismatch on AU');
  assert.ok(
    warnings.some((w) => w.includes('randstad.com.au') && w.includes('no longer matches')),
    `Warning must name the TLD domain and report pattern mismatch. Got: ${warnings.join('\n')}`,
  );
  assert.ok(
    !warnings.some((w) => w.includes('randstad.com.my')),
    'MY canary that still matches must not produce a warning',
  );
});

test('verifyBoardPatterns: Randstad board without directUrlPatterns → per-TLD loop is skipped entirely', async () => {
  // When the injected Randstad board has no directUrlPatterns (simulates a future
  // config that drops the patterns), the per-TLD loop must produce no output at all.
  const alwaysLive = async (_url: string) => true;

  // Use VERIFY_RANDSTAD_BOARD (no directUrlPatterns) as the injected board
  const boards: BoardConfig[] = [{
    name: 'Randstad',
    domain: 'randstad.com.my',
    urlHint: '',
    validDomains: ['randstad.com.my'],
    // deliberately no directUrlPatterns
  }];

  const randstadCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/pm_kuala-lumpur_47280800/',
  };

  const logged: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log  = (...args: any[]) => { logged.push(args.join(' ')); };
  console.warn = (...args: any[]) => { logged.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(boards, {}, alwaysLive, randstadCanaries);
  } finally {
    console.log  = origLog;
    console.warn = origWarn;
  }

  assert.equal(logged.length, 0, 'No output expected when Randstad board has no directUrlPatterns');
});

// ── verifyBoardPatterns — redirect-aware canary checks ────────────────────────
//
// These tests verify that a canary URL which is "live" (returns 3xx instead of
// 404/410) but redirects to a generic/homepage URL is correctly detected as
// stale — rather than producing a false-positive "OK" because the original URL
// happens to match the directUrlPatterns regex.
//
// The real-world trigger: Randstad IE redirects all /jobs/our-current-vacancies/
// paths to randstad.co.uk/ireland/ instead of returning 404 for expired postings.
// Without redirect-following, checkUrlLive returns true (3xx = live) and
// isDirectPostingUrl(originalUrl) returns true (original URL matches pattern),
// giving a false "OK". With resolveFinalUrlFn injected, the final URL
// (https://www.randstad.ie/) is checked — it does NOT match the pattern →
// correct warning is emitted.

test('verifyBoardPatterns: canary that redirects to generic homepage → warns "redirects to non-posting URL"', async () => {
  // Models Randstad IE behaviour: canary is "live" (3xx) but redirects to homepage.
  const alwaysLive = async (_url: string) => true;
  // Simulate 301 → homepage
  const redirectsToHomepage = async (_url: string) => 'https://www.randstad.ie/';

  const randstadCanaries: Record<string, string> = {
    'randstad.ie': 'https://www.randstad.ie/jobs/our-current-vacancies/product-owner_dublin_47299876/',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [VERIFY_RANDSTAD_WITH_PATTERNS],
      {},
      alwaysLive,
      randstadCanaries,
      redirectsToHomepage,
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the redirect to a non-posting URL');
  assert.ok(
    warnings.some((w) => w.includes('randstad.ie') && w.includes('redirect')),
    `Warning must name the TLD domain and report the redirect. Got: ${warnings.join('\n')}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('https://www.randstad.ie/')),
    `Warning must include the redirect destination URL. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: canary redirects but final URL still matches pattern → no warning, OK logged', async () => {
  // Models a canonical redirect (e.g. http → https, or a slug change that
  // preserves the _<city>_<id> suffix). The final URL still matches the pattern
  // so no warning should be emitted.
  const alwaysLive = async (_url: string) => true;
  // Simulate a redirect that preserves the posting-URL shape
  const redirectsToCanonical = async (_url: string) =>
    'https://www.randstad.com.my/jobs/our-current-vacancies/pm-canonical_kuala-lumpur_47280800/';

  const randstadCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/pm_kuala-lumpur_47280800/',
  };

  const warnings: string[] = [];
  const logs: string[] = [];
  const origWarn = console.warn;
  const origLog  = console.log;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  console.log  = (...args: any[]) => { logs.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [VERIFY_RANDSTAD_WITH_PATTERNS],
      {},
      alwaysLive,
      randstadCanaries,
      redirectsToCanonical,
    );
  } finally {
    console.warn = origWarn;
    console.log  = origLog;
  }

  assert.equal(warnings.length, 0, `No warnings expected for canonical redirect. Got: ${warnings.join('\n')}`);
  assert.ok(logs.some((l) => l.includes('[BOARD PATTERN] OK')), 'OK log must be emitted');
});

test('verifyBoardPatterns: main board loop (non-Randstad) canary redirect to generic page → warns', async () => {
  // Confirms redirect-aware checking also applies to the per-board loop
  // (LinkedIn, Indeed, Hays), not only the Randstad per-TLD loop.
  const alwaysLive = async (_url: string) => true;
  // Indeed canary redirects to the homepage instead of returning 404
  const redirectsToHomepage = async (_url: string) => 'https://indeed.com/';

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [VERIFY_INDEED_BOARD],
      { Indeed: 'https://indeed.com/viewjob?jk=expired00000' },
      alwaysLive,
      {},
      redirectsToHomepage,
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the redirect to a non-posting URL');
  assert.ok(
    warnings.some((w) => w.includes('Indeed') && w.includes('redirect')),
    `Warning must name the board and report the redirect. Got: ${warnings.join('\n')}`,
  );
});

// ── verifyBoardPatterns — coverage-gap warnings for uncovered Randstad TLDs ───
//
// When verifyBoardPatterns is called from runDailyJobSearch it receives the board
// configs for today's country (e.g. Randstad with validDomains: ['randstad.ie']
// on Ireland days). If that TLD has no entry in RANDSTAD_CANARY_URLS the probe
// cannot verify the URL pattern for that region. These tests confirm an explicit
// warning is emitted rather than silently skipping the check.

test('verifyBoardPatterns: searched Randstad TLD has no canary → warns about missing coverage', async () => {
  // Models an Ireland-day run: the board is randstad.ie but no canary exists for it.
  const alwaysLive = async (_url: string) => true;
  const identityResolve = async (url: string) => url;

  // Pass an empty canary map — simulates IE/PL having no entry
  const emptyRandstadCanaries: Record<string, string> = {};

  const irlBoard: BoardConfig = {
    ...VERIFY_RANDSTAD_WITH_PATTERNS,
    validDomains: ['randstad.ie'],
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [irlBoard],
      {},
      alwaysLive,
      emptyRandstadCanaries,
      identityResolve,
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a coverage-gap warning for randstad.ie with no canary configured');
  assert.ok(
    warnings.some((w) => w.includes('randstad.ie') && w.includes('no canary')),
    `Warning must name the TLD and mention "no canary". Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: searched Randstad TLD is covered by canary → no coverage-gap warning', async () => {
  // Models a Malaysia-day run where randstad.com.my has a canary entry.
  const alwaysLive = async (_url: string) => true;
  const identityResolve = async (url: string) => url;

  const myCanaries: Record<string, string> = {
    'randstad.com.my': 'https://www.randstad.com.my/jobs/our-current-vacancies/pm_kuala-lumpur_47280800/',
  };

  const myBoard: BoardConfig = {
    ...VERIFY_RANDSTAD_WITH_PATTERNS,
    validDomains: ['randstad.com.my'],
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [myBoard],
      {},
      alwaysLive,
      myCanaries,
      identityResolve,
    );
  } finally {
    console.warn = origWarn;
  }

  const coverageGapWarnings = warnings.filter((w) => w.includes('no canary'));
  assert.equal(
    coverageGapWarnings.length, 0,
    `No coverage-gap warning expected when the TLD has a canary. Got: ${coverageGapWarnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: Randstad TLD canary redirects to a different domain → warns "different domain"', async () => {
  // Models Randstad IE: the canary redirects 301 to randstad.co.uk/ireland/
  // which is a DIFFERENT domain from randstad.ie. Without a hostname check,
  // if that destination URL happened to contain a matching path suffix it would
  // pass as OK — this test ensures the cross-domain redirect is always flagged.
  const alwaysLive = async (_url: string) => true;
  // Simulate 301 → randstad.co.uk (different domain, not randstad.ie)
  const redirectsToDifferentDomain = async (_url: string) =>
    'https://www.randstad.co.uk/ireland/';

  const randstadCanaries: Record<string, string> = {
    'randstad.ie': 'https://www.randstad.ie/jobs/our-current-vacancies/product-owner_dublin_47299876/',
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [VERIFY_RANDSTAD_WITH_PATTERNS],
      {},
      alwaysLive,
      randstadCanaries,
      redirectsToDifferentDomain,
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the cross-domain redirect');
  assert.ok(
    warnings.some((w) => w.includes('randstad.ie') && w.includes('different domain')),
    `Warning must name the TLD domain and report "different domain". Got: ${warnings.join('\n')}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('randstad.co.uk')),
    `Warning must include the redirect destination. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: main board loop canary redirects to a different domain → warns "different domain"', async () => {
  // Confirms cross-domain redirect detection also applies to the per-board loop
  // (LinkedIn, Indeed, Hays), not only the Randstad per-TLD loop.
  // Example scenario: Indeed migrates postings to a partner domain.
  const alwaysLive = async (_url: string) => true;
  // Indeed canary redirects to a completely different domain
  const redirectsToDifferentDomain = async (_url: string) =>
    'https://www.glassdoor.com/job-listing/12345';

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    await verifyBoardPatterns(
      [VERIFY_INDEED_BOARD],
      { Indeed: 'https://au.indeed.com/viewjob?jk=abc123' },
      alwaysLive,
      {},
      redirectsToDifferentDomain,
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warnings.length > 0, 'Expected a warning about the cross-domain redirect');
  assert.ok(
    warnings.some((w) => w.includes('Indeed') && w.includes('different domain')),
    `Warning must name the board and report "different domain". Got: ${warnings.join('\n')}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('glassdoor.com')),
    `Warning must include the redirect destination. Got: ${warnings.join('\n')}`,
  );
});

test('verifyBoardPatterns: resolveCanaryFinalUrl is exported and is a function', () => {
  // Smoke-test: confirms the function is exported correctly so server/index.ts
  // can import and pass it as the 5th argument.
  assert.equal(typeof resolveCanaryFinalUrl, 'function', 'resolveCanaryFinalUrl must be an exported function');
});

// ── getBoardConfigs — Randstad inclusion/exclusion policy per active TLD ──────
//
// For every country in RANDSTAD_TLD, getBoardConfigs must either:
//   (a) include Randstad in the returned board list (TLD has a verified canary), OR
//   (b) exclude Randstad and log a warning (TLD has no verified canary — known site
//       migration or domain restructure).
// Policy: never search under an unverified directUrlPatterns filter; it would
// silently reject every Randstad URL Claude returns for that country.

test('getBoardConfigs: Ireland → Randstad excluded (randstad.ie has no canary) + warning logged', () => {
  // randstad.ie redirects all /jobs/ paths to randstad.co.uk/ireland/ (site migration).
  // Until a live IE direct-posting URL is confirmed the board must be excluded.
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  let boards: BoardConfig[];
  try {
    boards = getBoardConfigs('Ireland');
  } finally {
    console.warn = origWarn;
  }

  const randstadBoard = boards.find((b) => b.name === 'Randstad');
  assert.equal(
    randstadBoard, undefined,
    'Randstad must not be included in Ireland board configs — randstad.ie has no verified canary',
  );
  assert.ok(
    warnings.some((w) => w.includes('randstad.ie') && w.includes('excluded')),
    `A warning about the exclusion must be logged. Got: ${warnings.join('\n')}`,
  );
});

test('getBoardConfigs: Poland → Randstad excluded (randstad.pl has no canary) + warning logged', () => {
  // randstad.pl returns 404 for all /jobs/ paths (domain restructure).
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  let boards: BoardConfig[];
  try {
    boards = getBoardConfigs('Poland');
  } finally {
    console.warn = origWarn;
  }

  const randstadBoard = boards.find((b) => b.name === 'Randstad');
  assert.equal(
    randstadBoard, undefined,
    'Randstad must not be included in Poland board configs — randstad.pl has no verified canary',
  );
  assert.ok(
    warnings.some((w) => w.includes('randstad.pl') && w.includes('excluded')),
    `A warning about the exclusion must be logged. Got: ${warnings.join('\n')}`,
  );
});

test('getBoardConfigs: Malaysia → Randstad included (randstad.com.my has a verified canary)', () => {
  const boards = getBoardConfigs('Malaysia');
  const randstadBoard = boards.find((b) => b.name === 'Randstad');
  assert.ok(
    randstadBoard !== undefined,
    'Randstad must be included in Malaysia board configs — randstad.com.my has a verified canary',
  );
  assert.equal(randstadBoard?.validDomains?.[0], 'randstad.com.my');
});

test('getBoardConfigs: every active RANDSTAD_TLD country is either included-with-canary or excluded-with-warning', () => {
  // Exhaustive policy check: for every country that maps to a Randstad TLD, the
  // board config must be consistent with RANDSTAD_CANARY_URLS.
  // Countries that should be included (have verified canaries):
  const shouldInclude: string[] = ['Malaysia', 'Australia', 'New Zealand', 'Switzerland', 'Sweden'];
  // Countries that should be excluded (known broken TLDs):
  const shouldExclude: string[] = ['Ireland', 'Poland'];

  for (const country of shouldInclude) {
    const boards = getBoardConfigs(country);
    const randstadBoard = boards.find((b) => b.name === 'Randstad');
    assert.ok(
      randstadBoard !== undefined,
      `${country} must include Randstad — its TLD has a verified canary in RANDSTAD_CANARY_URLS`,
    );
  }

  for (const country of shouldExclude) {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    let boards: BoardConfig[];
    try {
      boards = getBoardConfigs(country);
    } finally {
      console.warn = origWarn;
    }
    const randstadBoard = boards.find((b) => b.name === 'Randstad');
    assert.equal(
      randstadBoard, undefined,
      `${country} must NOT include Randstad — its TLD has no verified canary`,
    );
    assert.ok(
      warnings.some((w) => w.includes('excluded')),
      `${country}: expected a warning about Randstad exclusion. Got: ${warnings.join('\n')}`,
    );
  }
});

// ── resolveCanaryFinalUrl — SSRF protection for IP-literal redirect targets ──
//
// Node bypasses the custom `lookup` hook when a redirect's Location header
// points to an IP literal (e.g. http://127.0.0.1/).  The lookup hook is only
// called during DNS resolution — IP literals connect directly without it.
// These tests verify that resolveCanaryFinalUrl rejects private-IP-literal
// redirect targets BEFORE opening any socket, so no connection is made.

import { EventEmitter } from 'node:events';

/** Build a minimal mock http.ClientRequest that never does anything. */
function makeNullReq() {
  const emitter = new EventEmitter() as any;
  emitter.end = () => {};
  emitter.destroy = () => {};
  return emitter;
}

/** Build a minimal mock http.IncomingMessage that looks like a 301 redirect. */
function makeRedirectRes(location: string) {
  const emitter = new EventEmitter() as any;
  emitter.statusCode = 301;
  emitter.headers = { location };
  emitter.destroy = () => {};
  return emitter;
}

test('resolveCanaryFinalUrl SSRF: startUrl with 127.0.0.1 literal → returns URL unchanged, http.request NOT called', async () => {
  // The function must detect the private IP at hop 0 and return immediately.
  const httpCalls: string[] = [];
  const m = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('http://127.0.0.1/admin');
    assert.equal(result, 'http://127.0.0.1/admin', 'Must return the original URL unchanged');
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for a 127.0.0.1 URL');
  } finally {
    m.mock.restore();
  }
});

test('resolveCanaryFinalUrl SSRF: redirect to 127.0.0.1 → no http.request made to private IP', async () => {
  // Simulates: https://www.randstad.ie/canary → 301 → http://127.0.0.1:8080/
  // Expected: one HTTPS request to the legitimate host; zero HTTP requests to 127.0.0.1.
  const httpCalls: string[] = [];
  const httpsM = mock.method(https, 'request', (opts: any, callback: any) => {
    // Simulate the legitimate host returning a 301 to a private IP
    const res = makeRedirectRes('http://127.0.0.1:8080/');
    setTimeout(() => callback(res), 0);
    return makeNullReq();
  });
  const httpM = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('https://www.randstad.ie/jobs/canary_dublin_47299876/');
    assert.equal(result, 'http://127.0.0.1:8080/', 'Must return the redirect destination unchanged (not followed)');
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for the 127.0.0.1 redirect target');
  } finally {
    httpsM.mock.restore();
    httpM.mock.restore();
  }
});

test('resolveCanaryFinalUrl SSRF: redirect to RFC1918 192.168.x.x → no connection made', async () => {
  const httpCalls: string[] = [];
  const httpsM = mock.method(https, 'request', (opts: any, callback: any) => {
    const res = makeRedirectRes('http://192.168.1.1/');
    setTimeout(() => callback(res), 0);
    return makeNullReq();
  });
  const httpM = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('https://example.com/canary');
    assert.equal(result, 'http://192.168.1.1/', 'Must return the redirect destination unchanged (not followed)');
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for a 192.168.x.x redirect target');
  } finally {
    httpsM.mock.restore();
    httpM.mock.restore();
  }
});

test('resolveCanaryFinalUrl SSRF: redirect to link-local 169.254.x.x → no connection made', async () => {
  // 169.254.169.254 is the cloud metadata endpoint (AWS/GCP/Azure).
  const httpCalls: string[] = [];
  const httpsM = mock.method(https, 'request', (opts: any, callback: any) => {
    const res = makeRedirectRes('http://169.254.169.254/latest/meta-data/');
    setTimeout(() => callback(res), 0);
    return makeNullReq();
  });
  const httpM = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('https://example.com/canary');
    assert.equal(result, 'http://169.254.169.254/latest/meta-data/', 'Must return the redirect destination unchanged (not followed)');
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for a link-local metadata redirect target');
  } finally {
    httpsM.mock.restore();
    httpM.mock.restore();
  }
});

test('resolveCanaryFinalUrl SSRF: startUrl with IPv6 loopback [::1] literal → returns unchanged, no connection made', async () => {
  // Tests the same guard (hop-0 IP-literal check) as a "redirect to [::1]" scenario —
  // the SSRF guard fires at the start of every hop before any socket is opened,
  // so the code path is identical whether the IP arrives as the start URL or via a
  // Location redirect header. Using a direct startUrl avoids HTTPS mock fragility.
  const httpCalls: string[] = [];
  const m = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('http://[::1]:8080/');
    assert.equal(result, 'http://[::1]:8080/', 'IPv6 loopback URL must be returned unchanged (guard fires on hop 0)');
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for an IPv6 loopback startUrl');
  } finally {
    m.mock.restore();
  }
});

test('resolveCanaryFinalUrl SSRF: startUrl with ULA IPv6 [fc00::1] literal → returns unchanged, no connection made', async () => {
  // fc00::/7 (fc and fd prefixes) are Unique Local Addresses (RFC 4193).
  // Same guard as above — same hop-0 code path that also fires for redirect destinations.
  const httpCalls: string[] = [];
  const m = mock.method(http, 'request', (opts: any, _cb: any) => {
    httpCalls.push(opts?.hostname ?? String(opts));
    return makeNullReq();
  });
  try {
    const result = await resolveCanaryFinalUrl('http://[fc00::1]/internal/');
    assert.ok(
      result.includes('fc00'),
      `Must return the ULA IPv6 URL unchanged (guard fires on hop 0). Got: ${result}`,
    );
    assert.equal(httpCalls.length, 0, 'http.request must NOT be called for a ULA IPv6 startUrl');
  } finally {
    m.mock.restore();
  }
});

// ── findStaleness unit tests ──────────────────────────────────────────────────

test('findStaleness: expired validThrough → returns stale reason', () => {
  // validThrough is a date well in the past — the posting explicitly expired
  const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
  const body = `<script type="application/ld+json">{"@type":"JobPosting","validThrough":"${pastDate}"}</script>`;
  const result = findStaleness(body);
  assert.ok(result !== null, 'Should detect expired validThrough as stale');
  assert.ok(result!.includes('validThrough'), `Reason should mention validThrough, got: ${result}`);
});

test('findStaleness: validThrough in the future → returns null (live)', () => {
  // validThrough is tomorrow — the posting has not yet expired
  const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const body = `<script type="application/ld+json">{"@type":"JobPosting","validThrough":"${futureDate}"}</script>`;
  const result = findStaleness(body);
  assert.equal(result, null, 'Future validThrough should not be flagged as stale');
});

test(`findStaleness: datePosted older than ${MAX_POSTING_AGE_DAYS} days → returns stale reason`, () => {
  const oldDate = new Date(Date.now() - (MAX_POSTING_AGE_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const body = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"${oldDate}"}</script>`;
  const result = findStaleness(body);
  assert.ok(result !== null, `datePosted ${MAX_POSTING_AGE_DAYS + 5} days old should be stale`);
  assert.ok(result!.includes('datePosted'), `Reason should mention datePosted, got: ${result}`);
});

test(`findStaleness: datePosted exactly at the limit (${MAX_POSTING_AGE_DAYS} days) → returns null (not yet stale)`, () => {
  // Exactly MAX_POSTING_AGE_DAYS ago — the check is strictly "older than", so the boundary is not stale
  const borderDate = new Date(Date.now() - MAX_POSTING_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const body = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"${borderDate}"}</script>`;
  const result = findStaleness(body);
  // Whether exactly at the limit passes or fails depends on sub-second timing, so we only verify
  // that a datePosted 1 ms newer than the limit is never stale (the strict inequality).
  const freshDate = new Date(Date.now() - (MAX_POSTING_AGE_DAYS * 24 * 60 * 60 * 1000) + 60_000).toISOString();
  const freshBody = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"${freshDate}"}</script>`;
  assert.equal(findStaleness(freshBody), null, 'datePosted 1 min inside the window should not be stale');
});

test(`findStaleness: datePosted within ${MAX_POSTING_AGE_DAYS} days → returns null (live)`, () => {
  const recentDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 1 week ago
  const body = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"${recentDate}"}</script>`;
  const result = findStaleness(body);
  assert.equal(result, null, 'Recent datePosted (1 week old) should not be stale');
});

test('findStaleness: malformed validThrough date string → fails open (returns null)', () => {
  // Non-parseable date value must not throw and must not flag the posting as stale
  const body = `<script type="application/ld+json">{"@type":"JobPosting","validThrough":"not-a-date"}</script>`;
  const result = findStaleness(body);
  assert.equal(result, null, 'Malformed validThrough should fail open, not flag as stale');
});

test('findStaleness: malformed datePosted date string → fails open (returns null)', () => {
  const body = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"??/??/????"}</script>`;
  const result = findStaleness(body);
  assert.equal(result, null, 'Malformed datePosted should fail open, not flag as stale');
});

test('findStaleness: no structured data at all → fails open (returns null)', () => {
  const body = '<html><body><h1>Senior Engineer</h1><p>Apply now!</p></body></html>';
  const result = findStaleness(body);
  assert.equal(result, null, 'Page without JSON-LD structured data should fail open');
});

test('findStaleness: JSON-LD present but no date fields → fails open (returns null)', () => {
  const body = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","hiringOrganization":{"name":"Acme"}}</script>`;
  const result = findStaleness(body);
  assert.equal(result, null, 'Structured data without date fields should fail open');
});

test('findStaleness: empty string body → fails open (returns null)', () => {
  assert.equal(findStaleness(''), null, 'Empty body should fail open');
});

// ── checkUrlLive + skipStalenessCheck integration tests ──────────────────────

test('checkUrlLive: expired validThrough in response body → returns false (stale)', async () => {
  const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleBody = `<html><body><script type="application/ld+json">{"@type":"JobPosting","validThrough":"${pastDate}"}</script></body></html>`;
  mockRequest(https, 200, staleBody);
  const live = await checkUrlLive('https://example-board.com/jobs/123');
  assert.equal(live, false, 'Posting with expired validThrough should be treated as dead');
});

test('checkUrlLive with skipStalenessCheck: expired validThrough in body → returns true (staleness bypassed)', async () => {
  // The canary verifier passes skipStalenessCheck: true so old canary postings
  // (whose validThrough has long since passed) are not false-flagged as dead.
  const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleBody = `<html><body><script type="application/ld+json">{"@type":"JobPosting","validThrough":"${pastDate}"}</script></body></html>`;
  mockRequest(https, 200, staleBody);
  const live = await checkUrlLive('https://example-board.com/jobs/canary-123', { skipStalenessCheck: true });
  assert.equal(live, true, 'skipStalenessCheck should bypass expired validThrough check');
});

test('checkUrlLive with skipStalenessCheck: old datePosted in body → returns true (staleness bypassed)', async () => {
  const oldDate = new Date(Date.now() - (MAX_POSTING_AGE_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString();
  const staleBody = `<html><body><script type="application/ld+json">{"@type":"JobPosting","datePosted":"${oldDate}"}</script></body></html>`;
  mockRequest(https, 200, staleBody);
  const live = await checkUrlLive('https://example-board.com/jobs/old-canary', { skipStalenessCheck: true });
  assert.equal(live, true, 'skipStalenessCheck should bypass old datePosted check');
});

test('checkUrlLive: old datePosted without skipStalenessCheck → returns false (stale)', async () => {
  const oldDate = new Date(Date.now() - (MAX_POSTING_AGE_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString();
  const staleBody = `<html><body><script type="application/ld+json">{"@type":"JobPosting","datePosted":"${oldDate}"}</script></body></html>`;
  mockRequest(https, 200, staleBody);
  const live = await checkUrlLive('https://example-board.com/jobs/old-posting');
  assert.equal(live, false, 'Old datePosted without skipStalenessCheck should be treated as dead');
});
