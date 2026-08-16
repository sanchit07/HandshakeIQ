/**
 * Regression tests for the email registration route.
 *
 * Run with:  npm run test:register
 *
 * Covers the account-takeover vulnerability where unauthenticated registration
 * with an existing OAuth-only user's email could silently claim their account.
 * With the fix (server/routes.ts), ANY existing user — with or without a
 * passwordHash — causes the endpoint to return 409 with no session created.
 *
 * Uses Node's built-in test runner + module mocks; no real DB or OAuth calls.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ── Mock all server-side dependencies before importing routes ─────────────────

// Mock storage — getUserByEmail is overridden per-test via mockStorage
const mockStorage: {
  getUserByEmail: (email: string) => Promise<any>;
  createUser: (u: any) => Promise<any>;
  upsertUser: (u: any) => Promise<any>;
  [key: string]: any;
} = {
  getUserByEmail: async (_email: string) => undefined,
  createUser: async (u: any) => ({ ...u, id: 1, isAdmin: false }),
  upsertUser: async (u: any) => ({ ...u, id: 1, isAdmin: false }),
  // Stub all IStorage methods used anywhere in routes
  getDossiers: async () => [],
  getDossier: async () => null,
  createDossier: async (d: any) => ({ ...d, id: 1 }),
  updateDossier: async (d: any) => d,
  deleteDossier: async () => {},
  getNotes: async () => [],
  createNote: async (n: any) => ({ ...n, id: 1 }),
  deleteNote: async () => {},
  getSearchHistory: async () => [],
  addSearchHistory: async (h: any) => ({ ...h, id: 1 }),
  getJobMatches: async () => [],
  addJobMatch: async (j: any) => ({ ...j, id: 1 }),
  getJobQuestions: async () => [],
  addJobQuestion: async (q: any) => ({ ...q, id: 1 }),
  getAllUsers: async () => [],
  deleteUser: async () => {},
  getUserById: async () => null,
  updateUser: async (u: any) => u,
};

mock.module('./storage', {
  namedExports: { storage: mockStorage },
});

mock.module('./db', {
  namedExports: { db: {} },
});

mock.module('./googleAuth', {
  namedExports: {
    setupGoogleAuth: (_app: any) => {},
    requireAuth: (_req: any, res: any, next: any) => next(),
    attachSessionIfPresent: (_req: any, _res: any, next: any) => next(),
  },
});

mock.module('./replitAuth', {
  namedExports: {
    setupReplitAuth: (_app: any) => {},
    requireReplitAuth: (_req: any, res: any, next: any) => next(),
  },
});

mock.module('../services/intelligenceService', {
  namedExports: {
    generateIntelligenceReport: async () => ({ report: {}, sources: [] }),
    extractTextFromImage: async () => ({ name: '', company: '' }),
  },
});

mock.module('../services/calendarService', {
  namedExports: {
    CalendarService: class {
      getCalendarEvents() { return []; }
      syncJobToCalendar() { return null; }
    },
  },
});

mock.module('./googleSearchService', {
  namedExports: {
    searchPerson: async () => ({ results: [] }),
    enhancedPersonSearch: async () => ({ results: [] }),
  },
});

// ── Import routes AFTER mocks are registered ──────────────────────────────────

import express from 'express';
import session from 'express-session';
const { registerRoutes } = await import('./routes.js');

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Creates a minimal Express app with session middleware and registered routes. */
async function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      // In-memory store (default MemoryStore)
    }),
  );
  await registerRoutes(app);
  return app;
}

/** Makes a POST request against a local test server and returns { status, body, setCookie }. */
function post(
  server: http.Server,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; body: any; setCookie: string | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
              setCookie: res.headers['set-cookie']?.[0],
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data, setCookie: undefined });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('POST /api/register/email: new user (no existing account) → 200, session created', async () => {
  mockStorage.getUserByEmail = async (_email: string) => undefined; // no existing account
  mockStorage.createUser = async (u: any) => ({ ...u, id: 42, isAdmin: false });

  const app = await buildTestApp();
  const server = app.listen(0);
  try {
    const { status, body } = await post(server, '/api/register/email', {
      email: 'newuser@example.com',
      password: 'password123',
      firstName: 'New',
      lastName: 'User',
    });
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.email, 'newuser@example.com');
  } finally {
    server.close();
  }
});

test('POST /api/register/email: existing account WITH passwordHash → 409 conflict', async () => {
  // Pre-fix behaviour: correctly rejected even before the fix.
  mockStorage.getUserByEmail = async (_email: string) => ({
    id: 1,
    email: 'existing@example.com',
    passwordHash: '$2b$10$somehash',
    isAdmin: false,
  });

  const app = await buildTestApp();
  const server = app.listen(0);
  try {
    const { status, body } = await post(server, '/api/register/email', {
      email: 'existing@example.com',
      password: 'newpassword123',
    });
    assert.equal(status, 409, `Expected 409 for existing password account, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.message?.includes('already exists'), `Expected conflict message, got: ${body.message}`);
  } finally {
    server.close();
  }
});

test('POST /api/register/email: existing OAuth account (no passwordHash) → 409, session NOT created — regression guard', async () => {
  // This is the critical security regression test.
  //
  // Vulnerability (before fix): `if (existing?.passwordHash)` only blocked
  // registration when the existing account already had a password. An OAuth-only
  // account (no passwordHash) would fall through to the upsert branch, attaching
  // the caller-supplied password and immediately creating a session as that user.
  // Knowing any OAuth user's email was sufficient to take over their account.
  //
  // Fix: `if (existing)` — block registration for ANY existing account.
  mockStorage.getUserByEmail = async (_email: string) => ({
    id: 99,
    email: 'oauth-user@example.com',
    passwordHash: null,   // OAuth-only account (no password set)
    provider: 'google',
    isAdmin: false,
  });
  const upsertCalled = { value: false };
  mockStorage.upsertUser = async (u: any) => { upsertCalled.value = true; return u; };

  const app = await buildTestApp();
  const server = app.listen(0);
  try {
    const { status, body, setCookie } = await post(server, '/api/register/email', {
      email: 'oauth-user@example.com',
      password: 'attacker-password123',
    });

    // Must reject with 409 — account takeover must be impossible
    assert.equal(
      status, 409,
      `Expected 409 for existing OAuth account (no passwordHash), got ${status}. ` +
      `SECURITY REGRESSION: unauthenticated registration must not claim an OAuth account. ` +
      `Response: ${JSON.stringify(body)}`,
    );
    assert.ok(
      body.message?.includes('already exists'),
      `Expected conflict message, got: ${body.message}`,
    );

    // upsertUser must never be called — the OAuth account must remain unchanged
    assert.equal(
      upsertCalled.value, false,
      'upsertUser must NOT be called for an existing OAuth account during unauthenticated registration',
    );

    // No session cookie should be set for the OAuth user
    assert.ok(
      !setCookie || !setCookie.includes('connect.sid'),
      `No session must be created for a rejected registration. setCookie: ${setCookie}`,
    );
  } finally {
    server.close();
  }
});

test('POST /api/register/email: missing email → 400 bad request', async () => {
  mockStorage.getUserByEmail = async (_email: string) => undefined;

  const app = await buildTestApp();
  const server = app.listen(0);
  try {
    const { status } = await post(server, '/api/register/email', {
      password: 'password123',
    });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/register/email: short password → 400 bad request', async () => {
  mockStorage.getUserByEmail = async (_email: string) => undefined;

  const app = await buildTestApp();
  const server = app.listen(0);
  try {
    const { status } = await post(server, '/api/register/email', {
      email: 'user@example.com',
      password: 'short',
    });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});
