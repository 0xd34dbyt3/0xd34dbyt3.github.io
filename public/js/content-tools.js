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
    const acceptedMime = {png:['image/png'], jpg:['image/jpeg'], jpeg:['image/jpeg'], gif:['image/gif'], webp:['image/webp']};
    if (file.type && !acceptedMime[ext].includes(file.type.toLowerCase())) throw Error('Dosya MIME türü uzantıyla eşleşmiyor.');
    const b = new Uint8Array(await file.arrayBuffer());
    const start = (...bytes) => bytes.every((v, i) => b[i] === v);
    const valid = ext === 'png' ? start(137,80,78,71,13,10,26,10) :
      ['jpg','jpeg'].includes(ext) ? start(255,216,255) :
      ext === 'gif' ? [ 'GIF87a', 'GIF89a' ].includes(String.fromCharCode(...b.slice(0,6))) :
      String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP';
    if (!valid) throw Error('Dosya içeriği görsel türüyle eşleşmiyor.');
    const dimensions = imageDimensions(b, ext);
    if (!dimensions || !dimensions.every(Boolean)) throw Error('Görsel boyut bilgisi okunamadı.');
    const [width, height] = dimensions;
    if (width > 8192 || height > 8192 || width * height > 40000000) throw Error('Görsel ölçüleri güvenli sınırı aşıyor.');
    return ext;
  }
  function imageDimensions(b, ext) {
    const u16le = i => b[i] | (b[i + 1] << 8);
    const u16be = i => (b[i] << 8) | b[i + 1];
    const u24le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    const u32be = i => ((b[i] * 0x1000000) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]);
    if (ext === 'png' && b.length >= 24) return [u32be(16), u32be(20)];
    if (ext === 'gif' && b.length >= 10) return [u16le(6), u16le(8)];
    if ((ext === 'jpg' || ext === 'jpeg') && b.length >= 4) {
      const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        while (i < b.length && b[i] === 0xff) i++;
        if (i >= b.length) break;
        const marker = b[i++];
        if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 2 > b.length) break;
        const length = u16be(i);
        if (length < 2 || i + length > b.length) break;
        if (sof.has(marker) && length >= 7) return [u16be(i + 5), u16be(i + 3)];
        i += length;
      }
      return null;
    }
    if (ext === 'webp' && b.length >= 30) {
      const kind = String.fromCharCode(...b.slice(12,16));
      if (kind === 'VP8X') return [1 + u24le(24), 1 + u24le(27)];
      if (kind === 'VP8L' && b[20] === 0x2f) return [1 + (b[21] | ((b[22] & 0x3f) << 8)), 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10))];
      if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return [u16le(26) & 0x3fff, u16le(28) & 0x3fff];
    }
    return null;
  }
  const api = {languages, validate, safeImage, serialize, serializeDraft, parseDocument, serializeDocument, newBlock, tokens, copy, enhance, validateFile, imageDimensions};
  if (typeof module !== 'undefined') module.exports = api;
  root.ContentTools = api;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => enhance(root.document));
    else enhance(root.document);
  }
})(typeof window === 'undefined' ? globalThis : window);
