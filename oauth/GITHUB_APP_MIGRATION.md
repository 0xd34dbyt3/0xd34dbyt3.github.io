# GitHub App kullanıcı tokenına kontrollü geçiş

24 Ekim ortak editör ve açık üretim CSP profili için güncel akış:
[ADMIN_RELEASE.md](ADMIN_RELEASE.md). Aşağıdaki eski tarihlenmiş simülasyon
notları gerçek kabulün yerine geçmez; gerçek kanıt ayrı kabul raporunda tutulur.

Workers Free planı ve yalnız hedef depoya Contents write / Metadata read kurulumu
sahip tarafından doğrulandı. Bu talimat plan/abonelik açmaz. Mevcut OAuth App
secret'ları korunur. Gerçek App ile test yapılmadan üretim geçişi tamamlanmış değildir.

## 1. İzole test

GitHub App → General → Callback URLs listesine mevcut `/callback` adresini
silmeden şunu ekleyin:

`https://portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev/callback`

`Expire user authorization tokens` açık kalmalı. Başka izin eklemeyin.

Test Worker adı `portfolio-admin-auth-app-check`, admin adresi aynı origin'in
`/admin/` yoludur. `appcheck` environment'ı yalnız `github_app` modundadır;
secret eksikse güvenli biçimde kapanır, eski OAuth'a geri dönmez. CMS kayıtları
yalnız `security/github-app-check` dalına gider; `main` veya canlı site değişmez.
Bu dalda public fixture içerikler kullanın; kayıtlar public Git geçmişinde kalabilir.
GitHub arayüzünde `main` üzerinden `security/github-app-check` dalını oluşturun;
varsa mevcut test dalını koruyun. Decap hedef dalı kendiliğinden oluşturmaz.

Güncel kod/assetleri yalnız test Worker'a yayımlayıp çift kimlik bilgisini
**tek secret** olarak yükleyin:

```bash
python scripts/configure_github_app.py --target check
```

Komut her iki değeri terminalde `getpass` ile gizler. JSON yalnız bellekte ve
Wrangler stdin'inde bulunur; dosyaya, shell history'ye veya komut argümanlarına
yazılmaz. `GITHUB_APP_CREDENTIALS` tek işlemle oluşturulur. İki ayrı `secret put`
komutu çalıştırmayın. Script mevcut kurulu Wrangler'ı kullanır, araç kurmaz.
App Client ID `Iv...` biçimindedir; App ID veya eski OAuth App `Ov...` ID'si değildir.
Kod/asset yüklemesi başarısızsa secret işlemine geçilmez. Üretim Worker'ı bu
komutla değiştirilmez. Scriptin yakaladığı ham Wrangler çıktıları gösterilmez.

Temiz bir tarayıcı profiliyle test adminine girin; GitHub App yetkilendirmesini
tamamlayın. Sunucu sayısal hesap ID `170147187`, hedef depo ID `1425670208`,
tam depo adı ve `permissions.push` değerini doğrular. Token ayrıca
`repository_id` ile istenir; kurulum/repo listelerinin tek hedefi kapsadığı ve
izinlerin Contents write + Metadata read olduğu denetlenir. Herhangi bir hata
olursa izinleri genişletmek veya kontrolleri kapatmak yerine hata araştırılmalıdır.

Gerçek App kabul adımları:

1. Giriş → mevcut kaydı açma → EN/TR metin ve kod fixture'ı kaydetme → yeniden açma.
2. Küçük PNG yükleme → içerikte kullanma → kaydetme → yeniden açıp görseli doğrulama.
3. Açık bir kayıtta kaydedilmemiş EN/TR değişiklik ve seçili medya bırakma. Süre
   dolunca kaydetme 401 ile durmalı veya yerel süre kontrolünde engellenmeli.
   `GitHub ile yeniden giriş` düğmesi aynı sekmedeki taslağı koruyarak popup açar;
   başarılı girişten sonra kullanıcı tekrar kaydeder. Popup iptali taslağı silmemeli.
   Gerçek sekiz saatlik süre testi yapılmadıysa, yerel kontrollü saat/401 testini
   gerçek süre testi olarak raporlamayın.
4. Repo commitlerinin **yalnız test dalına** gittiğini kontrol edin. Gerçek giriş,
   metin/medya kaydı ve yeniden giriş sonucunu secretsız kaydedin. Sır/token,
   Authorization header, callback code/state veya localStorage içeriği paylaşmayın.

Yerel regresyonlar simüle ağ ve gerçek Decap modülleriyle yürütüldü; gerçek
App/UI sonucunun yerine geçmez. Adapter yenileme tokenını tarayıcıya göndermez,
otomatik token refresh hizmeti kurmaz. Token hâlâ localStorage'dadır; bu risk
giderilmiş değildir. İlk App girişinde eski `github` backend kaydı yeniden
kullanılmaz; yeni `github-app` backend oturumu açılır.

22 Ekim 2026 yerel kanıt: Decap 3.17.1 config şeması `offline_access` değerini
`backend.auth_scope` içinde kabul etmiyor. Worker bu alanı App config'inden
çıkarır; adapter yalnız giriş bileşenine, config doğrulamasından sonra
`offline_access` verir. App girişinde `public_repo`/`repo` istenmez.
Sabitlenmiş admin paketiyle aşağıdaki tarayıcı regresyonu config/giriş, kontrollü
süre dolumu, upstream 401, popup iptali, açık EN/TR editörü ve File nesnesi,
saklanan credential güncellemesi, otomatik yazma yapılmaması ve açık kullanıcı
kaydı/yeniden açmayı denetler. GitHub/OAuth yanıtları simüledir; seçili gerçek
Decap medya taslağı ve gerçek sekiz saatlik token süresi için kabul adımı 3 kalır.

```bash
python scripts/tests/browser_github_app.py --decap-bundle .private/decap-cms.js
```

Bu isteğe bağlı test mevcut Playwright/Chromium ortamında çalışır ve paketin
admin HTML'indeki SHA-384 değeriyle eşleşmesini zorunlu tutar. Gerçek App ile
giriş, metin/PNG kaydı ve yeniden giriş: **henüz doğrulanmadı**.

## 2. Üretim için kod ve credential çiftini yayımlamadan hazırlama

**Yalnız yukarıdaki gerçek App kabul adımları başarılı olduktan sonra.**
Kod/asset ve credential çiftini yayımlamadan birlikte hazırlayın:

```bash
python scripts/configure_github_app.py --target production --confirmed-real-app-test
```

Script yeni assetleri kendine ait geçici dizine üretir; `versions upload` ile
kod/asset sürümünü **yayımlamadan** yükler. Sonra `versions secret put` ile bu
sürüme JSON credential çiftini **tek secret** olarak ekleyen yeni bir
**yayımlanmamış** sürüm oluşturur. Mevcut üretim Client ID/secret değişmez.
Script çalışırken başka bir Worker sürümü yüklemeyin.

Araç çıktısındaki son sürüm ID'sini `wrangler versions view` ile kontrol edin;
doğru kaynak/asset ve `GITHUB_APP_CREDENTIALS` binding adı görünmeli. Secret
değerlerini dökmeyin. Sonra yalnız bu sürümü tek seferde %100 etkinleştirin:

```bash
npx --no-install wrangler versions view YENI_SURUM_ID
npx --no-install wrangler versions deploy YENI_SURUM_ID@100% --yes
```

Yüzdelik karma dağıtım kullanmayın: eski/yeni kimlik bilgileri ve state farklı
sürümlerde karışmamalıdır. Mod veya Client ID değişirken açık giriş popup'ları
yeniden başlatılmalıdır; eski state, yanlış kimlik bilgileriyle exchange
edilmeden reddedilir. Güncelleme, tarayıcıdaki eski OAuth tokenını GitHub'da
kendiliğinden iptal etmez.

Üretim kontrolünde App backend config'i, giriş, metin/PNG kaydı ve Pages deploy
sonucunu ayrıca doğrulayın. Bu son adım main'e gerçekten içerik yazar; yalnız
istenen gerçek içerik güncellemesiyle veya açıkça seçilmiş fixture ile yapın.

## 3. Geri dönüş

Son çalışan üretim Worker sürümünü geçişten önce `wrangler deployments list`
ile kaydedin. Sorunda `wrangler rollback ONCEKI_SURUM_ID` kullanın. Eski OAuth
App secret'larını bu aşamada silmeyin veya iptal etmeyin. Geri dönüş eski geniş
`public_repo` modelini geri getirir; güvenlik açığının giderildiği anlamına gelmez.
Tarayıcı oturumunun yeniden açılması gerekebilir. Test dalı/Worker temizliği ve
eski OAuth grant iptali gerçek geçiş kabulünden sonra ayrıca kararlaştırılmalıdır.

Kaynaklar: [GitHub App user tokenı](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[Cloudflare secrets ve versions](https://developers.cloudflare.com/workers/configuration/secrets/).
