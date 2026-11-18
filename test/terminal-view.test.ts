import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "../lib/types"
import { viewFromSession, WITHHELD } from "../lib/terminal-view"

/**
 * Contract these tests protect: the assistant reads the screen, not the repaint bytes.
 *
 * PSReadLine rewrites the current line with backspaces and cursor moves. Handing that tail to the
 * model makes it read `e\becho tesecho test` and then write commands based on the garbage, so
 * `viewFromSession` — the single read path behind `terminal_pty_read_terminal`,
 * `terminal_pty_wait_for_prompt` and `terminal_pty_terminal_info` — renders it first. The
 * `TerminalView` contract (id, title, cwd, foreground process) does not change; only `text` does.
 */

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "ses_1",
  target: { kind: "local", cwd: "C:\\work" },
  status: "ready",
  createdAt: 1,
  lastActivityAt: 2,
  blinded: false,
  fullScreenApp: null,
  cwd: "C:\\work",
  foregroundProcess: "pwsh.exe",
  shell: "pwsh",
  ...overrides,
})

describe("viewFromSession", () => {
  test("renders the repaint out of the text the assistant reads", () => {
    // The exact garbage the assistant used to read: the typed prefix, a backspace, a cursor move
    // back to the start of the line and the whole command again.
    const view = viewFromSession(session(), { text: "e\becho tes\x1b[9D\x1b[Kecho test" })

    expect(view.text).toBe("echo test")
  })

  test("keeps the contract while only the text changes", () => {
    const view = viewFromSession(session(), {
      text: "$ s\bssh\r\x1b[Kls\x1b[?25l",
      fullScreenApp: "vim",
    })

    expect(view.ptyID).toBe("ses_1")
    expect(view.title).toBe("pwsh (local)")
    expect(view.cwd).toBe("C:\\work")
    expect(view.foregroundProcess).toBe("vim")
    expect(view.text).toBe("ls")
  })

  test("never exposes a backspace, carriage return or escape", () => {
    const view = viewFromSession(session(), { text: "hola\r\x1b[Kok\x1b[?25l\b" })

    expect(view.text).not.toContain("\b")
    expect(view.text).not.toContain("\r")
    expect(view.text).not.toContain("\u001b")
    expect(view.text).toBe("ok")
  })

  test("leaves an already rendered screen untouched, so it is idempotent", () => {
    const rendered = "ops@srv-01:~$ ls -la\ntotal 0"
    const view = viewFromSession(session({ target: { host: "srv-01", user: "ops" } }), {
      text: rendered,
    })

    expect(view.text).toBe(rendered)
    expect(viewFromSession(session({ target: { host: "srv-01", user: "ops" } }), view).text).toBe(
      rendered,
    )
  })

  test("does not disturb the withheld placeholder", () => {
    const view = viewFromSession(session({ blinded: true }), { text: WITHHELD })

    expect(view.text).toBe(WITHHELD)
  })
})
