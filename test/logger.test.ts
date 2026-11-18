import { describe, expect, test } from "bun:test"
import { SessionLogger, redact } from "../lib/logger"

describe("SessionLogger", () => {
  test("serializes records as JSONL", () => {
    const logger = new SessionLogger({ sessionId: "s1", now: () => new Date("2026-11-11T10:00:00.000Z") })
    logger.record("ai-approved", { command: "uptime" })
    logger.record("session-exit", { exitCode: 0 })

    const lines = logger.exportJsonl().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      at: "2026-11-11T10:00:00.000Z",
      sessionId: "s1",
      kind: "ai-approved",
      data: { command: "uptime" },
    })
  })

  test("redacts secret-bearing keys", () => {
    const logger = new SessionLogger({ sessionId: "s1" })
    const record = logger.record("credential", {
      password: "hunter2",
      passphrase: "abc",
      token: "t",
      mfaCode: "123456",
      kind: "password",
    })

    expect(record.data).toEqual({
      password: "[redacted]",
      passphrase: "[redacted]",
      token: "[redacted]",
      mfaCode: "[redacted]",
      kind: "password",
    })
  })

  test("redacts nested objects", () => {
    expect(redact({ nested: { secret: "x", ok: 1 } })).toEqual({ nested: { secret: "[redacted]", ok: 1 } })
  })

  test("forwards each line to the sink", () => {
    const lines: string[] = []
    const logger = new SessionLogger({ sessionId: "s1", sink: (line) => lines.push(line) })
    logger.record("output", { bytes: 12 })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"kind":"output"')
  })
})
