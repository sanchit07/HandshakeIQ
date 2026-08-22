/**
 * Shared Claude-primary, Gemini-fallback text completion for the auto-apply
 * pipeline (job discovery, CV tailoring, apply-route resolution, contact
 * discovery, application emails). Claude remains the default model for
 * quality/consistency; Gemini only steps in when Claude itself is unusable
 * right now (API key invalid, credit balance exhausted, rate-limited,
 * overloaded) — never for an ordinary content/parsing problem, which must
 * surface to the caller as before rather than silently swapping providers
 * and potentially masking a real bug.
 *
 * Both providers return plain text here — callers keep using their existing
 * parseJsonLoose()/text-processing code unchanged; only the API call itself
 * is swapped out.
 */
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const GEMINI_MODEL = 'gemini-2.5-flash';

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
  return new Anthropic({ apiKey, timeout: 5 * 60 * 1000, maxRetries: 1 });
}

/**
 * True only for errors indicating Anthropic itself is unusable right now
 * (invalid/missing key, exhausted credit balance, rate-limited, overloaded)
 * — never for a genuine content or parsing problem, which must surface
 * normally instead of silently swapping providers.
 */
export function isAnthropicUnavailableError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  if (status === 401 || status === 403 || status === 429 || status === 529) return true;
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return /credit balance|insufficient_quota|rate_limit|overloaded|billing|quota exceeded|invalid x-api-key|authentication_error|anthropic_api_key is not configured/.test(msg);
}

export function extractAnthropicText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export interface AiCompletionOptions {
  system?: string;
  maxTokens: number;
  /** Enables Claude's/Gemini's respective web-search tool for this call. */
  webSearch?: { maxUses: number };
  timeoutMs?: number;
}

export interface AiCompletionResult {
  text: string;
  provider: 'anthropic' | 'gemini';
}

async function completeWithGemini(prompt: string, opts: AiCompletionOptions): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: opts.maxTokens },
        // Gemini can't combine tools with responseMimeType:'application/json' —
        // callers already ask for "ONLY a JSON array"/similar in the prompt
        // itself and parse leniently (parseJsonLoose), matching how they
        // already handle Claude's equally free-form text output.
        ...(opts.webSearch ? { tools: [{ google_search: {} }] } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[AI FALLBACK] Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    return text || null;
  } catch (e) {
    console.warn(`[AI FALLBACK] Gemini error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Runs one text completion, trying Claude first and falling back to Gemini
 * only when Claude is confirmed unavailable. If Gemini is also unconfigured
 * or fails, the ORIGINAL Claude error is re-thrown (never a generic Gemini
 * error) so existing catch blocks/log messages keep working unchanged.
 */
export async function completeWithFallback(prompt: string, opts: AiCompletionOptions): Promise<AiCompletionResult> {
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: opts.maxTokens,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: prompt }],
        ...(opts.webSearch ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: opts.webSearch.maxUses } as any] } : {}),
      },
      opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
    return { text: extractAnthropicText(response), provider: 'anthropic' };
  } catch (err) {
    if (!isAnthropicUnavailableError(err)) throw err;
    console.warn(`[AI FALLBACK] Claude unavailable (${(err as any)?.message ?? err}) — trying Gemini`);
    const text = await completeWithGemini(prompt, opts);
    if (text === null) throw err; // Gemini also unavailable — surface the ORIGINAL Claude error
    console.log('[AI FALLBACK] Gemini completed the request in Claude\'s place');
    return { text, provider: 'gemini' };
  }
}
