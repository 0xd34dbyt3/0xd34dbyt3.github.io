'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, configuration } = require('../../oauth/server.cjs');
const env = { GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret-not-real', CMS_ORIGIN: 'https://cms.example', OAUTH_ORIGIN: 'https://auth.example', GITHUB_REPOSITORY: 'test/repo' };
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
    const res = await call(handler, '/auth?provider=github&site_id=cms.example&scope=repo');
    const url = new URL(res.headers.Location);
    return { res, url, state: url.searchParams.get('state'), cookie: res.headers['Set-Cookie'].split(';')[0] };
}
test('configuration fails closed', () => {
    assert.throws(() => configuration({}));
    assert.throws(() => configuration({ ...env, CMS_ORIGIN: 'http://cms.example' }));
    assert.throws(() => configuration({ ...env, OAUTH_ORIGIN: 'https://auth.example/path' }));
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
        assert.equal(url, 'https://api.github.com/repos/test/repo');
        return { ok: true, json: async () => ({ permissions: { push: true }, private: false }) };
    });
    const { res, url, state, cookie } = await start(handler);
    assert.equal(url.searchParams.get('scope'), 'public_repo');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(res.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/);
    const callback = await call(handler, '/callback?code=test&state=' + state, cookie);
    assert.equal(callback.status, 200);
    assert.ok(callback.body.includes('authorization:github:success:'));
    assert.ok(callback.body.includes('event.source !== window.opener'));
    assert.ok(callback.body.includes('https://cms.example'));
    assert.ok(!callback.body.includes(env.GITHUB_CLIENT_SECRET));
    assert.ok(!callback.body.includes('postMessage(payload,\'*\')'));
    assert.equal((await call(handler, '/callback?code=test&state=' + state, cookie)).status, 400);
    assert.equal(count, 2);
});
test('read-only GitHub accounts never receive a token', async () => {
    const handler = createHandler(env, async url => ({ ok: true, json: async () => url.endsWith('/access_token') ? { access_token: 'mock-token-not-real' } : { permissions: { push: false }, private: false } }));
    const { state, cookie } = await start(handler);
    const callback = await call(handler, '/callback?code=test&state=' + state, cookie);
    assert.equal(callback.status, 403);
    assert.ok(!callback.body.includes('mock-token'));
});
