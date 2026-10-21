/* Decap 3.17.1 extensions; native editor, backend, media and draft lifecycle remain. */
(function () {
  'use strict';
  const T = window.ContentTools;
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const field = (name, label, widget = 'string', extra = {}) => ({name, label, widget, ...extra});
  const status = text => {
    const message = document.getElementById('save-message');
    message.textContent = text;
    message.hidden = !text;
  };
  let dirty = false;
  let revision = 0;
  let savingRevision = -1;
  const originalIds = new Map();
  function changed() {
    dirty = true;
    revision++;
    status('');
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

  const MarkdownPreview = CMS.getWidget('markdown').preview;
  const blockLabel = type => ({text:'Metin', image:'Görsel', code:'Kod'})[type];
  const BlockEditor = createClass({
    getInitialState() {
      this.lastValue = typeof this.props.value === 'string' ? this.props.value : '';
      this.handledMediaPaths = new Map();
      return {blocks:T.parseDocument(this.lastValue), openGap:null, mobileTab:'edit', selectedKey:null, settingsOpen:false, previewOpen:false};
    },
    isBlog() { return this.props.entry && this.props.entry.get('collection') === 'blog'; },
    componentDidMount() {
      if (this.isBlog()) {
        document.body.classList.add('cms-blog-entry');
        this.markBlogFields();
        this.blogObserver = new MutationObserver(() => this.markBlogFields());
        this.blogObserver.observe(document.getElementById('nc-root'), {childList:true, subtree:true});
      }
    },
    componentWillUnmount() {
      if (this.blogObserver) this.blogObserver.disconnect();
      if (this.isBlog()) document.body.classList.remove('cms-blog-entry', 'cms-blog-settings-open');
    },
    markBlogFields() {
      for (const container of document.querySelectorAll('#nc-root [class*="ControlContainer"]')) {
        const label = (container.querySelector('label')?.innerText || '').trim().toLocaleUpperCase('tr');
        const kind = label.startsWith('ANA BAŞLIK (TR)') ? 'title-tr'
          : label.startsWith('KISA AÇIKLAMA (TR)') ? 'summary-tr'
          : label.startsWith('DETAY İÇERİĞİ (TR)') ? 'body-tr'
          : label.startsWith('KAPAK GÖRSELİ') ? 'cover'
          : label.startsWith('KALICI BAĞLANTI') ? 'slug' : null;
        if (kind) container.dataset.blogField = kind;
      }
    },
    shouldComponentUpdate(nextProps, nextState) {
      if (this.state !== nextState || nextProps.value !== this.props.value || nextProps.classNameWrapper !== this.props.classNameWrapper) return true;
      const before = this.props.mediaPaths;
      const after = nextProps.mediaPaths;
      return this.state.blocks.some(block => block.type === 'image' &&
        before && after && before.get('ordered-image-' + block.key) !== after.get('ordered-image-' + block.key));
    },
    componentWillReceiveProps(nextProps) {
      const incoming = typeof nextProps.value === 'string' ? nextProps.value : '';
      if (incoming !== this.lastValue) {
        this.lastValue = incoming;
        this.setState({blocks:T.parseDocument(incoming), openGap:null, mobileTab:'edit'});
      }
      // Decap stores a media-library result under the controlID supplied to
      // onOpenMediaLibrary. The raw built-in image control's own random ID is
      // not connected to this composite widget's value, so bridge that map to
      // the block by its stable key here.
      const paths = nextProps.mediaPaths;
      if (paths && typeof paths.get === 'function') {
        for (const block of this.state.blocks) {
          if (block.type !== 'image') continue;
          const controlID = 'ordered-image-' + block.key;
          const selected = paths.get(controlID);
          if (!selected) {
            this.handledMediaPaths.delete(controlID);
            continue;
          }
          if (this.handledMediaPaths.get(controlID) !== selected) {
            this.handledMediaPaths.set(controlID, selected);
            if (selected !== block.value.src) {
              const blocks = this.state.blocks.map(item => item.key === block.key
                ? {...item, value:{...item.value, src:String(selected)}, raw:null}
                : item);
              this.lastValue = T.serializeDocument(blocks);
              this.setState({blocks});
              nextProps.onChange(this.lastValue);
              changed();
            }
            if (nextProps.onRemoveInsertedMedia) nextProps.onRemoveInsertedMedia(controlID);
            break;
          }
        }
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
      const blog = this.isBlog();
      return h('div', {className:'cms-block-gap' + (blog ? ' cms-blog-block-gap' : ''), key:'gap-' + index},
        h('button', {type:'button', className:'cms-add-here', 'aria-label':'Buraya ekle', title:'Buraya blok ekle', onClick:() => this.setState({openGap:open ? null : index})}, blog ? '+' : '＋ Buraya ekle'),
        open ? h('div', {className:'cms-add-options', role:'group', 'aria-label':'Eklenecek blok türü'},
          ...['text','image','code'].map(type => h('button', {key:type, type:'button', onClick:() => this.insert(index, type)}, blockLabel(type)))) : null);
    },
    renderBlock(block, index) {
      const data = block.value || {};
      const blog = this.isBlog();
      const selected = this.state.selectedKey === block.key;
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
        const controlID = 'ordered-image-' + block.key;
        const imageSettings = h('div', {className:'cms-image-settings'},
          h('label', {className:'cms-block-field'}, h('span', {}, 'Genişlik'), h('input', {type:'number', min:1, max:data.unit === '%' ? 100 : 4096, value:data.width ?? 100, onChange:event => this.updateData(index, {width:Number(event.target.value)})})),
          h('label', {className:'cms-block-field'}, h('span', {}, 'Birim'), h('select', {value:data.unit || '%', onChange:event => this.updateData(index, {unit:event.target.value})}, h('option', {value:'%'}, '%'), h('option', {value:'px'}, 'px'))),
          h('label', {className:'cms-block-field'}, h('span', {}, 'Hizalama'), h('select', {value:data.align || 'center', onChange:event => this.updateData(index, {align:event.target.value})}, h('option', {value:'left'}, 'Sol'), h('option', {value:'center'}, 'Orta'), h('option', {value:'right'}, 'Sağ'))),
          h('label', {className:'cms-block-field'}, h('span', {}, 'Alt metin'), h('input', {type:'text', value:data.alt || '', onChange:event => this.updateData(index, {alt:event.target.value})})),
          h('label', {className:'cms-block-field cms-crop-setting'}, h('span', {}, 'Kırpma'), h('select', {value:data.crop || 'none', onChange:event => this.updateData(index, {crop:event.target.value})}, h('option', {value:'none'}, 'Oranı koru'), h('option', {value:'square'}, 'Kare'), h('option', {value:'wide'}, '16:9'))));
        control = h('div', {className:'cms-image-block'},
          h('button', {type:'button', className:'cms-native-image-control', onClick:() => this.props.onOpenMediaLibrary({
            controlID, forImage:true, field, value:src, allowMultiple:false,
            config:field.getIn(['options','media_library','config'])
          })}, src ? 'Görseli değiştir' : 'Bir resim seçin'),
          preview ? h('div', {className:'cms-image-block-preview'}, preview) : null,
          h('label', {className:'cms-block-field cms-image-caption'}, h('span', {}, 'Açıklama (isteğe bağlı)'), h('input', {type:'text', value:data.caption || '', onChange:event => this.updateData(index, {caption:event.target.value})})),
          blog ? (src && selected ? h('details', {className:'cms-image-options', open:true}, h('summary', {}, 'Görsel ayarları'), imageSettings) : null) : imageSettings);
      } else {
        const codeSettings = h('div', {className:'cms-code-settings'},
          h('label', {className:'cms-block-field'}, h('span', {}, 'Dil'), h('select', {value:data.language || 'text', onChange:event => this.updateData(index, {language:event.target.value})}, ...T.languages.map(language => h('option', {key:language, value:language}, language)))),
          h('label', {className:'cms-block-field cms-wrap-option'}, h('input', {type:'checkbox', checked:!!data.wrap, onChange:event => this.updateData(index, {wrap:event.target.checked})}), h('span', {}, 'Uzun satırları sar')));
        control = h('div', {className:'cms-code-block'},
          blog ? h('span', {className:'cms-code-language'}, data.language || 'text') : null,
          blog && selected ? h('details', {className:'cms-code-options', open:true}, h('summary', {}, 'Kod ayarları'), codeSettings) : null,
          !blog ? codeSettings : null,
          h('label', {className:'cms-block-field cms-code-field'}, h('span', {className:blog ? 'cms-visually-hidden' : ''}, 'Kod (girintiler korunur)'), h('textarea', {value:data.code || '', rows:10, spellCheck:false, className:'cms-code-input', 'aria-label':'Kod alanı', onChange:event => this.updateData(index, {code:event.target.value})})));
      }
      return h('section', {className:'cms-content-block cms-block-' + block.type + (selected ? ' is-selected' : ''), key:block.key, 'data-block-type':block.type,
        tabIndex:blog ? 0 : undefined,
        onFocus:blog ? () => this.setState({selectedKey:block.key}) : undefined,
        onClick:blog ? () => this.setState({selectedKey:block.key}) : undefined,
        onKeyDown:blog ? event => {
          if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); this.move(index, -1); }
          if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); this.move(index, 1); }
        } : undefined,
        'data-block-type':block.type},
        h('header', {className:'cms-block-header'}, h('strong', {}, blockLabel(block.type)),
          h('div', {className:'cms-block-actions'},
            h('button', {type:'button', disabled:index===0, 'aria-label':'Bloku yukarı taşı', onClick:() => this.move(index,-1)}, '↑'),
            h('button', {type:'button', disabled:index===this.state.blocks.length-1, 'aria-label':'Bloku aşağı taşı', onClick:() => this.move(index,1)}, '↓'),
            h('button', {type:'button', className:'cms-block-delete', onClick:() => this.remove(index)}, 'Sil'))),
        control);
    },
    render() {
      const blog = this.isBlog();
      const fieldName = this.props.field.get('name');
      const primaryBlogField = blog && fieldName === 'fullDesc';
      const children = blog ? [] : [h('p', {className:'cms-block-help', key:'help'}, 'Blok sırası yayın sırasıdır. Medya sekmesi ayrı kütüphanedir; buradan seçtiğiniz görsel yalnızca bu bloğa eklenir.')];
      this.state.blocks.forEach((block, index) => { children.push(this.renderGap(index), this.renderBlock(block, index)); });
      children.push(this.renderGap(this.state.blocks.length));
      const preview = h(BlockPreview, {...this.props, value:T.serializeDocument(this.state.blocks)});
      if (blog) {
        return h('div', {className:'cms-block-editor cms-blog-content-editor' + (fieldName === 'fullDesc_tr' ? ' cms-blog-content-editor-tr' : '')},
          primaryBlogField ? h('div', {className:'cms-blog-editor-toolbar'},
            h('strong', {}, 'Yazı içeriği'),
            h('div', {className:'cms-blog-editor-toolbar-actions'},
              h('button', {type:'button', 'aria-expanded':this.state.settingsOpen, onClick:() => {
                const open = !this.state.settingsOpen;
                document.body.classList.toggle('cms-blog-settings-open', open);
                this.setState({settingsOpen:open});
              }}, this.state.settingsOpen ? 'İçerik ayarlarını kapat' : 'İçerik ayarları'),
              h('button', {type:'button', 'aria-pressed':this.state.previewOpen, onClick:() => this.setState({previewOpen:!this.state.previewOpen})}, this.state.previewOpen ? 'Önizlemeyi kapat' : 'Önizleme'))) : null,
          h('div', {className:'cms-blog-workspace', 'data-preview-open':this.state.previewOpen},
            h('div', {className:'cms-block-editor-form'}, ...children),
            this.state.previewOpen ? h('aside', {className:'cms-blog-preview-panel', 'aria-label':'Yazı önizlemesi'}, preview) : null));
      }
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
        const bi = v => {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
          const preferred = v[this.state.lang];
          const fallback = this.state.lang === 'tr' ? v.en : v.tr;
          return typeof preferred === 'string' && preferred.trim() ? preferred
            : typeof fallback === 'string' ? fallback : '';
        };
        const text = value => typeof value === 'string' ? value : '';
        const rows = key => Array.isArray(about[key])
          ? about[key].filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
        const profile = about.profile || {};
        const sections = [
          ['education','education_log', item => h('div', {className:'education-entry', key:item.key},
            h('strong', {}, bi(item.value.institution)), h('p', {}, bi(item.value.detail)))],
          ['work','WORK_EXPERIENCE', item => h('div', {className:'education-entry', key:item.key},
            h('strong', {}, bi(item.value.title)), h('p', {}, [bi(item.value.company), text(item.value.duration)].filter(Boolean).join(' · ')),
            h('p', {}, bi(item.value.desc)))],
          ['skills','SKILL_MATRIX', item => h('div', {className:'education-entry', key:item.key},
            h('strong', {}, bi(item.value.category)), h('p', {}, (Array.isArray(item.value.items) ? item.value.items : []).map(bi).filter(Boolean).join(' · ')))],
          ['certs','CERT_CHAIN', item => h('div', {className:'education-entry', key:item.key},
            h('strong', {}, bi(item.value.title)), h('p', {}, bi(item.value.desc)))]
        ];
        return h('div', {}, controls, h('article', {className:'cms-preview markdown-content', style:{width:this.state.width}},
          h('h1', {}, text(profile.name)),
          h('p', {}, bi(profile.role)), h('p', {}, text(profile.location)), h('p', {}, text(profile.status)),
          h('p', {}, (Array.isArray(profile.core_focus) ? profile.core_focus : []).map(bi).filter(Boolean).join(' · ')),
          h('h2', {}, 'whoami'), h('p', {}, bi(about.whoami)),
          ...sections.map(([key, label, render]) => h('section', {key}, h('h2', {}, label),
            ...rows(key).map((value, i) => render({key:i, value}))))));
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
    status('');
  };
  CMS.registerEventListener({name:'postSave', handler:saved});
  CMS.registerEventListener({name:'postPublish', handler:saved});
  const markAboutLanguagePairs = () => {
    if (!document.body.classList.contains('cms-about-entry')) return;
    for (const group of document.querySelectorAll('#nc-root .Pane1 div')) {
      const fields = [...group.children].filter(child => child.matches('[class*="ControlContainer"]'));
      if (fields.length !== 2) continue;
      const labels = fields.map(field => (field.querySelector('label')?.innerText || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
      if (labels.some(label => label.startsWith('engl')) && labels.some(label => label.startsWith('turk'))) {
        group.dataset.aboutLanguagePair = 'true';
      }
    }
  };
  const syncAboutClass = () => {
    document.body.classList.toggle('cms-about-entry', location.hash.includes('/collections/about_page/'));
    document.body.classList.toggle('cms-post-entry', /\/collections\/(blog|project)\//.test(location.hash));
  };
  const syncNativeSaveStatus = () => {
    const badge = document.querySelector('#nc-root [class*="BackStatus"]');
    const target = document.getElementById('save-status');
    const current = badge && badge.textContent.trim();
    if (current && target.getAttribute('aria-label') !== current) {
      const compact = /kaydedilmemiş/i.test(current) ? 'Kaydedilmemiş' : /kaydedildi/i.test(current) ? 'Kaydedildi' : current;
      target.textContent = compact;
      target.setAttribute('aria-label', current);
    }
  };
  const observedAboutLayout = new WeakSet();
  const aboutMenuTargets = new WeakMap();
  const ensureAboutMobileMenu = () => {
    if (!document.body.classList.contains('cms-about-entry') || !window.matchMedia('(max-width: 767px)').matches) return;
    const toolbar = document.querySelector('#nc-root [class*="ToolbarContainer"]');
    const main = document.querySelector('#nc-root [class*="ToolbarSectionMain"]');
    const meta = document.querySelector('#nc-root [class*="ToolbarSectionMeta"]');
    if (!toolbar || !main || !meta) return;
    let menu = toolbar.querySelector('.cms-about-mobile-menu');
    if (!menu) {
      menu = document.createElement('details');
      menu.className = 'cms-about-mobile-menu';
      menu.innerHTML = '<summary aria-label="Hesap ve yayın menüsü" title="Hesap ve yayın menüsü">⋯</summary><div class="cms-about-mobile-menu-panel"><div class="cms-about-mobile-menu-site"></div><div class="cms-about-mobile-menu-actions"></div></div>';
      toolbar.append(menu);
      menu.addEventListener('toggle', () => document.body.classList.toggle('cms-about-mobile-menu-open', menu.open));
      menu.addEventListener('click', event => {
        const action = event.target.closest('[data-menu-action]');
        if (!action) return;
        const target = aboutMenuTargets.get(action);
        if (target?.isConnected) target.click();
      });
    }
    const site = menu.querySelector('.cms-about-mobile-menu-site');
    const actions = menu.querySelector('.cms-about-mobile-menu-actions');
    const identity = meta.innerText.trim().replace(/\s+/g, ' ');
    const siteLabel = identity ? 'Hesap / site: ' + identity : 'Hesap ve site';
    if (site.textContent !== siteLabel) site.textContent = siteLabel;
    const secondary = [...main.querySelectorAll('button,a,[role="button"]')].filter(control => {
      const label = (control.innerText || control.getAttribute('aria-label') || control.title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLocaleLowerCase();
      return label !== 'yayinla';
    });
    for (const control of secondary) control.dataset.mobileSecondary = 'true';
    const signature = secondary.map(control => (control.innerText || control.getAttribute('aria-label') || control.title || '').trim()).join('|');
    const targets = secondary.map(target => ({label:(target.innerText || target.getAttribute('aria-label') || target.title || 'Yayın kontrolü').trim(), target, kind:'publish'}));
    if (actions.dataset.signature !== signature) {
      actions.replaceChildren();
      for (const entry of targets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.menuAction = entry.kind;
        button.textContent = entry.label;
        actions.append(button);
      }
      actions.dataset.signature = signature;
    }
    [...actions.children].forEach((button, index) => aboutMenuTargets.set(button, targets[index]?.target));
  };
  const syncAboutToolbarLayout = () => {
    if (!document.body.classList.contains('cms-about-entry') || !window.matchMedia('(max-width: 767px)').matches) return;
    const toolbar = document.querySelector('#nc-root [class*="ToolbarContainer"]');
    const controls = document.querySelector('#nc-root [class*="ViewControls"]');
    const split = document.querySelector('#nc-root .SplitPane');
    if (!toolbar || !controls || !split) return;
    const container = toolbar.parentElement;
    const editor = controls.closest('#nc-root [class*="-Editor "]');
    const setMeasurements = () => {
      const toolbarHeight = Math.ceil(toolbar.getBoundingClientRect().height) + 'px';
      const controlsHeight = Math.ceil(controls.getBoundingClientRect().height) + 'px';
      const footer = document.getElementById('cms-status');
      if (footer) document.documentElement.style.setProperty('--cms-footer-height', Math.ceil(footer.getBoundingClientRect().height) + 'px');
      container.style.setProperty('--about-toolbar-height', toolbarHeight);
      container.style.setProperty('--about-controls-height', controlsHeight);
      document.documentElement.style.setProperty('--about-toolbar-height', toolbarHeight);
      document.documentElement.style.setProperty('--about-controls-height', controlsHeight);
      split.style.setProperty('position', 'fixed', 'important');
      split.style.setProperty('top', `calc(${toolbarHeight} + ${controlsHeight})`, 'important');
      split.style.setProperty('right', '0', 'important');
      split.style.setProperty('bottom', 'var(--cms-footer-height, 92px)', 'important');
      split.style.setProperty('left', '0', 'important');
      split.style.setProperty('height', 'auto', 'important');
    };
    setMeasurements();
    if (window.ResizeObserver && !observedAboutLayout.has(toolbar)) {
      const observer = new ResizeObserver(setMeasurements);
      observer.observe(toolbar);
      observer.observe(controls);
      observedAboutLayout.add(toolbar);
    }
    if (editor) editor.style.top = 'var(--about-toolbar-height, 175px)';
  };
  const bindAboutPreviewToggle = () => {
    if (!document.body.classList.contains('cms-about-entry')) return;
    const button = document.querySelector('#nc-root [class*="ViewControls"] button:first-child');
    if (!button) return;
    button.title = document.body.classList.contains('cms-about-preview-active') ? 'Düzenle' : 'Önizle';
    button.setAttribute('aria-label', button.title);
    syncAboutToolbarLayout();
  };
  const aboutMobileBreakpoint = window.matchMedia('(max-width: 767px)');
  aboutMobileBreakpoint.addEventListener?.('change', () => {
    if (!aboutMobileBreakpoint.matches) document.body.classList.remove('cms-about-mobile-menu-open');
    ensureAboutMobileMenu();
    syncAboutToolbarLayout();
    requestAnimationFrame(() => { ensureAboutMobileMenu(); syncAboutToolbarLayout(); });
  });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('#nc-root [class*="ViewControls"] button:first-child');
    if (!button || !document.body.classList.contains('cms-about-entry') || !window.matchMedia('(max-width: 767px)').matches) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const active = document.body.classList.toggle('cms-about-preview-active');
    button.title = active ? 'Düzenle' : 'Önizle';
    button.setAttribute('aria-label', button.title);
  }, true);
  window.addEventListener('hashchange', () => { syncAboutClass(); markAboutLanguagePairs(); ensureAboutMobileMenu(); syncAboutToolbarLayout(); });
  syncAboutClass();
  const adminObserver = new MutationObserver(() => {
    syncNativeSaveStatus();
    markAboutLanguagePairs();
    ensureAboutMobileMenu();
    bindAboutPreviewToggle();
    syncAboutToolbarLayout();
  });
  window.addEventListener('resize', () => {
    ensureAboutMobileMenu();
    syncAboutToolbarLayout();
    requestAnimationFrame(() => { ensureAboutMobileMenu(); syncAboutToolbarLayout(); });
  });
  adminObserver.observe(document.body, {childList:true, subtree:true, characterData:true});
  if (window.ResizeObserver) {
    const footer = document.getElementById('cms-status');
    const syncFooterHeight = () => {
      document.documentElement.style.setProperty('--cms-footer-height', Math.ceil(footer.getBoundingClientRect().height) + 'px');
      syncAboutToolbarLayout();
    };
    new ResizeObserver(syncFooterHeight).observe(footer);
    syncFooterHeight();
  }
  markAboutLanguagePairs();
  ensureAboutMobileMenu();
  syncNativeSaveStatus();
  bindAboutPreviewToggle();
  syncAboutToolbarLayout();
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
