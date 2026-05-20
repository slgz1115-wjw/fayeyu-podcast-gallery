// lib/crypto.js — AES-256-GCM for user API key at-rest encryption.
// 2026-05-19 v0.1
// Master key in env MURMUR_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// Format on disk: <iv-hex>:<ciphertext-hex>:<auth-tag-hex>

'use strict';

const crypto = require('node:crypto');

function getMasterKey() {
  const hex = process.env.MURMUR_ENCRYPTION_KEY;
  if (!hex) throw new Error('MURMUR_ENCRYPTION_KEY env var not set — generate with generateMasterKey() and add to pm2 env');
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('MURMUR_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return Buffer.from(hex, 'hex');
}

function encryptApiKey(plaintext) {
  if (!plaintext) return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ct = cipher.update(String(plaintext), 'utf8', 'hex');
  ct += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${ct}:${tag}`;
}

function decryptApiKey(encrypted) {
  if (!encrypted) return null;
  try {
    const parts = String(encrypted).split(':');
    if (parts.length !== 3) return null;
    const [ivHex, ctHex, tagHex] = parts;
    if (!ivHex || !ctHex || !tagHex) return null;
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let pt = decipher.update(ctHex, 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
  } catch (_) {
    return null;
  }
}

function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encryptApiKey, decryptApiKey, generateMasterKey };
