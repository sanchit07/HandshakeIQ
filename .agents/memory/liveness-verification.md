---
name: Liveness verification lessons
description: Hard-won rules for verifying job-posting URLs are genuinely live (redirects, body caps, bot-blocks)
---

# Liveness verification lessons

- **Boards signal "expired" with redirects, not 404s.** LinkedIn 301s expired jobs to a listing page with `trk=expired_jd_redirect`; Greenhouse redirects to `/<company>?error=true`. Any liveness check that treats 3xx as "live" without following the chain will shortlist dead jobs.
  **How to apply:** probe must follow redirects (bounded hops, SSRF-guarded per hop), kill on expiry-redirect markers, and treat "ID-bearing URL settled on shallow ID-less page" as dead (with corroboration — some ATSes canonicalize numeric→slug legitimately).
- **Body-capture caps can silently blind content checks.** Lever pages front-load ~700 KB of CSS before job content; a 400 KB cap made the AI audit see "only CSS" and falsely kill LIVE postings, and hid JSON-LD `datePosted` from the staleness check. Cap is now 1.5 MB with bounded probe concurrency (5) to control memory.
- **Nondeterministic AI verdicts on truncated input are a symptom, not noise.** If the audit says "page contains only CSS / no content", suspect fetch truncation or JS-rendered pages before believing CLOSED.
- **Background processes spawned from agent shell sessions die with the session** (even with setsid/nohup/disown). Long pipeline runs must be triggered through the backend workflow process (HTTP endpoint) — session cookie requires HTTPS via $REPLIT_DEV_DOMAIN because cookies are `secure: true` (curl to localhost gets no Set-Cookie).
- **Two force runs overlapping** produce interleaved delete/insert and "Job match not found" CV failures — never fire a second run while one is in flight.
- Gemini audit 429s constantly → Claude fallback carries the audit load in practice.
