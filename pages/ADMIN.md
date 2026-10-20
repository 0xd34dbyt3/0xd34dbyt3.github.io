# İçerik yönetimi

`/admin/` OAuth kuruluncaya kadar etkin değildir; kurulum: [oauth/README.md](../oauth/README.md).

- Hakkımda: EN/TR alanlarını ayrı düzenleyin. Listelerde ekle, kaldır ve sürükle
  tutamacıyla sıralama kullanılır; iç beceriler ve odak alanları da listedir.
- Blog/Projeler: aynı zengin metin editörü. Araç çubuğundan başlık, liste, bağlantı,
  **Görsel ve yerleşim** veya **Kod bloğu** ekleyin. Blokları sürükleyerek taşıyın.
  Mevcut `slug` ve `id` değerlerini değiştirmeyin.
- Görsel: yükle/seç, alt metin, açıklama, px/% genişlik, hizalama ve açık kırpma
  seçimi. Kapak ayrı alandır. PNG/JPEG/GIF/WebP, en fazla 10 MiB; yeni dosyalara
  benzersiz güvenli ad verilir. Mobilde genişlik sınırlanır, oran korunur.
- Kod: dil ve satır sarma seçilir; metin HTML olarak çalışmaz. Kopyalama panoya
  erişim iznine bağlıdır; sonuç düğmede görünür.
- Önizleme: EN/TR ve masaüstü/320/375/390 px. Ortak `content.css` kullanılır.
  Önizleme yayın değildir.
- Kaydet/Publish doğrudan **public GitHub deposuna** kaydeder. Özel taslak veya
  özel görsel göndermeyin. Kaydedilmemiş yazı yereldir; hata halinde editörü
  kapatmadan yeniden deneyin. Sayfadan çıkış ve silme için Decap onayı vardır.
- “GitHub’a kaydedildi” yalnızca commit sonucudur. Actions bağlantısından aynı
  commit'in **deploy** işini kontrol edin; admin yayın başarısını varsaymaz.

Typed blok verileri Markdown içinde saklanır; kullanıcı JSON veya HTML yazmaz.
Python build bu verileri doğrular; geçersiz ayarlar yayını durdurur. Mevcut Markdown,
EN/TR içerikler ve ID/slug eşlemeleri korunur. Sanitizer devrededir.

Kontroller:

```sh
mkdir -p .private/test-tmp
TMPDIR="$PWD/.private/test-tmp" python -m unittest discover -s scripts/tests -v
node --test scripts/tests/*.test.cjs
python scripts/check_repository_sources.py
python scripts/build_pages.py --release
```
