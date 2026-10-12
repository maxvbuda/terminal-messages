'use strict';

// Colours and text layout. Inside maxshell, colours come from maxshell's
// current theme (its theme.js, loaded from wherever maxshell is installed),
// so a chat looks like the rest of the shell; otherwise a built-in palette.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FALLBACK = { accent: 45, accent2: 207, muted: 244, ok: 78, err: 203, warn: 214, dir: 75 };

// maxshell's src folder, if it's installed: the login wrapper names it, or the
// `maxshell` command on PATH links to it.
function maxshellSrc() {
  const candidates = [];
  if (process.env.MAXSHELL_SRC) candidates.push(process.env.MAXSHELL_SRC);
  try {
    const wrapper = fs.readFileSync(path.join(os.homedir(), '.maxshell', 'bin', 'maxshell'), 'utf8');
    const m = /^MAXSHELL='([^']+)'/m.exec(wrapper);
    if (m) candidates.push(path.join(path.dirname(m[1]), '..', 'src'));
  } catch { /* no wrapper */ }
  const which = spawnSync('/bin/sh', ['-c', 'command -v maxshell'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    try { candidates.push(path.join(path.dirname(fs.realpathSync(which.stdout.trim())), '..', 'src')); } catch { /* broken link */ }
  }
  candidates.push(path.join(os.homedir(), 'maxshell', 'src'));
  return candidates.find((d) => fs.existsSync(path.join(d, 'theme.js'))) || null;
}

let ui = null;
function palette() {
  if (ui) return ui;
  ui = { ...FALLBACK };
  const src = maxshellSrc();
  if (src) {
    try {
      const theme = require(path.join(src, 'theme.js'));
      theme.loadSavedTheme();
      ui = { ...FALLBACK, ...theme.current().ui };
    } catch { /* an older or different maxshell: keep the fallback */ }
  }
  return ui;
}

let enabled = !process.env.NO_COLOR;
function setEnabled(on) { enabled = on; }

const paint = (code, text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const color = (role, text) => {
  const c = palette()[role];
  return paint(`38;5;${typeof c === 'number' ? c : c.c}`, text);
};
const bold = (text) => paint('1', text);

// Everyone's name keeps one colour, picked from the theme's accents.
function nameColor(name) {
  const roles = ['accent', 'accent2', 'ok', 'warn', 'dir', 'err'];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return roles[h % roles.length];
}

// Anyone with the room code can send anything; never let them drive the
// terminal with escape sequences.
function clean(text, max = 2000) {
  return String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max);
}

function charWidth(cp) {
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

function width(text) {
  let w = 0;
  for (const ch of String(text).replace(/\x1b\[[0-9;]*m/g, '')) w += charWidth(ch.codePointAt(0));
  return w;
}

// Cuts plain text to at most `max` columns, ending in … when cut.
function cut(text, max) {
  if (width(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

function clock(t) {
  return new Date(t * 1000).toTimeString().slice(0, 5);
}

// One message as a chat line.
function line(entry) {
  const name = clean(entry.from, 24) || '?';
  const text = clean(entry.text);
  if (entry.event) return color('muted', `${clock(entry.t)} * ${name} ${text}`);
  return `${color('muted', clock(entry.t))} ${bold(color(nameColor(name), name))}: ${text}`;
}

// One message as a notification above the maxshell prompt, within `cols`.
function notice(entry, room, cols) {
  const name = clean(entry.from, 24) || '?';
  const hint = `  msg ${room}`;
  const head = `✉ ${name} · ${room}  `;
  const room_ = Math.max(8, cols - 1 - width(head) - width(hint));
  const text = cut(clean(entry.text), room_);
  if (width(head) + width(text) + width(hint) > cols - 1) return cut(`✉ ${name}: ${clean(entry.text)}`, cols - 1);
  return `${color('accent', '✉')} ${bold(color(nameColor(name), name))}${color('muted', ` · ${room}`)}  ${text}${color('muted', hint)}`;
}

module.exports = { palette, maxshellSrc, setEnabled, color, bold, nameColor, clean, width, cut, line, notice };
