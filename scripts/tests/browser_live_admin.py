"""Real GitHub App UI acceptance. No mocked routes, fake credentials or TEST backend.

Writes only explicitly named acceptance entries; About changes are restored exactly.
Requires the user's logged-in Chromium at the local CDP address.
"""
import argparse
import base64
import json
import re
import struct
import zlib
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
REPO = '0xd34dbyt3/0xd34dbyt3.github.io'
ORIGINS = {'appcheck':'https://portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev',
           'production':'https://portfolio-admin-auth.muhammedfatihozturk02.workers.dev'}
BRANCHES = {'appcheck':'security/github-app-check', 'production':'main'}
REPORT = ROOT / '.private/admin-live-acceptance.json'
MARKER = 'ADMIN_ACCEPTANCE_FIXTURE — kullanıcı içeriği değildir.'


def png_fixture():
    def chunk(kind, data):
        return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    raw = b''.join(b'\0'+bytes([40,115,190])*64 for _ in range(48))
    data = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',64,48,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    path = ROOT/'.private/admin-acceptance.png'
    path.write_bytes(data)
    return path


def run(args):
    origin, branch = ORIGINS[args.target], BRANCHES[args.target]
    report = json.loads(REPORT.read_text()) if REPORT.exists() else {}
    if args.target == 'production' and args.step in ('posts','about'):
        check = report.get('appcheck',{})
        assert all(key in check for key in ('blog','project','about')), 'Real appcheck acceptance must pass first'
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(args.cdp)
        context = browser.contexts[0]
        page = context.new_page()  # Preserve the user's existing tabs and drafts.
        page.add_init_script("window.acceptanceReceipts=[];document.addEventListener('cms-entry-saved',e=>acceptanceReceipts.push(e.detail.sha));")
        page.set_default_timeout(20000)
        page.set_viewport_size({'width':1440,'height':1000})
        updates = []
        def response_seen(response):
            url = urlsplit(response.url)
            if url.hostname == 'api.github.com' and '/git/refs/heads/' in url.path and response.request.method == 'PATCH':
                assert response.status == 200, 'GitHub ref write failed: '+str(response.status)
                result = response.json()
                updates.append({'sha':result.get('object',{}).get('sha'),
                                'branch':unquote(url.path.split('/git/refs/heads/',1)[1])})
        page.on('response',response_seen)
        page.goto(origin+'/admin/',wait_until='networkidle')
        config = page.request.get(origin+'/admin/config.yml').json()
        assert config['backend']['name']=='github-app' and config['backend']['branch']==branch
        login = page.get_by_role('button',name='GitHub ile Giriş',exact=True)
        sidebar = page.locator('a[href="#/collections/blog"]')
        login.or_(sidebar).first.wait_for()
        assert sidebar.is_visible(), 'NEEDS_USER_LOGIN: complete App login in the dedicated browser and keep it open'
        context.grant_permissions(['clipboard-read','clipboard-write'],origin=origin)

        def read_file(path, missing=False, commit=None):
            url=f'https://api.github.com/repos/{REPO}/contents/'+quote(path,safe='/')+'?ref='+quote(commit or branch,safe='')
            res=context.request.get(url,headers={'Cache-Control':'no-cache'})
            if missing and res.status==404: return None
            assert res.status==200,(path,res.status)
            obj=res.json()
            return obj

        def stored_json(path,commit=None):
            return json.loads(base64.b64decode(read_file(path,commit=commit)['content']))

        def save():
            before=len(updates)
            page.get_by_role('button',name='Kaydet',exact=True).click()
            page.get_by_text('Depoya kaydet',exact=True).click()
            try:
                page.wait_for_function("document.getElementById('save-status').textContent.startsWith('Depoya kaydedildi')",timeout=45000)
            except Exception:
                if not page.is_closed():
                    print(json.dumps({'save_status':page.locator('#save-status').inner_text(),
                                      'save_message':page.locator('#save-message').inner_text(),
                                      'inline_errors':page.get_by_role('alert').all_text_contents(),
                                      'confirmed_ref_updates':updates},ensure_ascii=False),flush=True)
                raise
            assert len(updates)>before,'No real GitHub ref update observed'
            assert updates[-1]['branch']==branch,'Unexpected write branch'
            assert page.evaluate('acceptanceReceipts.at(-1)')==updates[-1]['sha'],'Publication receipt must identify the exact confirmed commit'
            return updates[-1]['sha']

        def open_entry(kind, slug):
            page.goto(origin+f'/admin/?acceptance={kind}#/collections/{kind}/entries/{slug}',wait_until='networkidle')
            page.locator('.cms-post-content-editor').first.wait_for()

        def screen_checks(kind):
            root=page.locator('.cms-post-content-editor').first
            for width in (1440,390):
                page.set_viewport_size({'width':width,'height':1000})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(kind,width,'overflow')
                save_button=page.get_by_role('button',name='Kaydet',exact=True).or_(page.get_by_role('button',name='Depodaki kayıt',exact=True))
                save_button.scroll_into_view_if_needed()
                assert save_button.is_visible()
                preview=root.get_by_role('button',name='Önizleme',exact=True)
                preview.scroll_into_view_if_needed(); preview.click()
                assert root.locator('.cms-post-preview-panel').is_visible()
                image=root.locator('.cms-post-preview-panel img')
                image.scroll_into_view_if_needed()
                page.wait_for_function("()=>{const i=document.querySelector('.cms-post-preview-panel img');return i&&i.complete&&i.naturalWidth>0}")
                assert root.locator('.cms-post-preview-panel code').inner_text()=='  const acceptance = "'+kind+'";\n'
                page.screenshot(path=str(ROOT/'.private'/f'live-{args.target}-{kind}-{width}.png'))
                root.get_by_role('button',name='Önizlemeyi kapat',exact=True).click()
            page.set_viewport_size({'width':1440,'height':1000})

        if args.step=='inspect':
            result={}
            for kind in ('blog','project'):
                page.goto(origin+f'/admin/#/collections/{kind}',wait_until='networkidle')
                page.locator(f'a[href^="#/collections/{kind}/entries/"]').first.click()
                page.locator('.cms-block-editor').first.wait_for()
                result[kind]=page.evaluate("()=>({background:getComputedStyle(document.body).backgroundColor,classes:document.body.className,toolbars:document.querySelectorAll('.cms-post-editor-toolbar,.cms-blog-editor-toolbar').length})")
                page.screenshot(path=str(ROOT/'.private'/f'live-before-{kind}.png'))
            print(json.dumps({'real_app_session':True,'target':args.target,'before':result},ensure_ascii=False))
            page.close(); return

        if args.step=='posts':
            png=png_fixture()
            def verify_post(kind,slug,sha):
                path=f'content/{kind}/{slug}.json'
                data=stored_json(path,sha)
                parsed=page.evaluate('source=>ContentTools.parseDocument(source)',data['fullDesc'])
                assert [b['type'] for b in parsed]==['text','image','text','code']
                assert parsed[0]['value'].strip()=='Admin kabul metni '+kind+'.'
                assert parsed[2]['value'].strip()=='Görselden sonraki metin korunur.'
                assert parsed[1]['value']['width']==58 and parsed[1]['value']['unit']=='%' and parsed[1]['value']['align']=='right'
                assert parsed[3]['value']['language']=='javascript'
                assert data['slug']==slug and data['title_tr']=='Admin doğrulama örneği — '+kind
                src=parsed[1]['value']['src']
                assert src.startswith('/media/'), 'Stored media must remain a public relative URL'
                media_path='content/media/'+src.removeprefix('/media/')
                media=read_file(media_path,commit=sha)
                raw=context.request.get(media['download_url'])
                assert raw.status==200 and raw.headers.get('content-type','').startswith('image/')
                open_entry(kind,slug)
                image=page.locator('.cms-post-content-editor').first.locator('.cms-block-image')
                image.click()
                assert image.get_by_label('Genişlik',exact=True).input_value()=='58'
                screen_checks(kind)
                page.screenshot(path=str(ROOT/'.private'/f'live-{args.target}-{kind}-reopened.png'))
                report.setdefault(args.target,{})[kind]={'real':True,'branch':branch,'commit':sha,'path':path,'media_path':media_path,'media_sha':media['sha'],'raw_http':raw.status,'desktop_and_390':True}
                REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2))
                print(json.dumps({kind:report[args.target][kind]},ensure_ascii=False),flush=True)
            for kind in ('blog','project'):
                slug='admin-acceptance-'+kind
                path=f'content/{kind}/{slug}.json'
                previous=read_file(path,missing=True)
                if previous:
                    old=json.loads(base64.b64decode(previous['content']))
                    assert old.get('shortDesc')==MARKER,'Existing user content must never be overwritten'
                    commits=context.request.get(f'https://api.github.com/repos/{REPO}/commits?sha='+quote(branch,safe='')+'&path='+quote(path,safe='')+'&per_page=1').json()
                    verify_post(kind,slug,commits[0]['sha'])
                    continue
                page.goto(origin+f'/admin/?acceptance={kind}#/collections/{kind}/new',wait_until='networkidle')
                root=page.locator('.cms-post-content-editor').first
                root.wait_for()
                page.locator('input[id^="title-field-"]').fill(slug)
                page.locator('textarea[id^="shortDesc-field-"]').fill(MARKER)
                root.get_by_role('button',name='İçerik ayarları',exact=True).click()
                page.locator('input[id^="title_tr-field-"]').fill('Admin doğrulama örneği — '+kind)
                page.locator('textarea[id^="shortDesc_tr-field-"]').fill(MARKER)
                root.get_by_role('button',name='İçerik ayarlarını kapat',exact=True).click()
                first='Admin kabul metni '+kind+'.'
                second='Görselden sonraki metin korunur.'
                textarea=root.get_by_role('textbox',name='Metin bloğu').first
                textarea.fill(first+'\n'+second)
                textarea.evaluate('(node,position)=>{node.focus();node.setSelectionRange(position,position)}',len(first)+1)
                root.get_by_role('button',name='İmlece görsel ekle',exact=True).first.click()
                image=root.locator('.cms-block-image')
                page.evaluate('''() => {window.acceptanceUploadName=null;addEventListener('change',event=>{
                  if(event.target.matches('input[type=file]')&&event.target.files[0]?.name.startsWith('image-'))
                    window.acceptanceUploadName=event.target.files[0].name;
                },true)}''')
                image.get_by_role('button',name='Bir resim seçin',exact=True).click()
                page.locator('input[type=file]').last.set_input_files(str(png))
                page.wait_for_function('typeof acceptanceUploadName === "string"')
                uploaded=page.evaluate('acceptanceUploadName')
                card=page.locator('div[tabindex="0"]').filter(has_text=uploaded).last
                card.locator('img').wait_for()
                use=page.get_by_role('button',name='Seçileni kullan',exact=True)
                if not use.is_enabled():
                    card.locator('[tabindex="-1"]').click()
                expect(use).to_be_enabled()
                use.click()
                page.wait_for_function("()=>{const i=document.querySelector('.cms-image-block-preview img');return i&&i.complete&&i.naturalWidth>0}")
                image.get_by_label('Genişlik',exact=True).fill('58')
                image.locator('.cms-image-settings select').nth(1).select_option('right')
                tail=root.get_by_role('textbox',name='Metin bloğu').last
                tail.evaluate('node=>{node.focus();node.setSelectionRange(node.value.length,node.value.length)}')
                root.get_by_role('button',name='İmlece kod ekle',exact=True).last.click()
                code=root.locator('.cms-block-code')
                code.locator('.cms-code-input').fill('  const acceptance = "'+kind+'";\n')
                code.locator('.cms-code-settings select').select_option('javascript')
                code.get_by_role('button',name='Bloku yukarı taşı').click()
                code.get_by_role('button',name='Bloku aşağı taşı').click()
                code.get_by_role('button',name='Kodu kopyala').click()
                assert page.evaluate('navigator.clipboard.readText()')=='  const acceptance = "'+kind+'";\n'
                screen_checks(kind)
                sha=save()
                verify_post(kind,slug,sha)

        if args.step=='about':
            backup=ROOT/'.private'/f'about-before-{args.target}.json'
            commits=context.request.get(f'https://api.github.com/repos/{REPO}/commits?sha='+quote(branch,safe='')+'&path=content%2Fabout.json&per_page=1').json()
            latest_sha=commits[0]['sha']
            current=stored_json('content/about.json',latest_sha)
            original=json.loads(backup.read_text()) if backup.exists() else current
            if not backup.exists(): backup.write_text(json.dumps(original,ensure_ascii=False))
            expected=json.loads(json.dumps(original))
            expected['whoami']['en']+=' [admin kabul]'
            expected['whoami']['tr']+=' [admin kabul]'
            assert current in (original,expected),'About changed outside acceptance; preserve it and inspect before proceeding'
            page.goto(origin+'/admin/#/collections/about_page/entries/about',wait_until='networkidle')
            en=page.locator('#nc-root .Pane1 textarea').nth(0)
            tr=page.locator('#nc-root .Pane1 textarea').nth(1)
            if current==original:
                en.fill(expected['whoami']['en']);tr.fill(expected['whoami']['tr'])
                sha=save()
            else: sha=latest_sha
            changed=stored_json('content/about.json',sha)
            assert 'slug' not in changed
            assert changed['whoami']['en']==original['whoami']['en']+' [admin kabul]'
            assert changed['whoami']['tr']==original['whoami']['tr']+' [admin kabul]'
            page.reload(wait_until='networkidle')
            assert en.input_value()==changed['whoami']['en'] and tr.input_value()==changed['whoami']['tr']
            en.fill(original['whoami']['en']);tr.fill(original['whoami']['tr'])
            for width in (1440,390):
                page.set_viewport_size({'width':width,'height':1000})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                page.get_by_role('button',name='Kaydet',exact=True).scroll_into_view_if_needed()
                assert page.get_by_role('button',name='Kaydet',exact=True).is_visible()
                if width==390:
                    page.get_by_role('button',name='Önizle',exact=True).click()
                    page.locator('#nc-root .Pane2 iframe').wait_for(state='visible')
                    frame=page.locator('#nc-root .Pane2 iframe').element_handle().content_frame()
                    frame.wait_for_function("text=>document.body.innerText.replace(/\\s+/g,' ').includes(text)",arg=' '.join(original['whoami']['en'].split()))
                    page.get_by_role('button',name='Düzenle',exact=True).click()
                page.screenshot(path=str(ROOT/'.private'/f'live-{args.target}-about-{width}.png'))
            restored_sha=save()
            assert stored_json('content/about.json',restored_sha)==original,'About content must be restored exactly'
            report.setdefault(args.target,{})['about']={'real':True,'commit':sha,'restored_commit':restored_sha,'exactly_restored':True,'desktop_and_390':True}
            REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2))
            print(json.dumps({'about':report[args.target]['about']},ensure_ascii=False))
        page.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',choices=ORIGINS,default='appcheck')
    parser.add_argument('--step',choices=['inspect','posts','about'],required=True)
    parser.add_argument('--cdp',default='http://127.0.0.1:9223')
    run(parser.parse_args())
