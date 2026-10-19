# 0xd34dbyt3.github.io

Static visitor site generated from public/ templates and content/ JSON (Markdown bodies).

Build: `python3 -m pip install -r requirements-pages.txt` then `python3 scripts/build_pages.py --release --output dist/site`.

The current content preserves text already embedded in the public HTML files. It is not a verified MySQL export; see content/migration.json.

GitHub Pages source: GitHub Actions. OAuth is not required for visitor publication. Admin is explicitly disabled pending the separate HTTPS OAuth broker described in oauth/README.md; enable adminEnabled and set oauthOrigin in site.config.json only after setup. No credentials belong in this repository.
