import { describe, expect, test } from "bun:test"
import { SessionManager, type SessionEvent } from "../lib/session-manager"
import type { PtyConnector, PtyProcess, PtyTarget } from "../lib/types"
import { FakePty } from "./fake-pty"

/**
 * Multi-session isolation (FR-011, SC-007).
 *
 * Three concurrent sessions share one manager and nothing else: destroying or losing one must leave
 * the others live, with their own scrollback and their own credential-blinding state untouched.
 * Every assertion below is about *one* session staying exactly as it was while another disappears,
 * which is the failure mode a shared buffer or a shared detector would produce.
 */

/** Hands every session its own in-memory PTY. No shell, no `node-pty`, no real process. */
class FakeConnector implements PtyConnector {
  readonly processes: FakePty[] = []

  connect(_target: PtyTarget): PtyProcess {
    const pty = new FakePty()
    this.processes.push(pty)
    return pty
  }

  at(index: number): FakePty {
    const pty = this.processes[index]
    if (!pty) throw new Error(`No PTY was connected at index ${index}`)
    return pty
  }
}

const LOCAL: PtyTarget = { kind: "local", cwd: "C:\\work" }

const setup = async () => {
  const connector = new FakeConnector()
  const events: SessionEvent[] = []
  const manager = new SessionManager({
    // The connector owns every PTY; a spawn here would mean the isolation test left the sandbox.
    spawner: {
      spawn: () => {
        throw new Error("the fake connector owns every PTY")
      },
    },
    connector,
    platform: "linux",
  })
  manager.on((event) => events.push(event))
  return { connector, manager, events }
}

/** Creates three local sessions and gives each one its own distinguishable output. */
const threeSessions = async () => {
  const context = await setup()
  for (const id of ["iso-a", "iso-b", "iso-c"]) {
    await context.manager.create({ id, target: LOCAL })
  }
  context.connector.at(0).emit("alpha ready\r\nalpha$ ")
  context.connector.at(1).emit("beta ready\r\nbeta$ ")
  context.connector.at(2).emit("gamma ready\r\ngamma$ ")
  return context
}

describe("session isolation", () => {
  test("destroying one of three sessions keeps the others live with their buffer intact", async () => {
    const { connector, manager } = await threeSessions()
    const alphaSeq = manager.humanSnapshot("iso-a").seq
    const betaSeq = manager.humanSnapshot("iso-b").seq

    manager.destroy("iso-c")

    expect(manager.has("iso-c")).toBe(false)
    expect(connector.at(2).killed).toBe(true)
    expect(manager.has("iso-a")).toBe(true)
    expect(manager.has("iso-b")).toBe(true)
    expect(manager.list().map((info) => info.id)).toEqual(["iso-a", "iso-b"])

    expect(manager.humanSnapshot("iso-a").text).toContain("alpha ready")
    expect(manager.humanSnapshot("iso-a").text).not.toContain("gamma ready")
    expect(manager.humanSnapshot("iso-a").seq).toBe(alphaSeq)
    expect(manager.humanSnapshot("iso-b").seq).toBe(betaSeq)
    expect(manager.snapshot("iso-a").text).toContain("alpha ready")

    // The destroyed handle is gone for every entry point, not just for `has`.
    expect(() => manager.writeHuman("iso-c", "x")).toThrow("Unknown session iso-c")
    expect(() => manager.snapshot("iso-c")).toThrow("Unknown session iso-c")
  })

  test("a blinded session stays blinded, with its human view intact, when a sibling is destroyed", async () => {
    const { connector, manager } = await threeSessions()
    connector.at(1).emit("Password: ")
    const blindedAt = manager.info("iso-b").lastActivityAt

    manager.destroy("iso-c")

    expect(manager.info("iso-b").blinded).toBe(true)
    expect(manager.info("iso-b").status).toBe("authenticating")
    expect(manager.info("iso-b").lastActivityAt).toBe(blindedAt)
    expect(manager.snapshot("iso-b").blinded).toBe(true)
    expect(manager.snapshot("iso-b").text).toContain("withheld")
    // The human keeps seeing their own prompt and their own scrollback; only the AI view is withheld.
    expect(manager.humanSnapshot("iso-b").text).toContain("beta ready")

    // The surviving sessions keep writing to their own PTY and to no one else's.
    manager.writeHuman("iso-a", "alpha$ ls -la\r")
    expect(connector.at(0).writes).toEqual(["alpha$ ls -la\r"])
    expect(connector.at(1).writes).toEqual([])
  })

  test("a session exiting by itself does not emit a close for its siblings", async () => {
    const { connector, manager, events } = await threeSessions()
    connector.at(2).emit("Password: ")

    connector.at(1).exit(0)

    expect(manager.has("iso-b")).toBe(false)
    expect(manager.has("iso-a")).toBe(true)
    expect(manager.has("iso-c")).toBe(true)
    expect(manager.humanSnapshot("iso-a").text).toContain("alpha ready")
    expect(manager.info("iso-c").blinded).toBe(true)

    const closed = events.filter((event) => event.type === "status" && event.status === "closed")
    expect(closed.map((event) => event.sessionId)).toEqual(["iso-b"])
    expect(events.filter((event) => event.type === "exit").map((event) => event.sessionId)).toEqual(["iso-b"])
    expect(events.some((event) => "sessionId" in event && event.sessionId === "iso-a" && event.type === "status")).toBe(
      true,
    )
  })

  test("destroyAll closes every session and kills every PTY", async () => {
    const { connector, manager } = await threeSessions()
    connector.at(2).emit("Password: ")

    manager.destroyAll()

    expect(manager.list()).toHaveLength(0)
    expect(connector.processes.map((pty) => pty.killed)).toEqual([true, true, true])
    for (const id of ["iso-a", "iso-b", "iso-c"]) expect(manager.has(id)).toBe(false)
  })
})
