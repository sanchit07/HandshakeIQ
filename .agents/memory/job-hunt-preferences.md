---
name: Job-hunt shortlisting & CV rules
description: User-mandated rules for the daily job-matching feature — shortlist preferences, rotation, dedup, and CV tailoring norms.
---

Shortlisting rules (user-mandated, Aug 2026):
1. English-speaking roles first.
2. Companies offering visa sponsorship / welcoming international candidates.
3. One country per day, Sunday→Saturday rotation (Portugal dropped): Malaysia(Sun), Australia, New Zealand, Ireland, Switzerland, Sweden, Poland(Sat). Malaysia gets top-priority slot.
4. Never re-shortlist a vacancy already shortlisted (90-day dedup by url/title+company).
5. Company cooldown: skip a company for 4 weeks after one of its roles was shortlisted.
6. Seniority is NOT a bar (5-6 yr roles fine) and domain is NOT a bar (fintech, e-commerce, automotive, construction ok) — primary criterion is likelihood of getting shortlisted.
7. Admin-only feature; hidden from all other users.

CV creation rules (all tailored CVs):
1. Follow the CV norms of the target country; web-research what CV type gets shortlisted at that specific company.
2. Simple formatting; clean, error-free PDF; ATS-friendly (standard headings, no tables/graphics).
3. Simple English; keywords mirrored truthfully from the job description; optimized to get shortlisted for the specific role.
4. Always record the base-CV → role mapping (cv_variant).

**Testing lesson:** HTTP 200 is not proof a posting is live — LinkedIn returns 200 for expired jobs, and generic career/search pages must be rejected; only direct posting URLs count.

**How to apply:** Bake these into the search/ranking/tailoring prompts of the daily job pipeline; any new job-hunt or CV feature must honor them.
