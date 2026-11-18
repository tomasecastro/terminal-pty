# terminal-pty — a local terminal for OpenCode, with an assistant that asks first

**English** · [Español](./README.es.md)

An OpenCode plugin that gives the assistant a real terminal to work with: it **opens its own shell**
on your machine, lets the assistant **read** it and, if you allow it, **run commands** in it.

Nothing happens without your permission. Reading and writing are separate capabilities, both closed
by default, granted per session, revocable at any moment, and gone when you close OpenCode.

---

## What it does

| Capability | Tools | Default |
|---|---|---|
| **Open / close** | `terminal_open`, `terminal_kill` | free |
| **Read** | `terminal_pty_read_terminal`, `terminal_pty_terminal_info`, `terminal_pty_wait_for_prompt` | closed |
| **Write** | `terminal_pty_execute_command` — runs a command you approved | closed |
| **Permissions** | `terminal_pty_access_grant`, `terminal_pty_access_status`, `terminal_pty_access_revoke` | — |
| **Visible terminal** | the side panel in OpenCode Desktop, and a palette command that opens it | free |

The plugin does **not** borrow a terminal from OpenCode. It spawns its own shell inside a PTY
(`node-pty`) and owns both ends of it, so writing does not depend on the host exposing
`experimental.terminal.write`. The host terminal is still used, but only as a **read-only fallback**
when the native binding cannot be loaded.

The same shell is drawn in OpenCode Desktop: a **Terminal** tab in the session's side panel, opened
from the **+** button next to the panel tabs or from the palette. You type in it, the assistant reads
it, and what it runs appears in the same screen. See *The visible terminal* below.

The shell runs with your user, your environment and your privileges. There is no sandbox: what
protects you is the permission gate, not a container. When you type a password into that shell, the
assistant never sees it: while a credential prompt is on screen, every read returns withheld text and
every execution is blocked.

## Requirements

- **OpenCode 2.2.x** (desktop or TUI). The plugin only needs `experimental.terminal.read` from the
  host, which every current build exposes.
- **`@lydell/node-pty` 1.2.0-beta.18**, installed next to your OpenCode config (see *Install*). It
  ships prebuilt binaries for `win32-x64`, `darwin-arm64/x64` and `linux-x64/arm64`, so no compiler
  is needed.
- A **Bun 1.4 or newer** runtime. OpenCode 2.2.7 embeds Bun 1.4.4, which is what the plugin was
  verified against.

  Verified on 2026-11-12: with Bun **1.3.14** on Windows, `node-pty` starts the shell and delivers
  its output, but writing into the ConPTY input pipe fails with `ERR_SOCKET_CLOSED`. The plugin
  survives that: it loads, reports `engine: host-read-only` and keeps working through the host
  terminal, read-only. Writing needs the newer runtime.

## Architecture

```
src/index.ts        Plugin.define: builds the engine, picks read/write sources, logs the mode
src/tools.ts        the 9 tools; only adapters, no decisions
src/gui/index.ts    the gui-experimental bundle: panel, keyboard, right-panel button
lib/gui/protocol.ts the RPC contract between the panel and the PTY (terminal-pty.panel)
lib/gui/host.ts     the RPC handlers: view, keystrokes, resize, over the plugin's PTY
lib/screen.ts       replays the PTY's cursor moves so the panel shows a readable screen
lib/terminal-keys.ts a key event → the bytes a terminal sends
lib/local-shell.ts  shell selection per platform + LocalShellConnector (PTY spawn)
lib/local-engine.ts LocalTerminal: open / kill / view / write over a SessionManager
lib/session-manager.ts  one session: buffer, credential blinding, TUI detection, audit log
lib/execution-flow.ts   fail-closed guards for reading and running
lib/access.ts       read/write capabilities, per session, process scope
lib/pty-host.ts     lazy `node-pty` binding
script/build-gui.ts builds gui-experimental.cjs (the file the desktop evaluates)
```

Read path: PTY bytes → `BufferBroadcaster` → `snapshot()` → ANSI stripped → tool.
Write path: tool → `runCommand` guards (grant, blinding, approval) → `SessionManager.writeAi` →
PTY write. The host terminal only replaces the first path when there is no local session.

Human path: keystroke → `lib/terminal-keys.ts` → RPC `terminal-pty.panel.write` →
`SessionManager.writeHuman` → PTY write. Same PTY, different door, no approval, nothing logged.

### How a command is submitted

A PTY carries a terminal line discipline, not a file. **ConPTY does not translate LF to CR**: writing
`\n` inserts a line in the PSReadLine buffer (the `>>` continuation prompt) instead of running the
command. `lib/enter.ts` is the only place that decides:

| Target | Terminator |
|---|---|
| Local shell on Windows | `\r` |
| Local shell on macOS/Linux | `\n` |
| SSH session (POSIX shell on the other side) | `\n` |

The terminator is applied twice on purpose: `runCommand` hands over a terminated line, and
`SessionManager.writeAi` re-normalizes it for the session, so no caller can reintroduce the bug.
Human keystrokes are never rewritten: xterm sends the right bytes and the plugin writes them through.

### Why the PowerShell shells start "quiet"

PSReadLine's inline predictive IntelliSense paints a suggestion taken from the **shared PowerShell
history file** next to the prompt, in dim italic, on the first keystroke. In an AI-driven terminal that
is noise and a privacy leak: the suggestion is a command some other session ran, and it ends up in
the buffer the assistant reads. The plugin starts `pwsh`/`powershell` with
`-NoExit -Command "try { Set-PSReadLineOption -PredictionSource None } catch { }"`, which applies to
that PTY only and leaves the user's own shells untouched. `cmd.exe` is not affected.

## Install

The plugin is a directory. Two ways to register it, both configuration only — no file of OpenCode is
modified.

### Option A — folder discovery (no config)

```powershell
# Windows (global, applies to every project)
Copy-Item -Recurse .\src\opencode\.opencode\plugin\terminal-pty "$env:USERPROFILE\.config\opencode\plugin\terminal-pty"

# macOS / Linux
cp -R src/opencode/.opencode/plugin/terminal-pty ~/.config/opencode/plugin/terminal-pty
```

Then install the native binding where the plugin can resolve it:

```powershell
cd "$env:USERPROFILE\.config\opencode"
npm i @lydell/node-pty
```

Verify:

```bash
opencode plugin list
```

```
ID       VERSION  SOURCE
terminal-pty  local    C:\Users\<you>\.config\opencode\plugin\terminal-pty
```

The folder **must** be named `plugin` (singular). Older builds do not discover `plugins`.

Folder discovery passes no options, so access stays disabled. Enable it with the environment variable
described in **Configuration**.

### Option B — declare it with options (recommended)

In your `opencode.json` (or `opencode.jsonc`), add the directory to the plugin list. Use the key your
build accepts: `plugin` on 2.2.7, `plugins` on the fork.

```json
{
  "plugin": [
    {
      "package": "C:/Users/<you>/.config/opencode/plugin/terminal-pty",
      "options": {
        "access": {
          "enabled": true,
          "allowlist": ["ls", "cat", "grep", "tail"]
        }
      }
    }
  ]
}
```

The target must be a **directory**, not a file. A file target is ignored with
`configured plugin path must be a directory`.

Restart OpenCode after changing configuration. The log then shows which engine came up:

```
msg="terminal-pty plugin loaded" engine=local-pty write=true shell="C:\Program Files\PowerShell\7\pwsh.exe"
```

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `access.enabled` | boolean | `true` | Whether the assistant may **ask** for access. It never grants anything by itself: reading and writing still need your explicit, per-session approval. Set to `false` to silence it entirely |
| `access.allowlist` | string[] | `[]` | Leading commands that skip the per-command approval once write is granted |

If you install with folder discovery and cannot pass options, use the environment variable:

```powershell
$env:SSH_PTY_ACCESS = "1"   # same as access.enabled: true
```

Or declare it in the environment that starts OpenCode. The name is kept for compatibility with
earlier versions of the plugin.

## The visible terminal

In OpenCode Desktop the plugin also draws its shell. It is **the same PTY** the assistant reads and
writes: one shell, two doors.

### Open it

- **Right panel**: the **+** button before the side panel tabs lists **Terminal**. Pick it and the
  tab opens on the right, focused.
- **Command palette**: `Open terminal`. It has no default shortcut, so it cannot collide with the
  app's own; bind it in Settings › Shortcuts if you want one.

The tab is per session: it shows the shell of the session you are looking at, and it comes back when
you switch to that session again.

### Type in it

Click anywhere in the terminal and type. The default is **line mode**: the characters stay in the
local line under the screen and nothing reaches the PTY until Enter (see *Line mode and raw mode*).
In **raw mode**, what you type goes to the PTY byte for byte:

| Key | Sent |
|---|---|
| Letters, digits, symbols | the character itself, as your keyboard layout composes it |
| Enter | `\r` (the byte a Windows console expects to run a line) |
| Backspace, Tab, Escape, arrows, Home/End, PgUp/PgDn, Delete, Insert | the usual terminal sequences |
| Ctrl + letter | the control code (`Ctrl+C` → `\u0003`) |
| Alt + key | `ESC` + key; AltGr characters are typed, not turned into control codes |
| Paste | the clipboard, with every line ending normalized to `\r` (raw mode); in line mode it fills the local line |

Your keystrokes are not logged, not broadcast and not audited: they follow
`SessionManager.writeHuman`, which is the path reserved for the person in front of the screen. That is
also why they need no approval — approving your own typing would be theatre. The assistant's commands
follow the gated path, below.

### Line mode and raw mode

Every panel starts in **line mode**, and the bar above the input says so. You compose the command in
the local line; the PTY hears nothing while you type, so the shell's echo cannot turn `abc` into `a`,
`aa`, `abc`. **Enter** sends the whole line once. `Ctrl+C` and `Escape` drop the local line without
sending it, and `Tab` inserts a tab instead of moving the focus.

The button next to the label switches to **raw mode** and back; it names the mode it goes to, so
`Raw` is always one click away and `Line` takes you back. Use raw for full-screen programs (`vim`,
`htop`, `less`) and prompts that want keys as they arrive: there each keystroke is sent once, like a
normal terminal. Switching modes clears the local line either way — a line nobody can see must not
keep the assistant waiting.

- **Paste is one insertion.** In line mode the clipboard becomes text in the local line and Enter
  sends it once, with `\r`. In raw mode the clipboard goes to the PTY once: the panel turns the
  window's paste shortcut into a single write, so the shell's own paste does not insert a second
  copy.
- **Credentials are masked and never logged.** While the credential detector sees a prompt, the
  local line paints discs instead of characters; the screen still shows the prompt, because you are
  the one who has to read it. The password does not reach the audit log or the assistant's read: the
  AI-facing buffer stays withheld for as long as the prompt is up.
- **One writer at a time.** If you start typing, the assistant waits: a command it had approved is
  queued instead of landing on top of your line, and it is released when the line closes — Enter,
  `Ctrl+C`, `Escape` or an emptied input — in approval order. What the panel sends reaches the PTY
  in the order you produced it, so a submit never overtakes a write already in flight.

### What the assistant sees

The shell you type in is the one `terminal_pty_read_terminal` reads. Nothing is shared implicitly: the
assistant still needs the per-session grant described in *Using it*, and it still needs your approval
for each command unless the command is allowlisted.

The panel and the assistant read the same buffer with one important difference: while a credential
prompt is on screen, the assistant gets withheld text and the panel keeps showing your prompt. You are
the one typing the password; hiding it from you would only make you type blind.

### The approval is the app's, not the plugin's

The plugin never draws a dialog of its own. When it needs your decision it calls
`context.permission.assert`, which OpenCode renders in the same native approval surface it uses for
`bash` and `edit`. Two consequences worth knowing:

- **A prompt you see is the app's prompt.** If it looks like every other permission request in
  OpenCode, it is working as intended.
- **If your `permission` config already allows that kind of action, no prompt appears.** That is the
  native mechanism deciding for you, not the plugin skipping a step: it asked, the app answered. To
  see the prompt again, remove the matching `permission` rule (or set it to `ask`).

#### The two permission keys

The plugin asks for two actions, and each one has a key in OpenCode's `permission` block:

| Action | Key | What it guards |
|---|---|---|
| `terminal_pty.access` | `"terminal_pty.access": "ask"` | the per-session grant: `terminal_pty_access_grant` cannot hand out reading or writing without your answer |
| `terminal_pty.execute` | `"terminal_pty.execute": "ask"` | every command the assistant submits through `terminal_pty_execute_command` |

The recommended value is `ask` for both. `ask` — not `deny` — is what keeps the tools usable: the
request reaches you in the approval surface, and you decide call by call. They go in the
`permission` block of your global config, `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "permission": {
    "read": "allow",
    "edit": "allow",
    "terminal_pty.access": "ask",
    "terminal_pty.execute": "ask"
  }
}
```

- **The dialog is OpenCode's.** There is no second window with a different look: approving a grant
  is the same interaction as approving `bash`.
- **Revoking stays frictionless.** `terminal_pty_access_revoke` never asks, even with both keys on
  `ask`; taking access away should not need a confirmation.
- **Back to the previous behaviour.** Remove the two keys, or set them to `"allow"`, and restart
  OpenCode. The host then approves both actions on its own and the prompts stop appearing: the
  plugin still asks, the app answers for you. That is how the plugin behaved before these keys were
  declared, and the rest of `permission` does not change.

### What it does not do

- **Full-screen programs are not rendered.** `vim`, `htop` or `less` write to the alternate screen;
  the panel says a full-screen program is running instead of painting garbage. The assistant reads
  them through the tools, and the tab tells you they are there.
- **It is a text screen, not an emulator.** Cursor moves, erases and line rewrites are replayed (that
  is what keeps typing readable); colours, mouse reporting and scroll regions are not.
- **The scrollback in the panel is the last 400 rows.** The PTY keeps more; the panel asks for a
  window small enough to stay responsive.
- **The shell is sized when the tab opens and when the panel resizes**, from the rendered box. A
  window resize during a long command still reaches it, but the estimate is in characters, so it can
  be off by one column.

### The bundle

The panel ships as `gui-experimental.cjs` at the plugin root, the CommonJS file the desktop app
evaluates in every window. It is built from `src/gui/`:

```bash
bun script/build-gui.ts
```

Rebuild it after changing anything under `src/gui/` or the modules it imports
(`lib/gui/`, `lib/screen.ts`, `lib/terminal-keys.ts`). Without the file the plugin works exactly as
before the panel existed: the tools, the grants and the approvals do not depend on it.

The app resolves the bundle from the plugin directory: `gui-experimental.cjs` at the root while the
manifest stays parked as `package.json.disabled` (the host's convention for a directory without
`exports`), or through `exports["./gui-experimental"]` in that manifest if you activate it. Both point
at the same file, so the panel survives either choice.

## Using it

1. **Ask for a terminal.** Say "open a terminal here" or "get me a shell". The assistant calls
   `terminal_open`; you get back the session id, the shell and the directory:

   ```json
   { "sessionID": "ses_abc", "pid": 4312, "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
     "cwd": "C:\\Users\\you", "engine": "local-pty" }
   ```

   Opening twice returns the same shell; nothing else is spawned.

2. **Read is still closed.** Ask it to read and it answers:

   ```
   Terminal access is disabled. The human must enable `access.enabled` in the plugin options.
   ```

   and, once access is enabled:

   ```
   No read permission for this session. The human must grant it with `terminal_pty_access_grant`.
   ```

3. **Grant what you want.** Say "read this terminal" or "you can run commands here". The assistant
   calls `terminal_pty_access_grant` and OpenCode shows you an approval prompt.

   | Mode | Grants |
   |---|---|
   | `read` | reading only |
   | `read-write` | reading and running commands |

4. **Work.** With `read` granted, the assistant reads the screen. With `read-write`, every command
   still asks you for approval unless it is in the allowlist.

5. **Revoke whenever you want.** `terminal_pty_access_revoke` takes effect immediately and never asks
   for approval. Use `capability: "write"` to keep reading and stop execution.

6. **Close the shell.** `terminal_kill` destroys the PTY and its scrollback; it never asks for
   approval, like revoking. Closing OpenCode kills every session with it.

## Security model

| Property | Behaviour |
|---|---|
| Closed by default | No read, no write, until you allow it. Installing the plugin grants nothing |
| Per session | Two sessions have independent grants and independent shells |
| Process-scoped | Grants live in memory; closing OpenCode discards them, even with a resumed session |
| No time limit, no command budget | It lasts while the process lives, not longer |
| Revocable instantly | Revoking never needs approval and applies to the next command |
| Write implies read | You cannot run what you cannot see |
| Read does not imply write | Granting reading never allows execution |
| Credential blinding wins | With read granted, a password prompt still returns withheld text; with write granted, it blocks execution |
| Chained commands never auto-approved | `;`, `&&`, `$(...)`, `>`, `|`, backticks always need approval |
| Keystrokes are not logged | Human input is written to the PTY and never recorded |
| The local shell is not a sandbox | It runs with your privileges, your env and your files. The gate, not the process, is the boundary |

## Known limitations

- **One shell per session.** `terminal_open` is idempotent; a second call returns the same shell. Use
  `terminal_kill` first if you want a clean one.
- **The panel needs OpenCode Desktop.** It is a GUI contribution (`gui-experimental`); the TUI has no
  side panel to put it in. The tools work the same in both.
- **The panel does not emulate a terminal.** It replays cursor moves and line erases over the last
  400 rows; a full-screen program is reported, not drawn. Copies of the exact screen, colours and
  mouse support belong to the app's own terminal, not to this view.
- **The host fallback is read-only.** On a runtime where `node-pty` cannot be loaded, the plugin
  reports `engine: "host-read-only"`, reads the host terminal and answers
  `Writing to the terminal is not available in this host` for execution.
- **No per-command timeout.** A command that hangs keeps the session busy until you kill it.
- **`pid` is `null` on Windows.** `node-pty` reports `0` for ConPTY sessions, so `terminal_open`
  returns `null` instead of a made-up number; the shell and the session id identify it.
- **Reads are a flattened screen, not a rendered screen.** PSReadLine repaints the line on every
  keystroke, so a snapshot can show the intermediate renders of your own command (repeated prefixes,
  `>>` while a quote is open). The last paint is the current state; foreign text can no longer appear,
  because history predictions are disabled for the plugin's shell.
- **The allowlist is a convenience, not a jail.** It still runs with your shell's privileges.
- **Windows needs a modern Bun.** Bun 1.3.x cannot write into ConPTY; the plugin downgrades instead
  of crashing.

## Uninstall

1. Remove the entry from `opencode.json`, **or** delete the folder:

   ```powershell
   Remove-Item -Recurse "$env:USERPROFILE\.config\opencode\plugin\terminal-pty"
   ```

2. Restart OpenCode. It behaves exactly as before installing.

Revoke access before removing it if you want to be explicit; removing the folder also ends it,
because grants live only in memory, and every spawned shell dies with the process.

## Development

```bash
cd src/opencode/.opencode/plugin/terminal-pty
bun test                     # 222 tests, 0 failures
bun script/build-gui.ts      # rebuilds gui-experimental.cjs
```

The suite is pure logic plus an in-memory PTY: no native binary, no host, no SSH server. Shell
selection is tested with an injected filesystem, so it runs identically on every platform. The panel
is tested by loading the built bundle the way the desktop loads it — one CommonJS text, evaluated with
a `require` that answers only the modules the window host provides — and driving its read loop and
keyboard.

What the suite cannot cover is the app itself: that the tab lands in the side panel, that the
approval appears where the app puts its own, and that the browser delivers the keys. That part needs a
running OpenCode Desktop with the plugin installed, and is listed as pending runtime verification in
`Documentacion/opencode/specs/003-plugin-terminal-pty/`.

See `Documentacion/opencode/specs/003-plugin-terminal-pty/` for the specification, plan, tasks and
verified status.
