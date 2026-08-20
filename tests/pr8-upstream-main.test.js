const test = require('node:test');
const assert = require('node:assert/strict');

const VERIFIED_UPSTREAM_MAIN = '16bf8f214d4c29ab3b6796d105aa4414f6bd49af';

test('PR8 verification baseline records a full Git SHA', () => {
  assert.match(VERIFIED_UPSTREAM_MAIN, /^[0-9a-f]{40}$/);
});
