#!/usr/bin/env node
'use strict';

// msg — chat between terminals on any network. See README.md.

const path = require('path');

const store = require('./lib/store');
const style = require('./lib/style');
const room = require('./lib/room');
const listener = require('./lib/listener');
const maxshell = require('./lib/maxshell');

const ENTRY = __filename;
const SUBCOMMANDS = ['new', 'join', 'ls', 'send', 'code', 'rm', 'remove', 'leave', 'name', 'install', 'uninstall', 'help'];

const HELP = `msg — chat between terminals, on any network

  msg new [ROOM]          start a room and get a code to share
  msg join CODE [ROOM]    join a room from its code
  msg [ROOM]              open a room (the last one, if no name)
  msg ls                  your rooms and what's unread
  msg send ROOM TEXT…     send without opening the chat
  msg code [ROOM]         show a room's code again
  msg rm ROOM             remove a room and its history (also: leave)
  msg name [NAME]         see or change the name others see
  msg install             set up maxshell (done for you the first time)
  msg uninstall           undo that

In a chat: /code shows the code, /quit (or Ctrl-D) leaves.
Messages are encrypted with the room code before they leave your machine.
`;

const out = (s) => process.stdout.write(s);
const fail = (s) => { process.stderr.write(`msg: ${s}\n`); process.exit(1); };
const muted = (s) => style.color('muted', s);

function pickRoom(name) {
  const rooms = store.rooms();
  if (name) {
    if (!rooms[name]) fail(`no room called ${name} — msg ls lists yours`);
    return name;
  }
  const { last } = store.config();
  if (last && rooms[last]) return last;
  const names = Object.keys(rooms);
  if (names.length === 1) return names[0];
  if (!names.length) { out(HELP); process.exit(0); }
  fail('which room? msg ls lists them');
}

// A room name that isn't also a subcommand, so `msg NAME` always opens it.
function roomName(wanted, code) {
  const n = room.slug(wanted) || room.nameFromCode(code);
  return SUBCOMMANDS.includes(n) ? `${n}-room` : n;
}

function shareLine(code) {
  return `${muted('others join with:')}  ${style.bold(`msg join ${code}`)}\n`;
}

function openChat(name) {
  listener.ensure(ENTRY);
  require('./lib/chat').chat(name);
}

// First run inside maxshell: set it up, once, and say what changed.
function autoInstall() {
  const c = store.config();
  if (c.maxshell || !maxshell.present()) return;
  const done = maxshell.install(ENTRY);
  store.setConfig({ maxshell: 'on' });
  if (done.length) out(muted(`✓ set up for maxshell: ${done.join('; ')} (msg uninstall undoes it)\n`));
}

// From ~/.maxshellrc as each maxshell starts: register the session for
// notifications, make sure the listener runs, and mention anything unread.
function hook(pid) {
  if (!pid || !store.alive(pid)) return;
  const rooms = store.rooms();
  if (!Object.keys(rooms).length) return;
  const tty = listener.ttyOf(pid);
  if (tty) store.registerShell(pid, tty);
  listener.ensure(ENTRY);
  const waiting = Object.entries(rooms)
    .map(([n, r]) => [n, store.unread(room.topicFor(r.code)).length])
    .filter(([, k]) => k);
  if (waiting.length) {
    out(`${style.color('accent', '✉')} ${waiting.map(([n, k]) => `${k} unread in ${style.bold(n)}`).join(', ')}${muted(`  msg ${waiting[0][0]}`)}\n`);
  }
}

function list() {
  const rooms = store.rooms();
  const names = Object.keys(rooms);
  if (!names.length) { out(muted('no rooms yet — msg new starts one, msg join CODE joins one\n')); return; }
  const { last } = store.config();
  for (const n of names) {
    const topic = room.topicFor(rooms[n].code);
    const unread = store.unread(topic).length;
    const inbox = store.inbox(topic).filter((e) => !e.event);
    const latest = inbox[inbox.length - 1];
    const tail = latest ? muted(`  ${style.clean(latest.from, 24)}: ${style.cut(style.clean(latest.text), 40)}`) : muted('  no messages yet');
    const badge = unread ? style.color('accent', ` ${unread} new`) : '';
    out(`${n === last ? style.color('accent', '❯') : ' '} ${style.bold(n)}${badge}${tail}\n`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === '--listen') { listener.listen(); return; }
  if (cmd === '--hook') { hook(Number(args[0])); return; }
  if (!process.stdout.isTTY) style.setEnabled(false);
  if (cmd !== 'install' && cmd !== 'uninstall') autoInstall();

  switch (cmd) {
    case 'help': case '-h': case '--help':
      out(HELP);
      return;

    case 'new': {
      const code = room.newCode(args[0] || 'room');
      const name = store.addRoom(roomName(args[0], code), code);
      out(`${style.color('ok', '✓')} room ${style.bold(name)} — ${shareLine(code)}`);
      openChat(name);
      return;
    }

    case 'join': {
      const code = (args[0] || '').trim();
      if (!code) fail('usage: msg join CODE [ROOM]');
      const name = store.addRoom(roomName(args[1], code), code);
      out(`${style.color('ok', '✓')} joined ${style.bold(name)}\n`);
      openChat(name);
      return;
    }

    case 'ls':
      list();
      listener.ensure(ENTRY);
      return;

    case 'send': {
      const name = pickRoom(args[0]);
      const text = args.slice(1).join(' ').trim();
      if (!text) fail('usage: msg send ROOM TEXT…');
      const { machine, name: me } = store.config();
      try {
        await room.publish(store.server(), store.rooms()[name].code, { t: Date.now() / 1000, from: me, text, cid: `${machine}.${process.pid}` });
      } catch (e) { fail(`not sent: ${e.message}`); }
      listener.ensure(ENTRY);
      return;
    }

    case 'code': {
      const name = pickRoom(args[0]);
      out(shareLine(store.rooms()[name].code));
      return;
    }

    case 'rm': case 'remove': case 'leave': {
      const name = args[0];
      if (!name) fail(`usage: msg ${cmd} ROOM`);
      const r = store.rooms()[name];
      if (!r) fail(`no room called ${name} — msg ls lists yours`);
      // Say goodbye first; a room you can't reach is still removed.
      const { machine, name: me } = store.config();
      await room.publish(store.server(), r.code, { t: Date.now() / 1000, from: me, text: 'left', cid: `${machine}.${process.pid}`, event: true }).catch(() => {});
      store.removeRoom(name);
      store.forgetRoom(room.topicFor(r.code));
      if (store.config().last === name) store.setConfig({ last: undefined });
      out(`${style.color('ok', '✓')} removed ${style.bold(name)}\n`);
      return;
    }

    case 'name': {
      if (!args.length) { out(`${store.config().name}\n`); return; }
      const name = style.clean(args.join(' '), 24).trim();
      if (!name) fail('that name is empty');
      store.setConfig({ name });
      out(`others now see you as ${style.bold(name)}\n`);
      return;
    }

    case 'install': {
      const done = maxshell.install(ENTRY);
      store.setConfig({ maxshell: maxshell.present() ? 'on' : undefined });
      for (const d of done) out(`✓ ${d}\n`);
      const where = maxshell.linkPath();
      out(`${style.color('ok', '✓')} msg is installed: ${where.replace(require('os').homedir(), '~')} → ${maxshell.target(ENTRY)}\n`);
      if (maxshell.present()) out(muted('open a new terminal window to use it and get notifications\n'));
      else if (!maxshell.onPath()) out(muted(`add ${require('path').dirname(where)} to your PATH to run msg from anywhere\n`));
      return;
    }

    case 'uninstall': {
      const done = maxshell.uninstall();
      store.setConfig({ maxshell: 'off' });
      out(done.length ? `${done.map((d) => `✓ ${d}`).join('\n')}\n` : 'nothing to undo\n');
      out(muted(`msg is no longer on your PATH; to put it back run ${path.join(path.dirname(maxshell.target(ENTRY)), 'install.sh')}\n`));
      return;
    }

    case undefined:
      openChat(pickRoom());
      return;

    default:
      if (cmd.startsWith('-')) fail(`unknown option ${cmd} — msg help`);
      openChat(pickRoom(cmd));
  }
}

main().catch((e) => fail(e.message));
