// Keeps the real Gemini API key off the public internet. VITE_-prefixed env vars get baked
// straight into the built JS bundle, so calling Gemini directly from the browser (the original
// approach) meant anyone with DevTools open could lift the key out of the bundle and run up
// Gemini usage billed to this app's own Google account. The deployed site now calls this Worker
// instead; the Worker attaches the real key server-side and forwards the request (and, for
// streamGenerateContent, the streamed response) through untouched. Local dev is unaffected — it
// keeps calling Google directly with the key from .env.local, since that never leaves the
// developer's own machine.

const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta';

function corsHeaders(request, allowedOrigin) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env.ALLOWED_ORIGIN);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    if (url.pathname === '/gemini/status') {
      return json({ configured: Boolean(env.GEMINI_API_KEY) }, 200, headers);
    }

    // Everything else under /gemini/ is forwarded as-is to Google — e.g.
    // /gemini/models/gemini-3.5-flash:generateContent or :streamGenerateContent?alt=sse — so this
    // Worker never needs updating if the model name or endpoint shape changes on the app side.
    if (!url.pathname.startsWith('/gemini/')) return json({ error: 'Not found' }, 404, headers);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
    if (!env.GEMINI_API_KEY) return json({ error: 'Gemini proxy is not configured (missing GEMINI_API_KEY secret)' }, 500, headers);

    const upstreamPath = url.pathname.slice('/gemini/'.length);
    const upstreamUrl = new URL(`${UPSTREAM}/${upstreamPath}`);
    for (const [k, v] of url.searchParams) {
      if (k === 'key') continue; // never trust a client-supplied key — the Worker's own secret always wins
      upstreamUrl.searchParams.set(k, v);
    }
    upstreamUrl.searchParams.set('key', env.GEMINI_API_KEY);

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await request.text()
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502, headers);
    }

    // Passed straight through — including a streamed SSE body for streamGenerateContent, so the
    // Research chat's incremental typing effect keeps working exactly as it did calling Google
    // directly.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: { ...headers, 'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json' }
    });
  }
};
