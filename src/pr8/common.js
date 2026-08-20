const crypto = require('node:crypto');
const { db } = require('../runtime-enhancements');

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const clean = (value, max = 500) => String(value == null ? '' : value).trim().slice(0, max);
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const json = (value, fallback = []) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function pageLimit(value, fallback = 20, max = 50) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.floor(parsed))) : fallback;
}

function cookieMap(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const parts = value.trim().split('=');
    return [decodeURIComponent(parts.shift()), decodeURIComponent(parts.join('='))];
  }));
}

async function currentUser(req) {
  const token = cookieMap(req).collegeox_session;
  if (!token) return null;
  return await db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`,
    [tokenHash(token), Date.now()]
  ) || null;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    avatar: row.avatar || '',
    accent: row.accent || '#155eef',
    department: row.department || '',
    year: row.year || '',
    profileVisibility: row.profile_visibility || 'campus'
  };
}

function send(res, status, payload) {
  const output = JSON.stringify(payload);
  if (!res.headersSent) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(output)
    });
  }
  res.end(output);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function readBody(req, maxBytes = 900000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let finished = false;
    const fail = error => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (finished) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        raw = '';
        fail(Object.assign(new Error('Request too large.'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', fail);
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw httpError(401, 'Sign in required.');
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw httpError(403, 'You do not have permission to do that.');
  return user;
}

function assertSameOrigin(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
    throw httpError(403, 'Origin rejected.');
  }
}

function encodeCursor(row) {
  const createdAt = row.created_at || row.createdAt;
  return Buffer.from(JSON.stringify({ createdAt, id: row.id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.createdAt && parsed.id) return parsed;
  } catch {}
  return null;
}

function normalizeUsername(value) {
  return clean(value, 24).toLowerCase();
}

function normalizeTag(value) {
  return clean(value, 80).replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 50);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

module.exports = {
  db,
  now,
  id,
  clean,
  json,
  pageLimit,
  cookieMap,
  currentUser,
  publicUser,
  send,
  originAllowed,
  readBody,
  httpError,
  requireUser,
  requireRole,
  assertSameOrigin,
  encodeCursor,
  decodeCursor,
  normalizeUsername,
  normalizeTag,
  bool
};