'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {backendClass, popupAuthorization} = require('../../pages/github-app-session.js');
const appCredentials = {client_id:'Ivtestapp', client_secret:'test-secret-not-real'};
const token = {access_token:'ghu_testnotreal', token_type:'bearer', scope:'', expires_in:28800, refresh_token:'ghr_testnotreal'};
const repo = {id:456, full_name:'test/repo', permissions:{push:true}, private:false};
const installation = {id:7, account:{id:12345}, repository_selection:'selected', permissions:{contents:'write', metadata:'read'}};
const json = (value, status=200) => Response.json(value, {status});

async function fixture(t, overrides={}) {
  const {default:worker, OAuthStateStore} = await import('../../oauth/worker.mjs');
  const records = new Map();
  let queue = Promise.resolve();
  const txn = {list:async()=>new Map(records), get:async key=>records.get(key),
    put:async(key,value)=>records.set(key,value), delete:async key=>records.delete(key)};
  const store = new OAuthStateStore({storage:{transaction:fn=>{
    const next = queue.then(()=>fn(txn)); queue = next.catch(()=>{}); return next;
  }}});
  const env = {GITHUB_APP_CREDENTIALS:JSON.stringify(appCredentials), GITHUB_ALLOWED_USER_ID:'12345',
    GITHUB_REPOSITORY_ID:'456', GITHUB_REPOSITORY:'test/repo', CMS_ORIGIN:'https://auth.example',
    OAUTH_ORIGIN:'https://auth.example', PAGES_ORIGIN:'https://pages.example',
    OAUTH_STATE:{idFromName:()=>1, get:()=>({fetch:(url,options)=>store.fetch(new Request(url,options))})}};
  const calls=[];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url,options});
    if (url.endsWith('/access_token')) return json(overrides.token || token);
    if (url.endsWith('/user')) return json(overrides.user || {id:12345});
    if (url.endsWith('/repos/test/repo')) return json(overrides.repo || repo);
    if (url.endsWith('/user/installations?per_page=2')) return json(overrides.installations || {total_count:1,installations:[installation]});
    if (url.endsWith('/user/installations/7/repositories?per_page=2')) return json(overrides.repositories || {total_count:1,repositories:[repo]});
    throw Error('Unexpected external request in isolated test');
  });
  const call = (path,cookie='',custom=env)=>worker.fetch(new Request('https://auth.example'+path,{headers:{Cookie:cookie}}),custom);
  const start=async()=>{
    const response=await call('/auth?provider=github&site_id=auth.example&scope=public_repo');
    const url=new URL(response.headers.get('Location'));
    return {response,url,state:url.searchParams.get('state'),cookie:response.headers.get('Set-Cookie').split(';')[0]};
  };
  return {env,records,calls,call,start};
}

test('App config is atomic, validates both fields, and does not fall back on invalid credentials',async()=>{
  const {config}=await import('../../oauth/worker.mjs');
  const env={GITHUB_APP_CREDENTIALS:JSON.stringify(appCredentials), GITHUB_ALLOWED_USER_ID:'12345',
    GITHUB_REPOSITORY_ID:'456',GITHUB_REPOSITORY:'test/repo',CMS_ORIGIN:'https://auth.example',
    OAUTH_ORIGIN:'https://auth.example',PAGES_ORIGIN:'https://pages.example',
    GITHUB_CLIENT_ID:'oldclient',GITHUB_CLIENT_SECRET:'old-secret'};
  assert.equal(config(env).GITHUB_CLIENT_ID,appCredentials.client_id);
  for(const bad of ['bad-json','null','{}',JSON.stringify({client_id:'Ivpartial'}),JSON.stringify({...appCredentials,client_id:'Ovwrongtype'})]) {
    assert.throws(()=>config({...env,GITHUB_APP_CREDENTIALS:bad}));
  }
  const {GITHUB_APP_CREDENTIALS:_,...legacy}=env;
  assert.equal(config(legacy).GITHUB_AUTH_MODE,'oauth_app');
  assert.throws(()=>config({...legacy,GITHUB_AUTH_MODE:'github_app'}));
});

test('App OAuth keeps PKCE, source/origin, exact account/repo and single-use state; no public_repo',async t=>{
  const f=await fixture(t);
  const {default:worker}=await import('../../oauth/worker.mjs');
  assert.equal((await worker.fetch(new Request('https://evil.example/auth'),f.env)).status,404);
  assert.equal((await f.call('/auth?provider=github&site_id=wrong.example')).status,400);
  const {response,url,state,cookie}=await f.start();
  assert.equal(response.status,302);
  assert.equal(url.searchParams.get('scope'),'offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const record=f.records.get('state:'+state);
  assert.equal(url.searchParams.get('code_challenge'),crypto.createHash('sha256').update(record.verifier).digest('base64url'));
  assert.equal((await f.call('/callback?code=fixture&state='+state)).status,400);
  const callback=await f.call('/callback?code=fixture&state='+state,cookie);
  assert.equal(callback.status,200);
  const body=await callback.text();
  assert.ok(body.includes('event.source !== window.opener'));
  assert.ok(body.includes('expires_at'));
  assert.ok(!body.includes(token.refresh_token));
  assert.ok(!body.includes(appCredentials.client_secret));
  const exchange=JSON.parse(f.calls[0].options.body);
  assert.equal(exchange.client_id,appCredentials.client_id);
  assert.equal(exchange.client_secret,appCredentials.client_secret);
  assert.equal(exchange.repository_id,'456');
  assert.equal(exchange.code_verifier,record.verifier);
  assert.equal((await f.call('/callback?code=fixture&state='+state,cookie)).status,400);
  assert.equal(f.calls.length,5);
});

test('missing App secret/binding and upstream failures close safely without secret output',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/auth?provider=github&site_id=auth.example','',{...f.env,GITHUB_APP_CREDENTIALS:undefined,GITHUB_AUTH_MODE:'github_app'})).status,502);
  assert.equal((await f.call('/auth?provider=github&site_id=auth.example','',{...f.env,OAUTH_STATE:undefined})).status,502);
  const started=await f.start();
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>{throw Error(appCredentials.client_secret);});
  const response=await f.call('/callback?code=fixture&state='+started.state,started.cookie);
  assert.equal(response.status,502);
  assert.ok(!(await response.text()).includes(appCredentials.client_secret));
});

test('App callback refuses unauthorized account, wrong repo and broad installation/token metadata',async t=>{
  for(const overrides of [
    {user:{id:99999}}, {repo:{...repo,id:999}}, {repo:{...repo,full_name:'other/repo'}},
    {repo:{...repo,permissions:{push:false}}},
    {installations:{total_count:2,installations:[installation]}},
    {installations:{total_count:1,installations:[{...installation,repository_selection:'all'}]}},
    {installations:{total_count:1,installations:[{...installation,permissions:{...installation.permissions,issues:'write'}}]}},
    {repositories:{total_count:2,repositories:[repo,{id:999,full_name:'other/repo'}]}},
    {token:{...token,access_token:'ghs_wrongtype'}}, {token:{...token,expires_in:undefined}},
    {token:{...token,expires_in:0}}, {token:{...token,scope:'public_repo'}}
  ]) {
    const f=await fixture(t,overrides);
    const {state,cookie}=await f.start();
    const response=await f.call('/callback?code=fixture&state='+state,cookie);
    assert.ok([401,403].includes(response.status));
    assert.ok(!(await response.text()).includes('ghu_'));
    if(overrides.user) assert.equal(f.calls.length,2);
    t.mock.restoreAll();
  }
});

test('state expires, concurrent callbacks consume once, rotation fails before token exchange',async t=>{
  const f=await fixture(t);
  const expired=await f.start();
  f.records.get('state:'+expired.state).expires=Date.now()-1;
  assert.equal((await f.call('/callback?code=fixture&state='+expired.state,expired.cookie)).status,400);
  const rotated=await f.start();
  const rotatedEnv={...f.env,GITHUB_APP_CREDENTIALS:JSON.stringify({...appCredentials,client_id:'Ivnewclient'})};
  assert.equal((await f.call('/callback?code=fixture&state='+rotated.state,rotated.cookie,rotatedEnv)).status,400);
  assert.equal(f.calls.length,0);
  const race=await f.start();
  const replies=await Promise.all([f.call('/callback?code=fixture&state='+race.state,race.cookie),f.call('/callback?code=fixture&state='+race.state,race.cookie)]);
  assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,400]);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/access_token')).length,1);
});

test('App admin config selects adapter and isolated branch without altering the static asset',async t=>{
  const f=await fixture(t);
  const original={backend:{name:'github',repo:'test/repo',branch:'main',base_url:'https://old.example',auth_scope:'public_repo'}};
  f.env.CMS_BRANCH='security/github-app-check';
  f.env.ASSETS={fetch:async()=>json(original)};
  const config=await (await f.call('/admin/config.yml')).json();
  assert.equal(config.backend.name,'github-app');
  assert.equal(config.backend.base_url,f.env.CMS_ORIGIN);
  assert.equal(config.backend.branch,'security/github-app-check');
  assert.equal(config.backend.auth_scope,undefined);
  assert.equal(original.backend.name,'github');
  assert.equal(original.backend.auth_scope,'public_repo');
});

test('native login gets only App scope after config validation',()=>{
  const NativeAuth=()=>{};
  class Native {authComponent(){return NativeAuth;}}
  const App=backendClass(Native,{createElement:(component,props)=>({component,props})});
  const config={backend:{name:'github-app',repo:'test/repo'}};
  const rendered=new App().authComponent()({config});
  assert.equal(rendered.component,NativeAuth);
  assert.equal(rendered.props.config.backend.auth_scope,'offline_access');
  assert.equal(config.backend.auth_scope,undefined);
});

test('save receipt follows confirmed backend write; failed write never emits success',async()=>{
  const sha='a'.repeat(40), receipts=[]; let failed=0, reject=false;
  class Native { async persistEntry(){if(reject)throw Object.assign(Error('failure'),{status:422});return {object:{sha}};} }
  const App=backendClass(Native,{onSaved:receipt=>receipts.push(receipt),onSaveError:()=>failed++,onExpired:()=>{}});
  const backend=new App();
  await backend.persistEntry({},{});
  assert.deepEqual(receipts,[{sha}]);
  reject=true;
  await assert.rejects(()=>backend.persistEntry({},{}),{status:422});
  assert.equal(receipts.length,1);
  assert.equal(failed,1);
});

test('401/expiry preserves open draft and media, explicit login updates credentials, no write replay',async()=>{
  let clock=100, login, saved=0, updated;
  let reject401=true;
  const draft={dataFiles:[{path:'content/blog/fixture.json',raw:'EN/TR draft'}],assets:[{path:'content/media/fixture.png'}]};
  const snapshot=structuredClone(draft);
  class Native {
    constructor(){this.options={updateUserCredentials:user=>{updated=user;}};}
    async authenticate(credentials){return {token:credentials.token};}
    async persistEntry(entry){assert.strictEqual(entry,draft);if(reject401)throw Object.assign(new Error('Expired'),{status:401});saved++;return 'saved';}
    async persistMedia(file){assert.strictEqual(file,draft.assets[0]);if(reject401)throw Object.assign(new Error('Expired'),{status:401});return file;}
  }
  const App=backendClass(Native,{now:()=>clock,onExpired:fn=>{login=fn;},
    authorize:async()=>({token:'ghu_newtest',expires_at:900})});
  const backend=new App();
  await backend.authenticate({token:'ghu_oldtest',expires_at:200});
  await assert.rejects(()=>backend.persistEntry(draft,{}),{status:401});
  assert.deepEqual(draft,snapshot);
  await assert.rejects(()=>backend.persistMedia(draft.assets[0],{}),{status:401});
  await login();
  assert.equal(updated.token,'ghu_newtest');
  assert.equal(saved,0);
  assert.deepEqual(draft,snapshot);
  reject401=false;
  assert.equal(await backend.persistEntry(draft,{}),'saved');
  assert.strictEqual(await backend.persistMedia(draft.assets[0],{}),draft.assets[0]);
  clock=901;
  await assert.rejects(()=>backend.persistEntry(draft,{}),{status:401});
  assert.equal(saved,1);
  assert.deepEqual(draft,snapshot);
});

test('reauth popup ignores forged source/origin and cancellation leaves credentials untouched',async()=>{
  let receive, interval, posted;
  const popup={closed:false,close(){this.closed=true;},postMessage(...args){posted=args;}};
  const host={open:()=>popup,addEventListener:(_,fn)=>{receive=fn;},removeEventListener(){},
    setInterval:fn=>{interval=fn;return 1;},clearInterval(){}};
  const promise=popupAuthorization('https://auth.example',host);
  receive({origin:'https://evil.example',source:popup,data:'authorizing:github'});
  receive({origin:'https://auth.example',source:{},data:'authorizing:github'});
  assert.equal(posted,undefined);
  receive({origin:'https://auth.example',source:popup,data:'authorizing:github'});
  assert.deepEqual(posted,['authorizing:github','https://auth.example']);
  receive({origin:'https://auth.example',source:popup,data:'authorization:github:success:'+JSON.stringify({provider:'github',token:'ghu_fixture',expires_at:Date.now()+10000})});
  assert.equal((await promise).token,'ghu_fixture');
  const cancelled=popupAuthorization('https://auth.example',host);
  popup.closed=true;interval();
  await assert.rejects(()=>cancelled,/taslağınız açık kalır/);
});
