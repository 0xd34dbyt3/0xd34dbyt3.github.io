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


def check_project(page, origin, project_name):
    slug = project_name.removesuffix('.json')
    page.goto(origin + '/admin/')
    page.locator('a[href="#/collections/project"]').click()
    page.locator(f'a[href="#/collections/project/entries/{slug}"]').click()
    editor = page.locator('.cms-block-editor').first
    editor.wait_for()
    assert editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)') == ['text','image','text','code']
    image_block = editor.locator('.cms-block-image').first
    image_block.get_by_label('Genişlik', exact=True).fill('58')
    image_block.get_by_role('button', name='Görseli değiştir').click()
    page.locator('div[tabindex="0"]').filter(has_text='project-icon.png').last.click()
    page.get_by_role('button', name='Seçileni kullan', exact=True).click()
    assert 'project-icon.png' in image_block.locator('img').get_attribute('src')
    for width in (1440, 320, 390):
        page.set_viewport_size({'width':width,'height':900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'project overflow', page.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({cls:e.className,rect:e.getBoundingClientRect().toJSON()}))"))
        editor.locator('.cms-code-input').scroll_into_view_if_needed()
        editor.locator('.cms-code-input').fill('  const example = 1;\n')
        page.screenshot(path=str(ROOT / '.private' / 'editor-review' / f'project-final-{width}.png'))
        if width < 768:
            editor.get_by_role('tab', name='Önizleme', exact=True).click()
            assert editor.locator('.cms-mobile-preview').is_visible()
            editor.get_by_role('tab', name='Düzenle', exact=True).click()
    page.get_by_role('button', name='Yayınla', exact=True).click()
    page.get_by_text('Şimdi yayımla', exact=True).click()
    page.wait_for_function("document.querySelector('#save-status').textContent === 'Kaydedildi'")
    page.evaluate("localStorage.setItem('cms-test-repo',JSON.stringify(window.repoFiles))")
    page.reload()
    editor = page.locator('.cms-block-editor').first
    editor.wait_for()
    assert editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)') == ['text','image','text','code']
    assert editor.get_by_label('Genişlik', exact=True).input_value() == '58'
    assert 'project-icon.png' in editor.locator('.cms-image-block-preview img').get_attribute('src')
    assert editor.locator('.cms-code-input').input_value() == '  const example = 1;\n'
    print('PASS Project: desktop/320/390, media/width, block order, preview, TEST save/reopen')


def run(bundle, project_only=False):
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
        image = dict(src='/media/user-icon.png', alt='Test image', caption='Örnek açıklama',
                     width=37, unit='%', align='right', crop='none')
        media_dir = output / 'media'
        media_dir.mkdir(exist_ok=True)
        (media_dir / 'user-icon.png').write_bytes((ROOT / 'public/assets/user-icon.png').read_bytes())
        (media_dir / 'project-icon.png').write_bytes((ROOT / 'public/assets/project-icon.png').read_bytes())
        code = dict(code='  const check = "test content";\n\treturn check;\n', language='javascript', wrap=False)
        blog_name = next(iter(repo['content']['blog']))
        post = json.loads(repo['content']['blog'][blog_name]['content'])
        post['title'] = 'Örnek yazı: blok düzeni'
        post['shortDesc'] = 'Masaüstü ve mobil için test içeriği.'
        post['fullDesc'] = '\n\n'.join([
            'Test metni: İlk paragraf burada.', block('image', image),
            'Test metni: Görselden sonraki paragraf.', block('code', code)
        ])
        repo['content']['blog'][blog_name]['content'] = json.dumps(post)
        # Official test backend's folder listing uses flat folder keys.
        repo['content/blog'] = repo['content']['blog']
        repo['content/about.json'] = repo['content']['about.json']
        project_name = next(iter(repo['content']['project']))
        project = json.loads(repo['content']['project'][project_name]['content'])
        project['fullDesc'] = post['fullDesc']
        repo['content']['project'][project_name]['content'] = json.dumps(project)
        repo['content/project'] = repo['content']['project']
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
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append('console: ' + message.text) if 'cms image change' in message.text else None)
                page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
                for width in (() if project_only else (320, 375, 390, 1440)):
                    page.set_viewport_size({'width': width, 'height': 900})
                    for name in ('index.html', 'about_me.html', 'blog.html', 'projects.html', 'stress.html'):
                        page.goto(origin + '/' + name)
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
                if not project_only:
                    print('PASS visitor pages: 320/375/390/1440, code scroll/wrap, actual clipboard')

                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.route('https://cdn.jsdelivr.net/npm/decap-cms@3.17.1/dist/decap-cms.js',
                           lambda route: route.fulfill(path=str(bundle), content_type='application/javascript'))
                page.route('**/admin/config.yml', lambda route: route.fulfill(json=config))
                image_bytes = base64.b64encode((ROOT / 'public/assets/user-icon.png').read_bytes()).decode('ascii')
                second_image_bytes = base64.b64encode((ROOT / 'public/assets/project-icon.png').read_bytes()).decode('ascii')
                page.add_init_script("""(() => {
                  const files = JSON.parse(localStorage.getItem('cms-test-repo') || %s);
                  const addImage = (name, asset, base64, id) => {
                    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                    const fileObj = new File([bytes], name, {type:'image/png'});
                    files.content.media[name] = { path:'content/media/' + name, content:{
                      id, name, size:fileObj.size, path:'content/media/' + name,
                      url:'/assets/' + asset, displayURL:'/assets/' + asset, fileObj
                    } };
                  };
                  files.content.media = {};
                  addImage('user-icon.png', 'user-icon.png', %s, 'fixture-image-1');
                  addImage('project-icon.png', 'project-icon.png', %s, 'fixture-image-2');
                  window.repoFiles = files;
                })();""" % (json.dumps(json.dumps(repo)), json.dumps(image_bytes), json.dumps(second_image_bytes)))
                if project_only:
                    page.goto(origin + '/admin/')
                    page.get_by_role('button', name='Giriş', exact=True).click()
                    check_project(page, origin, project_name)
                    assert not errors, errors
                    browser.close()
                    return
                for kind in ('blog',):
                    slug = blog_name.removesuffix('.json')
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    editor = page.locator('.cms-block-editor').first
                    editor.wait_for()
                    block_count = editor.locator('.cms-content-block').count()
                    assert block_count == 4, (kind, block_count, page.locator('body').inner_text()[-2500:], errors)
                    assert editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)') == ['text', 'image', 'text', 'code']
                    assert page.locator('body').evaluate('(body)=>body.classList.contains("cms-blog-entry")')
                    assert page.locator('[data-blog-field="title-tr"]').is_hidden()
                    assert page.locator('[data-blog-field="slug"]').is_hidden()
                    screenshot_dir = ROOT / '.private' / 'editor-review'
                    screenshot_dir.mkdir(exist_ok=True)
                    page.screenshot(path=str(screenshot_dir / 'blog-desktop.png'), full_page=True)

                    image_block = editor.locator('.cms-content-block').nth(1)
                    image_block.click()
                    image_block.locator('input[type="number"]').scroll_into_view_if_needed()
                    image_block.get_by_label('Genişlik', exact=True).fill('58')
                    image_block.locator('.cms-image-settings select').nth(0).select_option('%')
                    image_block.locator('.cms-image-settings select').nth(1).select_option('right')
                    image_block.get_by_label('Alt metin', exact=True).fill('Demo image alt')
                    image_block.get_by_role('button', name='Görseli değiştir').click()
                    page.locator('div[tabindex="0"]').filter(has_text='project-icon.png').last.click()
                    page.get_by_role('button', name='Seçileni kullan', exact=True).click()
                    assert 'project-icon.png' in image_block.locator('.cms-image-block-preview img').get_attribute('src')

                    code_block = editor.locator('.cms-content-block').nth(3)
                    code_block.click()
                    code_block.locator('.cms-code-input').scroll_into_view_if_needed()
                    code_block.locator('.cms-code-settings select').select_option('python')
                    code_block.get_by_label('Uzun satırları sar', exact=True).check()
                    assert code_block.locator('.cms-code-input').input_value() == code['code']

                    page.get_by_role('button', name='Önizleme', exact=True).click()
                    assert editor.locator('.cms-blog-preview-panel').is_visible()
                    assert editor.locator('.cms-blog-preview-panel figure').count() == 1
                    page.get_by_role('button', name='Önizlemeyi kapat', exact=True).click()
                    page.set_viewport_size({'width':390, 'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.evaluate("({inner:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth,wide:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,cls:typeof e.className==='string'?e.className:'',id:e.id,r:e.getBoundingClientRect().right,w:e.getBoundingClientRect().width,scroll:e.scrollWidth})).filter(x=>x.r>innerWidth+1||x.w>innerWidth+1).sort((a,b)=>b.r-a.r).slice(0,12)})")
                    code_block.scroll_into_view_if_needed()
                    assert code_block.is_visible()
                    page.screenshot(path=str(screenshot_dir / 'blog-mobile.png'), full_page=True)
                    page.get_by_role('button', name='Yayınla', exact=True).click()
                    page.get_by_text('Şimdi yayımla', exact=True).click()
                    page.wait_for_function("(() => { const top=document.querySelector('#nc-root [class*=BackStatus]')?.textContent.trim(); const bottom=document.getElementById('save-status')?.textContent.trim(); const compact=t=>/kaydedilmemiş/i.test(t)?'Kaydedilmemiş':/kaydedildi/i.test(t)?'Kaydedildi':t; return top && compact(top)===bottom; })()")
                    saved = page.evaluate("([kind,name])=>JSON.parse(window.repoFiles.content[kind][name].content)", [kind, blog_name])
                    fence = chr(96) * 3
                    image_data = [json.loads(part.split('\n', 1)[0]) for part in saved['fullDesc'].split(fence + 'cms-image\n')[1:]]
                    code_data = [json.loads(part.split('\n', 1)[0]) for part in saved['fullDesc'].split(fence + 'cms-code\n')[1:]]
                    assert saved['fullDesc'].index('İlk paragraf') < saved['fullDesc'].index('cms-image') < saved['fullDesc'].index('Görselden sonraki paragraf') < saved['fullDesc'].index('cms-code')
                    assert image_data[0]['src'] == '/media/project-icon.png' and image_data[0]['width'] == 58 and image_data[0]['unit'] == '%'
                    assert image_data[0]['align'] == 'right' and image_data[0]['alt'] == 'Demo image alt'
                    assert code_data[0]['language'] == 'python' and code_data[0]['wrap'] is True
                    page.evaluate("localStorage.setItem('cms-test-repo',JSON.stringify(window.repoFiles))")
                    page.goto(origin + '/admin/')
                    if page.get_by_role('button', name='Giriş', exact=True).count():
                        page.get_by_role('button', name='Giriş', exact=True).click()
                    page.goto(origin + f'/admin/#/collections/{kind}/entries/{slug}')
                    editor = page.locator('.cms-block-editor').first
                    editor.wait_for()
                    assert editor.locator('.cms-content-block').evaluate_all('(xs)=>xs.map(x=>x.dataset.blockType)') == ['text', 'image', 'text', 'code']
                    reopened_image = editor.locator('.cms-content-block').nth(1)
                    reopened_image.click()
                    assert reopened_image.get_by_label('Genişlik', exact=True).input_value() == '58'
                    reopened_code = editor.locator('.cms-content-block').nth(3)
                    reopened_code.click()
                    assert reopened_code.locator('.cms-code-settings select').input_value() == 'python'
                    assert reopened_code.get_by_label('Uzun satırları sar', exact=True).is_checked()
                page.set_viewport_size({'width':1440, 'height':1100})
                page.goto(origin + '/admin/')
                page.locator('a[href="#/collections/about_page"]').click()
                page.locator('a[href="#/collections/about_page/entries/about"]').click()
                about_en = page.locator('#nc-root .Pane1 textarea').nth(0)
                about_tr = page.locator('#nc-root .Pane1 textarea').nth(1)
                about_en.wait_for()
                assert page.locator('#nc-root .Pane1 [data-about-language-pair="true"]').count() >= 1
                assert about_en.input_value().startswith('I approach cybersecurity')
                screenshot_dir = ROOT / '.private' / 'editor-review'
                screenshot_dir.mkdir(exist_ok=True)
                education_summary = page.locator('#nc-root .Pane1').get_by_text('Sivas Cumhuriyet University', exact=True).first
                education_summary.click()
                assert page.locator('#nc-root .Pane1 [data-about-language-pair="true"]').count() >= 3
                education_pair = page.locator('#nc-root .Pane1 [data-about-language-pair="true"]').nth(1)
                assert education_pair.evaluate('(e)=>getComputedStyle(e).gridTemplateColumns.split(" ").length >= 2')
                about_en.fill(about_en.input_value() + ' ')
                page.get_by_role('button', name='Yayınla', exact=True).wait_for()
                for width in (320, 390):
                    page.set_viewport_size({'width':width, 'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'horizontal overflow')
                    mobile_pair = education_pair.evaluate('(e)=>getComputedStyle(e).gridTemplateColumns')
                    assert mobile_pair == 'minmax(0px, 1fr)', (width, mobile_pair)
                    page.wait_for_function('''() => {const t=document.querySelector('#nc-root [class*=ToolbarContainer]')?.getBoundingClientRect();const v=document.querySelector('#nc-root [class*=ViewControls]')?.getBoundingClientRect();const p=document.querySelector('#nc-root .SplitPane')?.getBoundingClientRect();return t&&v&&p&&v.top>=t.bottom-1&&p.top>=v.bottom-1}''')
                    toolbar_flow = page.evaluate('''() => {const t=document.querySelector('#nc-root [class*=ToolbarContainer]').getBoundingClientRect();const v=document.querySelector('#nc-root [class*=ViewControls]').getBoundingClientRect();const p=document.querySelector('#nc-root .SplitPane').getBoundingClientRect();return {toolbarBottom:t.bottom,controlsTop:v.top,controlsBottom:v.bottom,formTop:p.top} }''')
                    assert toolbar_flow['controlsTop'] >= toolbar_flow['toolbarBottom'] - 1 and toolbar_flow['formTop'] >= toolbar_flow['controlsBottom'] - 1, (width, toolbar_flow)
                    mobile_toolbar = page.evaluate('''() => {const root=document.querySelector('#nc-root');const title=root.querySelector('[class*=ToolbarSectionBackLink]')?.getBoundingClientRect();const publish=root.querySelector('[class*=PublishButton]')?.getBoundingClientRect();const menu=root.querySelector('.cms-about-mobile-menu');const view=root.querySelector('[class*=ViewControls]');const status=document.querySelector('#cms-status');return {title:title?.toJSON(),publish:publish?.toJSON(),menu:menu?.getBoundingClientRect().toJSON(),view:view.getBoundingClientRect().toJSON(),siteText:menu?.querySelector('.cms-about-mobile-menu-site')?.textContent,statusText:status.innerText,statusHeight:status.getBoundingClientRect().height,infoOpen:status.querySelector('.cms-status-info').open}}''')
                    assert mobile_toolbar['publish'] and mobile_toolbar['title']['top'] <= mobile_toolbar['publish']['top'] + 8 and mobile_toolbar['title']['bottom'] >= mobile_toolbar['publish']['bottom'] - 8, (width, mobile_toolbar)
                    assert mobile_toolbar['menu'] and mobile_toolbar['siteText'] and 'Hesap / site:' in mobile_toolbar['siteText'], (width, mobile_toolbar)
                    assert mobile_toolbar['view']['top'] >= mobile_toolbar['title']['bottom'] - 1, (width, mobile_toolbar)
                    assert not mobile_toolbar['infoOpen'] and 'Kaydet / Publish herkese açık depoya yazar' not in mobile_toolbar['statusText'], (width, mobile_toolbar)
                    assert mobile_toolbar['statusHeight'] < 90, (width, mobile_toolbar)
                    assert page.locator('#save-status').inner_text() == 'Kaydedilmemiş'
                    page.locator('#cms-status summary').click()
                    assert page.locator('#cms-status').get_by_text('Kaydet / Publish herkese açık depoya yazar', exact=False).is_visible()
                    page.locator('#cms-status summary').click()
                    page.locator('#nc-root .cms-about-mobile-menu > summary').click()
                    page.wait_for_function("document.body.classList.contains('cms-about-mobile-menu-open')")
                    assert page.locator('#nc-root [class*="ToolbarSectionMeta"] a[href="https://0xd34dbyt3.github.io"]').is_visible()
                    menu_bounds = page.locator('#nc-root .cms-about-mobile-menu-panel').evaluate('(e)=>e.getBoundingClientRect().toJSON()')
                    assert menu_bounds['left'] >= 0 and menu_bounds['right'] <= width, (width, menu_bounds)
                    page.screenshot(path=str(screenshot_dir / f'about-mobile-menu-{width}.png'))
                    page.locator('#nc-root .cms-about-mobile-menu > summary').click()
                    page.wait_for_function("!document.body.classList.contains('cms-about-mobile-menu-open')")
                    page.screenshot(path=str(screenshot_dir / f'about-mobile-toolbar-{width}.png'))
                    topbars = page.locator('#nc-root .Pane1 [class*="TopBarContainer"]')
                    edu_index = topbars.evaluate_all("xs=>xs.findIndex(e=>e.getBoundingClientRect().height>0&&e.innerText.toLocaleLowerCase('tr').includes('eğitim'))")
                    edu_topbar = topbars.nth(edu_index)
                    edu_add = edu_topbar.locator('button[class*="AddButton"]')
                    add_state = {'visible':edu_add.is_visible(), 'text':edu_add.inner_text(), 'topbar':edu_topbar.inner_text(), 'count':edu_add.count(), 'index':edu_index}
                    assert add_state['visible'] and 'Ekle' in add_state['text'] and 'education_log' not in add_state['text'], (width, add_state)
                    topbar_flow = edu_topbar.evaluate('''e=>{const b=e.querySelector('[class*=AddButton]').getBoundingClientRect();const first=e.firstElementChild.getBoundingClientRect();return {titleBottom:first.bottom,addTop:b.top,addWidth:b.width,containerWidth:e.getBoundingClientRect().width,children:[...e.children].map(x=>({tag:x.tagName,cls:x.className,text:x.innerText,rect:[x.getBoundingClientRect().x,x.getBoundingClientRect().y,x.getBoundingClientRect().width,x.getBoundingClientRect().height]}))}}''')
                    assert topbar_flow['addTop'] >= topbar_flow['titleBottom'] - 1 and topbar_flow['addWidth'] <= topbar_flow['containerWidth'], (width, topbar_flow)
                    about_form_text = page.locator('#nc-root .Pane1').inner_text()
                    for label in ('EĞİTİM', 'İŞ DENEYİMİ', 'BECERİLER', 'SERTİFİKALAR'):
                        assert label in about_form_text, (width, label)
                    page.locator('#nc-root .Pane1').get_by_text('Vendor Certs', exact=True).scroll_into_view_if_needed()
                    page.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)')
                    page.wait_for_timeout(100)
                    end_access = page.evaluate('''() => {const rows=[...document.querySelectorAll('#nc-root .Pane1 *')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='Vendor Certs');const r=rows[0].getBoundingClientRect();const f=document.querySelector('#cms-status').getBoundingClientRect();return {rowBottom:r.bottom,availableBottom:innerHeight-f.height,footerHeight:f.height}}''')
                    assert end_access['rowBottom'] <= end_access['availableBottom'] + 1, (width, end_access)
                    assert page.locator('#nc-root .Pane1').get_by_text('Vendor Certs', exact=True).is_visible()
                    page.locator('#nc-root [class*="ViewControls"] button').first.click()
                    page.wait_for_function("document.body.classList.contains('cms-about-preview-active')")
                    toggle_state = page.locator('#nc-root [class*="ViewControls"] button').first.evaluate("e=>({title:e.title,aria:e.getAttribute('aria-label'),bound:e.dataset.aboutViewBound,body:document.body.className})")
                    assert 'cms-about-preview-active' in toggle_state['body'], (width, toggle_state)
                    pane_state = page.evaluate("() => {const p1=document.querySelector('#nc-root .Pane1'),p2=document.querySelector('#nc-root .Pane2'),s=document.querySelector('#nc-root .SplitPane'),r=document.querySelector('#nc-root');return {body:document.body.className,p1:p1&&getComputedStyle(p1).display,p1r:p1?.getBoundingClientRect().toJSON(),p2:p2&&getComputedStyle(p2).display,p2r:p2?.getBoundingClientRect().toJSON(),iframe:p2?.querySelector('iframe')?.getBoundingClientRect().toJSON(),split:s?.getBoundingClientRect().toJSON(),splitStyle:s&&{pos:getComputedStyle(s).position,top:getComputedStyle(s).top,bottom:getComputedStyle(s).bottom,height:getComputedStyle(s).height},root:r?.getBoundingClientRect().toJSON(),vars:{toolbar:getComputedStyle(document.documentElement).getPropertyValue('--about-toolbar-height'),controls:getComputedStyle(document.documentElement).getPropertyValue('--about-controls-height'),footer:getComputedStyle(document.documentElement).getPropertyValue('--cms-footer-height')}}}")
                    assert page.locator('#nc-root .Pane1').is_hidden() and page.locator('#nc-root .Pane2').is_visible(), pane_state
                    preview_mobile = page.frame_locator('iframe')
                    cert_heading = preview_mobile.get_by_role('heading', name='CERT_CHAIN', exact=True)
                    cert_heading.scroll_into_view_if_needed()
                    assert cert_heading.is_visible(), pane_state
                    preview_mobile.get_by_text('Vendor Certs', exact=True).scroll_into_view_if_needed()
                    page.evaluate("() => [document.documentElement,document.body,...document.querySelectorAll('#nc-root *')].forEach(e=>{if(e.scrollTop)e.scrollTop=0})")
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'preview horizontal overflow')
                    preview_geometry = page.evaluate("() => ({frame:document.querySelector('#nc-root .Pane2 iframe').getBoundingClientRect().bottom,footer:document.querySelector('#cms-status').getBoundingClientRect().top})")
                    assert preview_geometry['frame'] <= preview_geometry['footer'] + 1, (width, preview_geometry)
                    page.locator('#nc-root [class*="ViewControls"] button').first.click()
                    page.wait_for_function("!document.body.classList.contains('cms-about-preview-active')")
                    assert page.locator('#nc-root .Pane1').is_visible() and page.locator('#nc-root .Pane2').is_hidden()
                page.set_viewport_size({'width':1440, 'height':1100})
                about_en.fill('About preview test English')
                about_tr.fill('About önizleme test Türkçe')
                page.wait_for_function("(() => { const top=document.querySelector('#nc-root [class*=BackStatus]')?.textContent.trim(); const bottom=document.getElementById('save-status')?.textContent.trim(); const compact=t=>/kaydedilmemiş/i.test(t)?'Kaydedilmemiş':/kaydedildi/i.test(t)?'Kaydedildi':t; return top && compact(top)===bottom; })()")
                assert 'kaydedilmemiş' in page.locator('#nc-root [class*="BackStatus"]').text_content().lower()
                assert page.locator('#publish-status').inner_text() == 'Yayın durumu: Actions sonucu doğrulanmadı.'
                preview = page.frame_locator('iframe')
                preview.get_by_role('heading', name='whoami', exact=True).wait_for()
                assert preview.get_by_text('About preview test English', exact=True).is_visible()
                preview.get_by_role('button', name='TR', exact=True).click()
                assert preview.get_by_text('About önizleme test Türkçe', exact=True).is_visible()
                rendered = preview.locator('body').inner_text()
                assert all(value not in rendered for value in ('widget', 'required', 'label'))
                page.screenshot(path=str(screenshot_dir / 'about-desktop.png'), full_page=True)
                page.set_viewport_size({'width':390, 'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                about_tr.scroll_into_view_if_needed()
                page.screenshot(path=str(screenshot_dir / 'about-mobile.png'), full_page=True)
                page.get_by_role('button', name='Yayınla', exact=True).click()
                page.get_by_text('Şimdi yayımla', exact=True).click()
                page.wait_for_function("(() => { const top=document.querySelector('#nc-root [class*=BackStatus]')?.textContent.trim(); const bottom=document.getElementById('save-status')?.textContent.trim(); const compact=t=>/kaydedilmemiş/i.test(t)?'Kaydedilmemiş':/kaydedildi/i.test(t)?'Kaydedildi':t; return top && compact(top)===bottom; })()")
                saved_about = page.evaluate("JSON.parse(window.repoFiles.content['about.json'].content)")
                assert saved_about['whoami']['en'] == 'About preview test English'
                assert saved_about['whoami']['tr'] == 'About önizleme test Türkçe'
                assert saved_about['education'][0]['institution']['en'] == 'Sivas Cumhuriyet University'
                page.evaluate("localStorage.setItem('cms-test-repo',JSON.stringify(window.repoFiles))")
                page.goto(origin + '/admin/')
                page.locator('a[href="#/collections/about_page"]').click()
                page.locator('a[href="#/collections/about_page/entries/about"]').click()
                reopened_en = page.locator('#nc-root .Pane1 textarea').nth(0)
                reopened_tr = page.locator('#nc-root .Pane1 textarea').nth(1)
                reopened_en.wait_for()
                assert reopened_en.input_value() == 'About preview test English'
                assert reopened_tr.input_value() == 'About önizleme test Türkçe'
                assert page.locator('#nc-root .Pane1').get_by_text('Sivas Cumhuriyet University', exact=True).is_visible()
                page.wait_for_function("(() => { const top=document.querySelector('#nc-root [class*=BackStatus]')?.textContent.trim(); const bottom=document.getElementById('save-status')?.textContent.trim(); const compact=t=>/kaydedilmemiş/i.test(t)?'Kaydedilmemiş':/kaydedildi/i.test(t)?'Kaydedildi':t; return top && compact(top)===bottom; })()")
                assert page.locator('#save-status').inner_text() == 'Kaydedildi'
                assert page.locator('#publish-status').inner_text() == 'Yayın durumu: Actions sonucu doğrulanmadı.'
                page.set_viewport_size({'width':390, 'height':844})
                page.wait_for_function("document.querySelector('#nc-root .cms-about-mobile-menu') !== null")
                page.locator('#nc-root .cms-about-mobile-menu > summary').click()
                page.wait_for_function("document.body.classList.contains('cms-about-mobile-menu-open')")
                menu_labels = page.locator('#nc-root .cms-about-mobile-menu-panel button').all_inner_texts()
                assert any('Yayınlanan' in label for label in menu_labels), menu_labels
                assert any('Önizlemeyi Denetle' in label for label in menu_labels), menu_labels
                page.screenshot(path=str(screenshot_dir / 'about-mobile-menu-390-saved.png'))
                account_toggle = page.locator('#nc-root [class*="ToolbarSectionMeta"] [aria-haspopup="true"]')
                account_toggle.click()
                page.wait_for_function("document.querySelector('#nc-root [class*=ToolbarSectionMeta] [aria-haspopup=true]')?.getAttribute('aria-expanded')==='true'")
                account_toggle.evaluate('(e)=>e.click()')
                page.locator('#nc-root .cms-about-mobile-menu > summary').click()
                page.wait_for_function("!document.body.classList.contains('cms-about-mobile-menu-open')")
                page.set_viewport_size({'width':1440, 'height':1100})
                page.screenshot(path=str(screenshot_dir / 'about-desktop.png'), full_page=True)
                for width in (320, 390):
                    page.set_viewport_size({'width':width, 'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'reopened form overflow')
                    page.evaluate("() => [document.documentElement,document.body,...document.querySelectorAll('#nc-root *')].forEach(e=>{if(e.scrollTop)e.scrollTop=0})")
                    page.wait_for_function("(() => {const p=document.querySelector('#nc-root .Pane1'),f=document.querySelector('#cms-status');return p&&f&&p.getBoundingClientRect().bottom<=f.getBoundingClientRect().top+1})()")
                    viewport_pane = page.evaluate("() => {const p=document.querySelector('#nc-root .Pane1'),f=document.querySelector('#cms-status');return {pane:p.getBoundingClientRect().toJSON(),footer:f.getBoundingClientRect().toJSON(),overflow:getComputedStyle(p).overflowY,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight}}")
                    assert viewport_pane['pane']['bottom'] <= viewport_pane['footer']['top'] + 1, (width, viewport_pane)
                    page.screenshot(path=str(screenshot_dir / f'about-mobile-{width}-top.png'))
                    page.locator('#nc-root .Pane1').get_by_text('Vendor Certs', exact=True).scroll_into_view_if_needed()
                    last_vendor = page.locator('#nc-root .Pane1').get_by_text('Vendor Certs', exact=True)
                    assert last_vendor.is_visible()
                    last_geometry = page.evaluate("() => {const f=document.querySelector('#cms-status'),r=document.querySelector('#nc-root'),p=document.querySelector('#nc-root .Pane1'),s=document.querySelector('#nc-root .SplitPane');return {row:[...document.querySelectorAll('#nc-root .Pane1 *')].find(e=>e.childElementCount===0&&e.textContent.trim()==='Vendor Certs').getBoundingClientRect().bottom,footer:f.getBoundingClientRect().top,footerPosition:getComputedStyle(f).position,footerParent:f.parentElement.tagName+'.'+f.parentElement.className,rootParent:r.parentElement.tagName+'.'+r.parentElement.className,root:r.getBoundingClientRect().toJSON(),rootHeight:getComputedStyle(r).height,splitPosition:getComputedStyle(s).position,split:s.getBoundingClientRect().toJSON(),pageScroll:document.scrollingElement.scrollTop,paneScroll:p.scrollTop}}")
                    assert last_geometry['row'] <= last_geometry['footer'] + 1, (width, last_geometry)
                    page.screenshot(path=str(screenshot_dir / f'about-mobile-{width}-edit.png'))
                    if width == 390:
                        page.locator('#nc-root [class*="ViewControls"] button').first.click()
                        page.wait_for_function("document.body.classList.contains('cms-about-preview-active')")
                        mobile_preview = page.frame_locator('iframe')
                        mobile_preview.get_by_role('heading', name='CERT_CHAIN', exact=True).scroll_into_view_if_needed()
                        assert mobile_preview.get_by_role('heading', name='CERT_CHAIN', exact=True).is_visible()
                        page.screenshot(path=str(screenshot_dir / 'about-mobile-390-preview.png'))
                        page.locator('#nc-root [class*="ViewControls"] button').first.click()
                        page.wait_for_function("!document.body.classList.contains('cms-about-preview-active')")
                print('PASS Decap / TEST backend: Blog text-image-text-code edit, image settings, preview, save/reopen; desktop/mobile screenshots')
                check_project(page, origin, project_name)
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--decap-bundle', type=Path, required=True)
    parser.add_argument('--project-only', action='store_true')
    args = parser.parse_args()
    run(args.decap_bundle.resolve(), project_only=args.project_only)
