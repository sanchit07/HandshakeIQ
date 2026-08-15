---
name: AI provider architecture
description: Which AI provider powers reports/OCR and why calls must stay server-side
---

Claude (Anthropic) is the primary provider for intelligence reports and business-card OCR; Gemini is the fallback and cross-checker.

**Why:** User explicitly requested Anthropic by default with Gemini as fallback/cross-check (Aug 2026). Earlier, the app crashed at startup because an AI client was instantiated in the browser without a key — AI SDK clients must never be constructed at module load time in client code, and API keys must never reach the browser.

**How to apply:** Any new AI feature goes through rate-limited server endpoints, tries Claude first, falls back to Gemini. Model JSON output must be normalized/validated before the UI renders it.
