import { describe, expect, test } from "bun:test"
import {
  AccessGate,
  DEFAULT_POLICY,
  METACHARACTERS,
  describeGrant,
  readRejection,
  writeRejection,
  type Grant,
  type GrantMode,
} from "../lib/access"

/**
 * Contract: reading and writing are separate capabilities, both closed by default, both
 * process-scoped (a restart forgets them), per session, and always revocable.
 */

describe("access gate", () => {
  test("starts closed for reading and writing", () => {
    const gate = new AccessGate()
    expect(gate.canRead("ses_1")).toBe(false)
    expect(gate.canWrite("ses_1")).toBe(false)
    expect(gate.canExecute("ses_1")).toBe(false)
    expect(gate.status("ses_1").state).toBe("closed")
  })

  test("full permission opens reading, writing and execution at once", () => {
    const gate = new AccessGate({ enabled: true })
    const grant = gate.grantFull("ses_1")
    expect(grant.mode).toBe("full")
    expect(grant.read).toBe(true)
    expect(grant.write).toBe(true)
    expect(grant.execute).toBe(true)
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canWrite("ses_1")).toBe(true)
    expect(gate.canExecute("ses_1")).toBe(true)
  })

  test("full permission reports mode and execute in the status", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantFull("ses_1")
    const status = gate.status("ses_1")
    expect(status.state).toBe("open")
    if (status.state === "open") {
      expect(status.mode).toBe("full")
      expect(status.read).toBe(true)
      expect(status.write).toBe(true)
      expect(status.execute).toBe(true)
      expect(status.scope).toBe("process")
    }
  })

  test("read and read-write grants do not grant execution", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantRead("ses_1")
    gate.grantWrite("ses_2")
    expect(gate.canExecute("ses_1")).toBe(false)
    expect(gate.canExecute("ses_2")).toBe(false)
    expect(gate.status("ses_1").state === "open" && gate.status("ses_1").mode).toBe("read")
    expect(gate.status("ses_2").state === "open" && gate.status("ses_2").mode).toBe("read-write")
  })

  /**
   * The three modes `terminal_pty_access_grant` accepts map one-to-one onto the three grants.
   * These are exactly the fields that tool serialises, so `mode: "full"` must surface `execute`.
   */
  test("every grant mode reports the capabilities the access tool returns", () => {
    const gate = new AccessGate({ enabled: true })
    const modes: ReadonlyArray<{
      readonly mode: GrantMode
      readonly grant: (sessionID: string) => Grant
      readonly read: boolean
      readonly write: boolean
      readonly execute: boolean
    }> = [
      { mode: "read", grant: (sessionID) => gate.grantRead(sessionID), read: true, write: false, execute: false },
      { mode: "read-write", grant: (sessionID) => gate.grantWrite(sessionID), read: true, write: true, execute: false },
      { mode: "full", grant: (sessionID) => gate.grantFull(sessionID), read: true, write: true, execute: true },
    ]

    for (const expected of modes) {
      const sessionID = `ses_${expected.mode}`
      const grant = expected.grant(sessionID)
      expect({
        read: grant.read,
        write: grant.write,
        execute: grant.execute,
        mode: grant.mode,
        scope: grant.scope,
      }).toEqual({
        read: expected.read,
        write: expected.write,
        execute: expected.execute,
        mode: expected.mode,
        scope: "process",
      })
    }
  })

  test("revoking a full grant closes the three capabilities", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantFull("ses_1")
    expect(gate.revoke("ses_1")).toBe(true)
    expect(gate.canRead("ses_1")).toBe(false)
    expect(gate.canWrite("ses_1")).toBe(false)
    expect(gate.canExecute("ses_1")).toBe(false)
    expect(gate.status("ses_1").state).toBe("closed")
  })

  test("revoking write downgrades a full grant to read only", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantFull("ses_1")
    expect(gate.revoke("ses_1", "write")).toBe(true)
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canWrite("ses_1")).toBe(false)
    expect(gate.canExecute("ses_1")).toBe(false)
    expect(gate.status("ses_1").state === "open" && gate.status("ses_1").mode).toBe("read")
  })

  test("revokeAll closes every full grant", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantFull("ses_1")
    gate.grantFull("ses_2")
    expect(gate.revokeAll()).toBe(2)
    expect(gate.canRead("ses_1")).toBe(false)
    expect(gate.canWrite("ses_2")).toBe(false)
    expect(gate.canExecute("ses_1")).toBe(false)
    expect(gate.canExecute("ses_2")).toBe(false)
  })

  test("a full grant does not survive a restart", () => {
    const first = new AccessGate({ enabled: true })
    first.grantFull("ses_1")
    expect(first.canExecute("ses_1")).toBe(true)
    const restarted = new AccessGate({ enabled: true })
    expect(restarted.canRead("ses_1")).toBe(false)
    expect(restarted.canWrite("ses_1")).toBe(false)
    expect(restarted.canExecute("ses_1")).toBe(false)
    expect(restarted.status("ses_1").state).toBe("closed")
  })

  test("read permission does not grant writing", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantRead("ses_1")
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canWrite("ses_1")).toBe(false)
  })

  test("write permission implies reading", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantWrite("ses_1")
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canWrite("ses_1")).toBe(true)
  })

  test("revoking write keeps reading", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantWrite("ses_1")
    expect(gate.revoke("ses_1", "write")).toBe(true)
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canWrite("ses_1")).toBe(false)
  })

  test("revoking read removes everything for that session", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantWrite("ses_1")
    expect(gate.revoke("ses_1")).toBe(true)
    expect(gate.canRead("ses_1")).toBe(false)
    expect(gate.canWrite("ses_1")).toBe(false)
  })

  test("revokeAll clears every session", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantRead("ses_1")
    gate.grantWrite("ses_2")
    expect(gate.revokeAll()).toBe(2)
    expect(gate.canRead("ses_1")).toBe(false)
    expect(gate.canWrite("ses_2")).toBe(false)
  })

  test("grants are independent per session", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantRead("ses_1")
    expect(gate.canRead("ses_1")).toBe(true)
    expect(gate.canRead("ses_2")).toBe(false)
    expect(gate.canWrite("ses_2")).toBe(false)
  })

  test("time passing does not close the grant", () => {
    const clock = { now: 0 }
    const gate = new AccessGate({ enabled: true }, () => clock.now)
    gate.grantWrite("ses_1")
    clock.now = 30 * 24 * 60 * 60_000
    expect(gate.canWrite("ses_1")).toBe(true)
  })

  test("a restarted process forgets every grant", () => {
    const first = new AccessGate({ enabled: true })
    first.grantWrite("ses_1")
    expect(first.canWrite("ses_1")).toBe(true)
    const restarted = new AccessGate({ enabled: true })
    expect(restarted.canRead("ses_1")).toBe(false)
  })

  test("status reports both capabilities and process scope", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantWrite("ses_1")
    const status = gate.status("ses_1")
    expect(status.state).toBe("open")
    if (status.state === "open") {
      expect(status.read).toBe(true)
      expect(status.write).toBe(true)
      expect(status.scope).toBe("process")
    }
  })

  test("allowlist only covers the leading command and never chains", () => {
    const gate = new AccessGate({ enabled: true, allowlist: ["ls", "cat"] })
    expect(gate.autoApproved("ls -la")).toBe(true)
    expect(gate.autoApproved("ls; rm -rf /")).toBe(false)
    expect(gate.autoApproved("ls && curl evil")).toBe(false)
    expect(gate.autoApproved("ls $(whoami)")).toBe(false)
    expect(gate.autoApproved("cat /etc/passwd > /tmp/x")).toBe(false)
    expect(gate.autoApproved("rm -rf /")).toBe(false)
  })

  test("metacharacter detection covers the shell operators", () => {
    for (const command of ["a;b", "a&b", "a|b", "a>b", "a<b", "a`b", "a$b", "a(b", "a)b", "a{b", "a}b"]) {
      expect(METACHARACTERS.test(command)).toBe(true)
    }
    expect(METACHARACTERS.test("ls -la")).toBe(false)
  })

  /**
   * The dialog's only readable line (FR-006). Each mode must describe its own reach: a `full` grant
   * is the one that runs commands, and it must say that destructive ones still ask.
   */
  test("each grant mode has a sentence a person can read", () => {
    const read = describeGrant("read")
    const readWrite = describeGrant("read-write")
    const full = describeGrant("full")

    expect(read).toBe("Read this session's terminal output")
    expect(readWrite).toContain("run commands")
    expect(full).toContain("delete data")
    expect(new Set([read, readWrite, full]).size).toBe(3)
  })

  test("rejections explain the difference between read and write", () => {    expect(DEFAULT_POLICY.enabled).toBe(true)
    expect(DEFAULT_POLICY.allowlist).toEqual([])
    expect(readRejection({ ...DEFAULT_POLICY, enabled: false }, { state: "closed" })).toContain("disabled")
    expect(readRejection({ ...DEFAULT_POLICY, enabled: true }, { state: "closed" })).toContain("read permission")
    expect(
      writeRejection(
        { ...DEFAULT_POLICY, enabled: true },
        { state: "open", scope: "process", grantedAt: 0, read: true, write: false, execute: false, mode: "read" },
      ),
    ).toContain("read-write")
  })
})
