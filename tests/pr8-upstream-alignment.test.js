const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { enhancedIndex } = require('../src/static-enhancements');

const publicDir = path.join(__dirname, '..', 'public');

test('production shell loads all PR8 browser layers', () => {
  const html = enhancedIndex();
  assert.match(html, /\/pr8\.css\?v=1/);
  assert.match(html, /\/pr8\.js\?v=1/);
  assert.match(html, /\/pr8-fixes\.js\?v=1/);
});

test('service worker caches the complete PR8 browser shell', () => {
  const source = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  assert.match(source, /\/pr8\.css\?v=1/);
  assert.match(source, /\/pr8\.js\?v=1/);
  assert.match(source, /\/pr8-fixes\.js\?v=1/);
});
