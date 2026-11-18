import { describe, expect, test } from "bun:test"
import { panelHandlers } from "../lib/gui/host"
import { LocalTerminal } from "../lib/local-engine"
import { LocalShellConnector } from "../lib/local-shell"
import { SessionManager, type SessionEvent } from "../lib/session-manager"
import { FakeSpawner } from "./fake-pty"

/**
 * T054 — the whole cycle in one PTY.
 *
 * The panel opens it, the human types in it, the assistant reads it, proposes a command, the human
 * approves, the assistant runs it and the human sees the result. What is asserted is the part that
 * can silently break: that every hop lands in the *same* `SessionManager` session, not in a second
 * shell or in a copy of the buffer.
 *
 * `node-pty` is replaced by the fake spawner, so the OS is not exercised; the wiring is.
 */

const POWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"

const windows = {
  platform: "win32" as const,
  env: {
    PATH: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    HOME: "C:\\Users\\ana",
  },
  exists: (file: string) => file.toLowerCase() === POWSH.toLowerCase(),
}

function setup() {
  const spawner = new FakeSpawner()
  const connector = new LocalShellConnector(spawner, windows)
  const manager = new SessionManager({ spawner, connector, platform: "win32" })
  const terminal = new LocalTerminal(manager, connector)
  const panel = panelHandlers(terminal.panel(), () => "local-pty")
  const events: SessionEvent[] = []
  manager.on((event) => events.push(event))
  return { spawner, manager, terminal, panel, events }
}

describe("the visible terminal and the assistant share one PTY", () => {
  test("the human types, the assistant reads the same lines", async () => {
    const { spawner, terminal, panel } = setup()

    const opened = await panel.open({ sessionID: "ses_1", cwd: "C:\\work" })
    expect(opened.attached).toBe(true)
    expect(spawner.processes).toHaveLength(1)

    // The human writes through the panel: one keystroke per byte, as the browser sends them.
    expect(panel.write({ sessionID: "ses_1", data: "echo hola" })).toEqual({ written: true })
    expect(panel.write({ sessionID: "ses_1", data: "\r" })).toEqual({ written: true })
    expect(spawner.last.writes).toEqual(["echo hola", "\r"])

    // The shell answers into the same buffer.
    spawner.last.emit("PS C:\\work> echo hola\r\nhola\r\nPS C:\\work> ")

    // `terminal_pty_read_terminal` reads `LocalTerminal.view`, the assistant's door to this session.
    const view = terminal.view("ses_1")
    expect(view?.text).toContain("echo hola")
    expect(view?.text).toContain("hola")
    expect(view?.ptyID).toBe("ses_1")
  })

  test("the human's keys never become an approved-command event", async () => {
    const { panel, events } = setup()
    await panel.open({ sessionID: "ses_1" })

    panel.write({ sessionID: "ses_1", data: "echo hola\r" })

    // `writeHuman` is silent on purpose: no approval event, nothing for the audit trail.
    expect(events.filter((event) => event.type === "approval")).toEqual([])
  })

  test("the assistant's proposal waits for the human and then runs in the same PTY", async () => {
    const { spawner, manager, panel, events } = setup()
    await panel.open({ sessionID: "ses_1" })

    const outcome = manager.proposeCommand("ses_1", "echo adios", "comprobar el eco")
    expect(outcome.status).toBe("requires-approval")
    // Nothing reached the PTY: a proposal is not an execution.
    expect(spawner.last.writes).toEqual([])

    manager.approve("ses_1")
    expect(spawner.last.writes).toEqual(["echo adios\r"])
    expect(events.some((event) => event.type === "approval")).toBe(true)
    expect(spawner.processes).toHaveLength(1)

    // The human sees the assistant's command in the same terminal.
    spawner.last.emit("PS C:\\work> echo adios\r\nadios\r\nPS C:\\work> ")
    const view = panel.read({ sessionID: "ses_1" })
    expect(view.attached).toBe(true)
    expect(view.text).toContain("echo adios")
    expect(view.text).toContain("adios")
  })

  test("a rejected proposal never touches the PTY", async () => {
    const { spawner, manager, panel } = setup()
    await panel.open({ sessionID: "ses_1" })

    manager.proposeCommand("ses_1", "Remove-Item -Recurse .")
    manager.reject("ses_1")

    expect(spawner.last.writes).toEqual([])
    expect(manager.pendingProposal("ses_1")).toBeNull()
  })

  test("the panel's view is not withheld while the assistant's is", async () => {
    const { spawner, manager, terminal, panel } = setup()
    await panel.open({ sessionID: "ses_1" })

    // A password prompt blinds the assistant, not the person typing the password.
    spawner.last.emit("Password: ")

    expect(terminal.blinded("ses_1")).toBe(true)
    expect(terminal.view("ses_1")?.text).toContain("withheld")
    expect(panel.read({ sessionID: "ses_1" }).text).toContain("Password:")
  })

  test("the panel resizes the PTY it is showing", async () => {
    const { spawner, panel } = setup()
    await panel.open({ sessionID: "ses_1" })

    expect(panel.resize({ sessionID: "ses_1", cols: 120, rows: 30 })).toEqual({ resized: true })
    expect(spawner.last.resizes).toEqual([[120, 30]])
  })

  test("closing the plugin's shell leaves the panel with nothing to show", async () => {
    const { spawner, terminal, panel } = setup()
    await panel.open({ sessionID: "ses_1" })

    expect(terminal.kill("ses_1")).toBe(true)
    expect(spawner.last.killed).toBe(true)
    expect(panel.read({ sessionID: "ses_1" })).toMatchObject({ attached: false, reason: "no-terminal" })
  })
})
