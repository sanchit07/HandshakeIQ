---
name: Node.js URL IPv6 bracket handling
description: WHATWG URL.hostname returns bracketed form for IPv6 — must strip before net.isIPv6/isPrivateIp
---

## Rule
`new URL('http://[::1]:8080/').hostname` returns `'[::1]'` (WITH brackets), not `'::1'`.
`net.isIPv6('[::1]')` returns `false` — so any SSRF guard that does `net.isIPv6(parsedUrl.hostname)` silently passes IPv6 literals through.

**Why:** WHATWG URL spec serializes IPv6 hosts with brackets in the `hostname` getter. Node.js follows the spec.

**How to apply:** Before calling `net.isIPv6()` or `isPrivateIp()` on a URL hostname, strip brackets:
```typescript
const rawHost = parsedUrl.hostname; // may be '[::1]'
const bareHost = rawHost.startsWith('[') && rawHost.endsWith(']')
  ? rawHost.slice(1, -1)
  : rawHost;
if ((net.isIPv4(bareHost) || net.isIPv6(bareHost)) && isPrivateIp(bareHost)) { ... }
```
