'use strict';

// Everything on disk, in ~/.terminal-messages (MSG_HOME overrides):
//   config.json   your name, this machine's id, the relay, maxshell set-up
//   rooms.json    rooms you're in: { name: { code } }
//   inbox/*.jsonl every message the listener has received, one file per room
//   read.json     how many of each inbox you've seen in a chat
//   shells.json   maxshell sessions to notify: { pid: tty }
//   chats.json    chats open right now: { pid: topic }
// JSON files are replaced atomically, since several processes share them.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { topicFor, DEFAULT_SERVER } = require('./room');

function dir() {
  return process.env.MSG_HOME || path.join(os.homedir(), '.terminal-messages');
}

function file(name) {
  return path.join(dir(), name);
}

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function writeJSON(name, value) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file(name));
}

function update(name, fallback, fn) {
  const value = readJSON(name, fallback);
  const result = fn(value);
  writeJSON(name, value);
  return result;
}

// --- config ------------------------------------------------------------------

function config() {
  const c = readJSON('config.json', {});
  if (!c.machine) {
    c.machine = crypto.randomBytes(6).toString('hex');
    c.name = c.name || os.userInfo().username;
    writeJSON('config.json', c);
  }
  return c;
}

function setConfig(changes) {
  config();
  update('config.json', {}, (c) => Object.assign(c, changes));
}

function server() {
  return process.env.MSG_SERVER || config().server || DEFAULT_SERVER;
}

// --- rooms -------------------------------------------------------------------

function rooms() {
  return readJSON('rooms.json', {});
}

// Adds a room under `name` (or name-2, name-3… if taken by another code);
// returns the name it got.
function addRoom(name, code) {
  return update('rooms.json', {}, (all) => {
    for (const [n, r] of Object.entries(all)) if (r.code === code) return n;
    let final = name;
    for (let i = 2; all[final]; i++) final = `${name}-${i}`;
    all[final] = { code };
    return final;
  });
}

function removeRoom(name) {
  return update('rooms.json', {}, (all) => {
    if (!all[name]) return false;
    delete all[name];
    return true;
  });
}

// Deletes what this machine kept of a room: its inbox and read count.
function forgetRoom(topic) {
  try { fs.unlinkSync(inboxFile(topic)); } catch { /* none kept */ }
  update('read.json', {}, (r) => { delete r[topic]; });
}

function roomByTopic(topic) {
  for (const [name, r] of Object.entries(rooms())) if (topicFor(r.code) === topic) return { name, ...r };
  return null;
}

// --- inboxes -----------------------------------------------------------------

function inboxFile(topic) {
  return path.join(dir(), 'inbox', `${topic}.jsonl`);
}

function append(topic, entry) {
  fs.mkdirSync(path.dirname(inboxFile(topic)), { recursive: true });
  fs.appendFileSync(inboxFile(topic), `${JSON.stringify(entry)}\n`);
}

function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn write */ }
  }
  return out;
}

function inbox(topic) {
  try { return parse(fs.readFileSync(inboxFile(topic), 'utf8')); } catch { return []; }
}

// A message counts toward unread if someone else wrote it.
function isMine(entry, machine = config().machine) {
  return String(entry.cid || '').startsWith(`${machine}.`);
}

function counts(entry, machine) {
  return !entry.event && !isMine(entry, machine);
}

function markRead(topic, n) {
  update('read.json', {}, (r) => { r[topic] = n; });
}

function unread(topic) {
  const all = inbox(topic);
  const seen = readJSON('read.json', {})[topic] || 0;
  const { machine } = config();
  return all.slice(seen).filter((e) => counts(e, machine));
}

// --- maxshell sessions and open chats ---------------------------------------

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function shells() {
  return readJSON('shells.json', {});
}

function registerShell(pid, tty) {
  update('shells.json', {}, (all) => {
    for (const p of Object.keys(all)) if (!alive(p)) delete all[p];
    all[pid] = tty;
  });
}

function forgetShell(pid) {
  update('shells.json', {}, (all) => { delete all[pid]; });
}

function openChat(pid, topic) {
  update('chats.json', {}, (all) => {
    for (const p of Object.keys(all)) if (!alive(p)) delete all[p];
    all[pid] = topic;
  });
}

function closeChat(pid) {
  update('chats.json', {}, (all) => { delete all[pid]; });
}

function chatOpen(topic) {
  return Object.entries(readJSON('chats.json', {})).some(([p, t]) => t === topic && alive(p));
}

module.exports = {
  dir, file, readJSON, writeJSON, config, setConfig, server,
  rooms, addRoom, removeRoom, forgetRoom, roomByTopic,
  inboxFile, append, inbox, parse, isMine, counts, markRead, unread,
  alive, shells, registerShell, forgetShell, openChat, closeChat, chatOpen,
};
