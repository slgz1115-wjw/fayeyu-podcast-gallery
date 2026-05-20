'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const KEY = crypto.randomBytes(32).toString('hex');
process.env.MURMUR_ENCRYPTION_KEY = KEY;
delete require.cache[require.resolve('../../lib/crypto')];
const { encryptApiKey, decryptApiKey, generateMasterKey } = require('../../lib/crypto');

test('encryptApiKey returns iv:ciphertext:tag format', () => {
  const out = encryptApiKey('sk-test-1234');
  assert.match(out, /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
});

test('decryptApiKey reverses encryptApiKey', () => {
  const original = 'sk-deepseek-abcdef1234567890';
  const encrypted = encryptApiKey(original);
  const decrypted = decryptApiKey(encrypted);
  assert.equal(decrypted, original);
});

test('encryptApiKey same input → different ciphertext (random IV)', () => {
  const a = encryptApiKey('sk-foo');
  const b = encryptApiKey('sk-foo');
  assert.notEqual(a, b);
});

test('decryptApiKey returns null for empty/null input (no crash)', () => {
  assert.equal(decryptApiKey(''), null);
  assert.equal(decryptApiKey(null), null);
  assert.equal(decryptApiKey(undefined), null);
});

test('decryptApiKey returns null for malformed input', () => {
  assert.equal(decryptApiKey('not-valid'), null);
  assert.equal(decryptApiKey('aa:bb'), null);
});

test('decryptApiKey returns null for wrong tag (tampered ciphertext)', () => {
  const encrypted = encryptApiKey('sk-test');
  const [iv, ct, tag] = encrypted.split(':');
  const tamperedTag = tag.replace(/./, c => c === '0' ? '1' : '0');
  assert.equal(decryptApiKey(`${iv}:${ct}:${tamperedTag}`), null);
});

test('generateMasterKey returns 64-char hex', () => {
  const k = generateMasterKey();
  assert.match(k, /^[a-f0-9]{64}$/);
});

test('encryptApiKey throws if MURMUR_ENCRYPTION_KEY not set', () => {
  delete process.env.MURMUR_ENCRYPTION_KEY;
  delete require.cache[require.resolve('../../lib/crypto')];
  const { encryptApiKey: e } = require('../../lib/crypto');
  assert.throws(() => e('sk-x'), /MURMUR_ENCRYPTION_KEY/);
  process.env.MURMUR_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../../lib/crypto')];
});
