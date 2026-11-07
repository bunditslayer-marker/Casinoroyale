// The name "Marker" belongs to the founder. Anyone who types it needs the secret code.
//
// The code itself is NOT written anywhere in this project — only a scrambled version
// (a one-way scrypt hash). Even if someone reads this file, they can't work out the code.
//
// To change the code: on Render, open your service → Environment → add a variable
// called OWNER_CODE with your new code as its value. That replaces the one below.

const crypto = require('crypto');

const RESERVED = ['marker'];

const STORED = {
  salt: '6e80fdda35e570db6c07ada1abd41ccc',
  hash: '0ef651d5ea7b677f35b1e32254a9c615adf5ad91624cdef3ef794744248917dc',
};

const SCRYPT = { N: 16384, r: 8, p: 1 };
const scramble = (code, salt) => crypto.scryptSync(String(code), Buffer.from(salt, 'hex'), 32, SCRYPT);

const secret = process.env.OWNER_CODE
  ? (() => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: scramble(process.env.OWNER_CODE, salt).toString('hex') }; })()
  : STORED;

function verifyOwnerCode(code) {
  if (typeof code !== 'string' || !code || code.length > 100) return false;
  const attempt = scramble(code.trim(), secret.salt);
  return crypto.timingSafeEqual(attempt, Buffer.from(secret.hash, 'hex'));
}

// Catch lookalikes too: "MARKER", "Mark3r", "M a r k e r", "Marker2", letters from other alphabets.
const LOOKALIKE = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'к': 'k', 'м': 'm', 'т': 't', 'х': 'x', 'у': 'y', // Cyrillic
  'α': 'a', 'ε': 'e', 'κ': 'k', 'μ': 'm', 'ρ': 'r', 'ο': 'o', // Greek
};
function isReservedName(name) {
  const flat = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .split('')
    .map((ch) => LOOKALIKE[ch] || ch)
    .join('')
    .replace(/[^a-z]/g, '');
  return RESERVED.some((r) => flat.includes(r));
}

// Stop people guessing the code over and over: 5 wrong tries, then a 10-minute wait.
const attempts = new Map(); // key -> { count, until }
const MAX_TRIES = 5;
const LOCK_MS = 10 * 60 * 1000;

function checkOwner(key, code) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now) return { ok: false, locked: true };
  if (verifyOwnerCode(code)) { attempts.delete(key); return { ok: true }; }
  const lockExpired = a && a.until && a.until <= now;
  const count = (a && !lockExpired ? a.count : 0) + 1;
  const until = count >= MAX_TRIES ? now + LOCK_MS : 0;
  attempts.set(key, { count, until });
  return { ok: false, locked: until > 0 };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until && a.until < now) attempts.delete(k);
}, 15 * 60 * 1000).unref();

module.exports = { isReservedName, checkOwner, verifyOwnerCode };
