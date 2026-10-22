'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler, configuration } = require('../../oauth/server.cjs');
const env = { GITHUB_CLIENT_ID: 'testclient', GITHUB_CLIENT_SECRET: 'test-secret-not-real', GITHUB_ALLOWED_USER_ID: '12345', CMS_ORIGIN: 'https://auth.example', OAUTH_ORIGIN: 'https://auth.example', PAGES_ORIGIN:'https://pages.example', GITHUB_REPOSITORY: 'test/repo' };
function response() {
    return { headers: {}, status: 200, body: '', headersSent: false,
        setHeader(k, v) { this.headers[k] = v; },
        writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; },
        end(body = '') { this.body = body; this.headersSent = true; } };
}
async function call(handler, url, cookie = '', method = 'GET') {
    const res = response(); await handler({ url, method, headers: { cookie } }, res); return res;
}
async function start(handler) {
    const siteId = new URL(env.CMS_ORIGIN).hostname;
    const res = await call(handler, '/auth?provider=github&site_id=' + siteId + '&scope=repo');
    const url = new URL(res.headers.Location);
    return { res, url, state: url.searchParams.get('state'), cookie: res.headers['Set-Cookie'].split(';')[0] };
}
test('configuration fails closed', () => {
    assert.throws(() => configuration({}));
    assert.throws(() => configuration({ ...env, CMS_ORIGIN: 'http://cms.example' }));
    assert.throws(() => configuration({ ...env, OAUTH_ORIGIN: 'https://auth.example/path' }));
    assert.throws(() => configuration({ ...env, GITHUB_CLIENT_ID: ' test-client' }));
    assert.throws(() => configuration({ ...env, GITHUB_CLIENT_SECRET: 'test secret' }));
    assert.throws(() => configuration({ ...env, GITHUB_ALLOWED_USER_ID: 'owner-name' }));
});
test('provider/site validation and no state bypass', async () => {
    const handler = createHandler(env, () => { throw Error('must not call GitHub'); });
    assert.equal((await call(handler, '/auth?provider=github&site_id=evil.example')).status, 400);
    assert.equal((await call(handler, '/callback?code=bad')).status, 400);
    assert.equal((await call(handler, '/auth', '', 'POST')).status, 405);
    const { state } = await start(handler);
    assert.equal((await call(handler, '/callback?code=test&state=' + state)).status, 400);
});
test('single-use state, PKCE, restricted scope, exact origin and authorization', async () => {
    let count = 0;
    const handler = createHandler(env, async (url, options) => {
        count++;
        if (url.endsWith('/access_token')) {
            const body = JSON.parse(options.body);
            assert.equal(body.client_secret, env.GITHUB_CLIENT_SECRET);
            assert.ok(body.code_verifier);
            return { ok: true, json: async () => ({ access_token: 'mock-token-not-real' }) };
        }
        if (url === 'https://api.github.com/user') return { ok: true, json: async () => ({ id: 12345, login: 'renamed-owner' }) };
        assert.equal(url, 'https://api.github.com/repos/test/repo');
        return { ok: true, json: async () => ({ full_name: 'test/repo', permissions: { push: true }, private: false }) };
    });
    const { res, url, state, cookie } = await start(handler);
    assert.equal(url.searchParams.get('scope'), 'public_repo');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(res.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/);
    const callback = await call(handler, '/callback?code=test&state=' + state, cookie);
    assert.equal(callback.status, 200);
    assert.ok(callback.body.includes('authorization:github:success:'));
    assert.ok(callback.body.includes('event.source !== window.opener'));
    assert.ok(callback.body.includes('https://auth.example'));
    assert.ok(!callback.body.includes(env.GITHUB_CLIENT_SECRET));
    assert.ok(!callback.body.includes('postMessage(payload,\'*\')'));
    assert.equal((await call(handler, '/callback?code=test&state=' + state, cookie)).status, 400);
    assert.equal(count, 3);
});
test('unauthorized GitHub account is rejected before repository access', async () => {
    const calls = [];
    const handler = createHandler(env, async url => {
        calls.push(url);
        if (url.endsWith('/access_token')) return { ok: true, json: async () => ({ access_token: 'mock-token-not-real' }) };
        assert.equal(url, 'https://api.github.com/user');
        return { ok: true, json: async () => ({ id: 99999 }) };
    });
    const { state, cookie } = await start(handler);
    const callback = await call(handler, '/callback?code=test&state=' + state, cookie);
    assert.equal(callback.status, 403);
    assert.ok(!callback.body.includes('mock-token'));
    assert.equal(calls.some(url => url.includes('/repos/')), false);
});
test('wrong repository or read-only permission never receives a token', async () => {
    for (const repo of [
        { full_name: 'other/repo', permissions: { push: true }, private: false },
        { full_name: 'test/repo', permissions: { push: false }, private: false }
    ]) {
        const handler = createHandler(env, async url => ({ ok: true, json: async () =>
            url.endsWith('/access_token') ? { access_token: 'mock-token-not-real' } :
            url.endsWith('/user') ? { id: 12345 } : repo }));
        const { state, cookie } = await start(handler);
        const callback = await call(handler, '/callback?code=test&state=' + state, cookie);
        assert.equal(callback.status, 403);
        assert.ok(!callback.body.includes('mock-token'));
    }
});

test('Worker configuration rejects whitespace and Durable Object rate limits state creation', async () => {
    const {default: worker, ADMIN_CSP, config, authorizedGitHubIdentity, OAuthStateStore} = await import('../../oauth/worker.mjs');
    assert.throws(() => config({ ...env, GITHUB_CLIENT_ID: ' test-client' }));
    const ok = {ok:true};
    const owner = {id:12345};
    const repo = {full_name:'test/repo', permissions:{push:true}, private:false};
    assert.equal(authorizedGitHubIdentity(ok, owner, ok, repo, env), true);
    assert.equal(authorizedGitHubIdentity(ok, {id:99999}, ok, repo, env), false);
    assert.equal(authorizedGitHubIdentity(ok, owner, ok, {...repo, full_name:'other/repo'}, env), false);
    assert.equal(authorizedGitHubIdentity(ok, owner, ok, {...repo, permissions:{push:false}}, env), false);
    const assetEnv = {...env, ASSETS:{fetch:async request => new Response('admin', {headers:{'Content-Type':'text/html'}})}};
    const admin = await worker.fetch(new Request('https://auth.example/admin/'), assetEnv);
    const inlineHash = crypto.createHash('sha256').update('window.CMS_MANUAL_INIT = true;').digest('base64');
    assert.equal(admin.status, 200);
    assert.ok(ADMIN_CSP.includes(`'sha256-${inlineHash}'`));
    assert.match(admin.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.equal(admin.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(admin.headers.get('Cache-Control'), 'no-store');
    assert.equal((await worker.fetch(new Request('https://auth.example/admin/?x=1'), assetEnv)).status, 200);
    assert.equal((await worker.fetch(new Request('https://evil.example/admin/'), assetEnv)).status, 404);
    const values = new Map();
    const txn = {
        async list() { return new Map(values); },
        async get(key) { return values.get(key); },
        async put(key, value) { values.set(key, value); },
        async delete(key) { values.delete(key); }
    };
    const store = new OAuthStateStore({ storage: { transaction: fn => fn(txn) } });
    const clientKey = 'a'.repeat(32);
    const request = (path, body) => new Request('https://oauth-state.internal' + path, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const record = n => ({state:n.toString(16).padStart(64, '0'), verifier:'v'.repeat(43), expires:Date.now()+300000, clientKey});
    const first = record(1);
    assert.equal((await store.fetch(request('/create', first))).status, 201);
    for (let n = 2; n <= 10; n++) assert.equal((await store.fetch(request('/create', record(n)))).status, 201);
    assert.equal((await store.fetch(request('/create', record(11)))).status, 429);
    const consumed = await (await store.fetch(request('/consume', {state:first.state}))).json();
    assert.equal(consumed.verifier, 'v'.repeat(43));
    assert.equal(consumed.expires, first.expires);
    assert.deepEqual(await (await store.fetch(request('/consume', {state:first.state}))).json(), {});
    const expired = {...record(12), expires: Date.now() - 1};
    values.set('state:' + expired.state, {verifier:expired.verifier, expires:expired.expires});
    assert.deepEqual(await (await store.fetch(request('/consume', {state:expired.state}))).json(), {});
});
