# Ayrı OAuth servisi

Bu klasör GitHub Pages çıktısına dahil edilmez. Node 22+ çalıştıran ayrı bir HTTPS
sunucuda `node oauth/server.cjs` çalıştırın; 127.0.0.1:8787 önüne TLS reverse proxy koyun.
Hesap veya hosting burada oluşturulmadı. Mevcut sunucu kullanılabilir; yeni sağlayıcı
seçimi ve olası maliyet kullanıcıya aittir. Tek süreç kullanın: geçici OAuth state
bellekte tutulur; yeniden başlatma oturumu iptal eder. Çoklu instance için paylaşımlı
tek kullanımlık state deposu gerekir.

Sunucunun secret/environment yöneticisine tanımlayın (repoya yazmayın):

- `GITHUB_CLIENT_ID`: GitHub OAuth App client ID.
- `GITHUB_CLIENT_SECRET`: OAuth App secret; yalnızca bu sunucuda.
- `CMS_ORIGIN`: `https://GITHUB_OWNER.github.io` (proje yolu eklenmez).
- `OAUTH_ORIGIN`: `https://OAUTH_HOST` (sonunda slash yok).
- `GITHUB_REPOSITORY`: `GITHUB_OWNER/GITHUB_REPOSITORY`.
- `PORT`: isteğe bağlı, varsayılan 8787.

GitHub Settings → Developer settings → OAuth Apps → New OAuth App:
Homepage URL gerçek site URL'si, callback **`https://OAUTH_HOST/callback`**.
`site.config.json` içindeki `oauthOrigin`, OAuth origin ile aynı olmalı.
Broker `/auth` ve `/callback` sunar. İstemciden gelen scope ve redirect adreslerini
kullanmaz; public repo için `public_repo` ister, ilgili depoda `push` yetkisini
GitHub API ile denetler. Bu OAuth kapsamı kullanıcının başka public depolarına da
erişebileceğinden ayrı bir içerik editörü hesabı tercih edilebilir.

OAuth App secret tarayıcıya gitmez. Kullanıcının kısa akışta aldığı GitHub erişim
tokenı Decap'in GitHub API çağrıları için tarayıcıya, yalnızca doğru origin ve
opener'a gönderilir; bu Decap GitHub backend davranışıdır. Sabit PAT kullanılmaz.
Decap oturumunu paylaşılan cihazda kapatın; GitHub yetkilendirmesi gerektiğinde
GitHub üzerinden iptal edilebilir. Origin doğrulaması aynı origin içindeki tüm
sayfaları kapsar; kullanıcı sitesinde başka güvenilmeyen uygulamalar barındırmayın.

Proxy access/error loglarında `/callback` sorgu parametrelerini, Cookie/Authorization
başlıklarını ve yanıt gövdelerini kaydetmeyin. HTTPS zorunludur. Proxy'de `/auth`
için IP hız sınırı ve kısa istek zaman aşımı uygulayın. Kod token/secret loglamaz;
OAuth state Secure/HttpOnly/SameSite=Lax cookie + tek kullanımlık kayıt ile doğrulanır.
PKCE S256 de kullanılır. `Cross-Origin-Opener-Policy: same-origin` gibi popup opener'ı
kesen bir başlık eklemeyin.

Yerel birim testleri gerçek GitHub girişinin yerine geçmez. Kurulumdan sonra
yetkili hesapla giriş, yetkisiz hesap reddi, görsel/yazı ekleme-düzenleme-silme,
Actions çıktısı ve oturum iptali uçtan uca kontrol edilmelidir.

Kaynaklar:
- https://decapcms.org/docs/github-backend/
- https://decapcms.org/docs/external-oauth-clients/
- https://decapcms.org/docs/backends-overview/
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
