'use strict';

// Hooking into maxshell, from outside it: maxshell puts ~/.maxshell/bin first
// on PATH in every session and runs ~/.maxshellrc at start-up, so `msg` goes
// in the first and a line registering the session for notifications in the
// second. Nothing in maxshell itself changes, and `msg uninstall` undoes it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BEGIN = '# >>> terminal-messages >>>';
const END = '# <<< terminal-messages <<<';
const BLOCK = `${BEGIN}
# New messages show up above the prompt. Remove with: msg uninstall
command -v msg >/dev/null && msg --hook $$
${END}
`;

const home = () => os.homedir();
const binDir = () => path.join(home(), '.maxshell', 'bin');
const rcFile = () => path.join(home(), '.maxshellrc');
const localBin = () => path.join(home(), '.local', 'bin');

function present() {
  return fs.existsSync(binDir());
}

function readRc() {
  try { return fs.readFileSync(rcFile(), 'utf8'); } catch { return ''; }
}

function installed() {
  return readRc().includes(BEGIN);
}

// Points `link` at `target` unless something else of the user's is there.
function link(target, linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return `left ${linkPath} alone (not a link)`;
    if (fs.readlinkSync(linkPath) === target) return null;
    fs.unlinkSync(linkPath);
  } catch { /* nothing there */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  return `linked ${linkPath.replace(home(), '~')}`;
}

// Returns what it did, as short sentences.
function install(entry) {
  const done = [];
  const target = fs.realpathSync(entry);
  if (present()) {
    const l = link(target, path.join(binDir(), 'msg'));
    if (l) done.push(l);
    if (!installed()) {
      const rc = readRc();
      fs.writeFileSync(rcFile(), `${rc}${rc && !rc.endsWith('\n') ? '\n' : ''}${rc ? '\n' : ''}${BLOCK}`);
      done.push('added the notification hook to ~/.maxshellrc');
    }
  } else {
    const l = link(target, path.join(localBin(), 'msg'));
    if (l) done.push(l);
    if (!(process.env.PATH || '').split(':').includes(localBin())) done.push('add ~/.local/bin to your PATH to run msg from anywhere');
  }
  return done;
}

function uninstall() {
  const done = [];
  for (const l of [path.join(binDir(), 'msg'), path.join(localBin(), 'msg')]) {
    try {
      if (fs.lstatSync(l).isSymbolicLink() && /terminal-messages/.test(fs.readlinkSync(l))) {
        fs.unlinkSync(l);
        done.push(`removed ${l.replace(home(), '~')}`);
      }
    } catch { /* not there */ }
  }
  const rc = readRc();
  const start = rc.indexOf(BEGIN);
  const end = rc.indexOf(END);
  if (start >= 0 && end > start) {
    let after = end + END.length;
    if (rc[after] === '\n') after++;
    let before = start;
    if (before > 0 && rc.slice(before - 2, before) === '\n\n') before--;
    fs.writeFileSync(rcFile(), rc.slice(0, before) + rc.slice(after));
    done.push('removed the hook from ~/.maxshellrc');
  }
  return done;
}

module.exports = { present, installed, install, uninstall, BLOCK, BEGIN, END };
