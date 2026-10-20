"""Typed Markdown blocks. Only validated data may generate layout attributes."""
import html
import json

LANGUAGES = ("text", "python", "javascript", "typescript", "bash", "json", "html", "css", "sql", "yaml", "c", "cpp", "java", "go", "rust")


def block_data(kind, value):
    if not isinstance(value, dict):
        raise ValueError("İçerik bloğu nesne olmalı")
    keys = {"src", "alt", "caption", "width", "unit", "align", "crop"} if kind == "image" else {"code", "language", "wrap"}
    if set(value) - keys:
        raise ValueError("Bilinmeyen içerik bloğu alanı")
    if kind == "image":
        data = dict(src="", alt="", caption="", width=100, unit="%", align="center", crop="none")
        data.update(value)
        if any(not isinstance(data[k], str) for k in ("src", "alt", "caption")):
            raise ValueError("Görsel metin alanları geçersiz")
        if not data["src"] or data["unit"] not in ("px", "%") or data["align"] not in ("left", "center", "right") or data["crop"] not in ("none", "square", "wide"):
            raise ValueError("Görsel ayarları geçersiz")
        width = data["width"]
        if isinstance(width, bool) or not isinstance(width, (int, float)) or not 1 <= width <= (100 if data["unit"] == "%" else 4096) or int(width) != width:
            raise ValueError("Genişlik: % için 1–100, px için 1–4096 kullanın")
        data["width"] = int(width)
    else:
        data = dict(code="", language="text", wrap=False)
        data.update(value)
        if not isinstance(data["code"], str) or data["language"] not in LANGUAGES or not isinstance(data["wrap"], bool):
            raise ValueError("Kod bloğu ayarları geçersiz")
    return data


def render_block(kind, value, local_url, base):
    data = block_data(kind, value)
    esc = lambda x: html.escape(str(x), quote=True)
    if kind == "code":
        return '<pre data-wrap="' + str(data["wrap"]).lower() + '"><code class="language-' + data["language"] + '">' + esc(data["code"]) + '</code></pre>'
    src = local_url(data["src"], base)
    if src.startswith("mailto:"):
        raise ValueError("Görsel adresi geçersiz")
    return (
        f'<figure class="content-image align-{data["align"]} crop-{data["crop"]}" style="width:{data["width"]}{data["unit"]}">'
        f'<img src="{esc(src)}" alt="{esc(data["alt"])}" loading="lazy">'
        + (f'<figcaption>{esc(data["caption"])}</figcaption>' if data["caption"] else "") + '</figure>'
    )


def expand_blocks(soup, local_url, base):
    """After sanitization: only real fenced code nodes can become typed blocks."""
    from bs4 import BeautifulSoup
    for node in list(soup.select("pre > code")):
        classes = node.get("class", [])
        kind = next((k for k in ("image", "code") if "language-cms-" + k in classes), None)
        if kind:
            try:
                data = json.loads(node.get_text())
            except (ValueError, TypeError) as error:
                raise ValueError("Bozuk CMS bloğu; editörde yeniden düzenleyin") from error
            node.parent.replace_with(BeautifulSoup(render_block(kind, data, local_url, base), "html.parser"))
