'use strict';

// Rooms and the relay. A room is identified only by its code: the code picks
// the ntfy topic and the encryption keys, so the relay (ntfy.sh by default)
// only ever sees ciphertext on a topic name nobody can guess.

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DEFAULT_SERVER = 'https://ntfy.sh';
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function derive(label, code) {
  return crypto.createHash('sha256').update(`terminal-messages/${label}/${code}`).digest();
}

function topicFor(code) {
  return `tm-${derive('topic', code).toString('hex').slice(0, 32)}`;
}

// HMAC-SHA256 in counter mode as the stream cipher, then HMAC over
// nonce + ciphertext (encrypt-then-MAC). Only the standard library needed.
function keystream(key, nonce, n) {
  const blocks = [];
  for (let i = 0; i * 32 < n; i++) {
    const ctr = Buffer.alloc(8);
    ctr.writeBigUInt64BE(BigInt(i));
    blocks.push(crypto.createHmac('sha256', key).update(Buffer.concat([nonce, ctr])).digest());
  }
  return Buffer.concat(blocks).subarray(0, n);
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function seal(code, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  const nonce = crypto.randomBytes(16);
  const ct = xor(data, keystream(derive('enc', code), nonce, data.length));
  const tag = crypto.createHmac('sha256', derive('mac', code)).update(Buffer.concat([nonce, ct])).digest().subarray(0, 16);
  return Buffer.concat([nonce, tag, ct]).toString('base64');
}

// The message, or null if it wasn't sealed with this code.
function open(code, text) {
  try {
    const raw = Buffer.from(String(text), 'base64');
    if (raw.length < 32) return null;
    const nonce = raw.subarray(0, 16);
    const tag = raw.subarray(16, 32);
    const ct = raw.subarray(32);
    const want = crypto.createHmac('sha256', derive('mac', code)).update(Buffer.concat([nonce, ct])).digest().subarray(0, 16);
    if (!crypto.timingSafeEqual(tag, want)) return null;
    const obj = JSON.parse(xor(ct, keystream(derive('enc', code), nonce, ct.length)).toString());
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// "work-k3n9x7qp2mfa": the room's name, then 60 random bits — the secret.
function newCode(name) {
  const bytes = crypto.randomBytes(12);
  const secret = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${slug(name) || 'room'}-${secret}`;
}

function nameFromCode(code) {
  const m = /^([a-z0-9-]+)-[a-z0-9]{8,}$/.exec(code);
  return m ? m[1] : 'room';
}

// --- the relay (ntfy's HTTP API) -------------------------------------------

function client(url) {
  return url.startsWith('https:') ? https : http;
}

function request(url, { method = 'GET', body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = client(url).request(url, { method, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${data.trim().slice(0, 200)}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function base(server) {
  return String(server || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function publish(server, code, obj) {
  await request(`${base(server)}/${topicFor(code)}`, { method: 'POST', body: seal(code, obj) });
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

// Everything the relay still holds for these topics (ntfy.sh keeps 12 hours).
async function history(server, topics, since = 'all') {
  const text = await request(`${base(server)}/${topics.join(',')}/json?poll=1&since=${since}`);
  return parseLines(text).filter((e) => e.event === 'message');
}

// Streams new events; calls onEvent for each message and onClose once when the
// connection ends for any reason. Returns a function that closes it.
function subscribe(server, topics, since, onEvent, onClose) {
  let closed = false;
  const done = (err) => { if (!closed) { closed = true; onClose(err); } };
  // ntfy sends a keepalive every 45s; silence for longer means a dead link.
  const req = client(base(server)).get(`${base(server)}/${topics.join(',')}/json?since=${since}`, { timeout: 100000 }, (res) => {
    if (res.statusCode >= 400) { res.resume(); done(new Error(`relay said ${res.statusCode}`)); return; }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const e = JSON.parse(line);
          if (e.event === 'message') onEvent(e);
        } catch { /* not JSON */ }
      }
    });
    res.on('end', () => done());
    res.on('error', done);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', done);
  return () => { closed = true; req.destroy(); };
}

module.exports = {
  DEFAULT_SERVER, topicFor, seal, open, newCode, nameFromCode, slug, publish, history, subscribe,
};
