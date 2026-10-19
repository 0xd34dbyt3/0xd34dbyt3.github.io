"""Generate Decap configuration (JSON is valid YAML); no secrets belong here."""


def field(name, widget="string", **kw):
    return dict(name=name, label=name, widget=widget, **kw)


def bilingual(name, widget="string"):
    return field(name, "object", fields=[field("en", widget, required=False), field("tr", widget, required=False)])


def config(site):
    post_fields = [
        field("title"), field("title_tr", required=False),
        field("slug", pattern=["^[a-z0-9][a-z0-9_-]*$", "Küçük harf, rakam, tire ve alt çizgi kullanın."],
              hint="Kalıcı adres; eski bağlantıları korumak için değiştirmeyin."),
        field("id", required=False, hint="Eski MySQL ID. Aktarılan kayıtlarda değiştirmeyin; yeni içerikte boş bırakın."),
        field("shortDesc", "text"), field("shortDesc_tr", "text", required=False),
        field("fullDesc", "markdown", required=False), field("fullDesc_tr", "markdown", required=False),
        field("imageUrl", "image", required=False),
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
    collections.append(dict(name="pages", label="Hakkımda", files=[dict(name="about", label="Hakkımda", file="content/about.json", fields=about)]))
    return dict(backend=dict(name="github", repo=site["repository"], branch=site["branch"],
                             base_url=site["oauthOrigin"], auth_endpoint="auth"),
                publish_mode="simple", media_folder="content/media", public_folder=site["basePath"] + "media",
                media_processing=dict(enabled=True, quality=85, strip_metadata=True, width=1200),
                site_url=site["origin"] + site["basePath"].rstrip("/"),
                locale="tr", show_preview_links=False, collections=collections)
