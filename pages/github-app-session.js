/* Decap 3.17.1 GitHub backend adapter: explicit in-place reauthorization,
 * no token refresh service, logout, draft reset or automatic write replay. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GitHubAppSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function popupAuthorization(origin, host = window) {
    const url = new URL('/auth', origin);
    url.searchParams.set('provider', 'github');
    url.searchParams.set('site_id', new URL(origin).hostname);
    // Called directly by the re-login button, preserving popup activation.
    const popup = host.open(url.href, 'GitHub App authorization', 'width=960,height=600');
    if (!popup) return Promise.reject(new Error('Giriş penceresine izin verin; taslağınız açık kalır.'));
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, data) => {
        host.removeEventListener('message', receive);
        host.clearInterval(timer);
        if (!popup.closed) popup.close();
        error ? reject(error) : resolve(data);
      };
      const started = Date.now();
      const receive = event => {
        if (event.origin !== origin || event.source !== popup || typeof event.data !== 'string') return;
        if (event.data === 'authorizing:github') {
          popup.postMessage('authorizing:github', origin);
          return;
        }
        const prefix = 'authorization:github:success:';
        if (!event.data.startsWith(prefix)) return;
        try {
          const data = JSON.parse(event.data.slice(prefix.length));
          if (data.provider !== 'github' || !/^ghu_[A-Za-z0-9]+$/.test(data.token || '') ||
              !Number.isFinite(data.expires_at) || data.expires_at <= Date.now()) throw Error();
          finish(null, {token: data.token, expires_at: data.expires_at});
        } catch { finish(new Error('Geçersiz giriş yanıtı; taslağınız açık kalır.')); }
      };
      host.addEventListener('message', receive);
      timer = host.setInterval(() => {
        if (popup.closed || Date.now() - started > 300000) finish(new Error('Giriş tamamlanmadı; taslağınız açık kalır.'));
      }, 500);
    });
  }

  function backendClass(NativeGitHub, {authorize, onExpired, onSaved, onSaveError, now = Date.now, createElement}) {
    return class GitHubApp extends NativeGitHub {
      authComponent() {
        const NativeAuth = super.authComponent();
        return props => createElement(NativeAuth, {...props, config: {...props.config,
          backend: {...props.config.backend, auth_scope: 'offline_access'}}});
      }
      async authenticate(credentials) {
        if (!/^ghu_[A-Za-z0-9]+$/.test(credentials.token || '') ||
            !Number.isFinite(credentials.expires_at) || credentials.expires_at <= now()) {
          const error = new Error('GitHub oturumunun süresi doldu. Yeniden giriş yapın; açık taslağı kapatmayın.');
          error.status = 401;
          throw error;
        }
        const user = await super.authenticate(credentials);
        this.expiresAt = credentials.expires_at;
        return {...user, expires_at: credentials.expires_at};
      }
      async reauthorize() {
        const credentials = await authorize();
        // Native GitHub caches /user; clear only authentication caches and polling.
        this._currentUserPromise = null;
        this.pollingManager?.destroy();
        this.pollingManager = null;
        const user = await this.authenticate(credentials);
        this.options.updateUserCredentials(user);
        return user;
      }
      async sessionOperation(operation) {
        try {
          if (this.expiresAt <= now()) {
            const error = new Error('GitHub oturumunun süresi doldu. Yeniden giriş yapıp kaydetmeyi tekrar deneyin.');
            error.status = 401;
            throw error;
          }
          return await operation();
        } catch (error) {
          if (error.status === 401) onExpired(() => this.reauthorize());
          throw error;
        }
      }
      async persistEntry(entry, options) {
        try {
          const result = await this.sessionOperation(() => super.persistEntry(entry, options));
          onSaved?.({sha:result?.object?.sha || result?.sha || null});
          return result;
        } catch (error) { onSaveError?.(); throw error; }
      }
      persistMedia(file, options) { return this.sessionOperation(() => super.persistMedia(file, options)); }
    };
  }

  function register(CMS, origin, document) {
    const native = CMS.getBackend('github')?.BackendClass;
    if (!native) throw new Error('Decap GitHub backend bulunamadı.');
    const onExpired = login => {
      if (document.getElementById('github-app-login')) return;
      const button = document.createElement('button');
      button.id = 'github-app-login';
      button.type = 'button';
      button.textContent = 'GitHub ile yeniden giriş';
      button.addEventListener('click', () => {
        button.disabled = true;
        login().then(() => {
          button.remove();
          const status = document.getElementById('save-status');
          if (status) status.textContent = 'Oturum yenilendi. Açık taslağı tekrar kaydedin.';
        }).catch(() => {
          button.disabled = false;
          button.textContent = 'Giriş tamamlanmadı — tekrar giriş';
        });
      });
      document.getElementById('cms-status').appendChild(button);
    };
    CMS.registerBackend('github-app', backendClass(native, {
      authorize: () => popupAuthorization(origin), onExpired, createElement: window.h,
      onSaved: detail => document.dispatchEvent(new CustomEvent('cms-entry-saved', {detail})),
      onSaveError: () => document.dispatchEvent(new CustomEvent('cms-entry-save-failed'))
    }));
  }
  return {backendClass, popupAuthorization, register};
});
