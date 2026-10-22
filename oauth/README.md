# Ayrı OAuth ve admin Worker'ı

GitHub App geçiş hazırlığı: [GITHUB_APP_MIGRATION.md](GITHUB_APP_MIGRATION.md).
Varsayılan eski OAuth akışı, `GITHUB_APP_CREDENTIALS` tek JSON secret'ı
etkinleştirilene kadar korunur. Aşağıdaki `public_repo` açıklamaları eski
OAuth App moduna aittir; App modu yalnız kısa ömürlü kullanıcı tokenı ister.

Üretim OAuth broker'ı ve admin arayüzü Cloudflare Worker'da çalışır; GitHub Pages
ziyaretçi sitesini sunar. Yerel `server.cjs` yalnız geliştirme/test fallback'idir,
üretim deploy talimatı değildir. Worker konfigürasyonu `wrangler.toml` içindedir;
secret'lar `wrangler secret` ile tanımlanır, dosyaya veya rapora yazılmaz.

Sunucunun secret/environment yöneticisine tanımlayın (repoya yazmayın):

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: Worker secret'ları.
- `GITHUB_ALLOWED_USER_ID`: izin verilen hesabın değişmez sayısal GitHub ID'si.
- `CMS_ORIGIN` ve `OAUTH_ORIGIN`: Worker `workers.dev` origin'i.
- `PAGES_ORIGIN`: ziyaretçi sitesi ve preview origin'i.
- `GITHUB_REPOSITORY`: `0xd34dbyt3/0xd34dbyt3.github.io`.

GitHub OAuth App callback URL'si Worker origin'inin `/callback` yoludur.
`site.config.json` içindeki `oauthOrigin`, Worker/admin origin’i ile aynı olmalı.
Worker secret'ları ve GitHub OAuth App callback ayarı deploy öncesi doğrulanmalıdır.
Broker `/auth` ve `/callback` sunar. İstemciden gelen scope ve redirect adreslerini
kullanmaz; public repo için `public_repo` ister, ilgili depoda `push` yetkisini
GitHub API ile denetler. Ayrıca `/user` yanıtındaki sayısal ID yalnız
`GITHUB_ALLOWED_USER_ID` ile eşleşirse tokenı Decap’e verir; kullanıcı adı değişse
de bu kontrol değişmez. Bu sunucu tarafı kontrol tokenın kapsamını daraltmaz.
OAuth kapsamı kullanıcının başka public depolarına da
erişebileceğinden ayrı bir içerik editörü hesabı tercih edilebilir.

OAuth App secret tarayıcıya gitmez. Kullanıcının kısa akışta aldığı GitHub erişim
tokenı Decap'in GitHub API çağrıları için tarayıcıya, yalnızca doğru origin ve
opener'a gönderilir; bu Decap GitHub backend davranışıdır. Sabit PAT kullanılmaz.
Decap tokenı halen tarayıcıdaki `localStorage` kaydında tutulur; çıkışta Decap
bu kaydı siler, ancak GitHub OAuth yetkisini iptal etmez. GitHub Pages `/admin/`
yalnız Worker `/admin/` adresine yönlendirir ve eski aynı-origin
`decap-cms-user` değerini siler. Worker admin dosyalarını ayrı origin’de sunar.
Bu, ziyaretçi origin’indeki başka GitHub Pages projelerinin admin DOM/localStorage
erişimini keser; XSS’nin admin origin’indeki yetkili tokena erişmesi riskini
ortadan kaldırmaz.

Worker admin yanıtlarına CSP (`frame-ancestors 'none'` dahil), HSTS, nosniff,
no-referrer, X-Frame-Options ve Permissions-Policy ekler. Admin preview
iframe’leri `allow-scripts allow-same-origin` sandbox’ıyla çalışır; parent ile
farklı origin’de olduklarından bu izinler admin DOM’una erişim sağlamaz.
Worker deploy öncesi `python scripts/build_worker_admin.py`, sonra
`npx wrangler deploy` çalıştırılmalıdır. Asset paketi yalnız admin HTML/JS/config
ve `content-tools.js` içerir.

OAuth flow `/user` endpoint’inde değişmez sayısal kullanıcı ID’sini, ardından
hedef repo adı, public durumu ve `permissions.push` değerini kontrol eder.
Bu hesap allowlist’i, OAuth App’in `public_repo` kapsamını hedef repo ile
sınırlandırmaz.

Proxy access/error loglarında `/callback` sorgu parametrelerini, Cookie/Authorization
başlıklarını ve yanıt gövdelerini kaydetmeyin. HTTPS zorunludur. Proxy'de `/auth`
için IP hız sınırı ve kısa istek zaman aşımı uygulayın. Kod token/secret loglamaz;
OAuth state Secure/HttpOnly/SameSite=Lax cookie + tek kullanımlık kayıt ile doğrulanır.
PKCE S256 de kullanılır. Admin origin’inde `Cross-Origin-Opener-Policy:
same-origin-allow-popups` kullanılır; popup handshake korunur.

Worker ayrıca `CF-Connecting-IP` değerinin yalnız SHA-256 özetini Durable Object içinde
bir dakika tutarak istemci başına dakikada 10 state üretimi sınırı uygular. Bu uygulama
sınırı, Cloudflare rate limiting/WAF kuralının yerine geçmez; dağıtım ayarında ikinci
katman olarak aynı uç ayrıca sınırlandırılmalıdır.

Yerel birim testleri gerçek GitHub girişinin yerine geçmez. Kurulumdan sonra
yetkili hesapla giriş, yetkisiz hesap reddi, görsel/yazı ekleme-düzenleme-silme,
Actions çıktısı ve oturum iptali uçtan uca kontrol edilmelidir.

Kaynaklar:
- https://decapcms.org/docs/github-backend/
- https://decapcms.org/docs/external-oauth-clients/
- https://decapcms.org/docs/backends-overview/
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

22 Ekim 2026 belge ve 3.17.1 kaynak kontrolü: Decap GitHub backend için public depoda `public_repo`
gerekiyor; `repo` istenmiyor. GitHub OAuth App kapsamı tek depoyla sınırlanamaz.
Mevcut broker PKCE S256, tek kullanımlık state ve hedef depoda `permissions.push`
kontrolünü korur. GitHub App user access tokenı App kurulumu ve kullanıcı
yetkilerinin kesişimiyle repo düzeyinde sınırlanabilir; ancak mevcut Decap sürümünde
yenileme/oturum davranışı gerçek App ile doğrulanmadan OAuth App kimlik bilgileri
değiştirilmemelidir. Yeni hesap, App veya ücretli hizmet oluşturulmadı.
