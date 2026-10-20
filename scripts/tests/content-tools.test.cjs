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
test('copy success and failure are visible', async () => {
  const button = {};
  await T.copy('  a\n', button, {clipboard:{writeText:async text => assert.equal(text, '  a\n')}});
  assert.equal(button.textContent, 'Kopyalandı');
  await T.copy('a', button, {clipboard:{writeText:async () => {throw Error('denied');}}});
  assert.match(button.textContent, /Kopyalanamadı/);
});
test('upload checks size, extension and file signature', async () => {
  const file = (name, bytes) => new File([new Uint8Array(bytes)], name);
  assert.equal(await T.validateFile(file('evil name.PNG',[137,80,78,71,13,10,26,10])), 'png');
  await assert.rejects(T.validateFile(file('x.svg',[1])), /PNG/);
  await assert.rejects(T.validateFile(file('x.png',[1,2,3])), /eşleşmiyor/);
  await assert.rejects(T.validateFile({name:'x.png',size:11*1024*1024}), /10 MiB/);
});
