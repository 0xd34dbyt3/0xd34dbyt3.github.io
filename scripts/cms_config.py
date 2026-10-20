"""Generate Decap configuration (JSON is valid YAML); no secrets belong here."""


def field(name, widget="string", **kw):
    if widget == "list":
        kw = dict(allow_add=True, allow_remove=True, allow_reorder=True, collapsed=False,
                  hint="Ekle/kaldır ile kayıt yönetin; sürükleme tutamacıyla sıralayın.", **kw)
    if widget == "markdown":
        kw = dict(editor_components=["managed-image", "managed-code"],
                  modes=["rich_text"], sanitize_preview=True,
                  hint="Araç çubuğundan görsel/kod bloğu ekleyin; blok tutamacıyla sıralayın. Özel taslak kaydetmeyin.",
                  **kw)
    labels = {
        "title": "Başlık (EN)", "title_tr": "Başlık (TR)",
        "shortDesc": "Kısa açıklama (EN)", "shortDesc_tr": "Kısa açıklama (TR)",
        "fullDesc": "Detay içeriği (EN)", "fullDesc_tr": "Detay içeriği (TR)",
        "imageUrl": "Kapak görseli", "whoami": "whoami",
        "education": "education_log", "work": "WORK_EXPERIENCE",
        "skills": "SKILL_MATRIX", "certs": "CERT_CHAIN",
        "profile": "Profil", "core_focus": "Odak alanları", "items": "Beceriler",
        "en": "English", "tr": "Türkçe",
    }
    kw.setdefault("label", labels.get(name, name))
    return dict(name=name, widget=widget, **kw)


def bilingual(name, widget="string"):
    return field(name, "object", fields=[field("en", widget, required=False), field("tr", widget, required=False)])


def config(site):
    post_fields = [
        field("title", label="Ana başlık (EN)"), field("title_tr", required=False, label="Ana başlık (TR)"),
        field("slug", pattern=["^[a-z0-9][a-z0-9_-]*$", "Küçük harf, rakam, tire ve alt çizgi kullanın."],
              hint="Kalıcı adres; eski bağlantıları korumak için değiştirmeyin."),
        field("id", required=False, hint="Eski MySQL ID. Aktarılan kayıtlarda değiştirmeyin; yeni içerikte boş bırakın."),
        field("shortDesc", "text"), field("shortDesc_tr", "text", required=False),
        field("fullDesc", "markdown", required=False), field("fullDesc_tr", "markdown", required=False),
        field("imageUrl", "image", required=False, hint="Kapak görseli; içerik görsellerinden bağımsızdır. PNG/JPEG/GIF/WebP, en fazla 10 MiB."),
        field("createdAt", "datetime", required=False), field("updatedAt", "datetime", required=False),
    ]
    collections = []
    for kind, label in [("blog", "Blog"), ("project", "Projeler")]:
        collections.append(dict(name=kind, label=label, folder=f"content/{kind}", format="json", extension="json",
                                create=True, delete=True, identifier_field="slug", slug="{{fields.slug}}",
                                preview_path=kind + "/{{fields.slug}}/", fields=post_fields,
                                description="Kaydetmek public depoya commit oluşturur. Özel taslak veya kişisel veri kaydetmeyin."))
    about = [bilingual("whoami", "text"), field("profile", "object", fields=[
        field("name"), field("status", required=False), field("location", required=False), bilingual("role"),
        field("core_focus", "list", field=bilingual("item"), required=False), field("image", "image", required=False,
              media_processing=dict(enabled=True, quality=85, strip_metadata=True, width=500))]),
        field("education", "list", fields=[bilingual("institution"), bilingual("detail", "text")], required=False),
        field("work", "list", fields=[bilingual("title"), bilingual("company"), field("duration", required=False), bilingual("desc", "text")], required=False),
        field("skills", "list", fields=[bilingual("category"), field("items", "list", field=bilingual("item"))], required=False),
        field("certs", "list", fields=[bilingual("title"), bilingual("desc", "text")], required=False)]
    collections.append(dict(name="about_page", label="Hakkımda", files=[dict(name="about", label="Hakkımda", file="content/about.json", fields=about)]))
    collection_names = [collection["name"] for collection in collections]
    if len(collection_names) != len(set(collection_names)):
        raise ValueError("Decap CMS collection names must be unique")
    return dict(backend=dict(name="github", repo=site["repository"], branch=site["branch"],
                             base_url=site["oauthOrigin"], auth_endpoint="auth"),
                publish_mode="simple", media_folder="content/media", public_folder=site["basePath"] + "media",
                media_processing=dict(enabled=True, quality=85, strip_metadata=True, width=1200),
                slug=dict(encoding="ascii", clean_accents=True, sanitize_replacement="-"),
                site_url=site["origin"] + site["basePath"].rstrip("/"),
                locale="tr", show_preview_links=False, collections=collections)
