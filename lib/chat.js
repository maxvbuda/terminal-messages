'use strict';

// The chat itself: recent messages, then a prompt. New messages from the
// listener's inbox appear above what you're typing.

const fs = require('fs');
const readline = require('readline');

const store = require('./store');
const style = require('./style');
const { topicFor, publish } = require('./room');

const HISTORY = 20;

function chat(roomName, { quiet = false } = {}) {
  const room = store.rooms()[roomName];
  const topic = topicFor(room.code);
  const { machine, name } = store.config();
  const cid = `${machine}.${process.pid}`;
  const out = process.stdout;

  store.openChat(process.pid, topic);
  store.setConfig({ last: roomName });

  const past = store.inbox(topic);
  if (!quiet) {
    out.write(`${style.color('muted', `── ${roomName} as ${name} · /code shares it · /quit leaves ──`)}\n`);
  }
  for (const e of past.slice(-HISTORY)) out.write(`${style.line(e)}\n`);
  let shown = past.length;
  store.markRead(topic, shown);

  const rl = readline.createInterface({ input: process.stdin, output: out, prompt: style.color('accent', '❯ ') });

  const above = (text) => {
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
    out.write(`${text}\n`);
    rl.prompt(true);
  };

  const send = (text, event = false) => {
    const entry = { t: Date.now() / 1000, from: name, text, cid };
    if (event) entry.event = true;
    return publish(store.server(), room.code, entry).then(() => entry, (e) => {
      above(style.color('err', `not sent (${e.message}): ${text}`));
      return null;
    });
  };

  // The listener appends; pick up whatever is new.
  const poll = () => {
    const all = store.inbox(topic);
    for (const e of all.slice(shown)) if (e.cid !== cid) above(style.line(e));
    if (all.length !== shown) { shown = all.length; store.markRead(topic, shown); }
  };
  fs.mkdirSync(require('path').dirname(store.inboxFile(topic)), { recursive: true });
  const timer = setInterval(poll, 250);

  let leaving = false;
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    clearInterval(timer);
    store.closeChat(process.pid);
    rl.close();
    await send('left', true);
    process.exit(0);
  };

  rl.on('line', (raw) => {
    const text = raw.trim();
    // Replace the typed line with the message as everyone sees it.
    readline.moveCursor(out, 0, -1);
    readline.clearLine(out, 0);
    if (text === '/quit' || text === '/exit') { leave(); return; }
    if (text === '/code') {
      out.write(`${style.color('muted', 'others join with:')} ${style.bold(`msg join ${room.code}`)}\n`);
    } else if (text) {
      const entry = { t: Date.now() / 1000, from: name, text, cid };
      out.write(`${style.line(entry)}\n`);
      send(text);
    }
    rl.prompt();
  });
  rl.on('SIGINT', leave);
  rl.on('close', leave);

  send('joined', true);
  rl.prompt();
}

module.exports = { chat };
