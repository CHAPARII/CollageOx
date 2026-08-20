const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production shell loads PR9 cleanup assets', () => {
  const source = read('src/static-enhancements.js');
  assert.match(source, /pr9-cleanup\.css\?v=1/);
  assert.match(source, /pr9-cleanup\.js\?v=1/);
});

test('cleanup removes messages, marketplace, and campus Q&A from visible routes', () => {
  const source = read('public/pr9-cleanup.js');
  assert.match(source, /messages/);
  assert.match(source, /marketplace/);
  assert.match(source, /qa/);
  assert.match(source, /REMOVED_ROUTES/);
  assert.match(source, /data-pr8-route/);
});

test('cleanup restores the colored profile cover', () => {
  const source = read('public/pr9-cleanup.js');
  const css = read('public/pr9-cleanup.css');
  assert.match(source, /profile-cover/);
  assert.match(source, /--accent/);
  assert.match(css, /\.profile-cover/);
  assert.match(css, /var\(--accent/);
});

test('desktop sidebar can scroll independently', () => {
  const css = read('public/pr9-cleanup.css');
  assert.match(css, /\.sidebar/);
  assert.match(css, /overflow-y\s*:\s*auto/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
});

test('service worker caches cleanup assets and no longer routes DM pushes to Messages', () => {
  const source = read('public/sw.js');
  assert.match(source, /pr9-cleanup\.css\?v=1/);
  assert.match(source, /pr9-cleanup\.js\?v=1/);
  assert.doesNotMatch(source, /dm_message'\) return '\/#messages'/);
});
