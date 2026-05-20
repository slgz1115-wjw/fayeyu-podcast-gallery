// lib/auth.js — bcrypt password hashing + session token mgmt + Express middleware + rate limiters.
// 2026-05-19 v0.1
'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const BCRYPT_COST = 10;

async function hashPassword(plaintext) {
  return bcrypt.hash(String(plaintext), BCRYPT_COST);
}

async function verifyPassword(plaintext, hash) {
  if (!hash) return false;
  try { return await bcrypt.compare(String(plaintext), String(hash)); }
  catch (_) { return false; }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(db, userId) {
  const token = generateToken();
  const created = Date.now();
  const expires = created + SESSION_TTL_MS;
  db.prepare(`INSERT INTO sessions (token, user_id, created, expires) VALUES (?, ?, ?, ?)`)
    .run(token, userId, created, expires);
  return token;
}

function verifyToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT user_id, expires FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.expires < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row.user_id;
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function requireUser(db) {
  return function _requireUser(req, res, next) {
    const headerToken = req.headers?.authorization?.replace(/^Bearer\s+/i, '');
    const cookieToken = req.cookies?.session;
    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ error: 'login required' });
    const userId = verifyToken(db, token);
    if (!userId) return res.status(401).json({ error: 'session expired or invalid' });
    req.user_id = userId;
    next();
  };
}

const signupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: '注册太频繁,稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试太频繁,稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  hashPassword, verifyPassword,
  generateToken, createSession, verifyToken, deleteSession,
  requireUser,
  signupRateLimit, loginRateLimit,
  SESSION_TTL_MS,
};
