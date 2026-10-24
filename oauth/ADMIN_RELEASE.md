# Tek üretim admini ve kayıt/yayın kanıtı

Üretim adresi: **https://portfolio-admin-auth.muhammedfatihozturk02.workers.dev/admin/**.
Appcheck ayrı Worker/origin'dir; yalnız `security/github-app-check` dalına yazar.
Test paneli bunu kalıcı olarak gösterir. Test dalı main'e topluca birleştirilmez.

Blog ve Projeler aynı ordered-content kontrolünü ve mevcut açık gri yüzeyi
kullanır. İmleçte metin bölme, görsel/kod ekleme, sıralama, boyut/hizalama,
dil etiketi ve kopyalama aynı uygulamadan gelir. İçerik biçimi, EN/TR, slug ve
legacy ID sözleşmesi değişmez. Geçersiz görsel blokları silinmez; yanında
uyarı gösterilir ve kayıt engellenir. Hakkımda kaydına yazılara ait slug eklenmez.

## Doğrulanmış hata mekanizmaları

- Gerçek App arayüzünde Blog'da araç çubuğu varken Projeler'de yoktu; ayrı
  render/CSS dalları ortaklaştırıldı.
- Native Decap `AssetProxy.toBase64()` ve `persistLocalDraftBackup()` yerel
  dosyayı `fetch(blob:...)` ile okuyor. Gerçek Chromium stack trace'inde
  `connect-src` bunu engelliyor, görsel görünmesine rağmen kayıt GitHub ref'ine
  ulaşmıyordu. Yalnız admin belgelerinde `connect-src blob:` eklendi.
- Önizleme CSS'leri Worker'ın açık dosya kümesinde eksikti; artık yalnız mevcut
  `styles.css` ve `content.css` dosyaları da sunuluyor.
- "Kaydedildi" başlangıçta native rozetten kopyalanıyordu. Artık kayıt sonucu
  yalnız başarılı postSave/postPublish ve backend sonucu sonrasında gösterilir;
  açılan temiz kayıt "Depodaki kayıt açıldı" olarak ayrılır.

## Yayın zinciri

Dosya/entry native GitHub App backend'iyle yapılandırılan dala kaydedilir.
Adapter başarılı ref yanıtındaki commit SHA'sını aktarır. Üretimde `/publication`
yalnız aynı SHA için `main` push Actions sonucunu ve canlı `build-report.json`
dosyasının `sourceCommit` alanını eşleştirir. İkisi de doğrulanmadan "Canlıda
yayımlandı" gösterilmez. Builder CI'daki `GITHUB_SHA` değerini rapora koyar.
Bekleyen/başarısız yayın, depoya kayıt başarısından ayrıdır. Appcheck için
Actions/canlı başarı iddiası üretilmez.

## App ve CSP geçişi

Üretim `github_app` modunda ve `main` dalındadır. Mevcut Worker kontrolleri App
kurulumunun yalnız tek site deposunu, Contents write / Metadata read izinlerini
ve sabit hesap/depo ID'lerini kapsamasını zorunlu tutar. Yeni izin veya ücretli
plan açılmaz. Credential çifti `configure_github_app.py --target production
--confirmed-real-app-test` ile yalnız maskeli terminalden, tek secret olarak
yayımlanmayan sürüme eklenir. O sürüm ayrıca %100 etkinleştirilir.

Sabit Decap 3.17.1'in AJV doğrulayıcısı çalışma anında `Function()` gerektirir;
ayrıntılı kaynak/alternatif değerlendirmesi `APPCHECK_CSP.md` içindedir.
Üretim için istisna **açıkça** `decap-3.17.1-production` profiline bağlıdır;
yalnız tam üretim origin'i ile `/admin/` ve `/admin/index.html` belgelerinde
etkindir. Appcheck profili üretim origin'inde çalışmaz.

`script-src-elem` mevcut self/jsDelivr/hash listesini korur; script attribute'ları
kapalıdır. `unsafe-eval`, yalnız AJV'ye sınırlandırılamaz: izinli bütün JS için
dize çalıştırma korumasını o iki belgede zayıflatır. `connect-src blob:` native
yerel dosya okumasını sağlar; dış ağ kaynaklarına yeni izin eklemez. Config/JS/CSS
yanıtları ve nonce'lı OAuth callback bu belge istisnalarını almaz.

## Gerçek kabul ve geri dönüş

`scripts/tests/browser_live_admin.py` mevcut oturuma CDP ile bağlanır; hiçbir
route/backend/auth cevabını taklit etmez. Yalnız `admin-acceptance-blog` ve
`admin-acceptance-project` adlı, işaretli ayrı kayıtlar üzerinde çalışır. Gerçek
ref PATCH SHA, dosya/görsel blob SHA, raw HTTP ve masaüstü/390 ekran görüntüleri
`.private/admin-live-acceptance.json` ile saklanır; credential loglanmaz.
Hakkımda EN/TR kabul eki yeniden açıldıktan sonra orijinal JSON eksiksiz geri
kaydedilir. Gerçek appcheck Blog/Projeler/Hakkımda kanıtları olmadan üretim
kabul komutları ve maskeli hazırlık çalıştırılmaz.

Geçiş öncesi üretim Worker sürümü:
`332a0939-a5a9-4419-a81a-bc78cdcd6605` (24 Ekim 2026 salt okunur kayıt).
Geri dönüş gerektiğinde yalnız doğrulanmış önceki sürüme Worker rollback yapılır;
kullanıcı içerikleri veya test dalı resetlenmez. Eski OAuth secret'ları otomatik
silinmez. Kaynak commit'i ve son gerçek canlı içerik/Actions SHA'sı ayrı raporlanır.
