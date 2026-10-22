/* Standalone GitHub OAuth broker for Decap. Deploy separately from GitHub Pages.
 * Node >=22, no npm dependencies; client secret never sent to the browser.
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

function configuration(env = process.env) {
    for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'CMS_ORIGIN', 'OAUTH_ORIGIN', 'GITHUB_REPOSITORY']) {
        if (!env[key] || /GITHUB_OWNER|example\.invalid/.test(env[key])) throw new Error('Missing OAuth configuration: ' + key);
        if (env[key] !== env[key].trim()) throw new Error('Invalid OAuth configuration: ' + key);
    }
    if (!/^[A-Za-z0-9]+$/.test(env.GITHUB_CLIENT_ID) || !/^\S+$/.test(env.GITHUB_CLIENT_SECRET)) throw new Error('Invalid OAuth credentials');
    for (const key of ['CMS_ORIGIN', 'OAUTH_ORIGIN']) {
        const url = new URL(env[key]);
        if (url.protocol !== 'https:' || url.origin !== env[key]) throw new Error(key + ' must be an HTTPS origin without trailing slash/path');
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid repository');
    return env;
}
function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
function createHandler(env, request = fetch) {
    const cfg = configuration(env);
    const pending = new Map();
    const cookieName = '__Host-decap_state';
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
        try {
            if (req.method !== 'GET') return fail(405, 'Method not allowed');
            if (req.url.length > 4096) return fail(414, 'Request URI too long');
            const url = new URL(req.url, cfg.OAUTH_ORIGIN);
            for (const [state, record] of pending) if (record.expires < Date.now()) pending.delete(state);
            if (url.pathname === '/auth') {
                if (url.searchParams.get('provider') !== 'github' || url.searchParams.get('site_id') !== new URL(cfg.CMS_ORIGIN).hostname) return fail(400, 'Invalid OAuth request');
                if (pending.size >= 1000) return fail(429, 'Try again later');
                const state = crypto.randomBytes(32).toString('hex');
                const verifier = crypto.randomBytes(32).toString('base64url');
                pending.set(state, { verifier, expires: Date.now() + 5 * 60 * 1000 });
                res.setHeader('Set-Cookie', `${cookieName}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`);
                const authorize = new URL('https://github.com/login/oauth/authorize');
                for (const [key, value] of Object.entries({ client_id: cfg.GITHUB_CLIENT_ID, redirect_uri: cfg.OAUTH_ORIGIN + '/callback', scope: 'public_repo', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
                res.writeHead(302, { Location: authorize.href }); return res.end();
            }
            if (url.pathname !== '/callback') return fail(404, 'Not found');
            const state = url.searchParams.get('state') || '';
            const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
            const transaction = pending.get(state);
            if (!/^[a-f0-9]{64}$/.test(state) || cookie !== state || !transaction) return fail(400, 'Invalid or expired OAuth state');
            pending.delete(state);
            res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
            const code = url.searchParams.get('code');
            if (!code || code.length > 2048 || url.searchParams.has('error')) return fail(400, 'GitHub authorization was not completed');
            const tokenResponse = await request('https://github.com/login/oauth/access_token', {
                method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: cfg.GITHUB_CLIENT_ID, client_secret: cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: cfg.OAUTH_ORIGIN + '/callback', code_verifier: transaction.verifier }),
                signal: AbortSignal.timeout(10000)
            });
            const data = await tokenResponse.json();
            if (!tokenResponse.ok || typeof data.access_token !== 'string' || data.error) return fail(401, 'GitHub token exchange failed');
            // Authenticate AND authorize this exact repository before sending a token to Decap.
            const repoResponse = await request('https://api.github.com/repos/' + cfg.GITHUB_REPOSITORY, {
                headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + data.access_token, 'User-Agent': 'DecapPortfolioOAuth' }, signal: AbortSignal.timeout(10000)
            });
            const repo = await repoResponse.json();
            if (!repoResponse.ok || !repo.permissions?.push || repo.private) return fail(403, 'Public repository write permission required');
            const nonce = crypto.randomBytes(24).toString('base64');
            res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            // Decap's documented external OAuth popup handshake; never use a wildcard origin.
            res.end(`<!doctype html><meta charset="utf-8"><title>GitHub authorization</title><script nonce="${nonce}">
const origin=${jsonForScript(cfg.CMS_ORIGIN)};
const payload=${jsonForScript('authorization:github:success:' + JSON.stringify({ token: data.access_token, provider: 'github' }))};
function receive(event) {
  if(event.origin !== origin || event.source !== window.opener || event.data !== 'authorizing:github') return;
  window.removeEventListener('message',receive);
  window.opener.postMessage(payload,origin);
  window.close();
}
window.addEventListener('message',receive);
if(window.opener) window.opener.postMessage('authorizing:github',origin);
</script>`);
        } catch {
            // Never log request URLs, OAuth codes, token responses, headers or exception details.
            if (!res.headersSent) fail(502, 'OAuth service unavailable'); else res.end();
        }
    };
}
if (require.main === module) {
    try {
        const server = http.createServer(createHandler(process.env));
        server.requestTimeout = 15000;
        server.listen(Number(process.env.PORT || 8787), '127.0.0.1');
        server.on('error', () => { console.error('OAuth listener unavailable'); process.exitCode = 1; });
    } catch { console.error('OAuth configuration incomplete; see oauth/README.md'); process.exitCode = 1; }
}
module.exports = { createHandler, configuration };
