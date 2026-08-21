import type { ServerResponse } from 'http';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

interface IgdbToken {
  value: string;
  expiresAt: number;
}

function igdbProxyPlugin(clientId: string | undefined, clientSecret: string | undefined): Plugin {
  let token: IgdbToken | null = null;

  async function getAccessToken(): Promise<string | null> {
    if (!clientId || !clientSecret) return null;
    if (token && token.expiresAt > Date.now()) return token.value;
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(`IGDB auth failed: ${res.status}`);
    const data = await res.json();
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }

  return {
    name: 'igdb-proxy',
    configureServer(server) {
      server.middlewares.use('/api/igdb/status', (_req, res) => {
        sendJson(res, 200, { configured: Boolean(clientId && clientSecret) });
      });

      server.middlewares.use('/api/igdb/search', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          const q = url.searchParams.get('q')?.trim();
          if (!q) return sendJson(res, 200, []);

          const accessToken = await getAccessToken();
          if (!accessToken) return sendJson(res, 200, []);

          const escaped = q.replace(/"/g, '\\"');
          const exact = url.searchParams.get('mode') === 'exact';
          // IGDB omits `category` entirely for a lot of real games (it's not defaulted to 0),
          // so an `= (0,8,9,10,11)` filter alone silently drops unclassified titles — including
          // well-known ones. Also allow untyped entries through rather than excluding them.
          const filterClause = exact
            ? `where name = "${escaped}"; `
            : `search "${escaped}"; where category = (0,8,9,10,11) | category = null; `;
          const body =
            filterClause +
            'fields name, cover.image_id, first_release_date, platforms.name, genres.name, summary, ' +
            'involved_companies.company.name, involved_companies.developer, involved_companies.publisher; ' +
            'limit 20;';

          // IGDB caps requests at 4/sec per key — a bulk import can burst past that even with
          // client-side throttling, and a 429 here previously surfaced as a plain 500, which
          // the frontend couldn't tell apart from "this game doesn't exist." Retrying in place
          // means a rate-limited request usually just resolves correctly instead of the caller
          // needing to notice, wait, and re-paste it later.
          let igdbRes: Response | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            igdbRes = await fetch('https://api.igdb.com/v4/games', {
              method: 'POST',
              headers: {
                'Client-ID': clientId as string,
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'text/plain'
              },
              body
            });
            if (igdbRes.status !== 429) break;
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
          if (!igdbRes || !igdbRes.ok) throw new Error(`IGDB search failed: ${igdbRes?.status}`);
          const data = await igdbRes.json();
          sendJson(res, 200, data);
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // GitHub Pages serves a project repo (not a `<user>.github.io` repo itself) from
  // `/<repo-name>/`, not `/` — every asset URL in the build needs that prefix or they 404 once
  // deployed, even though the exact same build works fine at `/` in local dev and preview.
  // `GITHUB_REPOSITORY` (`owner/repo`) is set automatically inside GitHub Actions, so this
  // adapts to whatever the repo ends up being named instead of a name hardcoded here going
  // stale the moment the repo is renamed.
  const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
  return {
    base: repoName ? `/${repoName}/` : '/',
    plugins: [react(), igdbProxyPlugin(env.IGDB_CLIENT_ID, env.IGDB_CLIENT_SECRET)],
    // Tauri-recommended tweaks: don't let the Rust build clear Vite's terminal output,
    // and don't rebuild the frontend when the Rust side (src-tauri/) changes.
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    server: {
      port: 5173,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
      proxy: {
        // Ollama refuses cross-origin browser requests, and localhost:5173 →
        // localhost:11434 counts as cross-origin. Proxying through the dev
        // server makes the call same-origin so the Research chat always works.
        '/api/ollama': {
          target: 'http://localhost:11434',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/ollama/, '')
        }
      }
    }
  };
});
