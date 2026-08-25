// Standalone replacement for the dev-only IGDB proxy in ../../vite.config.ts — same auth/search
// logic, ported to run as a real always-on endpoint since GitHub Pages (or any static host) has
// no server to run Vite's dev middleware. Local dev is untouched; it keeps using the Vite
// middleware at /api/igdb/*. Only the deployed site's requests come here instead — see the
// IGDB_ORIGIN switch in ../../src/lib/igdb.ts.

function corsHeaders(request, allowedOrigin) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin'
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}

// Persists only for the lifetime of one Worker isolate (Cloudflare may spin up a fresh one at
// any time) — same best-effort caching the original dev-server plugin did, just with a shorter
// effective lifespan. Worst case is an extra token fetch, never a correctness issue.
let cachedToken = null;

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${env.IGDB_CLIENT_ID}&client_secret=${env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`IGDB auth failed: ${res.status}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function handleSearch(url, env) {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return [];

  const accessToken = await getAccessToken(env);
  const escaped = q.replace(/"/g, '\\"');
  const exact = url.searchParams.get('mode') === 'exact';
  // IGDB omits `category` entirely for a lot of real games (it's not defaulted to 0), so an
  // `= (0,8,9,10,11)` filter alone silently drops unclassified titles. Also allow untyped
  // entries through rather than excluding them.
  const filterClause = exact
    ? `where name = "${escaped}"; `
    : `search "${escaped}"; where category = (0,8,9,10,11) | category = null; `;
  const body =
    filterClause +
    'fields name, cover.image_id, first_release_date, platforms.name, genres.name, summary, ' +
    'involved_companies.company.name, involved_companies.developer, involved_companies.publisher; ' +
    'limit 20;';

  // IGDB caps requests at 4/sec per key — retry once or twice on a 429 instead of surfacing it
  // as a hard failure the caller can't tell apart from "this game doesn't exist."
  let igdbRes;
  for (let attempt = 0; attempt < 3; attempt++) {
    igdbRes = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': env.IGDB_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/plain'
      },
      body
    });
    if (igdbRes.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!igdbRes || !igdbRes.ok) throw new Error(`IGDB search failed: ${igdbRes?.status}`);
  return igdbRes.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    try {
      if (url.pathname === '/api/igdb/status') {
        return json({ configured: Boolean(env.IGDB_CLIENT_ID && env.IGDB_CLIENT_SECRET) }, 200, headers);
      }
      if (url.pathname === '/api/igdb/search') {
        return json(await handleSearch(url, env), 200, headers);
      }
      return json({ error: 'Not found' }, 404, headers);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500, headers);
    }
  }
};
