---
name: Auto-apply engine invariants
description: Non-negotiable behavioral rules of the apply engine; any future apply work must keep them.
---

Behavioral invariants the apply engine must always uphold:

- **No unverified apply route.** Every apply URL — AI-found or fallback — must be a parseable HTTP(S) URL AND pass the SSRF-safe liveness probe before use. Dead or malformed route ⇒ application pauses for the user, never a usable state. **Why:** the liveness probe treats unparseable URLs as "live", so a parse check must come first.
- **Sensitive answers only from the vault.** Visa/sponsorship/EEO answers come exclusively from user-entered profile data; missing data pauses the application on every channel. Never guess, never silently omit. EEO answers are opt-in: absent means unanswered, never a default.
- **State transitions must be concurrency-safe** (conditional update on expected state; only one active application per job). **Why:** racing approvals would otherwise send duplicate application emails.
- **Email header values are injection-checked** — CR/LF in recipient/subject/filename must throw, since user/AI-edited subjects could smuggle extra headers.
- **Review-before-send is the default** submission mode; fully automatic sending is deliberately not honored.
- **Application emails always carry the tailored CV PDF.** No CV ⇒ pause for the user, never a silent send without attachment.
- Gmail "not connected" errors pause for the user with a connect prompt; they are not terminal failures.
- **Headless ATS runs fail closed on missing evidence.** No submitted-like state without a stored screenshot: missing pre-submit evidence blocks review/submission; missing post-click evidence pauses for manual verification — a click alone is never treated as proof of acceptance.
- **Approval is bound to the reviewed answers.** The submit run re-fills and must hash-match the answer set the user reviewed; any drift (vault edit, ATS form change) pauses for re-review.
- **Cross-replica coordination lives in Postgres, not process memory.** Browser-run serialization and the daily submission cap must hold across deployment replicas (advisory lock; session locks require a dedicated connection, not a pool).
- **Everything (observe → fill → submit) binds to one resolved application form**; a newsletter/login form on the same page must never be fillable or clickable. Navigation allowlisting must be public-suffix aware (co.uk-style).
- Schema changes need BOTH a drizzle migration file (with IF NOT EXISTS guards — several tables historically exist via push only) and db:push; migration history and push-managed DBs drift otherwise.
