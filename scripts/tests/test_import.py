import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from import_content import promote
from build_pages import ROOT, read_json

class ImportTests(unittest.TestCase):
    def test_review_counts_checksums_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp) / 'stage'
            target = Path(temp) / 'content'
            for folder in ('blog', 'project', 'media'):
                (stage / folder).mkdir(parents=True)
            (stage / 'about.json').write_text((ROOT / 'pages/empty-about.json').read_text())
            post = dict(id='71', slug='synthetic', title='A &amp; B', shortDesc='Synthetic only', fullDesc='![test](/uploads/test.png)', createdAt='2026-01-01T00:00:00Z')
            (stage / 'blog/synthetic.json').write_text(json.dumps(post))
            image = (ROOT / 'public/assets/user-icon.png').read_bytes()
            (stage / 'media/test.png').write_bytes(image)
            manifest = dict(status='review-required', publishedCounts=dict(blog=1, project=0), referencedImages=1, images=[dict(ref='/uploads/test.png', sha256=hashlib.sha256(image).hexdigest())])
            (stage / 'migration.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): promote(stage, target, False)
            self.assertFalse(target.exists())
            promote(stage, target, True)
            self.assertEqual(read_json(target / 'blog/synthetic.json')['title'], 'A & B')
            self.assertTrue(read_json(target / 'migration.json')['profileApproved'])
            with self.assertRaises(ValueError): promote(stage, target, True)
            (stage / 'media/test.png').write_bytes(b'corrupt synthetic fixture')
            with self.assertRaises(ValueError): promote(stage, Path(temp) / 'other', True)

if __name__ == '__main__': unittest.main()
