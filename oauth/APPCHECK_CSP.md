# Appcheck admin CSP / Decap 3.17.1

24 Ekim son düzenleme: üretim geçişi için ayrı, açıkça adlandırılmış origin
kilitli profil ve gerçek stack trace ile gerekçelendirilen yerel Blob okuma izni
[ADMIN_RELEASE.md](ADMIN_RELEASE.md) içinde açıklanır. Aşağıdaki ilk düzeltme
yalnız appcheck'e uygulanmıştı; yeni üretim profili bu istisnayı gizlice devralmaz.

24 Ekim 2026: canlı appcheck `/admin/` sayfası Chromium/Playwright ve CDP
`Debugger.setPauseOnExceptions: all` ile incelendi. HTTP 200 yanıtındaki gerçek
CSP altında config yükleniyor, fakat GitHub giriş düğmesi oluşmuyordu.

## Hatanın kaynağı

Sabitlenmiş CDN paketindeki tarayıcı stack trace'i (satır/sütun 1 tabanlı):

```text
EvalError: Evaluating a string as JavaScript violates ... 'unsafe-eval' ...
  at new Function (<anonymous>)
  at l.c          (decap-cms.js:2:1583516)
  at l.u          (decap-cms.js:2:1584321)
  at t.resolveRef (decap-cms.js:2:1585626)
  ... AJV compile / validateSchema / addKeyword ...
  at init         (decap-cms.js:56:82631)
  at              (admin.js:623:9)
```

`decap-cms.js` URL'si:
<https://cdn.jsdelivr.net/npm/decap-cms@3.17.1/dist/decap-cms.js>.
Paketin mevcut HTML'deki SHA-384 sabitlemesi değiştirilmedi.
Hata özel `github-app-session.js` adapter'ından kaynaklanmıyor.
Paket ayrıca isteğe bağlı Node `util.inspect` tespitinde `eval` çağırıp
başarısızlığı kendi içinde yakalıyor (`decap-cms.js:2:6525`); açılışı durduran
çağrı AJV'nin `new Function(...)` çağrısı.

[Decap 3.17.1 configSchema.js](https://github.com/decaporg/decap-cms/blob/decap-cms%403.17.1/packages/decap-cms-core/src/constants/configSchema.js)
`validateConfig` içinde AJV'yi oluşturup eklentileri ekler ve
`ajv.validate(getConfigSchema(), config)` çağırır. Config ile derleyiciyi
kapatma veya hazır validator sağlama seçeneği yoktur; widget şemaları kayıtlı
widget'lardan çalışma anında alınır. Tarayıcıda duran kaynak ifadesi
`new Function(..., m)(this, this.scope.get())` idi.

## CSP uyumlu yol ve bu paketin sınırı

[AJV standalone](https://ajv.js.org/standalone.html) şemaları build sırasında
derleyerek tarayıcıdaki Function ihtiyacını kaldırır. Ancak Decap bu API'yi
kullanmıyor; kullandığı `uniqueItemProperties` ve `instanceof` keyword'leri
[ajv-keywords tarafından standalone için desteklenmiyor](https://github.com/ajv-validator/ajv-keywords#keywords).
Bu yolu uygulamak özel Decap build'i ve bu keyword'lerin yeniden uygulanmasını
gerektirir; mevcut sabitlenmiş hazır pakete bir config değişikliğiyle uygulanamaz.
Doğrulama atlanmadı, Function/eval monkey-patch edilmedi ve hata gizlenmedi.

## Dar istisna ve etkisi

Kullanıcının sürümün zorunlu kıldığı durum için izin verdiği istisna kullanıldı:

- Yalnız `ADMIN_CSP_PROFILE=decap-3.17.1-appcheck` seçildiğinde **ve** origin
  tam olarak `portfolio-admin-auth-app-check.muhammedfatihozturk02.workers.dev`
  olduğunda; profil yalnız `[env.appcheck.vars]` içindedir.
- Yalnız `/admin/` ve `/admin/index.html` belgelerinde
  `script-src 'unsafe-eval'` bulunur.
- `script-src-elem` eski `'self'`, jsDelivr ve mevcut inline bootstrap hash
  listesini aynen korur. `script-src-attr 'none'` event handler'larını engeller.
  Diğer CSP direktifleri değişmez. Harici scriptin SRI doğrulaması korunur.
- Config, JS assetleri, OAuth callback ve varsayılan/üretim CSP'sine istisna
  eklenmez. Profil yanlışlıkla üretime kopyalansa da origin kontrolü izin vermez.

`unsafe-eval` yalnız AJV'ye veya tek bir script dosyasına sınırlandırılamaz:
bu admin belgesindeki izinli bütün JavaScript'in string eval/Function kullanmasına
(ve CSP bakımından Wasm derlemesine) izin verir; bir script açığı bulunursa
CSP'nin dinamik kod çalıştırma savunması bu belgede zayıflar. İstisna script
yükleme kaynaklarını ve inline script izinlerini genişletmez. `script-src-elem`
desteklemeyen eski tarayıcılarda fallback kaynak listesi boş olduğundan
scriptler engellenir. Özel CSP uyumlu Decap build'i ileride benimsenirse bu
profil kaldırılmalıdır; bu değişiklik o geçişi yapmaz.

## Odaklı doğrulama

```bash
node --test scripts/tests/admin-csp.test.cjs scripts/tests/oauth.test.cjs scripts/tests/github-app.test.cjs
.private/browser-venv/bin/python scripts/tests/browser_appcheck_csp.py \
  --executable .private/browsers/chromium-1248/chrome-linux64/chrome \
  --screenshot .private/appcheck-csp-login.png
```

Tarayıcı kontrolü gerçek appcheck HTTP yanıtlarını kullanır; ağ yanıtlarını veya
CSP'yi değiştirmez. Config HTTP 200, `github-app`, `security/github-app-check`
dalı, koleksiyonlar ve görünür `GitHub ile Giriş` düğmesini denetler. Açılışta
JS/CSP hatası olmamasını ve onaysız inline script/event handler'ın hâlâ
engellenmesini doğrular. Giriş düğmesine basmaz.

24 Ekim 2026 sonucu: odaklı üç Node test dosyası başarılı. Yalnız
`wrangler deploy --env appcheck --assets /tmp/appcheck-csp-admin-20261024 --keep-vars`
ile `portfolio-admin-auth-app-check` dağıtıldı; sürüm
`b0a56ee8-e15c-482a-a96b-946cae069152`. Wrangler mevcut beş admin assetinde
değişiklik bulmadı; yalnız Worker kodu/profil yayımlandı. Secret komutu çalıştırılmadı.
Canlı Chromium kontrolü başarılı: admin/config HTTP 200, üç koleksiyon,
`github-app`, doğru test dalı, görünür `GitHub ile Giriş`, sıfır açılış JS/CSP
hatası. Enjekte edilen onaysız inline script ve event handler ikisi de engellendi.
Ekran görüntüsü yerel `.private/appcheck-csp-login.png` dosyasındadır.
İlk doğrulama İngilizce düğme adı beklediği için zaman aşımına uğradı; sayfa
Türkçe düğmeyi hatasız gösteriyordu. Test gerçek Türkçe etikete düzeltildi.

Gerçek GitHub girişi, yetkilendirme, içerik/medya kaydı ve yeniden giriş kabulü
**yapılmadı**; kullanıcı tamamlayacaktır. Üretime deploy ve credential/secret
işlemi bu düzeltmenin kapsamı dışındadır.
