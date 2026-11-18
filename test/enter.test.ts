import { describe, expect, test } from "bun:test"
import { submitSuffix, terminate } from "../lib/enter"

/**
 * The bug this file exists for: writing `\n` into ConPTY inserts a line in the PSReadLine buffer
 * instead of running it, so the shell answers with `>>` and the command never executes. These
 * tests pin the terminator per platform and make the guarantee impossible to lose silently.
 */

describe("submitSuffix", () => {
  test("is CR on Windows", () => {
    expect(submitSuffix({ platform: "win32" })).toBe("\r")
  })

  test("is LF on POSIX", () => {
    expect(submitSuffix({ platform: "linux" })).toBe("\n")
    expect(submitSuffix({ platform: "darwin" })).toBe("\n")
  })

  test("follows the current platform when not told otherwise", () => {
    expect(submitSuffix()).toBe(process.platform === "win32" ? "\r" : "\n")
  })
})

describe("terminate", () => {
  test("appends exactly one terminator", () => {
    expect(terminate("echo hi", { platform: "win32" })).toBe("echo hi\r")
    expect(terminate("echo hi", { platform: "linux" })).toBe("echo hi\n")
  })

  test("replaces a trailing LF with CR on Windows", () => {
    expect(terminate("echo hi\n", { platform: "win32" })).toBe("echo hi\r")
    expect(terminate("echo hi\r\n", { platform: "win32" })).toBe("echo hi\r")
    expect(terminate("echo hi\r\n\r\n", { platform: "win32" })).toBe("echo hi\r")
  })

  test("replaces a trailing CR with LF on POSIX", () => {
    expect(terminate("echo hi\r", { platform: "linux" })).toBe("echo hi\n")
  })

  test("is idempotent", () => {
    for (const platform of ["win32", "linux"] as const) {
      const once = terminate("echo hi", { platform })
      expect(terminate(once, { platform })).toBe(once)
    }
  })

  test("keeps line breaks embedded in the command", () => {
    expect(terminate("first\rsecond", { platform: "win32" })).toBe("first\rsecond\r")
    expect(terminate("first\nsecond", { platform: "linux" })).toBe("first\nsecond\n")
  })

  test("submits an empty input as a bare Enter", () => {
    expect(terminate("", { platform: "win32" })).toBe("\r")
    expect(terminate("", { platform: "linux" })).toBe("\n")
  })
})
