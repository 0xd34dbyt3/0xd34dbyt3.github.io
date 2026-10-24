"""Decap 3.17.1 GitHub adapter/UI regression with simulated GitHub and OAuth.

No real credentials or network writes. This is NOT real-App acceptance.
Run: .private/browser-venv/bin/python scripts/tests/browser_github_app.py \
  --decap-bundle .private/decap-cms.js
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = 'http://localhost:8765'


def run(bundle):
    integrity = 'sha384-' + base64.b64encode(hashlib.sha384(bundle.read_bytes()).digest()).decode()
    assert integrity in (ROOT / 'pages/admin.html').read_text(), 'Use the pinned admin Decap bundle'
    config = {
        'backend': {'name': 'github-app', 'repo': 'test/repo', 'branch': 'check',
                    'base_url': ORIGIN},
        'media_folder': 'media', 'load_config_file': False,
        'collections': [{'name': 'fixture', 'label': 'Fixture', 'files': [{
            'name': 'draft', 'label': 'Draft', 'file': 'content/fixture.json',
            'fields': [{'name': name, 'label': name, 'widget': 'text'}
                       for name in ['title', 'body_en', 'body_tr']]
        }]}]
    }
    stored = {'title': 'Fixture', 'body_en': 'English', 'body_tr': 'Türkçe'}
    writes = []
    rejected = []
    failures = []
    state = {'reject': False, 'login': 0}

    def route_request(route):
        request = route.request
        path = urlparse(request.url).path
        if request.url.startswith('https://api.github.com/'):
            if state['reject']:
                rejected.append(request.method)
                return route.fulfill(status=401, json={'message': 'Bad credentials'})
            if request.method in ['POST', 'PATCH', 'PUT', 'DELETE']:
                writes.append({'path': path, 'token': request.headers.get('authorization')})
                data = request.post_data_json
                if path.endswith('/git/blobs'):
                    state['pending'] = json.loads(base64.b64decode(data['content']))
                if request.method == 'PATCH' and '/git/refs/' in path:
                    stored.update(state.pop('pending'))
                return route.fulfill(json={'sha': 'b' * 40, 'object': {'sha': 'b' * 40}})
            if path == '/user':
                data = {'id': 12345, 'login': 'fixture', 'name': 'Fixture'}
            elif path == '/repos/test/repo':
                data = {'permissions': {'push': True}, 'default_branch': 'check', 'owner': {'login': 'test'}}
            elif '/git/trees/' in path:
                data = {'sha': 'a' * 40, 'tree': [] if path.endswith(':media') else [
                    {'path': 'fixture.json' if path.endswith(':content') else 'content/fixture.json',
                     'type': 'blob', 'sha': 'c' * 40, 'mode': '100644'}]}
            elif '/contents/' in path or '/git/blobs/' in path:
                data = {'sha': 'c' * 40, 'encoding': 'base64',
                        'content': base64.b64encode(json.dumps(stored).encode()).decode()}
            elif '/git/refs/' in path or '/git/ref/' in path:
                data = {'object': {'sha': 'a' * 40}}
            elif '/git/commits/' in path:
                data = {'sha': 'a' * 40, 'tree': {'sha': 'a' * 40}}
            elif '/branches/' in path:
                data = {'commit': {'sha': 'a' * 40}}
            elif path.endswith('/commits'):
                data = [{'commit': {'author': {'name': 'Fixture', 'date': '2026-10-22T00:00:00Z'}}}]
            else:
                failures.append('Unexpected simulated GitHub request: ' + path)
                print(failures[-1])
                return route.fulfill(status=404, json={'message': 'Not Found'})
            return route.fulfill(json=data)
        if path == '/auth':
            assert 'public_repo' not in request.url and 'scope=repo' not in request.url
            state['login'] += 1
            token = 'ghu_fixture' + str(state['login'])
            return route.fulfill(content_type='text/html', body='''<script>
                const origin = %s;
                addEventListener('message', event => {
                  if(event.origin !== origin || event.source !== opener || event.data !== 'authorizing:github') return;
                  opener.postMessage('authorization:github:success:' + JSON.stringify({
                    provider:'github', token:%s, expires_at:Date.now()+28800000
                  }), origin); close();
                });
                opener.postMessage('authorizing:github', origin);
                </script>''' % (json.dumps(ORIGIN), json.dumps(token)))
        if path == '/decap.js':
            return route.fulfill(path=str(bundle), content_type='application/javascript')
        if path == '/session.js':
            return route.fulfill(path=str(ROOT / 'pages/github-app-session.js'), content_type='application/javascript')
        if path == '/':
            return route.fulfill(content_type='text/html', body='''<!doctype html><meta charset="utf-8">
                <div id="cms-status" style="position:fixed;bottom:0;left:0;z-index:999999;background:white"><span id="save-status"></span></div>
                <script>window.CMS_MANUAL_INIT=true;</script>
                <script src="/decap.js"></script><script src="/session.js"></script>
                <script>
                // Capture the real backend instance without replacing its behavior.
                const register = CMS.registerBackend;
                CMS.registerBackend = (name, Backend) => register(name, class extends Backend {
                  constructor(...args) { super(...args); window.backend = this; }
                });
                GitHubAppSession.register(CMS, location.origin, document);
                CMS.init({config:%s});
                </script>''' % json.dumps(config))
        failures.append('Unexpected external request: ' + urlparse(request.url).netloc + path)
        route.abort()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        context.route('**/*', route_request)
        page = context.new_page()
        page.on('pageerror', lambda error: failures.append(str(error)))
        page.goto(ORIGIN)
        # Validation must finish and render the native login component.
        page.get_by_role('button', name='Login with GitHub').click()
        page.get_by_role('link', name='Draft').click()
        page.wait_for_selector('textarea')
        page.get_by_label('body_en', exact=True).fill('Unsaved EN draft')
        page.get_by_label('body_tr', exact=True).fill('Kaydedilmemiş TR taslağı')
        # Keep a selected File and draft object across the actual session boundary.
        page.evaluate('''() => {
          window.draft = {dataFiles:[{path:'content/fixture.json', raw:'draft'}],
            assets:[{path:'media/fixture.png', toBase64:async()=>btoa('PNG'),
              fileObj:new File(['PNG'], 'fixture.png', {type:'image/png'})}]};
          window.selectedFile = draft.assets[0].fileObj;
          backend.expiresAt = Date.now()-1;
        }''')
        assert page.evaluate('''async () => {
          try { await backend.persistEntry(draft, {}); return false; }
          catch(error) { if(error.status !== 401) console.error(error); return error.status === 401; }
        }''')
        assert not writes and not rejected  # Local expiry prevents network writes.
        # Cancelled popup keeps the open editor and selected file.
        with page.expect_popup() as popup_info:
            # Block popup response so it can be cancelled before authorization.
            context.route('**/auth?**', lambda route: route.fulfill(body='Cancelled fixture'))
            page.get_by_role('button', name='GitHub ile yeniden giriş').click()
        popup_info.value.close()
        page.get_by_role('button', name='Giriş tamamlanmadı — tekrar giriş').wait_for(state='visible')
        context.unroute('**/auth?**')
        page.get_by_role('button', name='Giriş tamamlanmadı — tekrar giriş').click()
        page.wait_for_function("!document.getElementById('github-app-login')")
        assert page.get_by_label('body_en', exact=True).input_value() == 'Unsaved EN draft'
        assert page.get_by_label('body_tr', exact=True).input_value() == 'Kaydedilmemiş TR taslağı'
        assert page.evaluate('draft.assets[0].fileObj === selectedFile')
        assert not writes  # No automatic replay after login.
        # An upstream 401 also offers re-login with the same open draft.
        state['reject'] = True
        assert page.evaluate('''async () => {
          try { await backend.persistEntry(draft, {}); return false; }
          catch(error) { if(error.status !== 401) console.error(error); return error.status === 401; }
        }''')
        assert rejected
        state['reject'] = False
        page.get_by_role('button', name='GitHub ile yeniden giriş').click()
        page.wait_for_function("!document.getElementById('github-app-login')")
        assert page.get_by_label('body_tr', exact=True).input_value() == 'Kaydedilmemiş TR taslağı'
        assert page.evaluate('draft.assets[0].fileObj === selectedFile')
        user = page.evaluate("JSON.parse(localStorage.getItem('decap-cms-user'))")
        assert user['backendName'] == 'github-app' and user['expires_at'] > 0
        assert user['token'] == 'ghu_fixture3'
        assert not writes
        # Save through Decap UI after login, then reopen from simulated GitHub.
        page.get_by_role('button', name='Publish', exact=True).click()
        with page.expect_response(lambda response: response.request.method == 'PATCH'
                                  and response.url.endswith('/git/refs/heads/check')) as saved:
            page.get_by_text('Publish now', exact=True).click()
        assert saved.value.ok
        assert stored['body_en'] == 'Unsaved EN draft' and stored['body_tr'] == 'Kaydedilmemiş TR taslağı'
        assert writes and all(write['token'] == 'token ghu_fixture3' for write in writes)
        assert any(write['path'].endswith('/git/refs/heads/check') for write in writes)
        page.reload()
        assert page.get_by_label('body_en', exact=True).input_value() == 'Unsaved EN draft'
        assert page.get_by_label('body_tr', exact=True).input_value() == 'Kaydedilmemiş TR taslağı'
        assert not failures, failures
        browser.close()
    print('PASS Decap 3.17.1 GitHub UI: config/login scope, expiry/401, popup cancel, EN/TR draft/File preservation, credential storage, explicit save/reopen (SIMULATED; not real App acceptance)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--decap-bundle', type=Path, required=True)
    run(parser.parse_args().decap_bundle.resolve())
