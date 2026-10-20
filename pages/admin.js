/* Decap 3.17.1 extensions; native editor, backend, media and draft lifecycle remain. */
(function () {
  'use strict';
  const T = window.ContentTools;
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const field = (name, label, widget = 'string', extra = {}) => ({name, label, widget, ...extra});
  const status = text => { document.getElementById('save-status').textContent = text; };
  let dirty = false;
  let revision = 0;
  let savingRevision = -1;
  const originalIds = new Map();
  function changed() {
    dirty = true;
    revision++;
    status('Kaydedilmemiş değişiklikler var.');
  }
  document.addEventListener('input', changed);
  // Includes list reorder, rich-text toolbar and media selection actions.
  document.addEventListener('change', changed);
  window.addEventListener('beforeunload', event => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  // Decap's media library accepts any file. Validate before its React handler,
  // then replay once with safe unique names; failed uploads never clear the entry.
  const approvedEvents = new WeakSet();
  async function interceptUpload(event) {
    if (approvedEvents.has(event)) return;
    const input = event.type === 'change' && event.target.matches('input[type=file]') ? event.target : null;
    const files = input ? [...input.files] : event.type === 'drop' ? [...(event.dataTransfer?.files || [])] : [];
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const transfer = new DataTransfer();
      for (const file of files) {
        const ext = await T.validateFile(file);
        const safe = new File([file], 'image-' + crypto.randomUUID() + '.' + ext, {type: file.type, lastModified: file.lastModified});
        transfer.items.add(safe);
      }
      let replay;
      if (input) {
        input.files = transfer.files;
        replay = new Event('change', {bubbles: true});
      } else {
        replay = new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer});
      }
      approvedEvents.add(replay);
      event.target.dispatchEvent(replay);
      changed();
    } catch (error) {
      if (input) input.value = '';
      status('Görsel yüklenemedi: ' + error.message + ' Yazdıklarınız korunuyor.');
      window.alert('Görsel yüklenemedi: ' + error.message);
    }
  }
  window.addEventListener('change', interceptUpload, true);
  window.addEventListener('drop', interceptUpload, true);

  function imagePreview(value, getAsset) {
    try {
      const d = T.validate('image', value);
      const src = getAsset ? String(getAsset(d.src)) : d.src;
      T.safeImage(src, true);
      return `<figure class="content-image align-${d.align} crop-${d.crop}" style="width:${d.width}${d.unit}"><img src="${escape(src)}" alt="${escape(d.alt)}">${d.caption ? '<figcaption>' + escape(d.caption) + '</figcaption>' : ''}</figure>`;
    } catch (error) { return '<p>' + escape(error.message) + '</p>'; }
  }
  function codePreview(value) {
    try {
      const d = T.validate('code', value);
      return `<pre data-wrap="${d.wrap}"><code class="language-${d.language}">${escape(d.code)}</code></pre>`;
    } catch (error) { return '<p>' + escape(error.message) + '</p>'; }
  }
  CMS.registerEditorComponent({
    id: 'managed-image', label: 'Görsel ve yerleşim',
    fields: [
      field('src', 'Görsel yükle / seç', 'image'),
      field('alt', 'Alt metin', 'string', {default: ''}),
      field('caption', 'Açıklama', 'string', {required: false, default: ''}),
      field('width', 'Genişlik', 'number', {value_type: 'int', min: 1, max: 4096, default: 100}),
      field('unit', 'Birim', 'select', {options: ['%', 'px'], default: '%'}),
      field('align', 'Hizalama', 'select', {options: [{label:'Sol', value:'left'}, {label:'Orta', value:'center'}, {label:'Sağ', value:'right'}], default:'center'}),
      field('crop', 'Kırpma', 'select', {options: [{label:'Oranı koru (kırpma yok)', value:'none'}, {label:'Kare kırp', value:'square'}, {label:'16:9 kırp', value:'wide'}], default:'none'})
    ],
    pattern: /^```cms-image\n([^\n]+)\n```$/m,
    fromBlock: match => JSON.parse(match[1]),
    toBlock: value => T.serializeDraft('image', value),
    toPreview: imagePreview
  });
  CMS.registerEditorComponent({
    id: 'managed-code', label: 'Kod bloğu',
    fields: [
      field('language', 'Dil', 'select', {options: T.languages, default: 'text'}),
      field('wrap', 'Uzun satırları sar', 'boolean', {default: false, required: false}),
      field('code', 'Kod (girintiler korunur)', 'text', {default: ''})
    ],
    pattern: /^```cms-code\n([^\n]+)\n```$/m,
    fromBlock: match => JSON.parse(match[1]),
    toBlock: value => T.serializeDraft('code', value),
    toPreview: codePreview
  });

  const Preview = createClass({
    getInitialState() { return {width: '100%', lang: 'en'}; },
    componentDidMount() {
      const path = this.props.entry.get('path');
      if (path && !originalIds.has(path)) originalIds.set(path, this.props.entry.getIn(['data', 'id']));
      this.enhance();
    },
    componentDidUpdate(previous) {
      if (!previous.entry.get('data').equals(this.props.entry.get('data'))) changed();
      this.enhance();
    },
    enhance() { if (this.container) T.enhance(this.container); },
    render() {
      const data = this.props.entry.get('data');
      const suffix = this.state.lang === 'tr' ? '_tr' : '';
      const title = data.get('title' + suffix) || data.get('title');
      const desc = data.get('shortDesc' + suffix) || data.get('shortDesc');
      const body = data.get('fullDesc' + suffix) ? 'fullDesc' + suffix : 'fullDesc';
      const controls = h('div', {className:'cms-preview-controls'},
        ...['100%', '320px', '375px', '390px'].map(width => h('button', {key:width, type:'button', onClick:() => this.setState({width})}, width === '100%' ? 'Masaüstü' : width)),
        ...['en','tr'].map(lang => h('button', {key:lang, type:'button', onClick:() => this.setState({lang})}, lang.toUpperCase())));
      if (data.has('whoami')) {
        const about = data.toJS();
        const bi = v => v?.[this.state.lang] || v?.en || v?.tr || '';
        const profile = about.profile || {};
        const sections = [['education','education_log'], ['work','WORK_EXPERIENCE'], ['skills','SKILL_MATRIX'], ['certs','CERT_CHAIN']];
        return h('div', {}, controls, h('article', {className:'cms-preview markdown-content', style:{width:this.state.width}},
          h('h1', {}, profile.name), h('p', {}, bi(profile.role)), h('p', {}, profile.location),
          h('p', {}, profile.status), h('p', {}, (profile.core_focus || []).map(bi).join(' · ')),
          h('h2', {}, 'whoami'), h('p', {}, bi(about.whoami)),
          ...sections.map(([key, label]) => h('section', {key}, h('h2', {}, label),
            ...(about[key] || []).map((item, i) => h('div', {key:i, className:'education-entry'},
              ...Object.entries(item).map(([name, value]) => h('p', {key:name},
                Array.isArray(value) ? value.map(bi).join(' · ') : typeof value === 'string' ? value : bi(value)))))))));
      }
      let cover = null;
      try {
        if (data.get('imageUrl')) cover = h('img', {className:'detail-image', src:T.safeImage(String(this.props.getAsset(data.get('imageUrl'))), true), alt:title});
      } catch { /* Invalid cover is rejected on save, never injected in preview. */ }
      return h('div', {}, controls,
        h('article', {className:'cms-preview detail-content', style:{width:this.state.width}, ref:node => {this.container = node;}},
          h('h1', {}, title), h('p', {}, desc), cover,
          h('div', {className:'markdown-content'}, this.props.widgetFor(body))));
    }
  });
  CMS.registerPreviewStyle('../styles.css');
  CMS.registerPreviewStyle('../content.css');
  CMS.registerPreviewTemplate('blog', Preview);
  CMS.registerPreviewTemplate('project', Preview);
  CMS.registerPreviewTemplate('about', Preview);

  function validateEntry(entry) {
    const data = entry.get('data').toJS();
    const path = entry.get('path');
    if (path && data.slug && path.split('/').pop() !== data.slug + '.json') {
      throw Error('Mevcut slug değiştirilemez; eski bağlantılar korunmalıdır.');
    }
    if (path && originalIds.get(path) && data.id !== originalIds.get(path)) {
      throw Error('Mevcut ID değiştirilemez; eski bağlantılar korunmalıdır.');
    }
    for (const key of ['fullDesc', 'fullDesc_tr']) {
      const source = data[key] || '';
      for (const match of source.matchAll(/^```cms-(image|code)\n([^\n]+)\n```$/gm)) {
        T.validate(match[1], JSON.parse(match[2]));
      }
    }
    if (data.imageUrl) T.safeImage(data.imageUrl);
    return entry.get('data');
  }
  CMS.registerEventListener({name:'preSave', handler:({entry}) => {
    try {
      const data = validateEntry(entry);
      savingRevision = revision;
      status('GitHub’a kayıt deneniyor. Hata olursa yazdıklarınızı kapatmayın; yeniden deneyebilirsiniz.');
      return data;
    } catch (error) {
      status('Kayıt engellendi: ' + error.message + ' Yazdıklarınız korunuyor.');
      throw error;
    }
  }});
  const saved = () => {
    dirty = revision !== savingRevision;
    status(dirty ? 'GitHub’a kaydedildi; daha yeni değişiklikler kaydedilmedi.' : 'GitHub’a kaydedildi. Actions yayını henüz doğrulanmadı.');
  };
  CMS.registerEventListener({name:'postSave', handler:saved});
  CMS.registerEventListener({name:'postPublish', handler:saved});
  // Native Decap supplies delete confirmation, route-leave warning and keeps
  // the Redux draft on persist failure. Do not replace or auto-submit those flows.
  fetch('config.yml').then(r => { if (!r.ok) throw Error(); return r.json(); }).then(config => {
    document.getElementById('actions-link').href = 'https://github.com/' + config.backend.repo + '/actions/workflows/pages.yml';
    // This file already fetched the complete config; prevent Decap from loading
    // config.yml again and merging the collections array a second time.
    config.load_config_file = false;
    CMS.init({config});
  }).catch(() => status('Admin yapılandırması yüklenemedi. Sayfayı yeniden açmadan önce bağlantıyı kontrol edin.'));
})();
