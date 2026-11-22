# superself

`self` on your own machine: sign in to [Superself](https://superselfs.com) in the browser, then read and write the
issues and notes of your workspace from the terminal.

Superself itself runs in the cloud. This repository holds only what runs on your machine, and it is also where
you report problems with Superself: open an issue in [Issues](https://github.com/fxylabs/superself/issues).

The `superself` package up to 0.13.1 was a different, open-source CLI. It is archived at
[fxylabs/superself-runtime](https://github.com/fxylabs/superself-runtime).

## Install

Node.js 20 or later. From the first 1.0 release on:

```sh
npm install -g superself
```

## Sign in

```sh
self login
```

The browser opens the Superself sign-in. Pick the workspace `self` should work on; the terminal says when you are
signed in. On a machine without a browser, `self login --no-browser` prints the address to open instead.

- The tokens are kept in the OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on
  Linux) under the service name `superself`, and nowhere else.
- The sign-in renews itself. After 180 days, or when you disconnect `self` in Superself's settings, run
  `self login` again.
- `self logout` revokes the sign-in at the server and deletes it from the keychain.
- `self workspace switch` opens the browser to pick another workspace.

## Commands

```
self login [--server <origin>] [--no-browser]
self logout [--server <origin>]
self workspace show
self workspace switch

self issue add "<summary>" [--body <text>] [--criteria <text>…] [--project <slug>|none]
self issue show <issue>
self issue list [--state backlog|todo|started|blocked|done|canceled|open] [--project <slug>|none] [--all] [--after <cursor>] [--limit <n>]
self issue todo <issue>
self issue start <issue>
self issue block <issue> --on decision|dependency|external --why <text>
self issue done <issue> [--evidence <commit>…]
self issue cancel <issue> --resolution <slug>
self issue cover <issue> --criterion <cN> --why <text> [--evidence <commit>…] [--work <issue>]
self issue comment <issue> "<text>"
self issue evidence <issue> <commit> [<commit>…]
self issue link <issue> member-of|supersedes|relates|duplicate-of|blocks <issue>
self issue prioritize <issue> urgent|high|medium|low|none
self issue assign <issue> me|<email>|none
self issue move <issue> <slug>|none

self note add "<summary>" [--label <label>…] [--body <text>] [--private] [--project <slug>|none]
self note show <note>
self note list [--label <label>] [--project <slug>|none] [--status proposed|confirmed|superseded|retracted|undone] [--all] [--after <cursor>] [--limit <n>]
self note supersede <note> "<summary>" [--label <label>…] [--body <text>] [--private] [--project <slug>|none]
self note retract <note>
self note place <note> [--exposure full|index|search] [--priority <n>|none]

self record show <issue>|<note>
self record search <words>… [--kind document|issue] [--label <label>] [--project <slug>|none] [--all] [--after <cursor>] [--limit <n>]
self record undo <seq>|<issue>|<note>
```

`self help` prints the same list with a line on each command. Every write prints the command that takes it back
(`undo: self record undo <seq>`).

Exit codes: `0` done, `2` the command line was wrong, `3` the server refused or you are not signed in, `4` the
server could not be reached.

## Servers

`self` talks to `https://app.superselfs.com` unless told otherwise. `--server <origin>` on any command, or the
`SUPERSELF_SERVER` environment variable, names another; `self login --server <origin>` also makes it the default.
Settings that are not secret (the server, its sign-in metadata, the client id) are in
`~/.config/superself/config.json` (`%APPDATA%\superself` on Windows, `$XDG_CONFIG_HOME/superself` when set).

## Development

```sh
pnpm install
pnpm build
node dist/self.mjs help
```

`self` signs in through the OAuth 2.1 authorization server of the workspace's MCP server (discovery, dynamic client
registration, PKCE, a loopback redirect) and runs each command as one call to that server's tool of the same name
(`self issue add` is `issue_add`).
