import { describe, expect, test } from "bun:test"
import {
  createSessionDetectors,
  describeMissingTerminal,
  formatInfo,
  formatRead,
  formatWait,
  formatWithheld,
  WITHHELD,
  type TerminalView,
} from "../lib/terminal-view"

/**
 * Contract these tests protect: what the assistant may see, and what it must never see.
 * The logic is pure, so it is testable without a live terminal or the host runtime.
 */

function view(text: string): TerminalView {
  return { ptyID: "pty_1", title: "ssh prod", cwd: "/srv/app", foregroundProcess: "bash", text }
}

describe("terminal-view", () => {
  test("reports a missing terminal", () => {
    expect(describeMissingTerminal()).toContain("No terminal is attached")
  })

  test("returns the text and detects errors", () => {
    const result = formatRead(view("$ systemctl status api\nbash: systemctl: command not found"))
    const parsed = JSON.parse(result.content)
    expect(parsed.text).toContain("command not found")
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(result.metadata.blinded).toBe(false)
  })

  test("blinds the session on a password prompt", () => {
    const detectors = createSessionDetectors()
    expect(detectors.observe("ses_1", "[sudo] password for deploy: ")).toBe(true)
    expect(detectors.observe("ses_1", "anything")).toBe(true)
  })

  test("blinding is per session", () => {
    const detectors = createSessionDetectors()
    detectors.observe("ses_1", "Password: ")
    expect(detectors.observe("ses_2", "$ ls")).toBe(false)
  })

  test("withheld output never contains the prompt", () => {
    const result = formatWithheld("pty_1")
    expect(result.content).toBe(WITHHELD)
    expect(result.metadata.blinded).toBe(true)
    expect(result.content).not.toContain("password")
  })

  test("terminal_info hides contents while blinded", () => {
    const result = formatInfo(view("Password: secret"), true)
    const parsed = JSON.parse(result.content)
    expect(parsed.blinded).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain("Password:")
    expect(JSON.stringify(parsed)).not.toContain("secret")
  })

  test("wait reports blindness instead of matching", () => {
    const result = formatWait(false, true, WITHHELD)
    const parsed = JSON.parse(result.content)
    expect(parsed.matched).toBe(false)
    expect(parsed.blinded).toBe(true)
    expect(parsed.text).toBe(WITHHELD)
  })
})
