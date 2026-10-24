"""Read-only check of live appcheck HTTP CSP/config/login UI; no GitHub login/save."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ORIGIN = 'https://portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev'


def run(executable, screenshot):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=executable)
        page = browser.new_page()
        errors = []
        configs = []
        page.on('pageerror', lambda error: errors.append(error.stack))
        page.on('console', lambda message: errors.append(message.text)
                if message.type == 'error' and 'Failed to load resource' not in message.text else None)
        page.add_init_script('''
            window.cspViolations = [];
            addEventListener('securitypolicyviolation', event => {
                cspViolations.push({directive: event.effectiveDirective, blocked: event.blockedURI});
            });
        ''')
        page.on('response', lambda response: configs.append(response)
                if response.url == ORIGIN + '/admin/config.yml' else None)
        response = page.goto(ORIGIN + '/admin/', wait_until='networkidle')
        assert response.status == 200
        policy = response.headers['content-security-policy']
        assert "script-src 'unsafe-eval';" in policy
        assert "script-src-elem 'self' https://cdn.jsdelivr.net 'sha256-" in policy
        assert "script-src-attr 'none'" in policy
        assert "'unsafe-inline'" not in policy.split('script-src-elem ', 1)[1].split(';', 1)[0]
        try:
            page.get_by_role('button', name='GitHub ile Giriş', exact=True).wait_for(state='visible')
        except Exception:
            print(json.dumps({'startup_errors': errors, 'body': page.locator('body').inner_text(),
                              'csp_violations': page.evaluate('cspViolations')}, ensure_ascii=False, indent=2), flush=True)
            raise
        assert len(configs) == 1 and configs[0].status == 200
        config = configs[0].json()
        assert config['backend']['name'] == 'github-app'
        assert config['backend']['branch'] == 'security/github-app-check'
        assert config['backend']['base_url'] == ORIGIN
        assert config['collections']
        assert not errors, errors
        assert not page.evaluate('cspViolations')
        # DOM-inserted inline scripts/handlers still pass through browser CSP.
        page.evaluate('''() => {
            const script = document.createElement('script');
            script.textContent = 'window.unapprovedInlineRan = true';
            document.body.appendChild(script);
            const button = document.createElement('button');
            button.setAttribute('onclick', 'window.unapprovedHandlerRan = true');
            document.body.appendChild(button); button.click(); button.remove();
        }''')
        page.wait_for_function('cspViolations.length === 2')
        assert page.evaluate('!window.unapprovedInlineRan && !window.unapprovedHandlerRan')
        assert {v['directive'] for v in page.evaluate('cspViolations')} == {'script-src-elem', 'script-src-attr'}
        asset_policy = page.request.get(ORIGIN + '/admin/config.yml').headers['content-security-policy']
        assert 'unsafe-eval' not in asset_policy
        if screenshot:
            page.screenshot(path=screenshot)
        print(json.dumps({'url': response.url, 'status': response.status, 'csp': policy,
                          'config_status': configs[0].status, 'backend': config['backend']['name'],
                          'branch': config['backend']['branch'], 'collections': len(config['collections']),
                          'login_button': 'GitHub ile Giriş (visible)', 'startup_errors': 0, 'startup_csp_violations': 0,
                          'inline_script_and_handler': 'blocked', 'config_eval_exception': False,
                          'real_github_login_and_save': 'NOT TESTED'}, ensure_ascii=False, indent=2))
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=lambda value: str(Path(value).resolve()))
    parser.add_argument('--screenshot')
    args = parser.parse_args()
    run(args.executable, args.screenshot)
