/* Shared typed-block contract and safe DOM enhancement. No HTML from code text. */
(function (root) {
  'use strict';
  const languages = ['text', 'python', 'javascript', 'typescript', 'bash', 'json', 'html', 'css', 'sql', 'yaml', 'c', 'cpp', 'java', 'go', 'rust'];
  function validate(kind, value) {
    const defaults = kind === 'image'
      ? {src: '', alt: '', caption: '', width: 100, unit: '%', align: 'center', crop: 'none'}
      : {code: '', language: 'text', wrap: false};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !(k in defaults))) throw Error('Bilinmeyen blok alanı.');
    const d = {...defaults, ...value};
    if (kind === 'image') {
      if (['src', 'alt', 'caption'].some(k => typeof d[k] !== 'string') ||
          !d.src || !['px', '%'].includes(d.unit) || !['left', 'center', 'right'].includes(d.align) ||
          !['none', 'square', 'wide'].includes(d.crop) || !Number.isInteger(d.width) ||
          d.width < 1 || d.width > (d.unit === '%' ? 100 : 4096)) throw Error('Görsel genişliği % için 1–100, px için 1–4096 olmalı.');
      safeImage(d.src);
    } else if (typeof d.code !== 'string' || !languages.includes(d.language) || typeof d.wrap !== 'boolean') throw Error('Kod bloğu ayarları geçersiz.');
    return d;
  }
  function safeImage(src, allowBlob = false) {
    if (allowBlob && /^blob:/.test(src)) return src;
    if (/[\u0000-\u0020\\]/.test(src) || src.startsWith('//') ||
        /(^|\/)\.\.(\/|$)/.test(decodeURIComponent(src)) ||
        (/^[a-z][\w+.-]*:/i.test(src) && !src.startsWith('https://'))) throw Error('Güvenli görsel adresi kullanın.');
    return src;
  }
  function serialize(kind, value) {
    return serializeDraft(kind, validate(kind, value));
  }
  function serializeDraft(kind, value) {
    // Editing may temporarily clear required fields. Keep that draft editable;
    // preview and preSave validate it before any HTML or repository write.
    return '```cms-' + kind + '\n' + JSON.stringify(value).replace(/</g, '\\u003c').replace(/`/g, '\\u0060') + '\n```';
  }
  function newBlock(type) {
    if (type === 'text') return {key: crypto.randomUUID(), type, value: ''};
    if (type === 'image') return {key: crypto.randomUUID(), type, value: {src: '', alt: '', caption: '', width: 100, unit: '%', align: 'center', crop: 'none'}, raw: null};
    if (type === 'code') return {key: crypto.randomUUID(), type, value: {code: '', language: 'text', wrap: false}, raw: null};
    throw Error('Bilinmeyen içerik bloğu.');
  }
  function parseDocument(source) {
    source = typeof source === 'string' ? source : '';
    const blocks = [];
    const pattern = /^```cms-(image|code)\r?\n([^\r\n]+)\r?\n```$/gm;
    const matches = [];
    for (const match of source.matchAll(pattern)) {
      try {
        const parsed = JSON.parse(match[2]);
        // Empty image sources are a valid in-progress editor draft. Keep the typed
        // block editable until preSave can report the missing upload without loss.
        const draftImage = match[1] === 'image' && parsed && parsed.src === '';
        const value = draftImage ? {...validate('image', {...parsed, src:'/draft-image'}), src:''} : validate(match[1], parsed);
        matches.push({match, value});
      }
      catch { /* Keep malformed legacy text unchanged for visible repair. */ }
    }
    let cursor = 0;
    for (const {match, value} of matches) {
      const leading = source.slice(cursor, match.index);
      if (leading && !/^\s*$/.test(leading)) blocks.push({key: crypto.randomUUID(), type: 'text', value:leading});
      blocks.push({key: crypto.randomUUID(), type: match[1], value, raw:match[0], leading:/^\s*$/.test(leading) ? leading : ''});
      cursor = match.index + match[0].length;
    }
    const trailing = source.slice(cursor);
    if (trailing && /^\s*$/.test(trailing) && blocks.length && blocks[blocks.length - 1].type !== 'text') blocks[blocks.length - 1].trailing = trailing;
    else if (trailing || !blocks.length) blocks.push({key: crypto.randomUUID(), type: 'text', value:trailing});
    return blocks;
  }
  function serializeDocument(blocks) {
    let result = '';
    blocks.forEach((block, index) => {
      let value = block.type === 'text' ? String(block.value ?? '') : (block.leading || '') + (block.raw || serializeDraft(block.type, block.value || {})) + (block.trailing || '');
      const previous = blocks[index - 1];
      const next = blocks[index + 1];
      if (index && previous.type !== 'text' && block.type !== 'text' && !result.endsWith('\n') && !value.startsWith('\n')) result += '\n\n';
      if (index && previous.type === 'text' && block.type !== 'text' && result && !result.endsWith('\n') && !value.startsWith('\n')) result += '\n\n';
      if (index && previous.type !== 'text' && block.type === 'text' && value && !value.startsWith('\n')) value = '\n\n' + value;
      result += value;
      if (block.type !== 'text' && next && next.type !== 'text' && !result.endsWith('\n')) result += '\n\n';
      if (block.type !== 'text' && next && next.type === 'text' && next.value && !next.value.startsWith('\n')) result += '\n\n';
    });
    return result;
  }
  function tokens(code, language) {
    if (language === 'text') return [{text: code}];
    // Small conservative lexer: preserves every character; never interprets markup.
    const regex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|\b(import|from|def|class|return|if|else|elif|for|while|const|let|var|function|async|await|new|true|false|null|None|True|False|try|catch|throw|public|private|int|void|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|fn|func|package|use)\b|\b(\d+(?:\.\d+)?)\b/g;
    let previous = 0;
    const result = [];
    for (const m of code.matchAll(regex)) {
      if (m.index > previous) result.push({text: code.slice(previous, m.index)});
      result.push({text: m[0], type: m[1] ? 'string' : m[2] ? 'comment' : m[3] ? 'keyword' : 'number'});
      previous = m.index + m[0].length;
    }
    result.push({text: code.slice(previous)});
    return result;
  }
  async function copy(code, button, navigatorObject = root.navigator) {
    try {
      await navigatorObject.clipboard.writeText(code);
      button.textContent = 'Kopyalandı';
    } catch {
      button.textContent = 'Kopyalanamadı; kodu seçin';
    }
  }
  function enhance(scope) {
    scope.querySelectorAll('.markdown-content pre > code').forEach(code => {
      const pre = code.parentElement;
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = 'true';
      const language = (code.className.match(/language-([\w+-]+)/) || [,'text'])[1];
      const raw = code.textContent;
      const doc = code.ownerDocument;
      const bar = doc.createElement('div');
      bar.className = 'code-toolbar';
      const label = doc.createElement('span');
      label.textContent = language;
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = 'Kopyala';
      button.setAttribute('aria-live', 'polite');
      button.addEventListener('click', () => copy(raw, button));
      bar.append(label, button);
      pre.before(bar);
      code.replaceChildren(...tokens(raw, language).map(t => {
        const span = doc.createElement('span');
        if (t.type) span.className = 'tok-' + t.type;
        span.textContent = t.text;
        return span;
      }));
    });
  }
  async function validateFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) throw Error('Yalnızca PNG, JPEG, GIF veya WebP yükleyin.');
    if (!file.size || file.size > 10 * 1024 * 1024) throw Error('Görsel boş olmamalı ve 10 MiB sınırını aşmamalı.');
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const start = (...bytes) => bytes.every((v, i) => b[i] === v);
    const valid = ext === 'png' ? start(137,80,78,71,13,10,26,10) :
      ['jpg','jpeg'].includes(ext) ? start(255,216,255) :
      ext === 'gif' ? [ 'GIF87a', 'GIF89a' ].includes(String.fromCharCode(...b.slice(0,6))) :
      String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP';
    if (!valid) throw Error('Dosya içeriği görsel türüyle eşleşmiyor.');
    return ext;
  }
  const api = {languages, validate, safeImage, serialize, serializeDraft, parseDocument, serializeDocument, newBlock, tokens, copy, enhance, validateFile};
  if (typeof module !== 'undefined') module.exports = api;
  root.ContentTools = api;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => enhance(root.document));
    else enhance(root.document);
  }
})(typeof window === 'undefined' ? globalThis : window);
