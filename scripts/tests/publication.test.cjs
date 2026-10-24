const {test} = require('node:test');
const assert = require('node:assert/strict');
const env = {GITHUB_CLIENT_ID:'testclient',GITHUB_CLIENT_SECRET:'fixture-secret',GITHUB_ALLOWED_USER_ID:'1',
  GITHUB_REPOSITORY:'test/repo',CMS_ORIGIN:'https://admin.example',OAUTH_ORIGIN:'https://admin.example',PAGES_ORIGIN:'https://pages.example'};
const sha = 'a'.repeat(40);

test('publication requires exact main push, successful Actions and matching live build', async t => {
  const {default: worker} = await import('../../oauth/worker.mjs');
  let run = {head_sha:sha, head_branch:'main', event:'push', status:'completed', conclusion:'success'};
  let liveSha = sha;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url,options) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) return Response.json({workflow_runs:[run]});
    assert.equal(url,'https://pages.example/build-report.json');
    assert.equal(options.redirect,'manual'); // Workers rejects redirect:'error'.
    return Response.json({sourceCommit:liveSha});
  });
  const call = async (cfg=env, query=sha) => worker.fetch(new Request('https://admin.example/publication?sha='+query),cfg);
  assert.equal((await (await call()).json()).state,'live');
  liveSha = 'b'.repeat(40);
  assert.equal((await (await call()).json()).state,'pending');
  for (const override of [{head_sha:'b'.repeat(40)}, {head_branch:'security/check'}, {event:'workflow_dispatch'}, {status:'in_progress'}]) {
    const original = run; run = {...run,...override};
    assert.equal((await (await call()).json()).state,'pending'); run = original;
  }
  run.conclusion='failure';
  assert.equal((await (await call()).json()).state,'failed');
  assert.equal((await call(env,'bad')).status,400);
  const before = calls.length;
  assert.equal((await (await call({...env,CMS_BRANCH:'security/github-app-check'})).json()).state,'test');
  assert.equal(calls.length,before);
});
