import { describe, expect, test } from "bun:test"
import { isSafeCommand, SessionManager, type SessionEvent, type SessionManagerOptions } from "../lib/session-manager"
import { FakeSpawner } from "./fake-pty"

const setup = async (options: Partial<SessionManagerOptions> = {}) => {
  const spawner = new FakeSpawner()
  const manager = new SessionManager({ spawner, ...options })
  await manager.create({ id: "s1", target: { host: "srv-01", user: "ops" } })
  return { spawner, manager }
}

/**
 * Scheduler seam for the deferred write.
 *
 * The tests wake the pending timer by hand, so the human priority window costs no wall-clock time
 * and the assertions stay deterministic.
 */
const manualTimers = () => {
  const armed: { callback: () => void; delayMs: number; fired: boolean }[] = []

  return {
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, fired: false }
      armed.push(timer)
      return () => {
        timer.fired = true
      }
    },
    get pending() {
      return armed.filter((timer) => !timer.fired)
    },
    get delays() {
      return this.pending.map((timer) => timer.delayMs)
    },
    /** Wakes the armed drain, like the event loop would once the window had elapsed. */
    fire() {
      const timer = this.pending[0]
      if (!timer) throw new Error("No drain is armed")
      timer.fired = true
      timer.callback()
    },
  }
}

describe("SessionManager", () => {
  test("spawns ssh with the target and reports connecting", async () => {
    const { spawner, manager } = await setup()

    expect(spawner.lastOptions.file).toBe("ssh")
    expect(spawner.lastOptions.args).toContain("ops@srv-01")
    expect(manager.info("s1").status).toBe("connecting")
    expect(manager.list()).toHaveLength(1)
  })

  test("blinds AI snapshots while a credential prompt is active", async () => {
    const { spawner, manager } = await setup()
    spawner.last.emit("ops@srv-01's password: ")

    const snapshot = manager.snapshot("s1")

    expect(snapshot.blinded).toBe(true)
    expect(snapshot.text).toContain("withheld")
    expect(manager.info("s1").status).toBe("authenticating")
  })

  test("renders a PSReadLine repaint out of the AI snapshot", async () => {
    const { spawner, manager } = await setup()
    spawner.last.emit("ops@srv-01:~$ \n")
    // What PSReadLine sends when it rewrites the line it owns: the typed prefix, a backspace, a
    // cursor move back and the whole command again. Stripping the escapes glued both fragments
    // together, so the assistant read `e\becho tesecho test` and wrote commands based on it.
    spawner.last.emit("e\becho tes\x1b[9D\x1b[Kecho test")

    const snapshot = manager.snapshot("s1")

    expect(snapshot.text).toContain("ops@srv-01:~$\necho test")
    expect(snapshot.text).not.toContain("tesecho")
    expect(snapshot.text).not.toContain("\b")
    expect(snapshot.text).not.toContain("\u001b")
  })

  test("waitForPrompt matches the rendered line, not the repaint fragments", async () => {
    const { spawner, manager } = await setup()
    spawner.last.emit("ops@srv-01:~$ \n")
    spawner.last.emit("e\becho tes\x1b[9D\x1b[Kecho test")

    const result = await manager.waitForPrompt("s1", "echo test", 50)

    expect(result.matched).toBe(true)
    expect(result.text).toContain("ops@srv-01:~$\necho test")
    expect(result.text).not.toContain("tesecho")
  })

  test("returns to ready after authentication succeeds", async () => {
    const { spawner, manager } = await setup()
    spawner.last.emit("ops@srv-01's password: ")
    spawner.last.emit("\nLast login: Tue Nov 11 09:12:44 2026\nops@srv-01:~$ ")

    expect(manager.snapshot("s1").blinded).toBe(false)
    expect(manager.info("s1").status).toBe("ready")
  })

  test("human input goes straight to the PTY and never reaches the log", async () => {
    const lines: string[] = []
    const { spawner, manager } = await setup({ loggerSink: (_id, line) => lines.push(line) })

    manager.writeHuman("s1", "hunter2\r")

    expect(spawner.last.writes).toEqual(["hunter2\r"])
    expect(lines.some((line) => line.includes("hunter2"))).toBe(false)
  })

  test("an AI command requires approval and does not touch the PTY", async () => {
    const { spawner, manager } = await setup()

    const outcome = manager.proposeCommand("s1", "systemctl restart nginx", "restart nginx")

    expect(outcome.status).toBe("requires-approval")
    expect(spawner.last.writes).toEqual([])
    expect(manager.pendingProposal("s1")?.command).toBe("systemctl restart nginx")
  })

  test("approval writes the command with a trailing newline", async () => {
    const { spawner, manager } = await setup()
    manager.proposeCommand("s1", "systemctl restart nginx")

    manager.approve("s1")

    expect(spawner.last.writes).toEqual(["systemctl restart nginx\n"])
    expect(manager.pendingProposal("s1")).toBeNull()
  })

  test("approval can override the proposed command", async () => {
    const { spawner, manager } = await setup()
    manager.proposeCommand("s1", "systemctl restart nginx")

    manager.approve("s1", "systemctl status nginx")

    expect(spawner.last.writes).toEqual(["systemctl status nginx\n"])
  })

  test("holds an approved command while the human is mid-line", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })
    const events: SessionEvent[] = []
    manager.on((event) => events.push(event))

    // The human started a line and has not submitted it.
    manager.writeHuman("s1", "ssh")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")

    // The human still approved: only the moment of the write changed.
    expect(manager.pendingProposal("s1")).toBeNull()
    expect(timers.delays).toEqual([1_000])

    // Their line is untouched, and nothing was announced as written yet.
    expect(spawner.last.writes).toEqual(["ssh"])
    expect(events.filter((event) => event.type === "approval")).toEqual([])

    clock += 1_000
    timers.fire()

    // Released on its own write, only after the window elapsed.
    expect(spawner.last.writes).toEqual(["ssh", "dir\n"])
    expect(events.filter((event) => event.type === "approval")).toHaveLength(1)
  })

  test("keeps waiting while the human keeps typing", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.writeHuman("s1", "ssh")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")

    clock += 900
    manager.writeHuman("s1", " -p 22")

    // The armed drain wakes up while the human is typing again and pushes itself back.
    clock += 900
    timers.fire()

    expect(spawner.last.writes).toEqual(["ssh", " -p 22"])
    expect(timers.delays).toEqual([100])

    clock += 100
    timers.fire()

    expect(spawner.last.writes).toEqual(["ssh", " -p 22", "dir\n"])
  })

  test("writes two queued AI commands in the order they were approved", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.writeHuman("s1", "ssh")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")
    clock += 200
    manager.proposeCommand("s1", "whoami")
    manager.approve("s1")

    expect(spawner.last.writes).toEqual(["ssh"])

    clock += 1_000
    timers.fire()

    expect(spawner.last.writes).toEqual(["ssh", "dir\n", "whoami\n"])
  })

  /**
   * Line mode (FR-006, SC-004).
   *
   * The human composes the line in the panel, so the manager only knows it is open because the
   * panel says so (`humanLine`); no keystroke reaches the PTY. An approved AI command must wait for
   * the Enter, not merely for the keystroke idle window: the line can stay open for minutes.
   */
  test("holds an AI command until the human submits the line", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.humanLine("s1")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")

    expect(spawner.last.writes).toEqual([])
    expect(timers.delays).toEqual([1_000])

    // Long past the idle window the line is still being composed. The armed drain must wake, find
    // the line open, and not arm itself again (that would poll forever).
    clock += 5_000
    timers.fire()

    expect(spawner.last.writes).toEqual([])
    expect(timers.pending).toEqual([])

    manager.submitHumanLine("s1", "ssh")

    // The human's line lands first and exactly once; the approved command follows it.
    expect(spawner.last.writes).toEqual(["ssh\r", "dir\n"])
  })

  test("submits the line once and keeps it out of the log", async () => {
    const lines: string[] = []
    const { spawner, manager } = await setup({ loggerSink: (_id, line) => lines.push(line) })

    manager.humanLine("s1")
    manager.submitHumanLine("s1", "hunter2")

    expect(spawner.last.writes).toEqual(["hunter2\r"])
    expect(lines.some((line) => line.includes("hunter2"))).toBe(false)
  })

  test("releases two approved AI commands in order after the human line", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.humanLine("s1")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")
    clock += 200
    manager.proposeCommand("s1", "whoami")
    manager.approve("s1")

    expect(spawner.last.writes).toEqual([])

    manager.submitHumanLine("s1", "ssh")

    expect(spawner.last.writes).toEqual(["ssh\r", "dir\n", "whoami\n"])
  })

  test("a human submit that arrives while the AI is queued goes out before it", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    // The AI write is already waiting behind an open line...
    manager.humanLine("s1")
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")
    // ...and the human presses Enter before the scheduled drain would ever fire.
    manager.submitHumanLine("s1", "ssh")

    expect(spawner.last.writes).toEqual(["ssh\r", "dir\n"])
    expect(timers.pending).toEqual([])
  })

  /**
   * T019: the panel's `line` RPC, not a keystroke.
   *
   * The person is composing the line in the window, so no byte reaches the PTY while they type; the
   * only signal the server gets is `noteHumanLine(id, true)`. It must hold the AI for as long as the
   * line is open, and release it when the panel says the line is closed without a submit.
   */
  test("an open line announced by the panel queues the AI until it closes", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.noteHumanLine("s1", true)
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")

    // Queued behind the line: nothing reached the PTY, and the armed drain only waits the window.
    expect(spawner.last.writes).toEqual([])
    expect(timers.delays).toEqual([1_000])

    // The drain wakes long after the window and finds the line still open: the queue survives.
    clock += 5_000
    timers.fire()
    expect(spawner.last.writes).toEqual([])
    expect(timers.pending).toEqual([])

    // The panel reports the line closed (blur, Escape, an emptied input): the AI is released now,
    // without writing anything that the human never composed.
    manager.noteHumanLine("s1", false)

    expect(spawner.last.writes).toEqual(["dir\n"])
  })

  test("closing an announced line releases the AI, not the line itself", async () => {
    let clock = 1_000_000
    const timers = manualTimers()
    const { spawner, manager } = await setup({ now: () => clock, schedule: timers.schedule })

    manager.noteHumanLine("s1", true)
    manager.proposeCommand("s1", "dir")
    manager.approve("s1")
    // The human submitted the line they were composing while the AI waited.
    manager.submitHumanLine("s1", "ssh -p 22")
    // The panel then reports the closed line, twice: it must be a no-op, not a second write.
    manager.noteHumanLine("s1", false)
    manager.noteHumanLine("s1", false)

    expect(spawner.last.writes).toEqual(["ssh -p 22\r", "dir\n"])
    expect(timers.pending).toEqual([])
  })

  test("announcing a line writes nothing and never reaches the log", async () => {
    const lines: string[] = []
    const { spawner, manager } = await setup({ loggerSink: (_id, line) => lines.push(line) })

    manager.noteHumanLine("s1", true)
    manager.noteHumanLine("s1", false)

    expect(spawner.last.writes).toEqual([])
    // No bytes, so nothing to log: `line` is a state notice, not input.
    expect(lines.some((line) => line.includes("human-line") || line.includes("human-input"))).toBe(false)
  })

  test("rejection leaves the PTY untouched", async () => {
    const { spawner, manager } = await setup()
    manager.proposeCommand("s1", "systemctl restart nginx")

    manager.reject("s1")

    expect(spawner.last.writes).toEqual([])
    expect(manager.pendingProposal("s1")).toBeNull()
  })

  test("auto-approves allowlisted read-only commands when enabled", async () => {
    const { spawner, manager } = await setup({ autoApproveSafeCommands: true })

    const outcome = manager.proposeCommand("s1", "journalctl -u nginx -n 50")

    expect(outcome.status).toBe("executed")
    expect(spawner.last.writes).toEqual(["journalctl -u nginx -n 50\n"])
  })

  test("never auto-approves a command with shell metacharacters", async () => {
    const { spawner, manager } = await setup({ autoApproveSafeCommands: true })

    const outcome = manager.proposeCommand("s1", "ls; rm -rf /")

    expect(outcome.status).toBe("requires-approval")
    expect(spawner.last.writes).toEqual([])
  })

  test("blocks AI injection while a full-screen app owns the terminal", async () => {
    const { spawner, manager } = await setup({ autoApproveSafeCommands: true })
    spawner.last.emit("\u001b[?1049h")

    const outcome = manager.proposeCommand("s1", "ls")

    expect(outcome.status).toBe("blocked")
    expect(manager.info("s1").fullScreenApp).not.toBeNull()
    expect(spawner.last.writes).toEqual([])
  })

  test("emits session events for data, credential and exit", async () => {
    const { spawner, manager } = await setup()
    const events: SessionEvent[] = []
    manager.on((event) => events.push(event))

    spawner.last.emit("ops@srv-01's password: ")
    spawner.last.exit(1)

    expect(events.some((event) => event.type === "credential")).toBe(true)
    expect(events.some((event) => event.type === "exit")).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })

  test("destroy kills the PTY and drops the session", async () => {
    const { spawner, manager } = await setup()

    manager.destroy("s1")

    expect(spawner.last.killed).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })

  test("rejects a duplicate session id", async () => {
    const { manager } = await setup()

    await expect(manager.create({ id: "s1", target: { host: "h", user: "u" } })).rejects.toThrow("already exists")
  })
})

describe("isSafeCommand", () => {
  test("accepts allowlisted read-only commands", () => {
    expect(isSafeCommand("journalctl -u nginx", ["journalctl"])).toBe(true)
  })

  test("rejects metacharacters, redirections and substitution", () => {
    expect(isSafeCommand("ls > /tmp/x", ["ls"])).toBe(false)
    expect(isSafeCommand("ls && whoami", ["ls"])).toBe(false)
    expect(isSafeCommand("cat $(whoami)", ["cat"])).toBe(false)
    expect(isSafeCommand("cat `id`", ["cat"])).toBe(false)
  })

  test("rejects an empty command", () => {
    expect(isSafeCommand("   ", ["ls"])).toBe(false)
  })
})
