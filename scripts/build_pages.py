"""Build only approved content and explicit frontend assets; never import the legacy server.

public/ remains the single design/template source. Legacy root copies are not used.
Output directories must be new/empty, so no existing work is deleted or overwritten.
"""
import argparse
import datetime as dt
import html
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, unquote

import bleach
from defusedxml import ElementTree as ET
from bleach.css_sanitizer import CSSSanitizer
import mistune
from bs4 import BeautifulSoup
from cms_config import config as cms_config
from content_blocks import expand_blocks

ROOT = Path(__file__).resolve().parents[1]
PAGES = ["index.html", "about_me.html", "blog.html", "projects.html", "detail.html"]
ASSETS = ["styles.css", "script.js", "js/vortex-bg.js", "content.css", "js/content-tools.js", "assets/background.png", "assets/project-icon.png", "assets/user-icon.png", ".well-known/security.txt"]
POST_FIELDS = {"id", "slug", "title", "title_tr", "shortDesc", "shortDesc_tr", "fullDesc", "fullDesc_tr", "imageUrl", "createdAt", "updatedAt"}
TAGS = set(bleach.sanitizer.ALLOWED_TAGS) | {"p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "img", "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "del", "div", "span", "details", "summary"}
MARKDOWN = mistune.create_markdown(escape=False, plugins=['strikethrough', 'table', 'url'])
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 40_000_000


class AllowlistedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject a redirect before urllib opens the redirected request."""

    def __init__(self, allowed_hosts):
        self.allowed_hosts = frozenset(allowed_hosts)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.hostname not in self.allowed_hosts:
            raise ValueError("Unexpected feed redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_feed_url(url, allowed_hosts, timeout=8):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
        raise ValueError("Unexpected feed source")
    opener = urllib.request.build_opener(AllowlistedRedirectHandler(allowed_hosts))
    return opener.open(urllib.request.Request(url, headers={"User-Agent": "StaticPortfolioBuild/1.0"}), timeout=timeout)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def esc(s):
    return html.escape(str(s or ""), quote=True)


def text(value, lang="en"):
    if isinstance(value, dict):
        return value.get(lang) or value.get("en") or value.get("tr") or ""
    return str(value or "")


def base_path(value):
    if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*", value):
        raise ValueError("basePath must be / or /repository/ (trailing slash required)")
    return value


def local_url(value, base):
    value = str(value or "")
    if not value or value.startswith("#"):
        return value
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme not in ("https", "mailto"):
            raise ValueError("Unsupported content URL scheme")
        return value
    path = unquote(parsed.path)
    if ".." in Path(path).parts or "\\" in path or path.startswith("//"):
        raise ValueError("Unsafe content path")
    path = path.lstrip("/")
    if base != "/" and path.startswith(base.strip("/") + "/"):
        path = path[len(base.strip("/")) + 1:]
    if path.startswith("uploads/"):
        path = "media/" + path[len("uploads/"):]
    return base + path + ("?" + parsed.query if parsed.query else "") + ("#" + parsed.fragment if parsed.fragment else "")


def image_dimensions(raw, suffix):
    """Read dimensions without decoding attacker-controlled compressed pixels."""
    suffix = suffix.lower()
    if suffix == ".png" and len(raw) >= 24 and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if suffix == ".gif" and len(raw) >= 10 and raw.startswith((b"GIF87a", b"GIF89a")):
        return int.from_bytes(raw[6:8], "little"), int.from_bytes(raw[8:10], "little")
    if suffix in {".jpg", ".jpeg"} and raw.startswith(b"\xff\xd8\xff"):
        offset = 2
        sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while offset + 4 <= len(raw):
            if raw[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(raw) and raw[offset] == 0xFF:
                offset += 1
            if offset >= len(raw):
                break
            marker = raw[offset]
            offset += 1
            if marker in {0x01, 0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(raw):
                break
            length = int.from_bytes(raw[offset:offset + 2], "big")
            if length < 2 or offset + length > len(raw):
                break
            if marker in sof and length >= 7:
                return int.from_bytes(raw[offset + 5:offset + 7], "big"), int.from_bytes(raw[offset + 3:offset + 5], "big")
            offset += length
    if suffix == ".webp" and len(raw) >= 30 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        kind = raw[12:16]
        if kind == b"VP8X":
            return 1 + int.from_bytes(raw[24:27], "little"), 1 + int.from_bytes(raw[27:30], "little")
        if kind == b"VP8L" and len(raw) >= 25 and raw[20] == 0x2F:
            b1, b2, b3, b4 = raw[21:25]
            return 1 + (b1 | ((b2 & 0x3F) << 8)), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0F) << 10))
        if kind == b"VP8 " and raw[23:26] == b"\x9d\x01\x2a":
            return int.from_bytes(raw[26:28], "little") & 0x3FFF, int.from_bytes(raw[28:30], "little") & 0x3FFF
    return None


def validate_image(raw, suffix):
    dimensions = image_dimensions(raw, suffix)
    if not dimensions or not all(dimensions):
        raise ValueError("Image signature or dimensions rejected")
    width, height = dimensions
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("Image dimensions exceed the safe limit")
    return dimensions


def markdown_html(source, base):
    rendered = MARKDOWN(source or "")
    clean = bleach.clean(rendered, tags=TAGS, attributes={"a": ["href", "title"], "img": ["src", "alt", "title", "style"], "code": ["class"], "th": ["align"], "td": ["align"]}, css_sanitizer=CSSSanitizer(allowed_css_properties=['width']), protocols=["https", "mailto"], strip=True)
    soup = BeautifulSoup(clean, "html.parser")
    for image in soup.select("img"):
        alt, sep, size = image.get("alt", "").partition("|")
        if not sep:
            width = re.search(r'(?:^|;)\s*width\s*:\s*([1-9][0-9]{0,3}(?:px|%))\s*(?:;|$)', image.get('style', ''))
            if width:
                sep, size = '|', width.group(1)
        image["alt"] = alt
        style = "max-width:100%;height:auto;display:block;margin:1.25rem auto;border-radius:6px;border:1px solid var(--border-color);"
        if sep and re.fullmatch(r"[1-9][0-9]{0,3}(?:px|%)?", size.strip()):
            size = size.strip()
            style = "width:" + size + ("" if size.endswith(("px", "%")) else "px") + ";" + style
        image["style"] = style
    for el in soup.select("[src], [href]"):
        for attr in ("src", "href"):
            if el.has_attr(attr):
                el[attr] = local_url(el[attr], base)
    expand_blocks(soup, local_url, base)
    return str(soup)


def fragment(soup, selector, value):
    node = soup.select_one(selector)
    if node is None:
        raise ValueError("Template selector missing: " + selector)
    node.clear()
    for child in list(BeautifulSoup(value, "html.parser").contents):
        node.append(child)


def label(soup, selector, value):
    node = soup.select_one(selector)
    if node:
        node.string = str(value)


def template(name, base):
    soup = BeautifulSoup((ROOT / "public" / name).read_text(), "html.parser")
    # Keep the original canvas and terminal code; remove only dynamic data loaders.
    for script in list(soup.select("script")):
        if "DataManager" in script.text or "cdnjs.cloudflare.com/ajax/libs/marked" in script.get("src", ""):
            script.decompose()
        elif name == "index.html" and "async function loadNews" in script.text:
            script.string = script.text[:script.text.index("    // ═", script.text.index("window.addEventListener('resize'"))]
    if not soup.select('script[src^="script.js"]'):
        node = soup.new_tag("script", src="script.js?v=4", type="module")
        soup.body.append(node)
    for node in soup.select("[src], [href]"):
        for attr in ("src", "href"):
            if node.has_attr(attr):
                node[attr] = local_url(node[attr], base)
    if name == "detail.html":
        soup.head.append(soup.new_tag("link", rel="stylesheet", href=base + "content.css"))
        soup.body.append(soup.new_tag("script", src=base + "js/content-tools.js", defer=True))
    return soup


def seo(soup, site, path, title, description, image=""):
    soup.title.string = title + " — 0xDEADBYTE"
    for node in list(soup.select('meta[name="description"],link[rel="canonical"],meta[property^="og:"]')):
        node.decompose()
    url = site["origin"].rstrip("/") + site["basePath"] + path
    soup.head.append(soup.new_tag("link", rel="canonical", href=url))
    for attrs in [{"name": "description", "content": description}, {"property": "og:title", "content": title},
                  {"property": "og:description", "content": description}, {"property": "og:url", "content": url},
                  {"property": "og:type", "content": "article" if path.startswith(("blog/", "project/")) else "website"}]:
        soup.head.append(soup.new_tag("meta", attrs=attrs))
    if image:
        image = local_url(image, site["basePath"])
        soup.head.append(soup.new_tag("meta", attrs={"property": "og:image", "content": image if image.startswith("https:") else site["origin"] + image}))


def load_posts(content):
    posts, ids, slugs = [], set(), set()
    for kind in ("blog", "project"):
        for path in sorted((content / kind).glob("*.json")):
            if path.is_symlink() or not path.resolve().is_relative_to(content.resolve()):
                raise ValueError("Symlink content rejected")
            post = read_json(path)
            if set(post) - POST_FIELDS:
                raise ValueError(f"Unexpected/private post fields: {path.name}")
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", post.get("slug", "")):
                raise ValueError("Invalid slug: " + path.name)
            if path.stem != post["slug"]:
                raise ValueError("Filename must equal stable slug: " + path.name)
            for key in ("title", "shortDesc"):
                if not isinstance(post.get(key), str) or not post[key].strip():
                    raise ValueError("Missing " + key + ": " + path.name)
            if post.get("createdAt"):
                dt.datetime.fromisoformat(post["createdAt"].replace("Z", "+00:00"))
            for key, value in post.items():
                if value is not None and not isinstance(value, str):
                    raise ValueError("Post fields must be strings: " + path.name)
            identity = (kind, post["slug"])
            if identity in slugs:
                raise ValueError("Duplicate slug")
            slugs.add(identity)
            if post.get("id"):
                if not re.fullmatch(r"[0-9]+", post["id"]) or post["id"] in ids:
                    raise ValueError("Invalid or duplicate legacy ID")
                ids.add(post["id"])
            posts.append(dict(post, type=kind))
    return sorted(posts, key=lambda p: (p.get("createdAt", ""), -int(p['id']) if p.get('id') else 0), reverse=True)


def validate_about(about):
    def obj(value, keys):
        if not isinstance(value, dict) or set(value) - set(keys):
            raise ValueError("Unexpected/private profile fields")
    def bi(value):
        obj(value, ["en", "tr"])
        if any(not isinstance(v, str) for v in value.values()):
            raise ValueError("Invalid translated profile text")
    obj(about, ["whoami", "profile", "education", "work", "skills", "certs"])
    bi(about.get("whoami", {}))
    p = about.get("profile", {})
    obj(p, ["name", "status", "location", "role", "core_focus", "image"])
    bi(p.get("role", {}))
    for key in ["name", "status", "location", "image"]:
        if not isinstance(p.get(key, ""), str):
            raise ValueError("Invalid profile field")
    for item in p.get("core_focus", []):
        bi(item)
    for key, fields in [("education", ["institution", "detail"]), ("work", ["title", "company", "desc", "duration"]), ("certs", ["title", "desc"]), ("skills", ["category", "items"])]:
        if not isinstance(about.get(key, []), list):
            raise ValueError("Invalid profile list")
        for item in about.get(key, []):
            obj(item, fields)
            for name, value in item.items():
                if name == "items":
                    for entry in value:
                        bi(entry)
                elif name == "duration":
                    if not isinstance(value, str):
                        raise ValueError("Invalid duration")
                else:
                    bi(value)


def render_about(soup, about, base, lang="tr"):
    # Preserve original classes and inline styles from the old DOM renderer.
    label(soup, "#whoamiText", text(about.get("whoami"), lang) or "Content has not been imported yet.")
    edu = "".join('<div class="education-entry"><strong style="color:var(--accent-color)">' + esc(text(e.get("institution"), lang)) + '</strong><div style="color:var(--text-secondary);font-size:0.95rem;margin-top:0.2rem">' + esc(text(e.get("detail"), lang)) + '</div></div>' for e in about.get("education", []))
    fragment(soup, "#educationList", edu)
    work = ""
    for w in about.get("work", []):
        work += '<div class="education-entry"><div style="font-weight:700;color:var(--accent-color);font-size:1.05rem;">' + esc(text(w.get("title"), lang)) + '</div><div style="display:flex;align-items:center;gap:0.6rem;margin-top:0.35rem;flex-wrap:wrap;"><span style="color:var(--text-secondary);font-size:0.9rem;font-weight:500;">' + esc(text(w.get("company"), lang)) + '</span><span style="font-size:0.72rem;color:#27c93f;background:rgba(39,201,63,0.1);border:1px solid rgba(39,201,63,0.35);padding:0.12rem 0.5rem;border-radius:4px;font-weight:600;display:inline-block;">' + esc(w.get("duration")) + '</span></div>'
        if text(w.get("desc"), lang):
            work += '<div style="color:var(--text-muted);font-size:0.88rem;margin-top:0.45rem;line-height:1.5;">' + esc(text(w["desc"], lang)) + '</div>'
        work += '</div>'
    fragment(soup, "#workList", work)
    skills = "".join('<div class="skill-box"><strong style="color:var(--accent-color)">' + esc(text(s["category"], lang)) + '</strong><div style="margin-top:0.6rem">' + ''.join('<span class="chip">' + esc(text(i, lang)) + '</span>' for i in s["items"]) + '</div></div>' for s in about.get("skills", []))
    fragment(soup, "#skillGrid", skills)
    fragment(soup, "#certList", ''.join('<details><summary style="color:var(--text-muted)">' + esc(text(c.get("title"), lang)) + '</summary><p style="color:var(--text-secondary);margin-top:0.5rem">' + esc(text(c.get("desc"), lang)) + '</p></details>' for c in about.get("certs", [])))
    profile = about.get("profile", {})
    if profile.get("status"):
        status = soup.new_tag("div", attrs={"class": "meta-row", "id": "profileStatus"})
        status.string = profile["status"]
        soup.select_one("#profileName").insert_after(status)
    for selector, key in [("#profileName", "name"), ("#profileLoc", "location"), ("#profileRole", "role")]:
        label(soup, selector, text(profile.get(key), lang))
    soup.select_one("#profileImage")["src"] = local_url(profile.get("image") or "assets/user-icon.png", base)
    fragment(soup, "#profileFocus", ''.join('<span class="chip">' + esc(text(i, lang)) + '</span>' for i in profile.get("core_focus", [])))


def get_feeds(content, refresh):
    previous = read_json(content / "feeds.json") if (content / "feeds.json").exists() else {}
    result = {}
    for kind in ("news", "cve"):
        old = previous.get(kind, {})
        if old.get('items'):
            dt.datetime.fromisoformat(str(old.get('updatedAt', '')).replace('Z', '+00:00'))
            for item in old['items']:
                if not isinstance(item, dict) or set(item) - {'id', 'title', 'url', 'source', 'date'} or any(not isinstance(v, str) for v in item.values()):
                    raise ValueError('Unexpected/private cached feed fields')
        data = dict(items=old.get("items", []), updatedAt=old.get("updatedAt"), status="cached" if old.get("items") else "unavailable")
        if refresh:
            try:
                url = "https://feeds.feedburner.com/TheHackersNews" if kind == "news" else "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
                allowed_source_hosts = {"feeds.feedburner.com"} if kind == "news" else {"www.cisa.gov"}
                with open_feed_url(url, allowed_source_hosts) as response:
                    if urlsplit(response.geturl()).hostname not in allowed_source_hosts:
                        raise ValueError("Unexpected feed redirect")
                    raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise ValueError("Feed too large")
                if kind == "news":
                    items = [dict(title=n.findtext("title", ""), url=n.findtext("link", ""), source="The Hacker News", date=n.findtext("pubDate", "")) for n in ET.fromstring(raw).findall(".//item")[:6]]
                    if any(urlsplit(i["url"]).hostname not in {"thehackernews.com", "www.thehackernews.com"} for i in items):
                        raise ValueError("Unexpected news link host")
                else:
                    rows = sorted(json.loads(raw)["vulnerabilities"], key=lambda v: v.get("dateAdded", ""), reverse=True)[:6]
                    items = [dict(id=v["cveID"], title=v["vulnerabilityName"], url="https://nvd.nist.gov/vuln/detail/" + v["cveID"], source="CISA KEV", date=v["dateAdded"]) for v in rows]
                if (not items or any(urlsplit(i["url"]).scheme != "https" or len(i["url"]) > 2048
                                    or len(i.get("title", "")) > 500 or len(i.get("date", "")) > 200
                                    or len(i.get("source", "")) > 100 for i in items)):
                    raise ValueError("Invalid feed")
                data = dict(items=items, updatedAt=dt.datetime.now(dt.timezone.utc).isoformat(), status="snapshot")
            except Exception:
                print(f"Feed {kind}: update unavailable; using dated cache or explicit empty state.")
        result[kind] = data
    return result


def render_feeds(soup, feeds):
    for kind in ("news", "cve"):
        data = feeds[kind]
        status = ("CACHED" if data["status"] == "cached" else "SNAPSHOT") if data["items"] else "UNAVAILABLE"
        label(soup, "#" + kind + "Status", status)
        soup.select_one("#" + kind + "Status")["class"] = ["feed-live-dot"]
        rows = ""
        for item in data["items"]:
            if not str(item.get("url", "")).startswith("https://"):
                raise ValueError("Unsafe feed link")
            link = '<a class="feed-item-link" target="_blank" rel="noopener noreferrer" href="' + esc(item["url"]) + '">' + esc(item.get("id") or item["title"]) + '</a>'
            if kind == "cve":
                link = '<div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;">' + link + '<span class="sev-badge sev-kev">KEV EXPLOITED</span></div><div style="color:var(--text-muted);font-size:0.75rem;line-height:1.4;margin-top:0.2rem;">' + esc(item["title"]) + '</div>'
            rows += '<div class="feed-item">' + link + '<div class="feed-item-meta">' + esc(str(item.get("date", "")) + ' · ' + item.get("source", "")) + '</div></div>'
        if rows:
            updated = dt.datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00'))
            rows += '<div class="feed-item-meta">Last updated: <time datetime="' + esc(data['updatedAt']) + '">' + esc(updated.strftime('%Y-%m-%d %H:%M %Z')) + '</time></div>'
        fragment(soup, "#" + kind + "Items", rows or '<div class="feed-item">Feed could not be updated. No live data is available.</div>')


def audit(output, base):
    """Check every output path and local HTML reference, including missing media."""
    allowed = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".json", ".yml", ".xml", ".txt"}
    for path in output.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(output)
        allowed_hidden = rel.as_posix() in {".nojekyll", ".well-known/security.txt"}
        if path.is_symlink() or (not allowed_hidden and (path.suffix not in allowed or any(p.startswith(".") for p in rel.parts))):
            raise ValueError("Forbidden output file: " + str(rel))
        if any(p in {"server", "node_modules", ".git", ".aws", ".codex"} for p in rel.parts):
            raise ValueError("Private directory in output")
        if path.suffix in (".html", ".js", ".json", ".yml"):
            source = path.read_text()
            executable = source if path.suffix == '.js' else '\n'.join(s.text for s in BeautifulSoup(source, 'html.parser').select('script:not([type="application/json"])')) if path.suffix == '.html' else ''
            if re.search(r"(?:/api/|pn_token|pn_admin|fallback_secret_change_me)", executable):
                raise ValueError("Legacy API or private configuration in output: " + str(rel))
        if path.suffix != ".html":
            continue
        soup = BeautifulSoup(path.read_text(), "html.parser")
        for tag in soup.select("[src], [href]"):
            for attr in ("src", "href"):
                url = tag.get(attr, "")
                parsed = urlsplit(url)
                if not url or url.startswith("#") or parsed.scheme or parsed.netloc:
                    continue
                name = unquote(parsed.path)
                if name.startswith(base + 'api/'):
                    raise ValueError('Local API reference in static output')
                if name.startswith("/"):
                    if not name.startswith(base):
                        raise ValueError("Base path escaped: " + name)
                    target = output / name[len(base):]
                else:
                    target = path.parent / name
                if target.is_dir():
                    target = target / "index.html"
                if not target.is_file() or not target.resolve().is_relative_to(output.resolve()):
                    raise ValueError("Missing/unsafe local reference: " + str(rel) + " -> " + name)


def build(output, content=ROOT / "content", site=None, refresh=False, release=False):
    site = dict(site or read_json(ROOT / "site.config.json"))
    base = base_path(site["basePath"])
    origin = urlsplit(site["origin"])
    if origin.scheme != "https" or origin.path not in ("", "/") or origin.query or origin.fragment:
        raise ValueError("origin must be an HTTPS origin without a path")
    posts = load_posts(content)
    about = read_json(content / "about.json")
    validate_about(about)
    migration = read_json(content / "migration.json")
    accepted_content = migration['status'] == 'complete' or (migration['status'] == 'file-snapshot' and migration.get('fileContentApproved') is True)
    if release and (not site["contentReady"] or not accepted_content or not migration.get("profileApproved") or "GITHUB_" in site['origin'] + site['repository']):
        raise ValueError("Release blocked: approve source content and configure the public site first")
    admin_enabled = site.get('adminEnabled', True)
    if release and admin_enabled and ('.invalid' in site['oauthOrigin'] or not site['oauthOrigin'].startswith('https://')):
        raise ValueError('Admin enabled but OAuth origin is not configured')
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output is not empty; choose a new --output directory (nothing deleted)")
    output.mkdir(parents=True, exist_ok=True)
    for asset in ASSETS:
        dest = output / asset
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "public" / asset, dest)
    # Only media referenced by approved content is copied; never copy uploads wholesale.
    media_refs = set()
    def save(path, soup):
        for image in soup.select("img[src]"):
            src = image["src"]
            if src.startswith(base + "media/"):
                media_refs.add(unquote(urlsplit(src).path[len(base + "media/"):]))
        dest = output / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(str(soup), encoding="utf-8")
    for page in PAGES:
        soup = template(page, base)
        if page == "index.html":
            feeds = get_feeds(content, refresh)
            render_feeds(soup, feeds)
            dump(output / "data/feeds.json", feeds)
        elif page == "about_me.html":
            render_about(soup, about, base)
        elif page in ("blog.html", "projects.html"):
            kind = "blog" if page == "blog.html" else "project"
            rows = ""
            for p in posts:
                if p["type"] != kind:
                    continue
                rows += '<a class="nav-box project-card" href="' + base + kind + '/' + p["slug"] + '/"><div class="box-text glitch-text" style="font-size:1.15rem;color:var(--accent-color);margin-bottom:0.5rem">' + esc(p["title"]) + '</div><div style="color:var(--text-muted);font-size:0.9rem;line-height:1.4">' + esc(p["shortDesc"]) + '</div></a>'
            empty = 'No published content is available.' + (' Content migration is pending.' if not accepted_content else '')
            fragment(soup, "#blogContainer" if kind == "blog" else "#projectsContainer", rows or '<p class="subtitle">' + empty + '</p>')
        else:
            label(soup, "#pageTitle", "404_NOT_FOUND")
            label(soup, "#pageSubtitle", "The requested resource could not be located.")
            mapping = {}
            for p in posts:
                for key in [p["slug"], p.get("id")]:
                    if key:
                        alias = p["type"] + ":" + str(key)
                        target = base + p["type"] + "/" + p["slug"] + "/"
                        if alias in mapping and mapping[alias] != target:
                            raise ValueError('Legacy ID/slug collision')
                        mapping[alias] = target
            node = soup.new_tag("script", type="application/json", id="legacy-map")
            node.string = json.dumps(mapping).replace("<", "\\u003c")
            soup.body.append(node)
            soup.body.append(soup.new_tag("script", type="module", src=base + "js/legacy-detail.js"))
        save(page, soup)
    shutil.copyfile(ROOT / "pages/legacy-detail.js", output / "js/legacy-detail.js")
    for p in posts:
        for lang in ("en", "tr"):
            suffix = "_tr" if lang == "tr" else ""
            title = p.get("title" + suffix) or p["title"]
            desc = p.get("shortDesc" + suffix) or p["shortDesc"]
            body = p.get("fullDesc" + suffix) or p.get("fullDesc") or desc
            soup = template("detail.html", base)
            soup.html["lang"] = lang
            label(soup, "#pageTitle", title)
            label(soup, "#pageSubtitle", "READ_MODE: ENABLED")
            label(soup, "#backLink", "< ./blog.txt" if p["type"] == "blog" else "< ./projects.exe")
            soup.select_one("#backLink")["href"] = base + ("blog.html" if p["type"] == "blog" else "projects.html")
            cover = '<img class="detail-image" src="' + esc(local_url(p.get("imageUrl"), base)) + '" alt="' + esc(title) + '">' if p.get("imageUrl") else ""
            fragment(soup, "#contentArea", cover + '<div class="markdown-content">' + markdown_html(body, base) + '</div>')
            page = p["type"] + "/" + p["slug"] + "/" + ("tr.html" if lang == "tr" else "index.html")
            seo(soup, site, page.replace("index.html", ""), title, desc, p.get("imageUrl", ""))
            for alternate, tail in [("en", ""), ("tr", "tr.html")]:
                soup.head.append(soup.new_tag("link", rel="alternate", hreflang=alternate, href=site["origin"] + base + p["type"] + "/" + p["slug"] + "/" + tail))
            save(page, soup)
    # Both profile languages are available without changing the existing page layout.
    soup = template("about_me.html", base)
    render_about(soup, about, base, "en")
    save("about_me.en.html", soup)
    for name in media_refs:
        source = content / "media" / name
        if "/" in name or "\\" in name or source.is_symlink() or not source.resolve().is_relative_to(content.resolve()) or not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            raise ValueError("Missing or unsupported approved image: " + name)
        raw = source.read_bytes()
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("Görsel 10 MiB sınırını aşıyor: " + name)
        try:
            validate_image(raw, source.suffix)
        except ValueError as error:
            raise ValueError(str(error) + ": " + name) from error
        dest = output / "media" / name
        dest.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, dest)
    soup = template("detail.html", base)
    label(soup, "#pageTitle", "404_NOT_FOUND")
    label(soup, "#pageSubtitle", "The requested resource could not be located.")
    save("404.html", soup)
    (output / "admin").mkdir()
    if admin_enabled:
        redirect_page = (ROOT / "pages/admin-redirect.html").read_text(encoding="utf-8")
        redirect_page = redirect_page.replace("{{ADMIN_ORIGIN}}", esc(site["oauthOrigin"]))
        (output / "admin/index.html").write_text(redirect_page, encoding="utf-8")
    else:
        shutil.copyfile(ROOT / "pages/admin-pending.html", output / "admin/index.html")
    (output / ".nojekyll").touch()
    audit(output, base)
    report = dict(migration=migration["status"], posts={k: sum(p["type"] == k for p in posts) for k in ("blog", "project")}, referencedImages=len(media_refs), release=release, adminEnabled=admin_enabled)
    dump(output / "build-report.json", report)
    print(json.dumps(dict(output=str(output), **report)))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    parser.add_argument("--content", type=Path, default=ROOT / "content")
    parser.add_argument("--base-path")
    parser.add_argument("--refresh-feeds", action="store_true")
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    site = read_json(ROOT / "site.config.json")
    if args.base_path is not None:
        site["basePath"] = args.base_path
    try:
        build(args.output, args.content, site, args.refresh_feeds, args.release)
    except Exception as error:
        print("Build failed: " + str(error), file=sys.stderr)
        sys.exit(1)
