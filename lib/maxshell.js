'use strict';

// Putting `msg` where shells find it, and hooking into maxshell from outside
// it. maxshell puts ~/.maxshell/bin first on PATH in every session and runs
// ~/.maxshellrc at start-up, so `msg` goes in the first and a line
// registering the session for notifications in the second. For every other
// shell (zsh, bash), `msg` is linked into a folder already on PATH, or into
// ~/.local/bin with a PATH line added to the shell's start-up file. Nothing
// in maxshell itself changes, and `msg uninstall` undoes all of it.

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
const PATH_BLOCK = `${BEGIN}
# Puts msg on your PATH. Remove with: msg uninstall
export PATH="$HOME/.local/bin:$PATH"
${END}
`;

const home = () => os.homedir();
const binDir = () => path.join(home(), '.maxshell', 'bin');
const rcFile = () => path.join(home(), '.maxshellrc');
const localBin = () => path.join(home(), '.local', 'bin');
const tilde = (p) => p.replace(home(), '~');

function present() {
  return fs.existsSync(binDir());
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function installed() {
  return read(rcFile()).includes(BEGIN);
}

function appendBlock(file, block) {
  const text = read(file);
  if (text.includes(BEGIN)) return false;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`);
  return true;
}

function removeBlock(file) {
  const text = read(file);
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return false;
  let after = end + END.length;
  if (text[after] === '\n') after++;
  let before = start;
  if (before > 0 && text.slice(before - 2, before) === '\n\n') before--;
  fs.writeFileSync(file, text.slice(0, before) + text.slice(after));
  return true;
}

// Points `link` at `target` unless something else of the user's is there.
function link(target, linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return `left ${tilde(linkPath)} alone (not a link)`;
    if (fs.readlinkSync(linkPath) === target) return null;
    fs.unlinkSync(linkPath);
  } catch { /* nothing there */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  return `linked ${tilde(linkPath)}`;
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

const pathDirs = () => (process.env.PATH || '').split(':').filter(Boolean);

// The folder for the `msg` that every shell sees: one of these if it's on
// PATH already and we may write there, else ~/.local/bin.
function shellBin() {
  const onPath = new Set(pathDirs());
  const preferred = [localBin(), path.join(home(), 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return preferred.find((d) => onPath.has(d) && writable(d)) || localBin();
}

// The start-up file of the shell new terminal windows open, for the PATH line.
function profileFile() {
  const shell = path.basename(process.env.SHELL || '/bin/zsh');
  if (shell === 'bash') return path.join(home(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  return path.join(home(), '.zshrc');
}

function linkPath() {
  return path.join(shellBin(), 'msg');
}

function target(entry) {
  return fs.realpathSync(entry);
}

function onPath() {
  return pathDirs().includes(shellBin());
}

// Returns what it did, as short sentences.
function install(entry) {
  const done = [];
  const to = target(entry);
  const add = (s) => { if (s) done.push(s); };
  if (present()) {
    add(link(to, path.join(binDir(), 'msg')));
    if (appendBlock(rcFile(), BLOCK)) done.push('added the notification hook to ~/.maxshellrc');
  }
  const bin = shellBin();
  add(link(to, path.join(bin, 'msg')));
  if (!pathDirs().includes(bin)) {
    const profile = profileFile();
    if (appendBlock(profile, PATH_BLOCK)) done.push(`added ${tilde(bin)} to your PATH in ${tilde(profile)}`);
  }
  return done;
}

function uninstall() {
  const done = [];
  const dirs = [binDir(), localBin(), path.join(home(), 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const l of dirs.map((d) => path.join(d, 'msg'))) {
    try {
      if (fs.lstatSync(l).isSymbolicLink() && /terminal-messages/.test(fs.readlinkSync(l))) {
        fs.unlinkSync(l);
        done.push(`removed ${tilde(l)}`);
      }
    } catch { /* not there */ }
  }
  if (removeBlock(rcFile())) done.push('removed the hook from ~/.maxshellrc');
  for (const f of ['.zshrc', '.bash_profile', '.bashrc'].map((n) => path.join(home(), n))) {
    if (removeBlock(f)) done.push(`removed the PATH line from ${tilde(f)}`);
  }
  return done;
}

module.exports = {
  present, installed, install, uninstall, linkPath, target, onPath, shellBin, profileFile, BLOCK, PATH_BLOCK, BEGIN, END,
};
