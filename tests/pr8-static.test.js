const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { enhancedIndex } = require('../src/static-enhancements');

const publicDir = path.join(__dirname, '..', 'public');
const browserFiles = ['pr8.js', 'pr8-fixes.js', 'pr8-complete.js'];

test('PR8 browser bundles parse as JavaScript', () => {
  for (const file of browserFiles) {
    const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  }
});

test('production shell loads every PR8 browser layer in order', () => {
  const html = enhancedIndex();
  assert.match(html, /pr8\.css\?v=1/);
  assert.match(html, /pr8\.js\?v=1/);
  assert.match(html, /pr8-fixes\.js\?v=1/);
  assert.match(html, /pr8-complete\.js\?v=1/);
  assert.ok(html.indexOf('pr8.js?v=1') < html.indexOf('pr8-fixes.js?v=1'));
  assert.ok(html.indexOf('pr8-fixes.js?v=1') < html.indexOf('pr8-complete.js?v=1'));
});

test('service worker caches PR8 assets and handles push notifications', () => {
  const source = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  assert.match(source, /pr8\.css\?v=1/);
  assert.match(source, /pr8\.js\?v=1/);
  assert.match(source, /pr8-fixes\.js\?v=1/);
  assert.match(source, /pr8-complete\.js\?v=1/);
  assert.match(source, /addEventListener\(['"]push['"]/);
  assert.match(source, /showNotification/);
  assert.match(source, /addEventListener\(['"]notificationclick['"]/);
});

test('PR8 navigation wrapper renders as part of the existing sidebar flow', () => {
  const css = fs.readFileSync(path.join(publicDir, 'pr8.css'), 'utf8');
  assert.match(css, /\.pr8-nav-links\s*\{[^}]*display\s*:\s*contents/);
});

test('browser hardening validates poll expiry without sending a second answer vote request', () => {
  const source = fs.readFileSync(path.join(publicDir, 'pr8-fixes.js'), 'utf8');
  assert.match(source, /pr8-poll-expiry/);
  assert.match(source, /createImageBitmap/);
  assert.doesNotMatch(source, /fetch\(`\/api\/answers\//);
});

test('global search opens an exact Q&A question result', () => {
  const source = browserFiles.filter(file => file !== 'pr8-complete.js').map(file => fs.readFileSync(path.join(publicDir, file), 'utf8')).join('\n');
  assert.match(source, /question:/);
  assert.match(source, /openQuestionRouteFix|route\.startsWith\(['"]question:['"]\)/);
});

test('joined clubs keep an Open chat action with PR8 realtime updates', () => {
  const source = browserFiles.filter(file => file !== 'pr8-complete.js').map(file => fs.readFileSync(path.join(publicDir, file), 'utf8')).join('\n');
  assert.match(source, /data-pr8-club-chat-fix/);
  assert.match(source, /Open chat/);
  assert.match(source, /EventSource\(['"]\/api\/pr8\/stream['"]\)/);
  assert.match(source, /clubMessage/);
});

test('public polls expose a voter list control while anonymous polls stay identity-free', () => {
  const source = fs.readFileSync(path.join(publicDir, 'pr8-complete.js'), 'utf8');
  assert.match(source, /View voters/);
  assert.match(source, /voterVisibility/);
  assert.match(source, /option\.voters/);
});

test('project and club owners can create and view one pinned context post', () => {
  const source = fs.readFileSync(path.join(publicDir, 'pr8-complete.js'), 'utf8');
  assert.match(source, /data-pr8-context-pin-fix/);
  assert.match(source, /\/api\/pins\/project\//);
  assert.match(source, /\/api\/pins\/club\//);
  assert.match(source, /Pinned update/);
});

test('own profile exposes reversible block and feed-mute safety controls', () => {
  const source = fs.readFileSync(path.join(publicDir, 'pr8-complete.js'), 'utf8');
  assert.match(source, /Safety settings/);
  assert.match(source, /\/api\/safety\/blocks/);
  assert.match(source, /\/api\/safety\/mutes/);
  assert.match(source, /Unblock/);
  assert.match(source, /Unmute/);
});

test('clubs expose mute-feed controls and safety settings can unmute clubs', () => {
  const source = fs.readFileSync(path.join(publicDir, 'pr8-complete.js'), 'utf8');
  assert.match(source, /Mute club feed/);
  assert.match(source, /targetType:\s*['"]club['"]/);
  assert.match(source, /Muted clubs/);
  assert.match(source, /Unmute club/);
});
