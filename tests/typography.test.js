const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { enhancedIndex } = require('../src/static-enhancements');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function declarationsFor(css, selector) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(value => value.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return '';
}

function fontSizeFor(css, selector) {
  const match = declarationsFor(css, selector).match(/font-size\s*:\s*([\d.]+)px/);
  return match ? Number(match[1]) : 0;
}

test('production loads the typography layer after every existing stylesheet', () => {
  const html = enhancedIndex();
  assert.match(html, /typography\.css\?v=1/);
  assert.ok(html.indexOf('pr9-cleanup.css?v=2') < html.indexOf('typography.css?v=1'));
});

test('typography keeps social content and controls at readable sizes', () => {
  const css = read('public/typography.css');
  const minimumSizes = {
    body: 16,
    '.sidebar nav button': 14,
    '.bottom-nav button': 11,
    '.button': 14,
    label: 13,
    input: 16,
    '.post-body': 16,
    '.comment p': 14,
    '.person-card p': 14,
    '.profile-bio': 15,
    '.profile-details': 13,
    '.post-author span': 12,
    '.person-meta': 12,
    '.announcement time': 12
  };

  for (const [selector, minimum] of Object.entries(minimumSizes)) {
    assert.ok(
      fontSizeFor(css, selector) >= minimum,
      `${selector} must be at least ${minimum}px`
    );
  }
  assert.match(declarationsFor(css, '.post-body'), /line-height\s*:\s*1\.55/);
  assert.match(css, /@media\s*\(max-width:\s*530px\)/);
});

test('service worker refreshes and caches the typography stylesheet', () => {
  const worker = read('public/sw.js');
  assert.match(worker, /collegeox-v3-typography-v1/);
  assert.match(worker, /typography\.css\?v=1/);
});

test('auth typography remains contained on narrow mobile screens', () => {
  const css = read('public/typography.css');
  const card = declarationsFor(css, '.auth-form-card');
  assert.match(card, /width\s*:\s*100%/);
  assert.match(card, /max-width\s*:\s*420px/);
  assert.match(card, /min-width\s*:\s*0/);
});
