---
name: Auto-apply research reference
description: User requires all future auto-apply/job-application feature work to reference the uploaded research doc
---

The user uploaded `attached_assets/autoapplytechnicalfindings_1786789123150.md` (Aug 2026) — a deep technical teardown of LazyApply, AIApply, and LoopCV — and instructed that it be referenced **at all times** for features developed going forward.

**Why:** The user plans to build auto-apply/job-application features and wants design decisions grounded in how these competitors actually work (and fail).

**How to apply:** Before designing or building any job-matching, form-autofill, auto-apply, or application-content-generation feature, re-read the relevant section of that doc. Key durable takeaways:
- These products are DOM-automation with an AI label: deterministic layer (selector/label heuristics, boolean filters, per-ATS templates) does the real work; LLM only at the edges (free-text fallback). Rule-first + LLM-classify-and-cache is the category-standard field-detection pattern.
- Client-side (user's own logged-in browser session) is the safe submission path; server-side headless automation adds CAPTCHA/account-lockout/credential problems (AIApply's distinctive failure).
- Category-wide structural failure modes to design against: silent selector failures (matched≫applied gap), templated/identical generated content, wrong answers to sensitive fields (visa/EEO) from keyword misfires, applying to dead listings (no liveness check), bot-detection bans from fixed-interval cadence.
- Semantic matching (embeddings) alone doesn't deliver relevance — data quality, tuned weighting, and a verify-before-submit step matter more (AIApply: Meilisearch + Azure OpenAI embeddings, yet 74% irrelevant matches reported).
- Billing tiers double as rate limiters protecting LLM cost and bot-detection exposure.
