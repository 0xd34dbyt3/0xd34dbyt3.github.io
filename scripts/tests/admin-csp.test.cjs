'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');

test('Decap eval exception is opt-in, appcheck-origin and admin-document only', async () => {
  const {default: worker, ADMIN_CSP} = await import('../../oauth/worker.mjs');
  const checkOrigin = 'https://portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev';
  const env = {
    GITHUB_CLIENT_ID: 'testclient', GITHUB_CLIENT_SECRET: 'test-secret-not-real',
    GITHUB_ALLOWED_USER_ID: '12345', GITHUB_REPOSITORY: 'test/repo',
    CMS_ORIGIN: checkOrigin, OAUTH_ORIGIN: checkOrigin, PAGES_ORIGIN: 'https://pages.example',
    ASSETS: {fetch: async () => new Response('asset')},
  };
  const csp = async (path, overrides = {}, method = 'GET') => {
    const cfg = {...env, ...overrides};
    const res = await worker.fetch(new Request(cfg.OAUTH_ORIGIN + path, {method}), cfg);
    assert.equal(res.status, 200);
    return res.headers.get('Content-Security-Policy');
  };
  const enabled = {ADMIN_CSP_PROFILE: 'decap-3.17.1-appcheck'};
  assert.equal(await csp('/admin/'), ADMIN_CSP);
  for (const path of ['/admin/', '/admin/index.html']) {
    for (const method of ['GET', 'HEAD']) {
      const policy = await csp(path, enabled, method);
      const sourceList = ADMIN_CSP.match(/script-src ([^;]+);/)[1];
      assert.equal(policy, ADMIN_CSP.replace(`script-src ${sourceList};`,
        `script-src 'unsafe-eval'; script-src-elem ${sourceList}; script-src-attr 'none';`)
        .replace("connect-src 'self' ", "connect-src 'self' blob: "));
    }
  }
  for (const path of ['/admin/admin.js', '/admin/github-app-session.js', '/admin/config.yml', '/js/content-tools.js']) {
    assert.equal(await csp(path, enabled), ADMIN_CSP);
  }
  // Even an accidentally copied profile cannot relax production's policy.
  const production = 'https://portfolio-admin-auth.muhammedfatihozturk02.workers.dev';
  assert.equal(await csp('/admin/', {...enabled, CMS_ORIGIN: production, OAUTH_ORIGIN: production}), ADMIN_CSP);
  const productionEnabled = {ADMIN_CSP_PROFILE:'decap-3.17.1-production', CMS_ORIGIN:production, OAUTH_ORIGIN:production};
  assert.match(await csp('/admin/', productionEnabled), /script-src 'unsafe-eval'; script-src-elem/);
  assert.equal(await csp('/admin/config.yml', productionEnabled), ADMIN_CSP);
  assert.equal(await csp('/admin/', {ADMIN_CSP_PROFILE:'decap-3.17.1-production'}), ADMIN_CSP);
  assert.equal(await csp('/admin/', {ADMIN_CSP_PROFILE: 'unknown'}), ADMIN_CSP);
});
