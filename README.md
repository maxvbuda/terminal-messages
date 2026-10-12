# terminal-messages

Chat between terminals on any network — your laptop at home, a friend's Mac
on café Wi-Fi — with nothing to sign up for and no server to run. If you use
[maxshell](https://github.com/maxvbuda/maxshell), new messages show up right
above your prompt.

```
~/code ❯ git sta
✉ alice · work  are you free at 3?  msg work
~/code ❯ git status
```

## Install

Needs Node.js 16 or newer.

```sh
git clone https://github.com/maxvbuda/terminal-messages
cd terminal-messages
./install.sh
```

That puts `msg` on your PATH. With maxshell, it goes in `~/.maxshell/bin`
and one line is added to `~/.maxshellrc` so new shells get notifications —
open a new terminal window after installing. (Running `./msg` straight from
the clone does the same set-up on first use.) `msg uninstall` undoes all of
it.

## Use

```sh
msg new work            # start a room; prints a code to share
msg join work-k3n9x7…   # join with the code someone sent you
msg work                # open the chat (just `msg` opens the last one)
msg ls                  # your rooms, with unread counts
msg send work on my way # send without opening the chat
msg code work           # show the code again
msg name Max            # the name others see (default: your username)
msg rm work            # remove a room and its history
```

In a chat, type and press Enter. `/code` shows the room's code, `/quit` or
Ctrl-D leaves.

## In maxshell

- Messages arrive above the prompt as they come in, even mid-command — what
  you've typed stays put.
- While a program is running (vim, a build), they wait and appear when
  you're back at the prompt.
- A new shell tells you what's unread: `✉ 2 unread in work  msg work`.
- The chat uses maxshell's current theme colours.
- Not shown while that room's chat is open somewhere on this machine.

maxshell's own full-screen tools (`edit`, `files`, `dash`…) run inside the
shell, so a message arriving while one is open is drawn over it until the
screen next redraws.

## How it works

Messages go through [ntfy.sh](https://ntfy.sh), a free public relay that
works over plain HTTPS, so it gets through any network that can browse the
web. The room code is the only secret: it picks the relay topic and the key,
and every message is encrypted and authenticated on your machine before it
leaves (HMAC-SHA256, Node's standard library only). The relay sees
ciphertext on a topic named by a hash. Anyone who has the code can read and
post, so share it like a password.

A small background process (`msg --listen`, one per machine) stays
subscribed to your rooms and keeps an inbox for each in
`~/.terminal-messages`; it stops when you've left every room. The relay
holds messages for 12 hours, so you catch up on what you missed when you
come back online.

- `MSG_SERVER=https://ntfy.example.com` (or `"server"` in
  `~/.terminal-messages/config.json`) uses your own ntfy server. Everyone in
  a room must use the same one.
- ntfy.sh limits how much each address can send without an account
  (a few hundred messages a day) — plenty for chat, but self-host for more.

## Tests

```sh
npm test
```

They run against a fake relay in temporary folders.
