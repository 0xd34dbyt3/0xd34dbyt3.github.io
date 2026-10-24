"""Shared Blog/Projects UI regression. TEST backend, never real GitHub acceptance."""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = 'https://portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev'
IMAGE = 'https://raw.githubusercontent.com/0xd34dbyt3/0xd34dbyt3.github.io/main/content/media/image-f982ac6b-972c-4ed5-867c-100f93247098.png'


def run(executable):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable)
        context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'],viewport={'width':1440,'height':1000})
        page = context.new_page()
        page.set_default_timeout(15000)
        config = page.request.get(ORIGIN + '/admin/config.yml').json()
        config['backend'] = {'name':'test-repo','repo':'test/test','branch':'security/fixture'}
        tree = {'content':{'blog':{},'project':{},'media':{}}}
        for kind in ('blog','project'):
            data = {'id':'77' if kind == 'blog' else '78','slug':'fixture','title':'Fixture',
                    'shortDesc':'Regression','fullDesc':'Metin A\nMetin B','fullDesc_tr':'TR korunur'}
            tree['content'][kind]['fixture.json'] = {'path':f'content/{kind}/fixture.json','content':json.dumps(data)}
            tree['content/'+kind] = tree['content'][kind]
        about = json.loads((ROOT/'content/about.json').read_text())
        tree['content']['about.json'] = {'path':'content/about.json','content':json.dumps(about)}
        tree['content/about.json'] = tree['content']['about.json']
        page.add_init_script('window.repoFiles=JSON.parse(localStorage.getItem("common-fixture") || '+json.dumps(json.dumps(tree))+');')
        def html(route):
            response = route.fetch()
            route.fulfill(response=response,body=(ROOT/'pages/admin.html').read_text())
        page.route(re.compile(re.escape(ORIGIN)+r'/admin/(?:\?.*)?$'),html)
        page.route(ORIGIN+'/admin/config.yml',lambda route:route.fulfill(json=config))
        def file_handler(path):
            return lambda route: route.fulfill(path=str(ROOT/path))
        for url, path in [('/js/content-tools.js','public/js/content-tools.js'),('/styles.css','public/styles.css'),('/content.css','public/content.css')]:
            page.route(ORIGIN+url,file_handler(path))
        prelude = '''
          window.fixtureEditors = {};
          const register = CMS.registerWidget;
          CMS.registerWidget = (name, Control, Preview) => register(name,
            name==='ordered-content' ? class extends Control {
              constructor(...args){super(...args);fixtureEditors[this.props.entry.get('collection')+':'+this.props.field.get('name')]=this;}
            } : Control, Preview);
        '''
        page.route(ORIGIN+'/admin/admin.js',lambda route:route.fulfill(body=prelude+(ROOT/'pages/admin.js').read_text(),content_type='application/javascript'))
        page.goto(ORIGIN+'/admin/',wait_until='networkidle')
        page.get_by_role('button',name='Giriş',exact=True).click()

        def save():
            page.get_by_role('button',name='Kaydet',exact=True).click()
            page.get_by_text('Depoya kaydet',exact=True).click()
            page.wait_for_function("document.getElementById('save-status').textContent.startsWith('Depoya kaydedildi')")

        for kind in ('blog','project'):
            page.goto(ORIGIN+f'/admin/?collection={kind}#/collections/{kind}/entries/fixture')
            page.wait_for_function("kind=>!!fixtureEditors[kind+':fullDesc']",arg=kind)
            root=page.locator('.cms-post-content-editor').first
            root.wait_for()
            text=root.get_by_role('textbox',name='Metin bloğu').first
            text.evaluate("node=>{node.focus();node.setSelectionRange(8,8)}")
            root.get_by_role('button',name='İmlece görsel ekle',exact=True).first.click()
            page.evaluate("({kind,src})=>fixtureEditors[kind+':fullDesc'].updateData(1,{src})",{'kind':kind,'src':IMAGE})
            image=root.locator('.cms-block-image')
            image.click()
            image.get_by_label('Genişlik',exact=True).fill('58')
            image.locator('.cms-image-settings select').nth(1).select_option('right')
            tail=root.get_by_role('textbox',name='Metin bloğu').last
            tail.evaluate('node=>{node.focus();node.setSelectionRange(node.value.length,node.value.length)}')
            root.get_by_role('button',name='İmlece kod ekle',exact=True).last.click()
            code=root.locator('.cms-block-code')
            code.locator('.cms-code-input').fill('  const fixture = "EN/TR";\n')
            code.locator('.cms-code-settings select').select_option('javascript')
            code.get_by_role('button',name='Bloku yukarı taşı').click()
            code.get_by_role('button',name='Bloku aşağı taşı').click()
            code.get_by_role('button',name='Kodu kopyala').click()
            assert page.evaluate('navigator.clipboard.readText()') == '  const fixture = "EN/TR";\n'
            root.get_by_role('button',name='Önizleme',exact=True).click()
            page.wait_for_function("()=>{const i=document.querySelector('.cms-post-preview-panel img');return i&&i.complete&&i.naturalWidth>0}")
            page.set_viewport_size({'width':390,'height':1000})
            page.get_by_role('button',name='Kaydet',exact=True).scroll_into_view_if_needed()
            assert page.get_by_role('button',name='Kaydet',exact=True).is_visible()
            page.set_viewport_size({'width':1440,'height':1000})
            save()
            stored=page.evaluate('(kind)=>JSON.parse(repoFiles.content[kind]["fixture.json"].content)',kind)
            parsed=page.evaluate('(source)=>ContentTools.parseDocument(source)',stored['fullDesc'])
            assert [b['type'] for b in parsed] == ['text','image','text','code']
            assert parsed[0]['value'].strip()=='Metin A' and parsed[2]['value'].strip()=='Metin B'
            assert parsed[1]['value']['width']==58 and parsed[1]['value']['align']=='right'
            assert parsed[3]['value']['language']=='javascript'
            assert stored['id']==('77' if kind=='blog' else '78') and stored['slug']=='fixture'
            assert stored['fullDesc_tr']=='TR korunur'
            page.evaluate("localStorage.setItem('common-fixture',JSON.stringify(repoFiles))")
            page.reload(wait_until='networkidle')
            root=page.locator('.cms-post-content-editor').first
            root.wait_for()
            assert root.locator('.cms-block-image').count()==1 and root.locator('.cms-block-code').count()==1
            root.locator('.cms-block-image').click()
            assert root.get_by_label('Genişlik',exact=True).input_value()=='58'
            for width in (1440,390):
                page.set_viewport_size({'width':width,'height':1000})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(kind,width)
                clean=page.get_by_role('button',name='Depodaki kayıt',exact=True)
                clean.scroll_into_view_if_needed()
                assert clean.is_visible()
                root.get_by_role('button',name='Önizleme',exact=True).click()
                assert root.locator('.cms-post-preview-panel').is_visible()
                root.get_by_role('button',name='Önizlemeyi kapat',exact=True).click()
                page.screenshot(path=str(ROOT/'.private'/f'common-{kind}-{width}.png'))
            assert 'canlı' in page.locator('#cms-environment').inner_text()
            print('PASS shared editor',kind,'TEST backend save/reopen, caret split, order, width, EN/TR/id/slug, copy, desktop/390')
            page.set_viewport_size({'width':1440,'height':1000})
        page.goto(ORIGIN+'/admin/#/collections/about_page/entries/about')
        about_en=page.locator('#nc-root .Pane1 textarea').first
        about_en.wait_for()
        about_en.fill(about['whoami']['en']+' fixture')
        save()
        stored=page.evaluate("JSON.parse(repoFiles.content['about.json'].content)")
        assert 'slug' not in stored
        assert stored['whoami']['en']==about['whoami']['en']+' fixture'
        assert stored['whoami']['tr']==about['whoami']['tr']
        print('PASS About save preserves schema and TR; no injected slug (TEST backend)')
        browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable',required=True,type=lambda value:str(Path(value).resolve()))
    run(parser.parse_args().executable)
