---
name: mock.method chaining fragility in Node test runner
description: Repeated mock.method/restore cycles on https.request can cause later mocks to not intercept — use direct startUrl tests instead
---

## Rule
When using `mock.method(https, 'request', fn)` in multiple sequential tests (each restoring after), later tests in the chain can fail with the full timeout — the mock appears to stop intercepting even though `mock.method` was called again.

**Why:** Possibly a descriptor patching issue after multiple patch/restore cycles on the same Node.js built-in module method. The root cause wasn't fully diagnosed.

**How to apply:** For SSRF guard tests on redirect-following code:
- Tests that verify "no connection to private IP via redirect" can instead test with the private IP as the `startUrl` — the guard fires at hop 0 (same code path as hop N after a redirect). This avoids needing to mock the HTTPS layer entirely.
- Reserve HTTPS mock chaining for cases where you specifically need to test the redirect-parsing logic itself (not the SSRF guard).
