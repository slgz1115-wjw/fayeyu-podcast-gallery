'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sanity — node:test runner is wired', () => {
  assert.equal(1, 1);
});
