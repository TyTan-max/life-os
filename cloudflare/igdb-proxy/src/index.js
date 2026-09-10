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

// Trims defensively — a secret pasted with a trailing newline/space from a terminal paste is
// indistinguishable from a wrong value at the HTTP level (Twitch just returns a flat 400), so
// this rules that specific failure mode out rather than requiring a second round of guessing.
function clean(v) {
  return (v ?? '').trim();
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const clientId = clean(env.IGDB_CLIENT_ID);
  const clientSecret = clean(env.IGDB_CLIENT_SECRET);
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) {
    // Surface Twitch's actual rejection reason (e.g. "Invalid client secret") instead of just
    // the bare status code, plus enough about the input to catch a whitespace/swap mistake
    // without ever revealing the secret itself.
    const detail = await res.text().catch(() => '');
    throw new Error(
      `IGDB auth failed: ${res.status} ${detail} (client_id len=${clientId.length}, secret len=${clientSecret.length})`
    );
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

// IGDB caps requests at 4/sec per key — shared by every endpoint below so a burst (bulk
// import, or a time-to-beat lookup right after a search) usually just resolves in place
// instead of surfacing a 429 the frontend can't tell apart from "this doesn't exist."
async function igdbFetch(accessToken, env, endpoint, body) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: { 'Client-ID': env.IGDB_CLIENT_ID, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
      body
    });
    if (res.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!res || !res.ok) throw new Error(`IGDB ${endpoint} failed: ${res?.status}`);
  return res;
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

  const igdbRes = await igdbFetch(accessToken, env, 'games', body);
  return igdbRes.json();
}

// A separate endpoint, not an expandable field on /games — IGDB's time-to-beat data lives in
// its own game_time_to_beats table, keyed by game_id.
async function handleTimeToBeat(url, env) {
  const gameId = url.searchParams.get('gameId')?.trim();
  if (!gameId || !/^\d+$/.test(gameId)) return null;

  const accessToken = await getAccessToken(env);
  const igdbRes = await igdbFetch(
    accessToken, env, 'game_time_to_beats',
    `fields hastily, normally, completely; where game_id = ${gameId};`
  );
  const data = await igdbRes.json();
  return data[0] ?? null;
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
      if (url.pathname === '/api/igdb/time-to-beat') {
        return json(await handleTimeToBeat(url, env), 200, headers);
      }
      return json({ error: 'Not found' }, 404, headers);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500, headers);
    }
  }
};
