import json
import sys
import unittest
from pathlib import Path
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_pages import markdown_html, validate_about, ROOT, read_json
from cms_config import config
from content_blocks import block_data


def block(kind, value):
    return f'```cms-{kind}\n{json.dumps(value)}\n```'


class ContentBlockTests(unittest.TestCase):
    def test_image_layout_caption_and_safe_markup(self):
        for align in ('left', 'center', 'right'):
            for width, unit in [(42, '%'), (720, 'px')]:
                value = dict(src='/media/test.png', alt='<img onerror=alert(1)>', caption='<script>bad()</script>',
                             width=width, unit=unit, align=align, crop='none')
                soup = BeautifulSoup(markdown_html(block('image', value), '/repo/'), 'html.parser')
                self.assertEqual(soup.figure['style'], f'width:{width}{unit}')
                self.assertIn('align-' + align, soup.figure['class'])
                self.assertIn('crop-none', soup.figure['class'])
                self.assertEqual(soup.img['src'], '/repo/media/test.png')
                self.assertEqual(soup.img['alt'], value['alt'])
                self.assertFalse(soup.select('script, [onerror]'))
                self.assertEqual(soup.figcaption.text, value['caption'])
        for bad in [dict(width=101), dict(width=0), dict(width=True), dict(align='left;position:fixed'),
                    dict(crop='arbitrary'), dict(style='color:red'), dict(src='javascript:alert(1)')]:
            with self.assertRaises(ValueError):
                markdown_html(block('image', dict(src='/media/test.png', **bad) if 'src' not in bad else bad), '/')

    def test_code_exact_text_wrap_and_order(self):
        code = '  <script>alert("test")</script>\n\treturn `x`;\n\n'
        source = '# Before\n\n' + block('code', dict(code=code, language='javascript', wrap=True)) + '\n\nAfter'
        soup = BeautifulSoup(markdown_html(source, '/'), 'html.parser')
        self.assertEqual(soup.code.text, code)
        self.assertEqual(soup.pre['data-wrap'], 'true')
        self.assertEqual(soup.code['class'], ['language-javascript'])
        self.assertFalse(soup.script)
        self.assertLess(str(soup).index('Before'), str(soup).index('<pre'))
        self.assertLess(str(soup).index('</pre>'), str(soup).index('After'))
        for bad in [dict(language='"><script>'), dict(wrap='false'), dict(code={})]:
            with self.assertRaises(ValueError): block_data('code', bad)

    def test_about_crud_reorder_and_cms_contract(self):
        about = read_json(ROOT / 'content/about.json')
        for key in ('education', 'work', 'skills', 'certs'):
            entries = about[key]
            original = list(entries)
            sample = dict(entries[0]) if entries else {
                'education': {'institution': {'en': 'Test', 'tr': 'Deneme'}},
                'work': {'title': {'en': 'Test', 'tr': 'Deneme'}},
                'skills': {'category': {'en': 'Test', 'tr': 'Deneme'}, 'items': []},
                'certs': {'title': {'en': 'Test', 'tr': 'Deneme'}}
            }[key]
            entries.append(sample)
            validate_about(about)
            name = next(k for k, v in sample.items() if isinstance(v, dict))
            sample[name] = {'en': 'Edited', 'tr': 'Düzenlendi'}
            entries.reverse()
            validate_about(about)
            self.assertEqual(entries[0][name]['tr'], 'Düzenlendi')
            entries.pop(0)
            entries.reverse()
            self.assertEqual(entries, original)
        cms = config(read_json(ROOT / 'site.config.json'))
        def all_fields(fields):
            for entry in fields:
                yield entry
                yield from all_fields(entry.get('fields', []))
        about_fields = list(all_fields(cms['collections'][2]['files'][0]['fields']))
        for name in ('core_focus', 'education', 'work', 'skills', 'certs'):
            entry = next(f for f in about_fields if f['name'] == name)
            self.assertTrue(entry['allow_add'] and entry['allow_remove'] and entry['allow_reorder'])
        for collection in cms['collections'][:2]:
            markdown = [f for f in collection['fields'] if f['widget'] == 'markdown']
            self.assertEqual(len(markdown), 2)
            for field in markdown:
                self.assertEqual(field['editor_components'], ['managed-image', 'managed-code'])
                self.assertEqual(field['modes'], ['rich_text'])


if __name__ == '__main__':
    unittest.main()
