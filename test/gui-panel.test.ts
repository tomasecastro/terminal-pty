import { describe, expect, test } from "bun:test"
import { MAX_WRITE_BYTES, PANEL_LINES, panelHandlers, type PanelScreen, type PanelTerminal } from "../lib/gui/host"
import { autoOpenHandler, type PanelState } from "../lib/gui/auto-open"

/**
 * Contract these tests protect: what the visible terminal may do with the plugin's PTY.
 *
 * Two invariants matter and are asserted here:
 * 1. The panel reads the *unblinded* buffer (the person types their own password) and writes through
 *    the human path (`write`, never the assistant's approved-machine path).
 * 2. It cannot reach a session that does not exist, and it cannot be used to flood one.
 */

interface Recorder {
  readonly terminal: PanelTerminal
  readonly writes: string[]
  readonly submits: string[]
  readonly lines: boolean[]
  readonly resizes: [number, number][]
  readonly opened: string[]
}

function fakeScreen(overrides: Partial<PanelScreen> = {}): PanelScreen {
  return {
    text: "$ echo hola\r\nhola\r\n$ ",
    seq: 7,
    blinded: false,
    status: "ready",
    fullScreenApp: null,
    title: "pwsh.exe (local)",
    cwd: "C:\\work",
    foregroundProcess: "pwsh.exe",
    ...overrides,
  }
}

function recorder(options: { readonly sessions?: readonly string[]; readonly screen?: PanelScreen | null } = {}): Recorder {
  const sessions = new Set(options.sessions ?? ["ses_1"])
  const writes: string[] = []
  const submits: string[] = []
  const lines: boolean[] = []
  const resizes: [number, number][] = []
  const opened: string[] = []

  return {
    writes,
    submits,
    lines,
    resizes,
    opened,
    terminal: {
      has: (sessionID) => sessions.has(sessionID),
      open: async (sessionID) => {
        sessions.add(sessionID)
        opened.push(sessionID)
        return { sessionID }
      },
      humanView: (sessionID) =>
        sessions.has(sessionID) ? (options.screen === undefined ? fakeScreen() : options.screen) : null,
      write: (_sessionID, data) => {
        writes.push(data)
      },
      submit: (_sessionID, line) => {
        submits.push(line)
      },
      line: (_sessionID, active) => {
        lines.push(active)
      },
      resize: (_sessionID, cols, rows) => {
        resizes.push([cols, rows])
      },
    },
  }
}

describe("panel handlers", () => {
  test("opens a shell for a session that has none, then reports the view", async () => {
    const fake = recorder({ sessions: [] })
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    const view = await handlers.open({ sessionID: "ses_1", cwd: "C:\\work" })

    expect(fake.opened).toEqual(["ses_1"])
    expect(view.attached).toBe(true)
    expect(view.title).toBe("pwsh.exe (local)")
    expect(view.engine).toBe("local-pty")
    expect(view.text).toContain("echo hola")
  })

  test("is idempotent: an open session is not spawned twice", async () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    await handlers.open({ sessionID: "ses_1" })
    await handlers.open({ sessionID: "ses_1" })

    expect(fake.opened).toEqual([])
  })

  test("reports why there is no terminal instead of throwing", () => {
    const fake = recorder({ sessions: [], screen: null })
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    const view = handlers.read({ sessionID: "ses_missing" })

    expect(view.attached).toBe(false)
    expect(view.reason).toBe("no-terminal")
    expect(view.text).toBe("")
  })

  test("reports a spawn failure as a reason, not an exception", async () => {
    const fake = recorder({ sessions: [] })
    const failing: PanelTerminal = {
      ...fake.terminal,
      open: async () => {
        throw new Error("node-pty unavailable")
      },
    }

    const view = await panelHandlers(failing, () => "local-pty").open({ sessionID: "ses_1" })

    expect(view.attached).toBe(false)
    expect(view.reason).toContain("spawn-failed")
    expect(view.reason).toContain("node-pty unavailable")
  })

  test("skips the text when the caller already holds this sequence", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    const view = handlers.read({ sessionID: "ses_1", sinceSeq: 7 })

    expect(view.attached).toBe(true)
    expect(view.seq).toBe(7)
    expect(view.text).toBe("")
  })

  test("carries the credential-prompt flag so the panel can mask the line", () => {
    const fake = recorder({ screen: fakeScreen({ blinded: true }) })
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    expect(handlers.read({ sessionID: "ses_1" }).blinded).toBe(true)

    const miss = recorder({ sessions: [], screen: null })
    expect(panelHandlers(miss.terminal, () => "local-pty").read({ sessionID: "ses_x" }).blinded).toBe(false)
  })

  test("routes a keystroke through the human write path", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    expect(handlers.write({ sessionID: "ses_1", data: "echo hola\r" })).toEqual({ written: true })
    expect(fake.writes).toEqual(["echo hola\r"])
  })

  test("refuses a keystroke for a session with no PTY", () => {
    const fake = recorder({ sessions: [] })

    expect(panelHandlers(fake.terminal, () => "local-pty").write({ sessionID: "ses_x", data: "a" })).toEqual({
      written: false,
    })
    expect(fake.writes).toEqual([])
  })

  test("submits a whole line through the human line path, not as keystrokes", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    expect(handlers.submit({ sessionID: "ses_1", line: "ssh root@172.16.1.21" })).toEqual({ submitted: true })
    expect(fake.submits).toEqual(["ssh root@172.16.1.21"])
    expect(fake.writes).toEqual([])
  })

  test("accepts an empty line, which answers a prompt with its default", () => {
    const fake = recorder()

    expect(panelHandlers(fake.terminal, () => "local-pty").submit({ sessionID: "ses_1", line: "" })).toEqual({
      submitted: true,
    })
    expect(fake.submits).toEqual([""])
  })

  test("refuses a submitted line for a session with no PTY", () => {
    const fake = recorder({ sessions: [] })

    expect(panelHandlers(fake.terminal, () => "local-pty").submit({ sessionID: "ses_x", line: "a" })).toEqual({
      submitted: false,
    })
    expect(fake.submits).toEqual([])
  })

  test("caps a submitted line at the same size as a keystroke payload", () => {
    const fake = recorder()

    panelHandlers(fake.terminal, () => "local-pty").submit({ sessionID: "ses_1", line: "x".repeat(MAX_WRITE_BYTES * 2) })

    expect(fake.submits[0]?.length).toBe(MAX_WRITE_BYTES)
  })

  /**
   * T019: the line's state, not its text.
   *
   * The panel tells the server a line exists before Enter, so an approved AI write is queued for
   * as long as the person is composing it. The handler only carries the flag; no bytes are written.
   */
  test("relays the panel's line state without writing to the PTY", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    expect(handlers.line({ sessionID: "ses_1", active: true })).toEqual({ active: true })
    expect(handlers.line({ sessionID: "ses_1", active: false })).toEqual({ active: false })

    expect(fake.lines).toEqual([true, false])
    expect(fake.writes).toEqual([])
    expect(fake.submits).toEqual([])
  })

  test("cannot hold a line for a session with no PTY", () => {
    const fake = recorder({ sessions: [] })

    expect(panelHandlers(fake.terminal, () => "local-pty").line({ sessionID: "ses_x", active: true })).toEqual({
      active: false,
    })
    expect(fake.lines).toEqual([])
  })

  test("caps one paste so a runaway clipboard cannot flood the PTY", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    handlers.write({ sessionID: "ses_1", data: "x".repeat(MAX_WRITE_BYTES * 2) })

    expect(fake.writes[0]?.length).toBe(MAX_WRITE_BYTES)
  })

  test("clamps the terminal size to something a PTY accepts", () => {
    const fake = recorder()
    const handlers = panelHandlers(fake.terminal, () => "local-pty")

    handlers.resize({ sessionID: "ses_1", cols: 1, rows: 1 })
    handlers.resize({ sessionID: "ses_1", cols: 5000, rows: 5000 })

    expect(fake.resizes).toEqual([
      [20, 5],
      [500, 200],
    ])
  })

  test("does not render a full-screen program as text", () => {
    const fake = recorder({ screen: fakeScreen({ fullScreenApp: "vim", text: "\u001b[?1049hjunk" }) })

    const view = panelHandlers(fake.terminal, () => "local-pty").read({ sessionID: "ses_1" })

    expect(view.attached).toBe(true)
    expect(view.fullScreenApp).toBe("vim")
    expect(view.text).toBe("")
  })

  test("asks for the panel's default row count", () => {
    const fake = recorder()
    let asked = 0
    const terminal: PanelTerminal = {
      ...fake.terminal,
      humanView: (sessionID, lines) => {
        asked = lines ?? -1
        return fake.terminal.humanView(sessionID, lines)
      },
    }

    panelHandlers(terminal, () => "local-pty").read({ sessionID: "ses_1" })

    expect(asked).toBe(PANEL_LINES)
  })
})

/**
 * The auto-open (FR-007, FR-008): the server emits `opened` with the session whose grant was just
 * approved, and the window showing that session opens the terminal tab.
 *
 * The host's strip holds one entry per `${plugin}:${tab}`, so the handler's job is only to decide
 * *whether* to ask: the session on screen, and a strip that does not hold the tab yet.
 */
describe("auto-open handler", () => {
  function harness(options: { readonly current?: string; readonly state?: PanelState } = {}) {
    let state: PanelState = options.state ?? "closed"
    const opened: string[] = []
    const session = { id: options.current ?? "ses_1" }
    const handler = autoOpenHandler({
      current: () => session,
      state: () => state,
      // What the host does with a strip that gains the tab.
      open: (target) => {
        opened.push(target.id)
        state = "open"
      },
    })
    return { handler, opened, setState: (next: PanelState) => (state = next) }
  }

  test("opens the terminal for the session the grant names", () => {
    const fake = harness()

    fake.handler({ data: { sessionID: "ses_1" } })

    expect(fake.opened).toEqual(["ses_1"])
  })

  test("a second event for the same session does not add a tab again", () => {
    const fake = harness()
    const event = { data: { sessionID: "ses_1" } }

    fake.handler(event)
    fake.handler(event)

    expect(fake.opened).toEqual(["ses_1"])
  })

  test("leaves a strip that already holds the tab alone, so selection does not jump", () => {
    const fake = harness({ state: "visible" })

    fake.handler({ data: { sessionID: "ses_1" } })

    expect(fake.opened).toEqual([])
  })

  test("ignores a grant for another session", () => {
    const fake = harness({ current: "ses_2" })

    fake.handler({ data: { sessionID: "ses_1" } })

    expect(fake.opened).toEqual([])
  })

  test("reopens the tab after the person closed it and granted again", () => {
    const fake = harness()
    const event = { data: { sessionID: "ses_1" } }

    fake.handler(event)
    fake.setState("closed")
    fake.handler(event)

    expect(fake.opened).toEqual(["ses_1", "ses_1"])
  })

  test("does nothing on Home or before a session is routed", () => {
    const opened: string[] = []
    const handler = autoOpenHandler<{ id: string }>({
      current: () => undefined,
      state: () => "closed",
      open: (session) => opened.push(session.id),
    })

    handler({ data: { sessionID: "ses_1" } })

    expect(opened).toEqual([])
  })
})
