const assert = require('node:assert/strict');
const {test} = require('node:test');
const T = require('../../public/js/content-tools.js');
test('image and code settings survive serialization; arbitrary markup is data', () => {
  for (const [kind, value] of [
    ['image', {src:'/media/test.png', width:37, unit:'%', align:'right', alt:'<svg/onload=x>', caption:'Caption', crop:'none'}],
    ['code', {code:'  <script>x()</script>\n\t```end\n', language:'html', wrap:true}]
  ]) {
    const saved = T.serialize(kind, value);
    assert.deepEqual(JSON.parse(saved.split('\n')[1]), value);
    assert(!saved.includes('<script>'));
  }
  assert.throws(() => T.serialize('image', {src:'javascript:alert(1)'}));
  assert.throws(() => T.serialize('image', {src:'/media/a.png', width:101}));
  assert.throws(() => T.serialize('code', {language:'"><svg>'}));
});
test('highlighting preserves exact source', () => {
  const code = 'const x = "<script>";\n\t// comment\nreturn 42;\n';
  for (const language of T.languages) assert.equal(T.tokens(code, language).map(t => t.text).join(''), code);
});
test('legacy Markdown and typed block source round-trip without rewriting', () => {
  const legacy = '# Başlık\n\nParagraf **bold** ve https://example.test/link.\n';
  assert.equal(T.serializeDocument(T.parseDocument(legacy)), legacy);
  const image = '```cms-image\r\n{ "src": "/media/a.png", "width": 37, "unit": "%", "align": "right", "alt": "a", "caption": "", "crop": "none" }\r\n```';
  const source = 'Önce\n\n' + image + '\n\nSonra';
  assert.equal(T.serializeDocument(T.parseDocument(source)), source);
});
test('an empty image draft remains editable until preSave validation', () => {
  const draft = T.serializeDraft('image', {src:'', alt:'', caption:'', width:64, unit:'%', align:'right', crop:'none'});
  const [image] = T.parseDocument(draft);
  assert.equal(image.type, 'image');
  assert.equal(image.value.src, '');
  assert.equal(image.value.width, 64);
  assert.throws(() => T.validate('image', image.value), /görsel seçin/);
});
test('image width limits and value types stay strict across serialization', () => {
  for (const [unit, widths] of [['%', [1, 100]], ['px', [1, 4096]]]) {
    for (const width of widths) {
      const source = T.serialize('image', {src:'/media/a.png', width, unit});
      const [block] = T.parseDocument(source);
      assert.equal(block.value.width, width);
      assert.equal(block.value.unit, unit);
      assert.doesNotThrow(() => T.validate('image', JSON.parse(source.split('\n')[1])));
    }
  }
  for (const unit of ['%', 'px']) {
    for (const width of [0, -1, unit === '%' ? 101 : 4097, 1.5, '100', '', null, false, NaN, Infinity]) {
      assert.throws(() => T.validate('image', {src:'/media/a.png', width, unit}), /Görsel genişliği/);
    }
  }
  assert.throws(() => T.validate('image', {src:'/media/a.png',width:100,unit:''}), /birim/);
  assert.throws(() => T.validate('image', {src:'',width:100,unit:'%'}), /görsel seçin/);
  assert.equal(T.validate('image', {src:'/media/a.png'}).width, 100);
});
test('invalid image settings remain typed and repairable only in editor drafts', () => {
  for (const value of [{src:'/media/a.png',width:'100',unit:'%'},
    {src:'/media/a.png',width:'',unit:'%'}, {src:'/media/a.png',width:100,unit:''},
    {src:'/media/a.png',width:101,unit:'%'}]) {
    const source = T.serializeDraft('image', value);
    const [block] = T.parseDocument(source, {draft:true});
    assert.equal(block.type, 'image');
    assert.deepEqual(block.value, value);
    assert.equal(T.serializeDocument([block]), source);
    assert.throws(() => T.validate('image', block.value));
    assert.equal(T.parseDocument(source)[0].type, 'text');
  }
});
test('ordered text, image and code blocks remain ordered across insertion and movement', () => {
  const image = {src:'/media/a.png', alt:'A', caption:'', width:37, unit:'%', align:'right', crop:'none'};
  const code = {code:'  const x = 1;\n\treturn x;\n', language:'javascript', wrap:false};
  let blocks = [
    {type:'text', value:'# First\n\n'},
    {type:'image', value:image},
    {type:'text', value:'\n\nSecond\n\n'},
    {type:'code', value:code},
    {type:'image', value:{...image, src:'/media/b.png', width:480, unit:'px', align:'center'}}
  ];
  let source = T.serializeDocument(blocks);
  let parsed = T.parseDocument(source);
  assert.deepEqual(parsed.map(block => block.type), ['text','image','text','code','image']);
  assert.equal(parsed[1].value.width, 37);
  assert.equal(parsed[1].value.align, 'right');
  assert.equal(parsed[3].value.code, code.code);
  assert.equal(parsed[4].value.width, 480);
  [blocks[2], blocks[3]] = [blocks[3], blocks[2]];
  parsed = T.parseDocument(T.serializeDocument(blocks));
  assert.deepEqual(parsed.map(block => block.type), ['text','image','code','text','image']);
  assert.equal(parsed[2].value.code, code.code);
});
test('copy success and failure are visible', async () => {
  const button = {};
  await T.copy('  a\n', button, {clipboard:{writeText:async text => assert.equal(text, '  a\n')}});
  assert.equal(button.textContent, 'Kopyalandı');
  await T.copy('a', button, {clipboard:{writeText:async () => {throw Error('denied');}}});
  assert.match(button.textContent, /Kopyalanamadı/);
});
test('upload checks size, extension and file signature', async () => {
  const png = (width, height) => {
    const bytes = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
    for (const value of [width, height]) bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
    return bytes;
  };
  const file = (name, bytes, type = '') => new File([new Uint8Array(bytes)], name, {type});
  assert.equal(await T.validateFile(file('evil name.PNG',png(320, 200), 'image/png')), 'png');
  await assert.rejects(T.validateFile(file('x.svg',[1])), /PNG/);
  await assert.rejects(T.validateFile(file('x.png',[1,2,3])), /eşleşmiyor/);
  await assert.rejects(T.validateFile(file('x.png',png(320, 200), 'image/jpeg')), /MIME/);
  await assert.rejects(T.validateFile(file('x.png',png(8193, 1), 'image/png')), /güvenli sınırı/);
  await assert.rejects(T.validateFile(file('x.png',png(7000, 7000), 'image/png')), /güvenli sınırı/);
  await assert.rejects(T.validateFile({name:'x.png',size:11*1024*1024}), /10 MiB/);
});
