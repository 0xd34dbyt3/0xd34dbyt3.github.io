"""Optional Chromium checks with Decap's TEST backend, never GitHub OAuth/E2E.

Requires Playwright in the invoking environment. Run from repository root:
python scripts/tests/browser_admin.py --decap-bundle .private/decap-cms.js
The bundle must be the same pinned 3.17.1 CDN file used by admin.html.
All generated files stay in .private; no production data is changed.
"""
import argparse
import base64
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
            post['fullDesc'] = 'Başlangıç metni'
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
                page.on('console', lambda message: errors.append('console: ' + message.text) if 'cms image change' in message.text else None)
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
                image_bytes = base64.b64encode((ROOT / 'public/assets/user-icon.png').read_bytes()).decode('ascii')
                page.add_init_script("""(() => {
                  const files = JSON.parse(localStorage.getItem('cms-test-repo') || %s);
                  const bytes = Uint8Array.from(atob(%s), c => c.charCodeAt(0));
                  const fileObj = new File([bytes], 'user-icon.png', {type:'image/png'});
                  files.content.media = { 'user-icon.png': { path:'content/media/user-icon.png', content:{
                    id:'fixture-image', name:'user-icon.png', size:fileObj.size,
                    path:'content/media/user-icon.png', url:'/assets/user-icon.png',
                    displayURL:'/assets/user-icon.png', fileObj
                  } } };
                  window.repoFiles = files;
                })();""" % (json.dumps(json.dumps(repo)), json.dumps(image_bytes)))
                for kind in ('blog', 'project'):
                    name = next(iter(repo['content'][kind]))
                    slug = name.removesuffix('.json')
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    editor = page.locator('.cms-block-editor').first
                    editor.wait_for()
                    block_count = editor.locator('.cms-content-block').count()
                    assert block_count == 1, (kind, block_count, page.locator('body').inner_text()[-2500:], errors)
                    editor.get_by_label('Metin bloğu', exact=True).fill('İlk metin')
                    editor.locator('.cms-block-gap button[aria-label="Buraya ekle"]').nth(1).click()
                    editor.get_by_role('group', name='Eklenecek blok türü').get_by_role('button', name='Görsel').click()
                    editor.locator('.cms-content-block').nth(1).get_by_label('Alt metin', exact=True).fill('Test görseli')
                    editor.locator('.cms-content-block').nth(1).get_by_label('Açıklama (isteğe bağlı)', exact=True).fill('Görsel açıklaması')
                    editor.locator('.cms-content-block').nth(1).get_by_label('Genişlik', exact=True).fill('64')
                    editor.locator('.cms-content-block').nth(1).locator('.cms-image-settings select').nth(0).select_option('%')
                    editor.locator('.cms-content-block').nth(1).locator('.cms-image-settings select').nth(1).select_option('right')
                    image_block = editor.locator('.cms-content-block').nth(1)
                    image_block.get_by_role('button', name='Bir resim seçin', exact=True).click()
                    card = page.locator('div[tabindex="0"]').filter(has_text='user-icon.png').last
                    card.click()
                    page.wait_for_timeout(150)
                    assert page.get_by_role('button', name='Seçileni kullan', exact=True).is_enabled()
                    page.get_by_role('button', name='Seçileni kullan', exact=True).click()
                    page.wait_for_timeout(300)
                    print('IMAGE PROPS', page.evaluate('window.__cmsBlockWidgetProps'))
                    assert image_block.locator('.cms-image-block-preview img').count(), (image_block.inner_text(), errors)
                    editor.locator('.cms-content-block').nth(1).locator('.cms-image-block-preview img').wait_for()
                    editor.locator('.cms-block-gap button[aria-label="Buraya ekle"]').nth(2).click()
                    editor.get_by_role('group', name='Eklenecek blok türü').get_by_role('button', name='Metin').click()
                    editor.locator('.cms-content-block').nth(2).get_by_label('Metin bloğu', exact=True).fill('İkinci metin')
                    editor.locator('.cms-block-gap button[aria-label="Buraya ekle"]').nth(3).click()
                    editor.get_by_role('group', name='Eklenecek blok türü').get_by_role('button', name='Kod').click()
                    changed_code = '  const changed = 7;\n\treturn changed;\n'
                    editor.locator('.cms-content-block').nth(3).get_by_label('Dil', exact=True).select_option('javascript')
                    editor.locator('.cms-content-block').nth(3).get_by_label('Kod (girintiler korunur)', exact=True).fill(changed_code)
                    editor.locator('.cms-block-gap button[aria-label="Buraya ekle"]').nth(4).click()
                    editor.get_by_role('group', name='Eklenecek blok türü').get_by_role('button', name='Görsel').click()
                    editor.locator('.cms-content-block').nth(4).get_by_label('Genişlik', exact=True).fill('240')
                    editor.locator('.cms-content-block').nth(4).locator('.cms-image-settings select').nth(0).select_option('px')
                    second_image = editor.locator('.cms-content-block').nth(4)
                    second_image.get_by_role('button', name='Bir resim seçin', exact=True).click()
                    page.locator('div[tabindex="0"]').filter(has_text='user-icon.png').last.click()
                    page.get_by_role('button', name='Seçileni kullan', exact=True).click()
                    second_image.locator('.cms-image-block-preview img').wait_for()
                    block_types = editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)')
                    assert block_types == ['text', 'image', 'text', 'code', 'image'], block_types
                    # Insert at an exact gap, then move and remove it; the saved five-block
                    # sequence remains the acceptance scenario.
                    page.once('dialog', lambda dialog: dialog.accept())
                    editor.locator('.cms-block-gap button[aria-label="Buraya ekle"]').nth(2).click()
                    editor.get_by_role('group', name='Eklenecek blok türü').get_by_role('button', name='Kod').click()
                    editor.locator('.cms-content-block').nth(2).get_by_label('Bloku aşağı taşı').click()
                    editor.locator('.cms-content-block').nth(3).get_by_role('button', name='Sil').click()
                    # Wait for removal after the confirmation handler.
                    page.wait_for_function("document.querySelectorAll('.cms-content-block').length===6")
                    page.once('dialog', lambda dialog: dialog.accept())
                    editor.locator('.cms-content-block').nth(2).get_by_role('button', name='Sil').click()
                    page.wait_for_function("document.querySelectorAll('.cms-content-block').length===5")
                    # The last image settings and all block controls remain reachable at
                    # narrow viewports; use explicit viewport size rather than iframe widths.
                    for width in (320, 375, 390, 1440):
                        page.set_viewport_size({'width': width, 'height': 900})
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (kind, width, 'admin horizontal overflow')
                        editor.locator('.cms-content-block').last.scroll_into_view_if_needed()
                        assert editor.locator('.cms-content-block').last.is_visible()
                    page.set_viewport_size({'width': 1440, 'height': 1000})
                    assert editor.locator('.cms-content-block').last.get_by_label('Genişlik', exact=True).input_value() == '240'
                    preview = editor.locator('.cms-block-preview')
                    assert preview.locator('figure').count() == 2
                    assert preview.locator('pre code').first.inner_text() == changed_code
                    page.get_by_role('button', name='Yayınla', exact=True).click()
                    page.get_by_text('Şimdi yayımla', exact=True).click()
                    page.wait_for_function("document.getElementById('save-status').textContent.startsWith('GitHub’a kaydedildi')")
                    saved = page.evaluate("([kind,name])=>JSON.parse(window.repoFiles.content[kind][name].content)", [kind, name])
                    assert saved['fullDesc'].index('İlk metin') < saved['fullDesc'].index('cms-image') < saved['fullDesc'].index('İkinci metin') < saved['fullDesc'].index('cms-code')
                    assert '"width":64' in saved['fullDesc'] and '"width":240' in saved['fullDesc']
                    assert '"align":"right"' in saved['fullDesc']
                    assert json.dumps(changed_code) in saved['fullDesc']
                    page.evaluate("localStorage.setItem('cms-test-repo',JSON.stringify(window.repoFiles))")
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    editor = page.locator('.cms-block-editor').first
                    editor.wait_for()
                    assert editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)') == ['text', 'image', 'text', 'code', 'image']
                    assert editor.locator('.cms-content-block').nth(1).get_by_label('Genişlik', exact=True).input_value() == '64'
                    assert editor.locator('.cms-content-block').last.get_by_label('Genişlik', exact=True).input_value() == '240'
                    assert editor.locator('.cms-content-block').nth(3).get_by_label('Kod (girintiler korunur)', exact=True).input_value() == changed_code
                    page.get_by_role('button', name='Girdiyi sil', exact=True).click()
                    assert dialogs, 'delete must request confirmation'
                    assert page.evaluate("([kind,name])=>!!window.repoFiles.content[kind][name]", [kind, name])
                page.goto(origin + '/admin/')
                if page.get_by_role('button', name='Giriş', exact=True).count(): page.get_by_role('button', name='Giriş', exact=True).click()
                page.goto(origin + '/admin/#/collections/about_page/entries/about')
                page.locator('body').get_by_text('Hakkımda', exact=True).first.wait_for()
                assert page.evaluate('document.documentElement.scrollHeight > innerHeight')
                print('PASS real Decap / TEST backend: ordered text-image-text-code-image, exact insertion, move/delete, settings save/reopen; visitor widths/code/copy')
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--decap-bundle', type=Path, required=True)
    run(parser.parse_args().decap_bundle.resolve())
