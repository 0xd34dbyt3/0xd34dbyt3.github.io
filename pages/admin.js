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

  const NativeImageControl = CMS.getWidget('image').control;
  const MarkdownPreview = CMS.getWidget('markdown').preview;
  const blockLabel = type => ({text:'Metin', image:'Görsel', code:'Kod'})[type];
  const BlockEditor = createClass({
    getInitialState() {
      this.lastValue = typeof this.props.value === 'string' ? this.props.value : '';
      return {blocks:T.parseDocument(this.lastValue), openGap:null, mobileTab:'edit'};
    },
    componentWillReceiveProps(nextProps) {
      const incoming = typeof nextProps.value === 'string' ? nextProps.value : '';
      if (incoming !== this.lastValue) {
        this.lastValue = incoming;
      this.setState({blocks:T.parseDocument(incoming), openGap:null, mobileTab:'edit'});
      }
    },
    commit(blocks) {
      this.setState({blocks});
      this.lastValue = T.serializeDocument(blocks);
      this.props.onChange(this.lastValue);
      changed();
    },
    insert(index, type) {
      const blocks = this.state.blocks.slice();
      blocks.splice(index, 0, T.newBlock(type));
      this.setState({openGap:null});
      this.commit(blocks);
    },
    updateText(index, value) {
      const blocks = this.state.blocks.slice();
      blocks[index] = {...blocks[index], value};
      this.commit(blocks);
    },
    updateData(index, patch) {
      const blocks = this.state.blocks.slice();
      blocks[index] = {...blocks[index], value:{...blocks[index].value, ...patch}, raw:null};
      this.commit(blocks);
    },
    move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= this.state.blocks.length) return;
      const blocks = this.state.blocks.slice();
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      this.commit(blocks);
    },
    remove(index) {
      if (!window.confirm('Bu bloğu silmek istiyor musunuz?')) return;
      const blocks = this.state.blocks.slice();
      blocks.splice(index, 1);
      if (!blocks.length) blocks.push(T.newBlock('text'));
      this.commit(blocks);
    },
    renderGap(index) {
      const open = this.state.openGap === index;
      return h('div', {className:'cms-block-gap', key:'gap-' + index},
        h('button', {type:'button', className:'cms-add-here', 'aria-label':'Buraya ekle', onClick:() => this.setState({openGap:open ? null : index})}, '＋ Buraya ekle'),
        open ? h('div', {className:'cms-add-options', role:'group', 'aria-label':'Eklenecek blok türü'},
          ...['text','image','code'].map(type => h('button', {key:type, type:'button', onClick:() => this.insert(index, type)}, blockLabel(type)))) : null);
    },
    renderBlock(block, index) {
      const data = block.value || {};
      let control;
      if (block.type === 'text') {
        control = h('label', {className:'cms-block-field'}, h('span', {}, 'Metin (Markdown; HTML yazmanız gerekmez)'),
          h('textarea', {value:block.value, rows:8, spellCheck:true, 'aria-label':'Metin bloğu', placeholder:'Başlık, paragraf, liste veya bağlantı…', onChange:event => this.updateText(index, event.target.value)}));
      } else if (block.type === 'image') {
        const field = this.props.field.set('widget', 'image').set('label', 'Dosya seç / yükle').set('required', false);
        const src = typeof data.src === 'string' ? data.src : '';
        let preview = null;
        try { if (src) preview = h('img', {src:T.safeImage(this.props.getAsset ? String(this.props.getAsset(src)) : src, true), alt:data.alt || ''}); }
        catch { preview = h('p', {role:'alert'}, 'Görsel adresi geçersiz.'); }
        control = h('div', {className:'cms-image-block'},
          h(NativeImageControl, {...this.props, value:src, field, forID:'image-' + block.key, classNameWrapper:'cms-native-image-control', onChange:value => this.updateData(index, {src:String(value || '')})}),
          preview ? h('div', {className:'cms-image-block-preview'}, preview) : null,
          h('div', {className:'cms-image-settings'},
            h('label', {className:'cms-block-field'}, h('span', {}, 'Genişlik'), h('input', {type:'number', min:1, max:data.unit === '%' ? 100 : 4096, value:data.width ?? 100, onChange:event => this.updateData(index, {width:Number(event.target.value)})})),
            h('label', {className:'cms-block-field'}, h('span', {}, 'Birim'), h('select', {value:data.unit || '%', onChange:event => this.updateData(index, {unit:event.target.value})}, h('option', {value:'%'}, '%'), h('option', {value:'px'}, 'px'))),
            h('label', {className:'cms-block-field'}, h('span', {}, 'Hizalama'), h('select', {value:data.align || 'center', onChange:event => this.updateData(index, {align:event.target.value})}, h('option', {value:'left'}, 'Sol'), h('option', {value:'center'}, 'Orta'), h('option', {value:'right'}, 'Sağ'))),
            h('label', {className:'cms-block-field'}, h('span', {}, 'Kırpma (varsayılan: oranı koru)'), h('select', {value:data.crop || 'none', onChange:event => this.updateData(index, {crop:event.target.value})}, h('option', {value:'none'}, 'Oranı koru'), h('option', {value:'square'}, 'Kare'), h('option', {value:'wide'}, '16:9'))),
            h('label', {className:'cms-block-field'}, h('span', {}, 'Alt metin'), h('input', {type:'text', value:data.alt || '', onChange:event => this.updateData(index, {alt:event.target.value})})),
            h('label', {className:'cms-block-field'}, h('span', {}, 'Açıklama (isteğe bağlı)'), h('input', {type:'text', value:data.caption || '', onChange:event => this.updateData(index, {caption:event.target.value})}))));
      } else {
        control = h('div', {className:'cms-code-block'},
          h('label', {className:'cms-block-field'}, h('span', {}, 'Dil'), h('select', {value:data.language || 'text', onChange:event => this.updateData(index, {language:event.target.value})}, ...T.languages.map(language => h('option', {key:language, value:language}, language)))),
          h('label', {className:'cms-block-field cms-wrap-option'}, h('input', {type:'checkbox', checked:!!data.wrap, onChange:event => this.updateData(index, {wrap:event.target.checked})}), h('span', {}, 'Uzun satırları sar')),
          h('label', {className:'cms-block-field'}, h('span', {}, 'Kod (girintiler korunur)'), h('textarea', {value:data.code || '', rows:10, spellCheck:false, className:'cms-code-input', 'aria-label':'Kod alanı', onChange:event => this.updateData(index, {code:event.target.value})})));
      }
      return h('section', {className:'cms-content-block cms-block-' + block.type, key:block.key, 'data-block-type':block.type},
        h('header', {className:'cms-block-header'}, h('strong', {}, blockLabel(block.type)),
          h('div', {className:'cms-block-actions'},
            h('button', {type:'button', disabled:index===0, 'aria-label':'Bloku yukarı taşı', onClick:() => this.move(index,-1)}, '↑'),
            h('button', {type:'button', disabled:index===this.state.blocks.length-1, 'aria-label':'Bloku aşağı taşı', onClick:() => this.move(index,1)}, '↓'),
            h('button', {type:'button', className:'cms-block-delete', onClick:() => this.remove(index)}, 'Sil'))),
        control);
    },
    render() {
      const children = [h('p', {className:'cms-block-help', key:'help'}, 'Blok sırası yayın sırasıdır. Medya sekmesi ayrı kütüphanedir; buradan seçtiğiniz görsel yalnızca bu bloğa eklenir.')];
      this.state.blocks.forEach((block, index) => { children.push(this.renderGap(index), this.renderBlock(block, index)); });
      children.push(this.renderGap(this.state.blocks.length));
      const preview = h(BlockPreview, {...this.props, value:T.serializeDocument(this.state.blocks)});
      return h('div', {className:'cms-block-editor'},
        h('div', {className:'cms-mobile-tabs', role:'tablist'},
          h('button', {type:'button', role:'tab', 'aria-selected':this.state.mobileTab==='edit', onClick:() => this.setState({mobileTab:'edit'})}, 'Düzenle'),
          h('button', {type:'button', role:'tab', 'aria-selected':this.state.mobileTab==='preview', onClick:() => this.setState({mobileTab:'preview'})}, 'Önizleme')),
        h('div', {className:'cms-block-editor-form', 'data-mobile-active':this.state.mobileTab==='edit'}, ...children),
        h('div', {className:'cms-mobile-preview', 'data-mobile-active':this.state.mobileTab==='preview'}, preview));
    }
  });
  const BlockPreview = createClass({
    render() {
      const blocks = T.parseDocument(typeof this.props.value === 'string' ? this.props.value : '');
      return h('div', {className:'markdown-content cms-block-preview'}, ...blocks.map(block => {
        if (block.type === 'text') return h(MarkdownPreview, {...this.props, value:block.value, key:block.key});
        if (block.type === 'image') return imagePreviewNode(block.value, this.props.getAsset, block.key);
        return codePreviewNode(block.value, block.key);
      }));
    }
  });
  function imagePreviewNode(value, getAsset, key) {
    try {
      const data = T.validate('image', value);
      const src = getAsset ? String(getAsset(data.src)) : data.src;
      T.safeImage(src, true);
      return h('figure', {className:'content-image align-' + data.align + ' crop-' + data.crop, style:{width:data.width + data.unit}, key},
        h('img', {src, alt:data.alt, loading:'lazy'}), data.caption ? h('figcaption', {}, data.caption) : null);
    } catch (error) { return h('p', {key, role:'alert'}, error.message); }
  }
  function codePreviewNode(value, key) {
    const data = T.validate('code', value);
    return h('div', {className:'cms-preview-code', key},
      h('div', {className:'code-toolbar'}, h('span', {}, data.language), h('button', {type:'button', onClick:event => T.copy(data.code, event.currentTarget)}, 'Kopyala')),
      h('pre', {'data-wrap':String(data.wrap)}, h('code', {className:'language-' + data.language}, ...T.tokens(data.code, data.language).map((token, index) => h('span', {key:index, className:token.type ? 'tok-' + token.type : undefined}, token.text)))));
  }
  CMS.registerWidget('ordered-content', BlockEditor, BlockPreview);

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
  CMS.registerPreviewTemplate('about_page', Preview);

  function validateEntry(entry) {
    const data = entry.get('data').toJS();
    const path = entry.get('path');
    if (!data.slug) {
      const pathSlug = path && path.split('/').pop().replace(/\.json$/, '');
      const titleSlug = String(data.title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      data.slug = pathSlug || titleSlug;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(data.slug || '')) throw Error('Başlıktan geçerli slug üretilemedi; başlığı düzenleyin.');
    if (path && path.split('/').pop() !== data.slug + '.json') {
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
      return entry.get('data').set('slug', data.slug);
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
