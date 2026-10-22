import copy
import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_pages import ROOT, build, markdown_html, base_path, validate_about, read_json, audit, validate_image, get_feeds, AllowlistedRedirectHandler
from bs4 import BeautifulSoup

class PagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = self.root / 'content'
        for folder in ['blog', 'project', 'media']:
            (self.content / folder).mkdir(parents=True)
        self.site = dict(origin='https://test.example', basePath='/', repository='test/repo', branch='main', oauthOrigin='https://auth.example', contentReady=True)
        self.write('about.json', read_json(ROOT / 'pages/empty-about.json'))
        self.write('migration.json', dict(status='complete', profileApproved=True))
        self.post = dict(id='42', slug='test-only-fixture', title='Synthetic test content', title_tr='Yalnızca test', shortDesc='Not real migrated content', shortDesc_tr='Gerçek aktarım değildir', fullDesc='# Heading\n\n```python\nprint("test")\n```\n\n![alt|320](/uploads/test.png)\n\n<script>alert(1)</script><img src="x" onerror="alert(1)">', createdAt='2026-01-01T00:00:00Z', imageUrl='/uploads/test.png')
        # Remove deliberately broken reference for successful build fixtures.
        self.post['fullDesc'] = self.post['fullDesc'].split('<script>')[0]
        self.write('blog/test-only-fixture.json', self.post)
        (self.content / 'media/test.png').write_bytes((ROOT / 'public/assets/user-icon.png').read_bytes())

    def write(self, name, data):
        (self.content / name).write_text(json.dumps(data))

    def test_build_root_project_and_preserve_design(self):
        for i, prefix in enumerate(['/', '/repo/']):
            site = dict(self.site, basePath=prefix)
            output = self.root / str(i)
            report = build(output, self.content, site, release=True)
            self.assertEqual(report['posts'], {'blog': 1, 'project': 0})
            self.assertEqual(report['referencedImages'], 1)
            self.assertEqual((output / 'styles.css').read_bytes(), (ROOT / 'public/styles.css').read_bytes())
            self.assertEqual((output / 'script.js').read_bytes(), (ROOT / 'public/script.js').read_bytes())
            soup = BeautifulSoup((output / 'blog/test-only-fixture/index.html').read_text(), 'html.parser')
            self.assertEqual(soup.select_one('#pageTitle').text, self.post['title'])
            self.assertIn('width:320px;', str(soup))
            self.assertTrue(soup.select_one('pre code'))
            self.assertEqual(soup.select_one('.detail-image')['src'], prefix + 'media/test.png')
            self.assertIn('Yalnızca test', (output / 'blog/test-only-fixture/tr.html').read_text())
            legacy = BeautifulSoup((output / 'detail.html').read_text(), 'html.parser')
            mapping = json.loads(legacy.select_one('#legacy-map').text)
            self.assertEqual(mapping['blog:42'], prefix + 'blog/test-only-fixture/')
            self.assertEqual(mapping['blog:test-only-fixture'], mapping['blog:42'])
            cms = read_json(output / 'admin/config.yml')
            self.assertEqual(cms['backend']['name'], 'github')
            self.assertEqual(cms['public_folder'], prefix + 'media')
            self.assertFalse((output / 'server').exists())
            self.assertFalse((output / 'admin/dashboard.html').exists())
            self.assertFalse((output / 'deploy.zip').exists())
            for page in ['index.html', 'about_me.html', 'blog.html', 'projects.html', 'detail.html']:
                original = BeautifulSoup((ROOT / 'public' / page).read_text(), 'html.parser')
                result = BeautifulSoup((output / page).read_text(), 'html.parser')
                self.assertEqual([s.text for s in original.select('style')], [s.text for s in result.select('style')])
                self.assertEqual(original.select_one('main').get('class'), result.select_one('main').get('class'))

    def test_sanitize_markdown(self):
        result = markdown_html('<script>alert(1)</script><iframe src="https://bad.test"></iframe><img src="javascript:alert(1)" onerror="bad()"><a href="javascript:bad()">bad</a>\n\n![ok|40%;color:red](/media/test.png)', '/repo/')
        self.assertNotIn('<script', result)
        self.assertNotIn('<iframe', result)
        self.assertNotIn('onerror', result)
        self.assertNotIn('javascript:', result)
        self.assertNotIn('style="width:40%', result)
        raw = markdown_html('<img src="/uploads/test.png" style="width:450px; background:url(https://bad.example)">\n\n~~removed~~\n\n`/api/example`', '/repo/')
        self.assertIn('width:450px;', raw)
        self.assertNotIn('bad.example', raw)
        self.assertIn('<del>removed</del>', raw)

    def test_reject_secret_fields_missing_images_duplicates(self):
        for extra in [{'password': 'test-not-secret'}, {'isPublished': False}, {'imageUrl': '/media/missing.png'}]:
            self.write('blog/test-only-fixture.json', dict(self.post, **extra))
            with self.assertRaises(ValueError):
                build(self.root / ('out-' + next(iter(extra))), self.content, self.site)

    def test_no_overwrite_and_release_gate(self):
        output = self.root / 'occupied'
        output.mkdir()
        (output / 'user-file').write_text('preserve')
        with self.assertRaises(ValueError):
            build(output, self.content, self.site)
        self.assertEqual((output / 'user-file').read_text(), 'preserve')
        with self.assertRaises(ValueError):
            build(self.root / 'blocked', self.content, dict(self.site, contentReady=False), release=True)

    def test_file_snapshot_can_release_without_oauth_but_admin_stays_disabled(self):
        self.write('migration.json', dict(status='file-snapshot', fileContentApproved=True, profileApproved=True, databaseMigration='pending'))
        self.post['createdAt'] = ''
        self.write('blog/test-only-fixture.json', self.post)
        site = dict(self.site, adminEnabled=False, oauthOrigin='https://OAUTH_HOST.example.invalid')
        output = self.root / 'visitor-only'
        report = build(output, self.content, site, release=True)
        self.assertFalse(report['adminEnabled'])
        self.assertIn('henüz etkin değil', (output / 'admin/index.html').read_text())
        self.assertFalse((output / 'admin/config.yml').exists())
        with self.assertRaises(ValueError):
            build(self.root / 'invalid-admin', self.content, dict(site, adminEnabled=True), release=True)

    def test_profile_unknown_fields_and_base_path(self):
        about = read_json(self.content / 'about.json')
        about['profile']['password'] = 'not-secret'
        with self.assertRaises(ValueError): validate_about(about)
        for bad in ['/../', '//example/', '/repo', 'repo/']:
            with self.assertRaises(ValueError): base_path(bad)

    def test_output_audit_blocks_private_file_and_api(self):
        output = self.root / 'audit'
        build(output, self.content, self.site)
        (output / '.env').write_text('not a real secret')
        with self.assertRaises(ValueError): audit(output, '/')

    def test_content_add_edit_delete_rebuild(self):
        project = dict(self.post, id='43', slug='synthetic-project', title='Synthetic project')
        self.write('project/synthetic-project.json', project)
        first = build(self.root / 'first', self.content, self.site)
        self.assertEqual(first['posts'], {'blog': 1, 'project': 1})
        project['title'] = 'Edited synthetic project'
        self.write('project/synthetic-project.json', project)
        build(self.root / 'edited', self.content, self.site)
        self.assertIn('Edited synthetic project', (self.root / 'edited/project/synthetic-project/index.html').read_text())
        (self.content / 'project/synthetic-project.json').unlink()  # synthetic temporary fixture only
        final = build(self.root / 'deleted', self.content, self.site)
        self.assertEqual(final['posts']['project'], 0)
        self.assertFalse((self.root / 'deleted/project/synthetic-project/index.html').exists())

    def test_feed_cache_is_dated_not_live_and_rejects_private_fields(self):
        cache = dict(news=dict(items=[dict(title='Synthetic news', url='https://example.org/news', source='Test', date='2026-01-01')], updatedAt='2026-01-01T00:00:00Z', status='snapshot'))
        self.write('feeds.json', cache)
        output = self.root / 'cache'
        build(output, self.content, self.site)
        soup = BeautifulSoup((output / 'index.html').read_text(), 'html.parser')
        self.assertEqual(soup.select_one('#newsStatus').text, 'CACHED')
        self.assertEqual(soup.select_one('#cveStatus').text, 'UNAVAILABLE')
        self.assertEqual(soup.select_one('time')['datetime'], '2026-01-01T00:00:00Z')
        cache['news']['items'][0]['password'] = 'synthetic-private-field'
        self.write('feeds.json', cache)
        with self.assertRaises(ValueError): build(self.root / 'private-cache', self.content, self.site)

    def test_image_dimensions_reject_decompression_bomb_headers(self):
        def png(width, height):
            return b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + width.to_bytes(4, 'big') + height.to_bytes(4, 'big')
        self.assertEqual(validate_image(png(320, 200), '.png'), (320, 200))
        for dimensions in [(8193, 1), (7000, 7000), (0, 10)]:
            with self.assertRaises(ValueError):
                validate_image(png(*dimensions), '.png')

    def test_feed_redirect_outside_allowlist_fails_closed(self):
        class Redirected:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return 'https://attacker.example/feed'
            def read(self, _): return b'<rss><channel></channel></rss>'
        with patch('build_pages.open_feed_url', return_value=Redirected()):
            feeds = get_feeds(self.content, refresh=True)
        self.assertEqual(feeds['news']['status'], 'unavailable')
        self.assertEqual(feeds['cve']['status'], 'unavailable')

    def test_feed_redirect_is_rejected_before_target_request(self):
        handler = AllowlistedRedirectHandler({'feeds.example'})
        request = urllib.request.Request('https://feeds.example/source')
        with patch.object(urllib.request.HTTPRedirectHandler, 'redirect_request') as parent:
            with self.assertRaisesRegex(ValueError, 'Unexpected feed redirect'):
                handler.redirect_request(request, None, 302, 'Found', {}, 'https://forbidden.example/private')
        parent.assert_not_called()

if __name__ == '__main__': unittest.main()
