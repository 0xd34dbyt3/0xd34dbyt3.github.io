"""Optional Chromium checks with Decap's TEST backend, never GitHub OAuth/E2E.

Requires Playwright in the invoking environment. Run from repository root:
python scripts/tests/browser_admin.py --decap-bundle .private/decap-cms.js
The bundle must be the same pinned 3.17.1 CDN file used by admin.html.
All generated files stay in .private; no production data is changed.
"""
import argparse
import functools
import json
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_pages import ROOT, build, markdown_html, read_json


def block(kind, value):
    return f'```cms-{kind}\n{json.dumps(value)}\n```'


def run(bundle):
    private = ROOT / '.private'
    private.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=private, prefix='cms-browser-') as tmp:
        output = Path(tmp) / 'site'
        build(output, site=dict(read_json(ROOT / 'site.config.json'), adminEnabled=True))
        repo = {}
        for path in (ROOT / 'content').rglob('*.json'):
            parts = path.relative_to(ROOT).parts
            target = repo
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = {'content': path.read_text(), 'path': str(path.relative_to(ROOT))}
        image = dict(src='/assets/user-icon.png', alt='Test image', caption='Caption',
                     width=37, unit='%', align='right', crop='none')
        code = dict(code='  const x = "<script>";\n\treturn 42;\n', language='javascript', wrap=True)
        for kind in ('blog', 'project'):
            name = next(iter(repo['content'][kind]))
            post = json.loads(repo['content'][kind][name]['content'])
            post['fullDesc'] = '# Test\n\n' + block('image', image) + '\n\n' + block('code', code)
            repo['content'][kind][name]['content'] = json.dumps(post)
            # Official test backend's folder listing uses flat folder keys.
            repo['content/' + kind] = repo['content'][kind]
        config = read_json(output / 'admin/config.yml')
        config['backend'] = {'name': 'test-repo', 'repo': 'test/test'}
        stress = BeautifulSoup((output / 'detail.html').read_text(), 'html.parser')
        stress.select_one('#contentArea').append(BeautifulSoup(
            '<div class="markdown-content">' + markdown_html(
                block('image', dict(image, width=4096, unit='px')) + '\n\n' +
                block('code', dict(code, code='const x = "' + 'x' * 2000 + '";\n', wrap=False)) +
                '\n\n' + block('code', dict(code, code='x' * 2000, wrap=True)), '/') + '</div>',
            'html.parser'))
        (output / 'stress.html').write_text(str(stress))

        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(output)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
                page = context.new_page()
                page.set_default_timeout(8000)
                errors, dialogs = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
                page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
                for width in (320, 375, 390, 1440):
                    page.set_viewport_size({'width': width, 'height': 900})
                    for name in ('index.html', 'about_me.html', 'blog.html', 'projects.html', 'stress.html'):
                        page.goto(origin + '/' + name)
                        page.wait_for_timeout(120)
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, name, 'page overflow')
                        if name == 'stress.html':
                            metrics = page.locator('pre').first.evaluate('(p)=>({scroll:p.scrollWidth,width:p.clientWidth,wrap:getComputedStyle(p).whiteSpace,length:p.textContent.length})')
                            assert metrics['width'] <= width, (width, metrics, 'grid expanded beyond viewport')
                            assert metrics['scroll'] > metrics['width'], (width, metrics)
                            assert page.locator('pre').nth(1).evaluate('(p)=>p.scrollWidth <= p.clientWidth + 1')
                            assert page.locator('figure img').evaluate('(i)=>i.width <= i.closest(".markdown-content").clientWidth')
                            page.get_by_role('button', name='Kopyala', exact=True).first.click()
                            page.get_by_role('button', name='Kopyalandı', exact=True).wait_for()
                            assert page.evaluate('navigator.clipboard.readText()').startswith('const x = "')
                print('PASS visitor pages: 320/375/390/1440, code scroll/wrap, actual clipboard')

                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.route('https://cdn.jsdelivr.net/npm/decap-cms@3.17.1/dist/decap-cms.js',
                           lambda route: route.fulfill(path=str(bundle), content_type='application/javascript'))
                page.route('**/admin/config.yml', lambda route: route.fulfill(json=config))
                page.add_init_script("window.repoFiles=JSON.parse(localStorage.getItem('cms-test-repo')||" + json.dumps(json.dumps(repo)) + ")")
                for kind in ('blog', 'project'):
                    name = next(iter(repo['content'][kind]))
                    slug = name.removesuffix('.json')
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    page.wait_for_function("([slug])=>document.querySelector('[id^=slug-field]')?.value === slug", arg=[slug])
                    page.get_by_label('Genişlik', exact=True).wait_for()
                    value = page.get_by_label('Genişlik', exact=True).input_value()
                    assert value == '37', (kind, slug, value, page.locator('body').inner_text()[-1200:])
                    preview = page.frames[1]
                    assert preview.locator('figure').get_attribute('class') == 'content-image align-right crop-none'
                    for width in (320, 375, 390):
                        preview.get_by_role('button', name=f'{width}px', exact=True).click()
                        assert preview.locator('article').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
                    page.get_by_label('Genişlik', exact=True).fill('')
                    page.get_by_label('Genişlik', exact=True).fill('64')
                    changed_code = '  const changed = 7;\n\treturn changed;\n'
                    page.get_by_label('Kod (girintiler korunur)', exact=True).fill(changed_code)
                    page.get_by_role('button', name='Yayınla', exact=True).click()
                    page.get_by_text('Şimdi yayımla', exact=True).click()
                    page.wait_for_function("document.getElementById('save-status').textContent.startsWith('GitHub’a kaydedildi')")
                    saved = page.evaluate("([kind,name])=>JSON.parse(window.repoFiles.content[kind][name].content)", [kind, name])
                    assert '"width":64' in saved['fullDesc']
                    assert json.dumps(changed_code) in saved['fullDesc']
                    page.evaluate("localStorage.setItem('cms-test-repo',JSON.stringify(window.repoFiles))")
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    page.wait_for_function("([slug])=>document.querySelector('[id^=slug-field]')?.value === slug", arg=[slug])
                    page.get_by_label('Genişlik', exact=True).wait_for()
                    page.wait_for_function("document.querySelector('[id^=width-field]')?.value === '64'")
                    assert page.get_by_label('Genişlik', exact=True).input_value() == '64'
                    assert page.get_by_label('Kod (girintiler korunur)', exact=True).input_value() == changed_code
                    page.get_by_role('button', name='Girdiyi sil', exact=True).click()
                    assert dialogs, 'delete must request confirmation'
                    assert page.evaluate("([kind,name])=>!!window.repoFiles.content[kind][name]", [kind, name])
                page.goto(origin + '/admin/')
                if page.get_by_role('button', name='Giriş', exact=True).count(): page.get_by_role('button', name='Giriş', exact=True).click()
                page.goto(origin + '/admin/#/collections/pages/entries/about')
                page.wait_for_timeout(1500)
                print('ABOUT DEBUG', page.url, page.locator('body').inner_text()[-2200:], page.locator('button').evaluate_all('(xs)=>xs.map(x=>({text:x.textContent.trim(),aria:x.getAttribute("aria-label"),testid:x.parentElement?.getAttribute("data-testid")}))'))
                print('PASS real Decap / TEST backend: blog + project forms, preview widths, save/reopen, delete cancellation')
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--decap-bundle', type=Path, required=True)
    run(parser.parse_args().decap_bundle.resolve())
