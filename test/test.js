'use strict';

// node test/test.js — everything runs against a fake relay in temp folders.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-')));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
process.env.HOME = path.join(scratch, 'home');
process.env.MSG_HOME = path.join(scratch, 'state');
process.env.NO_COLOR = '1';
delete process.env.FORCE_COLOR;
fs.mkdirSync(process.env.HOME);

const room = require('../lib/room');
const store = require('../lib/store');
const style = require('../lib/style');
const maxshell = require('../lib/maxshell');
const listener = require('../lib/listener');
const fakeNtfy = require('./fake-ntfy');

const MSG = path.join(__dirname, '..', 'msg');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
// Runs msg without blocking, since the fake relay lives in this process.
const runMsg = (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [MSG, ...args], { env: process.env });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (c) => { stdout += c; });
  p.stderr.on('data', (c) => { stderr += c; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const until = async (what, fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// --- rooms and crypto --------------------------------------------------------

test('a sealed message opens only with its own code', () => {
  const sealed = room.seal('work-abcdefgh2345', { text: 'hi' });
  assert.deepStrictEqual(room.open('work-abcdefgh2345', sealed), { text: 'hi' });
  assert.strictEqual(room.open('work-abcdefgh2346', sealed), null);
  assert.ok(!sealed.includes('hi'));
});

test('tampered messages are rejected', () => {
  const raw = Buffer.from(room.seal('c', { text: 'pay 10' }), 'base64');
  raw[raw.length - 2] ^= 1;
  assert.strictEqual(room.open('c', raw.toString('base64')), null);
  assert.strictEqual(room.open('c', 'not base64 at all!'), null);
});

test('long messages round-trip (more than one keystream block)', () => {
  const text = 'x'.repeat(5000);
  assert.strictEqual(room.open('k', room.seal('k', { text })).text, text);
});

test('codes carry the room name and a random secret; topics hide both', () => {
  const code = room.newCode('Book Club!');
  assert.match(code, /^book-club-[a-z2-9]{12}$/);
  assert.strictEqual(room.nameFromCode(code), 'book-club');
  assert.notStrictEqual(room.newCode('x'), room.newCode('x'));
  assert.ok(!room.topicFor(code).includes('book'));
  assert.strictEqual(room.topicFor(code), room.topicFor(code));
});

test('the protocol matches the original Python version', () => {
  // Same derivation: sha256("terminal-messages/topic/<code>"), first 32 hex.
  const want = `tm-${require('crypto').createHash('sha256').update('terminal-messages/topic/abc').digest('hex').slice(0, 32)}`;
  assert.strictEqual(room.topicFor('abc'), want);
});

// --- display -------------------------------------------------------------------

test('escape sequences from other people are neutralised', () => {
  const line = style.line({ t: 0, from: 'eve\x1b[2J', text: 'hi\x1b]0;pwned\x07\rthere' });
  assert.ok(!/[\x00-\x1f]/.test(line), JSON.stringify(line));
});

test('a notification always fits the terminal width', () => {
  for (const cols of [20, 40, 80, 200]) {
    const n = style.notice({ t: 0, from: 'alice', text: '🎉 '.repeat(100) }, 'work', cols);
    assert.ok(style.width(n) <= cols - 1, `${cols}: ${style.width(n)}`);
  }
});

test('notifications go above the prompt and put the cursor back', () => {
  const seq = listener.insertAbove(['a', 'b']);
  assert.ok(seq.includes('\x1b7') && seq.includes('\x1b8\x1b[2B'));
  assert.ok(seq.includes('\x1b[2L'));
});

// --- store ---------------------------------------------------------------------

test('rooms get unique names; joining twice keeps one', () => {
  assert.strictEqual(store.addRoom('work', 'work-aaaaaaaaaaaa'), 'work');
  assert.strictEqual(store.addRoom('work', 'work-bbbbbbbbbbbb'), 'work-2');
  assert.strictEqual(store.addRoom('other', 'work-aaaaaaaaaaaa'), 'work');
  store.removeRoom('work');
  store.removeRoom('work-2');
  assert.deepStrictEqual(store.rooms(), {});
});

test('unread counts other people’s messages after what you read', () => {
  const { machine } = store.config();
  const t = 'tm-unread';
  store.append(t, { id: '1', t: 1, from: 'me', text: 'mine', cid: `${machine}.1` });
  store.append(t, { id: '2', t: 2, from: 'bo', text: 'one', cid: 'other.1' });
  store.append(t, { id: '3', t: 3, from: 'bo', text: 'joined', cid: 'other.1', event: true });
  assert.strictEqual(store.unread(t).length, 1);
  store.markRead(t, 3);
  store.append(t, { id: '4', t: 4, from: 'bo', text: 'two', cid: 'other.1' });
  assert.deepStrictEqual(store.unread(t).map((e) => e.text), ['two']);
});

// --- maxshell set-up -----------------------------------------------------------

test('without maxshell, install only links msg', () => {
  const done = maxshell.install(MSG);
  assert.ok(fs.lstatSync(path.join(process.env.HOME, '.local', 'bin', 'msg')).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.maxshellrc')));
  assert.ok(done.some((d) => d.startsWith('linked')));
});

test('with maxshell, install links msg and adds the hook once; uninstall undoes it', () => {
  fs.mkdirSync(path.join(process.env.HOME, '.maxshell', 'bin'), { recursive: true });
  const rc = path.join(process.env.HOME, '.maxshellrc');
  fs.writeFileSync(rc, 'alias ll="ls -l"\n');
  maxshell.install(MSG);
  maxshell.install(MSG);
  const text = fs.readFileSync(rc, 'utf8');
  assert.strictEqual(text.split(maxshell.BEGIN).length, 2);
  assert.ok(text.startsWith('alias ll="ls -l"\n'));
  assert.strictEqual(fs.realpathSync(path.join(process.env.HOME, '.maxshell', 'bin', 'msg')), fs.realpathSync(MSG));
  maxshell.uninstall();
  assert.strictEqual(fs.readFileSync(rc, 'utf8'), 'alias ll="ls -l"\n');
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.maxshell', 'bin', 'msg')));
});

test('install never replaces a file of yours', () => {
  const mine = path.join(process.env.HOME, '.maxshell', 'bin', 'msg');
  fs.writeFileSync(mine, '#!/bin/sh\necho mine\n');
  const done = maxshell.install(MSG);
  assert.ok(done.some((d) => d.includes('alone')));
  assert.strictEqual(fs.readFileSync(mine, 'utf8'), '#!/bin/sh\necho mine\n');
  fs.unlinkSync(mine);
  maxshell.uninstall();
});

test('the first run inside maxshell sets it up by itself, and only once', () => {
  store.setConfig({ maxshell: undefined });
  const run = () => spawnSync(process.execPath, [MSG, 'ls'], { encoding: 'utf8', env: process.env });
  assert.match(run().stdout, /set up for maxshell/);
  assert.ok(maxshell.installed());
  assert.doesNotMatch(run().stdout, /set up for maxshell/);
  spawnSync(process.execPath, [MSG, 'uninstall'], { env: process.env });
  assert.doesNotMatch(run().stdout, /set up for maxshell/, 'stays off after uninstall');
});

test('the rc hook runs in maxshell, if it is installed here', () => {
  const src = style.maxshellSrc();
  if (!src) return;
  const shellBin = path.join(src, '..', 'bin', 'maxshell.js');
  const r = spawnSync(process.execPath, [shellBin, '-c', maxshell.BLOCK], {
    encoding: 'utf8', env: { ...process.env, MAXSHELL_SETUP: '0', PATH: `${path.dirname(MSG)}:${process.env.PATH}` },
  });
  assert.strictEqual(r.status, 0, r.stderr);
});

// --- end to end, through a relay -----------------------------------------------

test('two people chat; the listener files messages and sends works', async () => {
  const relay = await fakeNtfy.start();
  process.env.MSG_SERVER = relay.url;
  try {
    const code = room.newCode('team');
    const name = store.addRoom('team', code);
    const topic = room.topicFor(code);

    // A message from before we were listening is caught up on.
    await room.publish(relay.url, code, { t: 1, from: 'bo', text: 'earlier', cid: 'bo.1' });
    const l = spawn(process.execPath, [MSG, '--listen'], { env: process.env, stdio: 'ignore' });
    try {
      await until('catch-up', () => store.inbox(topic).some((e) => e.text === 'earlier'));

      // Live messages, in both directions.
      await room.publish(relay.url, code, { t: 2, from: 'bo', text: 'live one', cid: 'bo.1' });
      await until('live message', () => store.inbox(topic).some((e) => e.text === 'live one'));
      const sent = await runMsg('send', name, 'hello', 'bo');
      assert.strictEqual(sent.status, 0, sent.stderr);
      await until('own message', () => store.inbox(topic).some((e) => e.text === 'hello bo'));
      assert.ok(store.isMine(store.inbox(topic).find((e) => e.text === 'hello bo')));

      // Relay only ever saw ciphertext, and nothing was filed twice.
      assert.ok(relay.topics.get(topic).every((m) => !m.message.includes('hello')));
      assert.strictEqual(store.inbox(topic).length, 3);

      // A room joined while running is picked up without a restart.
      const code2 = room.newCode('later');
      await room.publish(relay.url, code2, { t: 3, from: 'cy', text: 'were you there?', cid: 'cy.1' });
      store.addRoom('later', code2);
      await until('new room', () => store.inbox(room.topicFor(code2)).length === 1);

      const ls = await runMsg('ls');
      assert.match(ls.stdout, /team 2 new/);
      assert.match(ls.stdout, /later 1 new/);

      // Removing a room says goodbye, then forgets it and its history here.
      const rm = await runMsg('rm', 'later');
      assert.strictEqual(rm.status, 0, rm.stderr);
      assert.ok(!store.rooms().later);
      assert.ok(!fs.existsSync(store.inboxFile(room.topicFor(code2))));
      assert.ok(room.open(code2, relay.topics.get(room.topicFor(code2)).slice(-1)[0].message).event);
      assert.notStrictEqual((await runMsg('rm', 'later')).status, 0);
      assert.match((await runMsg('ls')).stdout, /team/);
    } finally {
      l.kill();
    }
  } finally {
    relay.close();
    delete process.env.MSG_SERVER;
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${name}\n  ${e.stack.split('\n').slice(0, 3).join('\n  ')}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
