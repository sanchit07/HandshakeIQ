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