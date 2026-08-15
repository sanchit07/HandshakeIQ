---
name: Job-search pipeline ops lessons
description: Operational lessons for the autonomous daily job-hunt pipeline (Anthropic rate limits, fallback design, URL quality)
---

- Parallel Anthropic web-search calls (5 concurrent) stall indefinitely in silent SDK rate-limit retries. Board searches must run **sequentially**, and the Anthropic client needs an explicit `timeout` (5 min) + `maxRetries: 1`.
  **Why:** a forced run once hung >30 min with zero log output in the parallel search phase; sequential + timeout fixed it.
- Never abort the daily run on empty intermediate results (0 board findings, 0 live jobs). Fall through to supplemental broad-search rounds (career pages/ATS allowed) that backfill to the 10-job minimum. Board yields for a given day can legitimately be zero.
- Claude often returns listing/category/search-page URLs even when told not to. Programmatic guards are required at every entry point (board path AND supplemental path): listing-page heuristic + same-batch dedup by company and URL, not just cross-day dedup.
- `tsx watch` restarts the backend on any file save — an in-flight long pipeline run (search + CV loop) dies silently when you edit server files. Don't edit server code while a run is in progress if you need its results.
- HTTP status alone cannot prove a job is live: LinkedIn/Hiredly/Foundit return 200 for closed jobs. Liveness must GET the page body and scan for multi-language "closed" markers (English/Polish/Swedish/German/French list in the service). Probe ALL public domains — the old allowlist skip let dead regional/career-page URLs through unverified.
- Node `lookup` callbacks must honor the `all` option (return an array of addresses); returning a plain string yields "Invalid IP address: undefined" errors that silently disabled liveness probes for many domains.
- Board URL patterns rot: Hays direct ads use `/job-detail/<slug>_<ref>` (not just `/job/`). When a board yields 0 while rejecting URLs, check the rejection log — the pattern may be stale, not the board empty.
- Supplemental search yield is highly variable (0–13 per round); Claude sometimes answers in prose — a JSON recovery pass (second non-search call converting the prose) rescues those rounds. Placeholder companies ("not specified") must be rejected.
- Detached shell processes (`setsid nohup`) get killed between agent shell sessions in this environment; trigger long runs through the running backend workflow via the API instead, then poll the DB/logs.
