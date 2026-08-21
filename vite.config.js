var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
function igdbProxyPlugin(clientId, clientSecret) {
    var token = null;
    function getAccessToken() {
        return __awaiter(this, void 0, void 0, function () {
            var res, data;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!clientId || !clientSecret)
                            return [2 /*return*/, null];
                        if (token && token.expiresAt > Date.now())
                            return [2 /*return*/, token.value];
                        return [4 /*yield*/, fetch("https://id.twitch.tv/oauth2/token?client_id=".concat(clientId, "&client_secret=").concat(clientSecret, "&grant_type=client_credentials"), { method: 'POST' })];
                    case 1:
                        res = _a.sent();
                        if (!res.ok)
                            throw new Error("IGDB auth failed: ".concat(res.status));
                        return [4 /*yield*/, res.json()];
                    case 2:
                        data = _a.sent();
                        token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
                        return [2 /*return*/, token.value];
                }
            });
        });
    }
    function sendJson(res, status, body) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
    }
    return {
        name: 'igdb-proxy',
        configureServer: function (server) {
            var _this = this;
            server.middlewares.use('/api/igdb/status', function (_req, res) {
                sendJson(res, 200, { configured: Boolean(clientId && clientSecret) });
            });
            server.middlewares.use('/api/igdb/search', function (req, res) { return __awaiter(_this, void 0, void 0, function () {
                var url, q, accessToken, escaped, exact, filterClause, body, igdbRes, _loop_1, attempt, state_1, data, err_1;
                var _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            _c.trys.push([0, 7, , 8]);
                            url = new URL((_a = req.url) !== null && _a !== void 0 ? _a : '', 'http://localhost');
                            q = (_b = url.searchParams.get('q')) === null || _b === void 0 ? void 0 : _b.trim();
                            if (!q)
                                return [2 /*return*/, sendJson(res, 200, [])];
                            return [4 /*yield*/, getAccessToken()];
                        case 1:
                            accessToken = _c.sent();
                            if (!accessToken)
                                return [2 /*return*/, sendJson(res, 200, [])];
                            escaped = q.replace(/"/g, '\\"');
                            exact = url.searchParams.get('mode') === 'exact';
                            filterClause = exact
                                ? "where name = \"".concat(escaped, "\"; ")
                                : "search \"".concat(escaped, "\"; where category = (0,8,9,10,11) | category = null; ");
                            body = filterClause +
                                'fields name, cover.image_id, first_release_date, platforms.name, genres.name, summary, ' +
                                'involved_companies.company.name, involved_companies.developer, involved_companies.publisher; ' +
                                'limit 20;';
                            igdbRes = void 0;
                            _loop_1 = function (attempt) {
                                return __generator(this, function (_d) {
                                    switch (_d.label) {
                                        case 0: return [4 /*yield*/, fetch('https://api.igdb.com/v4/games', {
                                                method: 'POST',
                                                headers: {
                                                    'Client-ID': clientId,
                                                    Authorization: "Bearer ".concat(accessToken),
                                                    'Content-Type': 'text/plain'
                                                },
                                                body: body
                                            })];
                                        case 1:
                                            igdbRes = _d.sent();
                                            if (igdbRes.status !== 429)
                                                return [2 /*return*/, "break"];
                                            return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 500 * (attempt + 1)); })];
                                        case 2:
                                            _d.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            };
                            attempt = 0;
                            _c.label = 2;
                        case 2:
                            if (!(attempt < 3)) return [3 /*break*/, 5];
                            return [5 /*yield**/, _loop_1(attempt)];
                        case 3:
                            state_1 = _c.sent();
                            if (state_1 === "break")
                                return [3 /*break*/, 5];
                            _c.label = 4;
                        case 4:
                            attempt++;
                            return [3 /*break*/, 2];
                        case 5:
                            if (!igdbRes || !igdbRes.ok)
                                throw new Error("IGDB search failed: ".concat(igdbRes === null || igdbRes === void 0 ? void 0 : igdbRes.status));
                            return [4 /*yield*/, igdbRes.json()];
                        case 6:
                            data = _c.sent();
                            sendJson(res, 200, data);
                            return [3 /*break*/, 8];
                        case 7:
                            err_1 = _c.sent();
                            sendJson(res, 500, { error: err_1.message });
                            return [3 /*break*/, 8];
                        case 8: return [2 /*return*/];
                    }
                });
            }); });
        }
    };
}
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    // GitHub Pages serves a project repo (not a `<user>.github.io` repo itself) from
    // `/<repo-name>/`, not `/` — every asset URL in the build needs that prefix or they 404 once
    // deployed, even though the exact same build works fine at `/` in local dev and preview.
    // `GITHUB_REPOSITORY` (`owner/repo`) is set automatically inside GitHub Actions, so this
    // adapts to whatever the repo ends up being named instead of a name hardcoded here going
    // stale the moment the repo is renamed.
    var repoName = (_b = process.env.GITHUB_REPOSITORY) === null || _b === void 0 ? void 0 : _b.split('/')[1];
    return {
        base: repoName ? "/".concat(repoName, "/") : '/',
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
                    rewrite: function (path) { return path.replace(/^\/api\/ollama/, ''); }
                }
            }
        }
    };
});
