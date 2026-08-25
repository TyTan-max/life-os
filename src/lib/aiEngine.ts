/**
 * aiEngine — shared config + a one-shot (non-streaming) completion helper for the
 * same two engines the Research tab's chat uses. ResearchChat.tsx keeps its own
 * streaming adapters (it needs incremental deltas for the typing effect); this
 * module is for callers that just want a single finished response back, like the
 * bucket list's "generate new ideas" feature.
 */

export type Engine = 'local' | 'cloud';

export const GEMINI_API_KEY: string =
  (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const OLLAMA_MODEL = 'llama3';
export const OLLAMA_BASE_URL = '/api/ollama';

// In dev, calls go straight to Google with the key from .env.local (never leaves the dev's own
// machine, so there's nothing to hide). In production a VITE_-prefixed var gets baked into the
// public JS bundle — anyone could pull the key out of DevTools and run up billed Gemini usage on
// this app's own account — so the deployed site instead calls a small standalone Cloudflare
// Worker that holds the real key server-side. See cloudflare/gemini-proxy/.
export const GEMINI_ORIGIN = import.meta.env.DEV ? '' : (import.meta.env.VITE_GEMINI_PROXY_URL as string | undefined) ?? '';
const GEMINI_BASE = GEMINI_ORIGIN ? `${GEMINI_ORIGIN}/gemini` : 'https://generativelanguage.googleapis.com/v1beta';

function geminiUrl(path: string, extraQuery = ''): string {
  const keyQuery = GEMINI_ORIGIN ? '' : `key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const query = [extraQuery, keyQuery].filter(Boolean).join('&');
  return `${GEMINI_BASE}/${path}${query ? `?${query}` : ''}`;
}

/** Same localStorage key the Research chat uses, so an engine choice made in either place carries over. */
export const ENGINE_STORAGE_KEY = 'life-os-research-engine-v1';

export const ENGINE_LABELS: Record<Engine, string> = {
  local: 'Local (Ollama)',
  cloud: 'Cloud (Gemini)'
};

export function loadSavedEngine(): Engine {
  const saved = window.localStorage.getItem(ENGINE_STORAGE_KEY);
  return saved === 'cloud' || saved === 'local' ? saved : 'local';
}

/** Works in both dev and prod — hits the Worker's /gemini/status route when GEMINI_ORIGIN is set. */
export async function checkCloudConfigured(): Promise<boolean> {
  if (!GEMINI_ORIGIN) return Boolean(GEMINI_API_KEY);
  try {
    const res = await fetch(`${GEMINI_ORIGIN}/gemini/status`);
    if (!res.ok) return false;
    const data = await res.json() as { configured?: boolean };
    return Boolean(data.configured);
  } catch {
    return false;
  }
}

async function describeHttpError(res: Response, label: string): Promise<string> {
  const raw = await res.text().catch(() => '');
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { error?: string | { message?: string } };
    const err = parsed.error;
    if (typeof err === 'string') detail = err;
    else if (err && typeof err === 'object' && err.message) detail = err.message;
  } catch {
    /* body wasn't JSON — keep the raw snippet */
  }
  return `${label} request failed (${res.status}). ${detail}`.trim();
}

async function completeOllama(system: string, user: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) throw new Error(`${await describeHttpError(res, 'Ollama')} — is Ollama running? Try \`ollama serve\`.`);
  const data = await res.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

async function completeGemini(system: string, user: string, signal: AbortSignal): Promise<string> {
  if (!GEMINI_ORIGIN && !GEMINI_API_KEY) {
    throw new Error('No Gemini API key found. Add VITE_GEMINI_API_KEY to .env.local and restart the dev server.');
  }
  const url = geminiUrl(`models/${GEMINI_MODEL}:generateContent`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }]
    })
  });
  if (!res.ok) throw new Error(await describeHttpError(res, 'Gemini'));
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map(p => p.text ?? '').join('');
}

/** Waits for the full reply — no streaming deltas. Times out after 30s so a hung local model doesn't spin forever. */
export async function complete(engine: Engine, systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    return await (engine === 'cloud'
      ? completeGemini(systemPrompt, userPrompt, controller.signal)
      : completeOllama(systemPrompt, userPrompt, controller.signal));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('The request timed out after 30s.');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}
