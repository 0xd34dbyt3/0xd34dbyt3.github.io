const COOKIE = '__Host-decap_state';
const STATE_TTL = 5 * 60 * 1000;
const MAX_PENDING = 1000;
const ADMIN_ASSETS = new Set(['/admin/', '/admin/index.html', '/admin/admin.js', '/admin/github-app-session.js', '/admin/config.yml', '/js/content-tools.js']);
export const ADMIN_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://cdn.jsdelivr.net 'sha256-Hx47mYK7okpadKVYneZvwqwuJSl8ZUaC0EMxEJ/t+8c='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https://api.github.com https://github.com https://raw.githubusercontent.com; frame-src https://0xd34dbyt3.github.io";

export function config(env) {
  let credentials = {};
  if (env.GITHUB_APP_CREDENTIALS !== undefined) {
    try { credentials = JSON.parse(env.GITHUB_APP_CREDENTIALS); } catch { throw new Error('Invalid configuration'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Invalid configuration');
  }
  const mode = env.GITHUB_APP_CREDENTIALS !== undefined ? 'github_app' : (env.GITHUB_AUTH_MODE || 'oauth_app');
  if (!['oauth_app', 'github_app'].includes(mode)) throw new Error('Invalid configuration');
  env = {...env, GITHUB_AUTH_MODE: mode,
    GITHUB_CLIENT_ID: mode === 'github_app' ? credentials.client_id : env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: mode === 'github_app' ? credentials.client_secret : env.GITHUB_CLIENT_SECRET};
  for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_ALLOWED_USER_ID', 'CMS_ORIGIN', 'OAUTH_ORIGIN', 'PAGES_ORIGIN', 'GITHUB_REPOSITORY']) {
    if (typeof env[key] !== 'string') throw new Error('Invalid configuration');
    if (!env[key] || /GITHUB_OWNER|example\.invalid/.test(env[key])) throw new Error('Invalid configuration');
    if (env[key] !== env[key].trim()) throw new Error('Invalid configuration');
  }
  if (!/^[A-Za-z0-9]+$/.test(env.GITHUB_CLIENT_ID) || !/^\S+$/.test(env.GITHUB_CLIENT_SECRET)) throw new Error('Invalid configuration');
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_ALLOWED_USER_ID)) throw new Error('Invalid configuration');
  for (const key of ['CMS_ORIGIN', 'OAUTH_ORIGIN', 'PAGES_ORIGIN']) {
    const url = new URL(env[key]);
    if (url.protocol !== 'https:' || url.origin !== env[key]) throw new Error('Invalid configuration');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid configuration');
  if (mode === 'github_app' && (!/^Iv[A-Za-z0-9]+$/.test(env.GITHUB_CLIENT_ID) ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_REPOSITORY_ID || '') || !Number.isSafeInteger(Number(env.GITHUB_REPOSITORY_ID)))) throw new Error('Invalid configuration');
  if (env.CMS_BRANCH && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(env.CMS_BRANCH)) throw new Error('Invalid configuration');
  return env;
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', ...headers
  }});
}
function fail(status, message, extraHeaders = {}) {
  return response(message, status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
}
async function stateOperation(env, operation, payload) {
  if (!env.OAUTH_STATE) throw new Error('State storage unavailable');
  const id = env.OAUTH_STATE.idFromName('github-oauth-state');
  const stub = env.OAUTH_STATE.get(id);
  return stub.fetch('https://oauth-state.internal/' + operation, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
}
function cookieValue(header) {
  return (header || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
}
export function authorizedGitHubIdentity(userResponse, user, repoResponse, repo, cfg) {
  return userResponse.ok && String(user.id) === cfg.GITHUB_ALLOWED_USER_ID && repoResponse.ok &&
    repo.full_name === cfg.GITHUB_REPOSITORY && repo.permissions?.push === true && repo.private === false &&
    (cfg.GITHUB_AUTH_MODE !== 'github_app' || String(repo.id) === cfg.GITHUB_REPOSITORY_ID);
}

export function authorizedInstallation(data, cfg) {
  const installs = data.installations;
  if (data.total_count !== 1 || !Array.isArray(installs) || installs.length !== 1) return null;
  const installation = installs[0];
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0 || installation.suspended_at ||
      String(installation.account?.id) !== cfg.GITHUB_ALLOWED_USER_ID || installation.repository_selection !== 'selected' ||
      installation.permissions?.contents !== 'write' || installation.permissions?.metadata !== 'read' ||
      Object.keys(installation.permissions).some(key => !['contents', 'metadata'].includes(key))) return null;
  return installation.id;
}

export default {
  async fetch(request, env) {
    try {
      const cfg = config(env);
      const url = new URL(request.url);
      if (url.origin !== cfg.OAUTH_ORIGIN) return fail(404, 'Not found');
      if (url.pathname === '/admin') return response(null, 308, { Location: '/admin/' });
      if (ADMIN_ASSETS.has(url.pathname)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');
        if (!env.ASSETS) return fail(503, 'Admin assets unavailable');
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set('Cache-Control', 'no-store');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Strict-Transport-Security', 'max-age=31536000');
        headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        headers.set('Content-Security-Policy', ADMIN_CSP);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        if (url.pathname === '/admin/config.yml' && request.method === 'GET' && cfg.GITHUB_AUTH_MODE === 'github_app' && asset.ok) {
          const cms = await asset.json();
          cms.backend = {...cms.backend, name: 'github-app', base_url: cfg.CMS_ORIGIN, auth_scope: 'offline_access',
            branch: cfg.CMS_BRANCH || cms.backend.branch};
          headers.delete('Content-Length');
          headers.delete('ETag');
          return new Response(JSON.stringify(cms), {status: 200, headers});
        }
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
      }
      if (request.method !== 'GET') return fail(405, 'Method not allowed');
      if (request.url.length > 4096) return fail(414, 'Request URI too long');

      if (url.pathname === '/auth') {
        if (url.searchParams.get('provider') !== 'github' || url.searchParams.get('site_id') !== new URL(cfg.CMS_ORIGIN).hostname) return fail(400, 'Invalid OAuth request');
        const state = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
        const verifier = b64url(randomBytes(32));
        const expires = Date.now() + STATE_TTL;
        const address = request.headers.get('CF-Connecting-IP') || 'unknown';
        const clientKey = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address)))).slice(0, 32);
        const stored = await stateOperation(env, 'create', { state, verifier, expires, clientKey,
          authMode: cfg.GITHUB_AUTH_MODE, clientId: cfg.GITHUB_CLIENT_ID });
        if (stored.status === 429) return fail(429, 'Try again later');
        if (!stored.ok) return fail(502, 'OAuth service unavailable');
        const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const authorize = new URL('https://github.com/login/oauth/authorize');
        for (const [key, value] of Object.entries({ client_id: cfg.GITHUB_CLIENT_ID, redirect_uri: cfg.OAUTH_ORIGIN + '/callback',
          scope: cfg.GITHUB_AUTH_MODE === 'github_app' ? 'offline_access' : 'public_repo',
          state, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
        return response(null, 302, { Location: authorize.href, 'Set-Cookie': `${COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300` });
      }

      if (url.pathname !== '/callback') return fail(404, 'Not found');
      const state = url.searchParams.get('state') || '';
      if (!/^[a-f0-9]{64}$/.test(state) || cookieValue(request.headers.get('Cookie')) !== state) return fail(400, 'Invalid or expired OAuth state');
      const consumed = await stateOperation(env, 'consume', { state });
      if (!consumed.ok) return fail(502, 'OAuth service unavailable');
      const transaction = await consumed.json();
      const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
      if (!transaction.verifier) return fail(400, 'Invalid or expired OAuth state');
      // A credential/mode change invalidates in-flight logins before code exchange.
      if (transaction.authMode !== cfg.GITHUB_AUTH_MODE || transaction.clientId !== cfg.GITHUB_CLIENT_ID) return fail(400, 'OAuth configuration changed; sign in again', {'Set-Cookie': clearCookie});
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048 || url.searchParams.has('error')) return fail(400, 'GitHub authorization was not completed', { 'Set-Cookie': clearCookie });

      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.GITHUB_CLIENT_ID, client_secret: cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: cfg.OAUTH_ORIGIN + '/callback', code_verifier: transaction.verifier,
          ...(cfg.GITHUB_AUTH_MODE === 'github_app' ? {repository_id: cfg.GITHUB_REPOSITORY_ID} : {}) }),
        signal: AbortSignal.timeout(10000)
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || typeof tokenData.access_token !== 'string' || tokenData.error) return fail(401, 'GitHub token exchange failed', { 'Set-Cookie': clearCookie });
      const tokenIssuedAt = Date.now();
      if (cfg.GITHUB_AUTH_MODE === 'github_app' && (!/^ghu_[A-Za-z0-9]+$/.test(tokenData.access_token) ||
          tokenData.token_type !== 'bearer' || tokenData.scope !== '' || !Number.isInteger(tokenData.expires_in) ||
          tokenData.expires_in <= 0 || tokenData.expires_in > 28800)) return fail(401, 'Expiring GitHub App user token required', {'Set-Cookie': clearCookie});
      const githubHeaders = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tokenData.access_token, 'User-Agent': 'DecapPortfolioOAuth' };
      const userResponse = await fetch('https://api.github.com/user', {
        headers: githubHeaders, signal: AbortSignal.timeout(10000)
      });
      const user = await userResponse.json();
      if (!userResponse.ok || String(user.id) !== cfg.GITHUB_ALLOWED_USER_ID) return fail(403, 'Authorized GitHub account required', { 'Set-Cookie': clearCookie });
      const repoResponse = await fetch('https://api.github.com/repos/' + cfg.GITHUB_REPOSITORY, {
        headers: githubHeaders,
        signal: AbortSignal.timeout(10000)
      });
      const repo = await repoResponse.json();
      if (!authorizedGitHubIdentity(userResponse, user, repoResponse, repo, cfg)) return fail(403, 'Public repository write permission required', { 'Set-Cookie': clearCookie });
      if (cfg.GITHUB_AUTH_MODE === 'github_app') {
        const installationsResponse = await fetch('https://api.github.com/user/installations?per_page=2', {
          headers: githubHeaders, signal: AbortSignal.timeout(10000)});
        const installationId = installationsResponse.ok ? authorizedInstallation(await installationsResponse.json(), cfg) : null;
        if (!installationId) return fail(403, 'Single-repository App installation required', {'Set-Cookie': clearCookie});
        const repositoriesResponse = await fetch(`https://api.github.com/user/installations/${installationId}/repositories?per_page=2`, {
          headers: githubHeaders, signal: AbortSignal.timeout(10000)});
        const repositories = repositoriesResponse.ok ? await repositoriesResponse.json() : {};
        if (repositories.total_count !== 1 || repositories.repositories?.length !== 1 ||
            String(repositories.repositories[0].id) !== cfg.GITHUB_REPOSITORY_ID ||
            repositories.repositories[0].full_name !== cfg.GITHUB_REPOSITORY) return fail(403, 'Target repository installation required', {'Set-Cookie': clearCookie});
      }

      const nonce = b64url(randomBytes(24));
      const origin = jsonScript(cfg.CMS_ORIGIN);
      const payload = jsonScript('authorization:github:success:' + JSON.stringify({ token: tokenData.access_token, provider: 'github',
        ...(cfg.GITHUB_AUTH_MODE === 'github_app' ? {expires_at: tokenIssuedAt + tokenData.expires_in * 1000} : {}) }));
      const html = `<!doctype html><meta charset="utf-8"><title>GitHub authorization</title><script nonce="${nonce}">
const origin=${origin};
const payload=${payload};
function receive(event) {
  if(event.origin !== origin || event.source !== window.opener || event.data !== 'authorizing:github') return;
  window.removeEventListener('message',receive);
  window.opener.postMessage(payload,origin);
  window.close();
}
window.addEventListener('message',receive);
if(window.opener) window.opener.postMessage('authorizing:github',origin);
</script>`;
      return response(html, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
        'Set-Cookie': clearCookie
      });
    } catch {
      return fail(502, 'OAuth service unavailable');
    }
  }
};

// Bind OAUTH_STATE to this SQLite-backed Durable Object. Its transaction makes
// state consumption single-use across Worker isolates and concurrent requests.
export class OAuthStateStore {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const operation = new URL(request.url).pathname;
    let body;
    try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
    if (operation === '/create') {
      if (!/^[a-f0-9]{64}$/.test(body.state || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.verifier || '') || !/^[A-Za-z0-9_-]{32}$/.test(body.clientKey || '') || !Number.isFinite(body.expires) ||
          !['oauth_app', 'github_app'].includes(body.authMode) || !/^[A-Za-z0-9]+$/.test(body.clientId || '')) return new Response('Bad request', { status: 400 });
      const created = await this.ctx.storage.transaction(async txn => {
        const now = Date.now();
        const entries = await txn.list();
        let active = 0;
        for (const [key, value] of entries) {
          if (value.expires <= now) await txn.delete(key);
          else if (key.startsWith('state:')) active++;
        }
        if (active >= MAX_PENDING) return false;
        const rateKey = 'rate:' + body.clientKey;
        const rate = await txn.get(rateKey);
        if (rate && rate.expires > now && rate.count >= 10) return false;
        await txn.put(rateKey, { count: rate && rate.expires > now ? rate.count + 1 : 1, expires: now + 60_000 });
        await txn.put('state:' + body.state, { verifier: body.verifier, expires: body.expires, authMode: body.authMode, clientId: body.clientId });
        return true;
      });
      return Response.json({ created }, { status: created ? 201 : 429 });
    }
    if (operation === '/consume') {
      if (!/^[a-f0-9]{64}$/.test(body.state || '')) return new Response('Bad request', { status: 400 });
      const record = await this.ctx.storage.transaction(async txn => {
        const key = 'state:' + body.state;
        const value = await txn.get(key);
        if (value) await txn.delete(key);
        return value && value.expires > Date.now() ? value : null;
      });
      return Response.json(record || {});
    }
    return new Response('Not found', { status: 404 });
  }
}
