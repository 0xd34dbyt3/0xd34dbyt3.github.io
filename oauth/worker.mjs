const COOKIE = '__Host-decap_state';
const STATE_TTL = 5 * 60 * 1000;
const MAX_PENDING = 1000;

function config(env) {
  for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'CMS_ORIGIN', 'OAUTH_ORIGIN', 'GITHUB_REPOSITORY']) {
    if (!env[key] || /GITHUB_OWNER|example\.invalid/.test(env[key])) throw new Error('Invalid configuration');
  }
  for (const key of ['CMS_ORIGIN', 'OAUTH_ORIGIN']) {
    const url = new URL(env[key]);
    if (url.protocol !== 'https:' || url.origin !== env[key]) throw new Error('Invalid configuration');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid configuration');
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
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers
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

export default {
  async fetch(request, env) {
    try {
      const cfg = config(env);
      const url = new URL(request.url);
      if (url.origin !== cfg.OAUTH_ORIGIN) return fail(404, 'Not found');
      if (request.method !== 'GET') return fail(405, 'Method not allowed');

      if (url.pathname === '/auth') {
        if (url.searchParams.get('provider') !== 'github' || url.searchParams.get('site_id') !== new URL(cfg.CMS_ORIGIN).hostname) return fail(400, 'Invalid OAuth request');
        const state = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
        const verifier = b64url(randomBytes(32));
        const expires = Date.now() + STATE_TTL;
        const stored = await stateOperation(env, 'create', { state, verifier, expires });
        if (stored.status === 429) return fail(429, 'Try again later');
        if (!stored.ok) return fail(502, 'OAuth service unavailable');
        const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const authorize = new URL('https://github.com/login/oauth/authorize');
        for (const [key, value] of Object.entries({ client_id: cfg.GITHUB_CLIENT_ID, redirect_uri: cfg.OAUTH_ORIGIN + '/callback', scope: 'public_repo', state, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
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
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) return fail(400, 'GitHub authorization was not completed', { 'Set-Cookie': clearCookie });

      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.GITHUB_CLIENT_ID, client_secret: cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: cfg.OAUTH_ORIGIN + '/callback', code_verifier: transaction.verifier }),
        signal: AbortSignal.timeout(10000)
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || typeof tokenData.access_token !== 'string' || tokenData.error) return fail(401, 'GitHub token exchange failed', { 'Set-Cookie': clearCookie });
      const repoResponse = await fetch('https://api.github.com/repos/' + cfg.GITHUB_REPOSITORY, {
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tokenData.access_token, 'User-Agent': 'DecapPortfolioOAuth' },
        signal: AbortSignal.timeout(10000)
      });
      const repo = await repoResponse.json();
      if (!repoResponse.ok || !repo.permissions?.push || repo.private) return fail(403, 'Public repository write permission required', { 'Set-Cookie': clearCookie });

      const nonce = b64url(randomBytes(24));
      const origin = jsonScript(cfg.CMS_ORIGIN);
      const payload = jsonScript('authorization:github:success:' + JSON.stringify({ token: tokenData.access_token, provider: 'github' }));
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
      if (!/^[a-f0-9]{64}$/.test(body.state || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.verifier || '') || !Number.isFinite(body.expires)) return new Response('Bad request', { status: 400 });
      const created = await this.ctx.storage.transaction(async txn => {
        const entries = await txn.list({ prefix: 'state:' });
        let active = 0;
        for (const [key, value] of entries) {
          if (value.expires <= Date.now()) await txn.delete(key);
          else active++;
        }
        if (active >= MAX_PENDING) return false;
        await txn.put('state:' + body.state, { verifier: body.verifier, expires: body.expires });
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
