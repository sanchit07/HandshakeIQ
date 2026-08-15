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
  urlHint: 'a URL on randstad.com.my that includes a job reference number or job slug',
  validDomains: ['randstad.com.my'],
  // No directUrlPatterns — Randstad slugs vary; any path on the valid domain is accepted
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

// ── Randstad: no path restriction ─────────────────────────────────────────────

test('isDirectPostingUrl: Randstad any path is accepted (no directUrlPatterns defined)', () => {
  // Randstad slug patterns vary by country — we don't enforce a path constraint
  assert.equal(
    isDirectPostingUrl('https://randstad.com.my/jobs/product-manager-kuala-lumpur-ref123', RANDSTAD_BOARD),
    true,
  );
  assert.equal(
    isDirectPostingUrl('https://randstad.com.my/', RANDSTAD_BOARD),
    true,
    'Even homepage is accepted when no directUrlPatterns are set (hostname check is the guard)',
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
