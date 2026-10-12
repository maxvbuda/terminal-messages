'use strict';

// The listener: one background process per machine (`msg --listen`). It
// stays subscribed to every room you're in, files each message in that room's
// inbox, and shows new ones above the prompt of every maxshell that asked
// (`msg --hook`, from ~/.maxshellrc) — but only while maxshell itself is in
// the foreground, so it never draws over vim or a running program. Messages
// that arrive meanwhile wait until you're back at the prompt.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const store = require('./store');
const style = require('./style');
const { topicFor, open, history, subscribe } = require('./room');

const PID_FILE = () => store.file('listener.pid');
const MAX_PENDING = 5;

function running() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), 'utf8'));
    return pid && store.alive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

// The newest change to this program's code, so a listener started before a
// `git pull` makes way for the new version.
function codeTime() {
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'msg'), ...fs.readdirSync(__dirname).map((f) => path.join(__dirname, f))];
  return Math.max(...files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
}

// Starts the listener in the background unless it's already going.
function ensure(entry) {
  const pid = running();
  if (pid) {
    let started = 0;
    try { started = fs.statSync(PID_FILE()).mtimeMs; } catch { /* just gone */ }
    if (started >= codeTime()) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    try { fs.unlinkSync(PID_FILE()); } catch { /* fine */ }
  }
  if (!Object.keys(store.rooms()).length) return;
  fs.mkdirSync(store.dir(), { recursive: true });
  const log = fs.openSync(store.file('listener.log'), 'a');
  spawn(process.execPath, [entry, '--listen'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
}

// --- the terminal side ---------------------------------------------------------

function ps(pid, fields) {
  const r = spawnSync('ps', ['-o', fields.split(',').map((f) => `${f}=`).join(','), '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// The terminal device of a process, e.g. /dev/ttys003.
function ttyOf(pid) {
  const t = ps(pid, 'tty');
  return t && t !== '??' && t !== '?' ? `/dev/${t.replace(/^\/dev\//, '')}` : null;
}

// True when the shell is what the terminal is showing (at its prompt), not a
// program it started.
function inForeground(pid) {
  const [pgid, tpgid] = ps(pid, 'pgid,tpgid').split(/\s+/).map(Number);
  return pgid > 0 && pgid === tpgid;
}

function columns(tty) {
  let fd;
  try {
    fd = fs.openSync(tty, 'r');
    const r = spawnSync('stty', ['size'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
    const cols = Number((r.stdout || '').trim().split(/\s+/)[1]);
    return cols > 10 ? cols : 80;
  } catch {
    return 80;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Puts `lines` above the line the cursor is on and puts the cursor back where
// it was, so a half-typed command is untouched — wherever the prompt is.
// Index then reverse-index n times makes sure n rows exist below the prompt
// (scrolling the screen up only if it's at the bottom); inserting n lines at
// the prompt then pushes it down into them.
function insertAbove(lines) {
  const n = lines.length;
  return `${'\x1bD'.repeat(n)}${'\x1bM'.repeat(n)}\x1b7\r\x1b[${n}L${lines.join('\r\n')}\x1b8\x1b[${n}B`;
}

function show(tty, entries) {
  const cols = columns(tty);
  let lines = entries.map(({ entry, room }) => style.notice(entry, room, cols));
  if (lines.length > MAX_PENDING) {
    const extra = lines.length - (MAX_PENDING - 1);
    lines = [...lines.slice(-(MAX_PENDING - 1)), style.color('muted', `… and ${extra} more — msg ls`)];
  }
  const fd = fs.openSync(tty, 'w');
  try { fs.writeSync(fd, insertAbove(lines)); } finally { fs.closeSync(fd); }
}

// --- the loop ----------------------------------------------------------------

function listen() {
  fs.mkdirSync(store.dir(), { recursive: true });
  if (running() && running() !== process.pid) return;
  fs.writeFileSync(PID_FILE(), String(process.pid));
  const quit = () => {
    try { if (Number(fs.readFileSync(PID_FILE(), 'utf8')) === process.pid) fs.unlinkSync(PID_FILE()); } catch { /* gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);

  const { machine } = store.config();
  const seen = new Set();
  let latest = 0;
  for (const r of Object.values(store.rooms())) {
    for (const e of store.inbox(topicFor(r.code))) {
      seen.add(e.id);
      latest = Math.max(latest, e.t_relay || 0);
    }
  }

  const pending = new Map(); // shell pid → [{ entry, room }]
  let known = new Set(); // topics already caught up
  let close = null;
  let generation = 0;

  function receive(ev, live) {
    if (!ev.id || seen.has(ev.id)) return;
    const room = store.roomByTopic(ev.topic);
    if (!room) return;
    const msg = open(room.code, ev.message);
    if (!msg) return;
    seen.add(ev.id);
    latest = Math.max(latest, ev.time || 0);
    const entry = {
      id: ev.id, t_relay: ev.time, t: Number(msg.t) || ev.time, from: msg.from, text: msg.text, cid: msg.cid,
    };
    if (msg.event) entry.event = true;
    store.append(ev.topic, entry);
    if (live && store.counts(entry, machine) && !store.chatOpen(ev.topic)) {
      for (const pid of Object.keys(store.shells())) {
        if (!pending.has(pid)) pending.set(pid, []);
        pending.get(pid).push({ entry, room: room.name });
      }
      deliver();
    }
  }

  async function connect() {
    const gen = ++generation;
    if (close) { close(); close = null; }
    const rooms = Object.values(store.rooms());
    if (!rooms.length) quit();
    const topics = rooms.map((r) => topicFor(r.code));

    // A room just joined: catch up on what the relay still holds, quietly.
    const fresh = topics.filter((t) => !known.has(t));
    if (fresh.length) {
      try {
        for (const ev of await history(store.server(), fresh)) receive(ev, false);
        for (const t of fresh) known.add(t);
      } catch (e) {
        console.error(`${new Date().toISOString()} catch-up failed: ${e.message}`);
        setTimeout(() => { if (gen === generation) connect(); }, 5000);
        return;
      }
    }
    if (gen !== generation) return;
    const since = latest ? latest - 1 : 'all';
    known = new Set(topics);
    close = subscribe(store.server(), topics, since, (ev) => receive(ev, true), (err) => {
      if (err) console.error(`${new Date().toISOString()} ${err.message}`);
      if (gen === generation) setTimeout(() => { if (gen === generation) connect(); }, 2000);
    });
  }

  function deliver() {
    const shells = store.shells();
    for (const [pid, list] of pending) {
      if (!shells[pid] || !store.alive(pid)) { pending.delete(pid); continue; }
      if (!list.length || !inForeground(pid)) continue;
      try {
        show(shells[pid], list);
      } catch (e) {
        console.error(`${new Date().toISOString()} can't write to ${shells[pid]}: ${e.message}`);
      }
      pending.delete(pid);
    }
  }

  fs.watchFile(store.file('rooms.json'), { interval: 1000 }, () => connect());
  setInterval(deliver, 1000);
  connect();
}

module.exports = { ensure, listen, running, ttyOf, inForeground, insertAbove, show };
