---
name: AI provider architecture
description: Which AI provider powers reports/OCR and why calls must stay server-side
---

Claude (Anthropic) is the primary provider for intelligence reports and business-card OCR; Gemini is the fallback.

**Why:** User explicitly requested Anthropic by default with Gemini as fallback/cross-check (Aug 2026). API keys must never reach the browser, and AI SDK clients must never be constructed at module load time in client code (a browser-side Gemini client once crashed the whole app at startup when the key was absent).

**How to apply:** New AI features go through rate-limited server endpoints, try Claude first, fall back to Gemini, and normalize/validate model JSON before the UI renders it.
