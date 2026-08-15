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
