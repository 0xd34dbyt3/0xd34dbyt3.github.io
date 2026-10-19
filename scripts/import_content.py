"""Promote a reviewed read-only export; refuse to replace existing user content."""
import argparse
import hashlib
import html
import json
import shutil
from pathlib import Path
from build_pages import ROOT, load_posts, read_json, validate_about, build
import tempfile

def promote(stage, destination, approved):
    if not approved:
        raise ValueError('Profile and every referenced image require explicit --approve-public-profile-and-images')
    manifest = read_json(stage / 'migration.json')
    if manifest.get('status') != 'review-required':
        raise ValueError('Not a reviewed export candidate')
    posts = load_posts(stage)
    counts = {k: sum(p['type'] == k for p in posts) for k in ('blog', 'project')}
    if counts != manifest.get('publishedCounts'):
        raise ValueError('Published record count mismatch')
    validate_about(read_json(stage / 'about.json'))
    for item in manifest.get('images', []):
        ref = item['ref']
        if ref.startswith('/uploads/'):
            source = stage / 'media' / Path(ref).name
        elif ref.startswith('assets/') and Path(ref).name == ref[len('assets/'):]:
            source = ROOT / 'public' / ref
        else:
            raise ValueError('Unexpected image reference')
        if source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Referenced image checksum mismatch')
    expected_media = {Path(i['ref']).name for i in manifest.get('images', []) if i['ref'].startswith('/uploads/')}
    actual_media = {p.name for p in (stage / 'media').iterdir() if p.name != '.gitkeep'}
    if expected_media != actual_media:
        raise ValueError('Unreviewed/missing staged media')
    if len(manifest.get('images', [])) != manifest.get('referencedImages'):
        raise ValueError('Referenced image count mismatch')
    for kind in ('blog', 'project', 'media'):
        if (destination / kind).exists() and any(p.name != '.gitkeep' for p in (destination / kind).iterdir()):
            raise ValueError('Destination contains existing content; merge manually after review')
    if (destination / 'about.json').exists():
        old = read_json(destination / 'about.json')
        blank = read_json(ROOT / 'pages/empty-about.json')
        if old != blank:
            raise ValueError('Refusing to overwrite existing profile')
    # Verify references and generated output in a disposable directory before promotion.
    with tempfile.TemporaryDirectory() as temp:
        build(Path(temp) / 'site', content=stage)
    destination.mkdir(parents=True, exist_ok=True)
    for kind in ('blog', 'project', 'media'):
        (destination / kind).mkdir(exist_ok=True)
        for source in (stage / kind).iterdir():
            if source.is_file() and source.name != '.gitkeep':
                target = destination / kind / source.name
                if kind in ('blog', 'project'):
                    data = read_json(source)
                    # The legacy API HTML-escaped titles/summaries before writing MySQL.
                    for field in ('title', 'title_tr', 'shortDesc', 'shortDesc_tr'):
                        data[field] = html.unescape(data.get(field, ''))
                    with target.open('x', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                else:
                    with target.open('xb') as f:
                        f.write(source.read_bytes())
    shutil.copyfile(stage / 'about.json', destination / 'about.json')
    manifest.update(status='complete', profileApproved=True)
    (destination / 'migration.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'status': 'complete', 'publishedCounts': counts, 'referencedImages': len(manifest['images'])}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', type=Path)
    parser.add_argument('--destination', type=Path, default=ROOT / 'content')
    parser.add_argument('--approve-public-profile-and-images', action='store_true')
    args = parser.parse_args()
    promote(args.stage, args.destination, args.approve_public_profile_and_images)
