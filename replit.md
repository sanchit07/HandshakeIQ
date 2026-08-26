# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform designed to enhance meeting preparation. It leverages Google's Gemini AI with web search capabilities to generate detailed reports on individuals, covering professional backgrounds, recent activities, personal interests, and potential discussion points. The platform supports guest access for core features, while requiring authentication for advanced functionalities like saving dossiers and calendar synchronization.

## User Preferences
None documented yet.

## System Architecture
HandshakeIQ utilizes a full-stack architecture with a React (TypeScript) frontend built with Vite and an Express.js (TypeScript) backend. Data persistence is handled by PostgreSQL with Drizzle ORM. Authentication is managed via direct Google OAuth 2.0, supporting both guest and authenticated modes with conditional access to features.

**Key Features:**
- Guest mode access with conditional authentication for saving and calendar synchronization.
- Real-time person search and disambiguation using Google Custom Search API.
- Comprehensive AI intelligence reports with web search grounding, source attribution, and timestamps.
- Business card scanning for contact extraction using Gemini Vision.
- Interactive person profiles with notes, social media links, and confidence scores.
- Google Calendar integration for upcoming meetings and participant details.
- Persistent storage of intelligence reports (dossiers) and personal notes.
- Animated save confirmation for dossiers.

**UI/UX Decisions:**
- Responsive design using Tailwind CSS for all components.
- Sci-fi themed animations and loaders (NeonLoader, DataStreamLoader, ProfileBuildingLoader).
- Progressive search guidance and locked keyword display during active searches.
- Enhanced card scanner UX with review and edit functionality before search.
- Comprehensive error handling with user-friendly messages.
- Carefully managed z-index layering for optimal UI element stacking.
- Filtering of generic LinkedIn placeholder logos for profile pictures.
- Improved person deduplication for distinct profiles across platforms.

## External Dependencies
- **Anthropic Claude API** (`@anthropic-ai/sdk`, claude-sonnet-4-5): Powers the Job Opportunities auto-apply engine — daily job discovery/ranking with web search, CV tailoring, contact discovery, apply-route resolution, and application email drafting. Admin-only feature (see `server/jobs/`).
- **Google Gemini API** (`@google/genai`): For AI intelligence report generation, web search grounding, and business card scanning using gemini-2.5-flash model.
- **Google OAuth 2.0**: For user authentication and authorization.
- **Google Custom Search API**: For real-time person search across the web.
- **Google Calendar API**: For syncing and displaying user's calendar events.
- **PostgreSQL**: Primary database for user data, sessions, dossiers, and notes.
- **Tailwind CSS**: For styling and responsive design.
- **React Query (@tanstack/react-query)**: For frontend state management and data fetching.
- **Drizzle ORM**: For database interaction with PostgreSQL.
- **`connect-pg-simple`**: For PostgreSQL-backed session management.
- **`google-auth-library`**: For Google OAuth 2.0 integration.
- **`googleapis`**: For Google Calendar API access.

## Recent Changes

### August 26, 2026 (2) - Fixed cascade-delete data loss + a silent daily-recheck SQL failure
Working through the priority findings from the earlier enterprise gap audit: a submitted application's `job_matches` row had no protection from the daily "is this posting still live" recheck — `applications.jobMatchId` and `application_screenshots.applicationId` both cascade `ON DELETE`, so a posting going dead *after* you'd already applied would silently destroy the application record and its screenshot evidence along with it.
- **`server/jobs/jobMatchService.ts`**: `recheckRecentShortlist`'s default query now excludes (via `NOT EXISTS`) any job with an application in `approved`/`submitting`/`submitted`/`submitted_unconfirmed` — those are never even candidates for deletion, regardless of whether the posting is still live. A job whose only application is still queued/needs_user/failed (no irreversible action taken) is still safely removable.
- **Found while building the regression test for the above**: `job_matches.run_date` is `varchar`, not a native `date` column, and the recheck query's date-range comparison (`run_date >= (...)::date`) had no cast on the left side — `operator does not exist: character varying >= date`. This has been throwing on every single cron run, silently swallowed by the daily handler's catch-all (`console.error('[CRON] Recheck ... failed (non-fatal)')`) — meaning the dead-posting cleanup feature has likely never actually run in production. The identical bug existed in `recheckContactEvidence`'s query too. Both fixed with explicit `::date` casts on both sides.
- New `server/jobs/jobMatchService.recheckProtection.test.ts` (real DB, `npm run test:recheck-live`) — exercises the actual (non-injected) default query end-to-end; refuses to run at all if its narrow lookback window isn't already empty, so it can never mistake unrelated real rows for its own fixtures and delete them.

### August 26, 2026 - AI-drafted screening answers + work-authorization coverage warnings
Two changes, both triggered by real live use: (1) common open-ended screening questions ("why this company", "years of experience with X", "describe a relevant project") were only ever answered from an exact/fuzzy match against the static Screening Answers vault list — an unmatched one always paused the application even when the answer was obviously derivable from the candidate's own CV and the job's own description. (2) A user reported "most applications need input" — traced to the work-authorization never-guess gate firing for every job in a country with no vault record, which is invisible until you open each job individually.
- **`server/jobs/atsSubmitter/core.ts`**: new pure `isAiAnswerableField()` — restricted to free-text/textarea fields only (never radio/checkbox/select, which are more likely a legal attestation), excluding a denylist (salary/compensation, notice period, certifications/licenses, background checks, conflict-of-interest/relatives) that stays vault-only-or-pause exactly like a sensitive field. `resolveField()` now signals `unmatchedScreening` on its generic no-vault-match fallthrough so the impure fill layer knows exactly when drafting may be attempted — never for a known canonical field (even one missing from the vault) or a sensitive field.
- **`server/jobs/applyService.ts`**: new `draftScreeningAnswer()` — grounds the draft strictly in the candidate's own `workHistory`/`education` and the job's own title/company/description via the existing Claude→Gemini fallback, explicitly instructed never to invent a fact; returns `null` (never throws) on any AI failure or refusal, so a required field still falls back to the existing pause. Successful drafts auto-save into `screeningAnswers` via new `saveDraftedScreeningAnswer()` (fuzzy-deduped against what's already there) so future applications reuse the answer instead of re-drafting it.
- **`server/jobs/atsSubmitter/index.ts`**: `fillFieldsInScope` calls the drafting step before falling through to the pause, types the result, and tags it `source: 'ai_drafted'` in the reviewable answer set (shared by both the generic and login-walled fill paths).
- **`components/JobOpportunities.tsx`**: AI-drafted answers get a visible "✦ AI-drafted" badge in the review screen — still shown before anything is submitted, same review-before-submit gate as every other answer.
- **Work-authorization coverage banners**: `components/ProfileVault.tsx`'s Job Search Schedule section now flags any scheduled country with no Work Authorization record, before a run ever happens. `components/JobOpportunities.tsx` separately flags, per shortlist date, which of the countries behind today's "needs your input" applications are missing that record — turning an opaque per-job pause into one explanation covering the whole batch.
- Caught a real bug while testing: the first denylist regex pattern for conflict-of-interest questions ("work at this company") was broad enough to also match "why do you want to work at this company" — the canonical example this feature exists for — narrowed to require relative/family-member phrasing.
- New `server/jobs/atsSubmitter/screeningAnswer.test.ts` (live Chromium fixtures, Gemini fallback exercised via mocked fetch) plus 2 new `core.test.ts` unit tests; live-verified the vault auto-save and its de-dup against the real database.

### August 22, 2026 - Claude→Gemini fallback for the auto-apply pipeline
Triggered by the Anthropic account's credit balance running out mid-use, which was silently failing CV generation (and everything else in the pipeline) with no recovery. Adds `server/jobs/aiClient.ts`: a shared `completeWithFallback()` used by every direct Claude call in the job pipeline (role derivation, ranking, board search, supplemental search + its JSON-repair pass, CV generation + its enforcement pass, apply-route resolution, application email drafting, contact identification). Claude stays primary for quality; Gemini (`gemini-2.5-flash`, using its `google_search` tool in place of Claude's `web_search`) steps in ONLY when Claude is confirmed unusable right now — invalid/missing key, exhausted credit balance, rate-limited, overloaded (`isAnthropicUnavailableError`) — never for an ordinary content/parsing problem, which still surfaces as before. If Gemini is also unconfigured or fails, the ORIGINAL Claude error is re-thrown so existing catch blocks and log messages are unaffected. 10 call sites across `jobMatchService.ts`, `applyService.ts`, and `contactDiscoveryService.ts` migrated; 8 new tests plus the full `test:apply` (164 assertions) and every jobMatchService-dependent suite (259 assertions) pass.

### August 21, 2026 - Configurable multi-country job search schedule
Replaces the fixed one-country-per-day rotation with an admin-configurable schedule: `shared/schema.ts` adds a `country_schedule` table (dayOfWeek, country, shortlistCount) editable via a new "Job Search Schedule" section in the Profile Vault UI (`GET`/`PUT /api/schedule`) — a day can now run zero, one, or several countries (e.g. 2 countries × 10 = 20/day), and the same country can appear on multiple different days. Defaults to the original 7-country rotation (10/day) the first time the table is read empty, so behavior is unchanged until an admin edits it. Country coverage expanded from 7 to 12: added Luxembourg, Netherlands, Spain, Germany, and Norway (with regional search-source hints and Adzuna/Hays/Randstad TLDs added where those actually operate; Randstad stays excluded for the new TLDs until a live canary URL is verified, matching the existing safety policy).
- **`server/jobs/jobMatchService.ts`**: `runDailyJobSearch` is now a thin orchestrator that reads today's scheduled countries and runs the extracted `runJobSearchForCountry` once per entry — one country failing no longer blocks the others, and a failure is re-thrown at the end (after every scheduled country got its chance) so the existing cron retry wrapper re-attempts only the countries that didn't already succeed, via per-(runDate, country) idempotence.
- **Fixed two cross-country contamination bugs this surfaced**: `role_search_log`'s primary key was `runDate` alone, so a second country's log on the same day silently overwrote the first's — now a composite `(runDate, country)` key. The per-title "underperforming" learning note was pooling searches across ALL countries — now scoped to the country actually being searched. The board-alerts cache also had an unscoped overwrite that would have dropped one country's alerts when a second country's search finished later the same day — now appends.
- **Discovery quality**: sharpened the existing "prefer English-language postings" guidance (at both board-search and final-ranking stages) into an explicit priority, called out as especially relevant for the newly added non-English-speaking markets.
- 8 new DB-backed tests (`jobMatchService.schedule.test.ts`); full `test:apply` suite (156 assertions) and every other test file depending on `jobMatchService.ts` (259 assertions across audit/liveness/aggregator/Google-discovery/recheck-shortlist/schedule) pass.

### August 20, 2026 - Structured Work History/Education fill (fixes ATS resume-mis-parse corruption)
Triggered by two real manual-application walkthroughs (a Hilti screening-question flow, and a Workday application where the portal's own resume parser put a DBA thesis under a "Forensic Scientist" entry with garbled dates). Root cause: the fill engine only ever wrote single scalar canonical fields (name/email/phone/etc.) — it had no concept of a repeating "Work Experience"/"Education" section, so those fields were left exactly as the ATS's own (frequently wrong) resume-parser populated them, and a bare "Location" label inside such an entry was actively misclassified as the CANDIDATE's own current-location field.
- **`shared/schema.ts`**: `candidate_profile` gains structured `workHistory` and `education` JSON arrays (title/employer/location/start-end dates/description per entry) — the verified source of truth for a portal's native experience/education section — plus an explicit `dataConsent` opt-in boolean.
- **`server/jobs/atsSubmitter/core.ts`**: new pure, tested field-role classification (`classifyExperienceRole`/`classifyEducationRole`) and DOM-order entry grouping (`groupEntryFields`) that scope a repeating section's fields to their own entry index, gated on the page's own section heading so an unrelated "Position" screening question is never mistaken for an experience entry.
- **`server/jobs/atsSubmitter/index.ts` / `loginWalled.ts`**: the shared fill engine now grows a repeating section via its own "Add Another" control to match the vault's entry count, then fills every entry from the vault — **always overwriting** whatever the ATS auto-parsed (same principle already applied to name/email/phone), including correcting a wrongly-pre-checked "currently work here" box. An entry the vault has no record for still pauses (never guesses) rather than trusting unverified auto-parsed content. Applies to both the generic multi-page wizard path and the Workday-style login-walled path, since both share this engine.
- **GDPR/privacy-consent checkboxes** (near-universal on EU/Swiss/UK portals): recognized as a distinct sensitive field, auto-checked only when the vault's new explicit `dataConsent` opt-in is on; a required one with no opt-in still pauses with an accurate reason instead of the generic sensitive-field message.
- **`components/ProfileVault.tsx`**: new Work History, Education, and Data & Privacy Consent sections.
- 20 new tests (pure classification/grouping/date-formatting + two real-Chromium fixture tests reproducing the exact mis-parsed-entry scenario) — full `test:apply` suite (156 assertions) passes.

### August 19, 2026 - Auto-Apply Engine Hardening (enterprise-readiness gap fixes)
Follow-up to a code-level audit of the Job Opportunities auto-apply pipeline (discovery → CV tailoring → ATS auto-apply), benchmarked against real-world ATS behavior. Fixes span `shared/schema.ts`, `server/jobs/jobMatchService.ts`, `server/jobs/applyService.ts`, and `server/jobs/atsSubmitter/*`:
- **Role discovery learning**: a `role_search_log` table now records searched titles vs. what actually got shortlisted, so Phase 1 role derivation can see (and deprioritize) titles that consistently produce nothing after repeated tries.
- **Full-JD relevance re-scoring**: the AI posting-liveness audit now also re-judges candidate fit against the FULL fetched job description (not just the short discovery snippet), dropping or re-scoring jobs a hard mismatch reveals.
- **Admin Q&A learnings** now also inform the daily shortlisting/ranking prompt, not just CV wording.
- **Guardrail tenant isolation**: per-domain CAPTCHA/bot-block cooldowns are now keyed on the actual employer tenant (hostname + company slug for shared-hosting ATSs like Greenhouse/Lever, full hostname for per-tenant Workday-style subdomains) — a block on one company's ATS instance no longer cools down or downgrades automation for every other unrelated company on the same platform.
- **Invisible bot-block detection**: enterprise anti-bot pages (Akamai/PerimeterX/DataDome/Cloudflare) that render no visible CAPTCHA are now detected via HTTP status + page-text signatures, correctly feeding the domain guardrail instead of silently retrying forever.
- **2FA/MFA and email-code verification**: a true second-factor challenge (authenticator app/SMS) now degrades to assisted immediately instead of risking a false "no auth wall" pass-through; an email-delivered numeric code (as opposed to a link) is now polled and typed automatically, same trust boundary as the existing link-based flow.
- **"Already applied" / "account already exists"** ATS states are now recognized distinctly with accurate messaging, instead of a generic "unsupported flow"/looping degrade.
- **Automated password reset**: a rejected vaulted password now triggers an automated "Forgot password" → inbox-polled reset link → new-password flow before degrading to assisted.
- **Conditionally-revealed form fields** (e.g. a visa-detail field that only appears after answering a prior question) are now caught via a bounded re-scan pass, instead of being silently never filled.
- **Multi-page application forms** outside the Workday-style login wall (e.g. a multi-step Greenhouse/Ashby flow) are now walked page-by-page instead of only ever filling the first page.
- **Non-native form widgets**: ARIA combobox/typeahead fields and native `<select multiple>` are now filled correctly (type + click matching option; multi-value selection), and a JS-only drag-and-drop resume upload zone (no native file input) is now supported via a simulated drop event.
- **Outreach hygiene**: the same contact is no longer cold-emailed for two different jobs within a cooldown window; a daily cap protects the connected Gmail account's sending reputation; a verified named contact is now preferred over a generic posting-listed mailbox alias; contacts with stale evidence are excluded from outreach entirely.
- **Stealth hardening**: the headless browser session now patches `navigator.webdriver` and other default headless tells, and rotates its user-agent/viewport per session instead of using one fixed fingerprint on every run.
- Full test suite (500+ assertions across `server/jobs/*.test.ts`) passes; see PR for details.

### November 17, 2025 - Zoho OAuth Integration
- **Real Zoho authentication**: Replaced mock Zoho login with complete OAuth 2.0 integration using Zoho API.
- **OAuth endpoints**: 
  - Authorization: Redirects to Zoho's real consent screen at `https://accounts.zoho.com/oauth/v2/auth`
  - Callback: Exchanges authorization code for access tokens at `/auth/zoho/callback`
- **User profile fetching**: Retrieves real user data (ZUID, email, name) from Zoho's user info endpoint.
- **Token management**: Implements automatic token refresh for both Google and Zoho providers.
- **Secure credential storage**: Zoho Client ID and Client Secret stored as encrypted environment variables.
- **Multi-provider support**: Enhanced middleware to handle both Google and Zoho authentication flows seamlessly.
- **Session handling**: Stores Zoho provider metadata (apiDomain, provider flag) for proper API routing.

### November 17, 2025 - Search History & Caching System
- **Database schema**: Added `search_history` table to track all person searches with full intelligence reports and metadata.
- **Smart caching**: Intelligence report endpoint now checks for exact matches (name + company) and returns cached results instantly instead of calling Gemini API again.
- **API endpoints**: 
  - `GET /api/search-history` - Retrieve all search history (supports guest and authenticated users)
  - `GET /api/search-history/recent?limit=N` - Get recent searches
  - `POST /api/search-history/find-match` - Find exact match for person
- **Automatic saving**: Every intelligence report generation is automatically saved to search history for future reference.
- **Guest support**: Search history works for both authenticated users and guests (using userId null for guests).
- **Performance**: Exact match queries use indexed lookups for fast retrieval.
- **Verified functionality**: Successfully tested caching - duplicate searches return instant results with `fromCache: true`.

### November 17, 2025 - Gemini API Integration Fix
- **Fixed TypeScript errors**: Updated Gemini API calls to use correct syntax for `@google/genai` library (tools parameter moved to config object).
- **Improved error handling**: Added specific error detection for rate limits (429), authentication (401/403), server errors (500), and network issues.
- **Enhanced logging**: Added comprehensive logging with `[GEMINI API]` prefix to track API requests, responses, and data flow through both search and structuring steps.
- **Response validation**: Added validation before JSON parsing to detect empty responses and missing required fields.
- **API call structure**: 
  - Step 1: Uses `googleSearch` tool for web-grounded information retrieval.
  - Step 2: Uses `responseSchema` with structured JSON output for consistent intelligence reports.
- **Verified functionality**: Successfully tested with real-world data (retrieved 26 sources for test query with detailed intelligence reports).