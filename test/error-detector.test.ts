import { describe, expect, test } from "bun:test"
import { detectErrors, shouldProposeAnalysis } from "../lib/ai/error-detector"

describe("detectErrors", () => {
  test("finds runtime failures with line numbers", () => {
    const findings = detectErrors("starting\nerror\nTraceback (most recent call last):\n  File \"app.py\"\n")

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ pattern: "python-traceback", category: "runtime", lineNumber: 3 })
  })

  test("finds service and resource failures", () => {
    const findings = detectErrors("Active: failed (Result: exit-code)\nNo space left on device\n")

    expect(findings.map((finding) => finding.pattern)).toEqual(["systemd-failed", "disk-full"])
  })

  test("finds network and permission failures", () => {
    const findings = detectErrors("curl: (7) Failed to connect: Connection refused\nbash: /etc/shadow: Permission denied\n")

    expect(findings.map((finding) => finding.category)).toEqual(["network", "permission"])
  })

  test("ignores escape sequences when matching", () => {
    const findings = detectErrors("\u001b[31merror TS2322: Type mismatch\u001b[0m\n")

    expect(findings[0]?.pattern).toBe("tsc-error")
    expect(findings[0]?.line).toBe("error TS2322: Type mismatch")
  })

  test("returns nothing for clean output", () => {
    expect(detectErrors("total 12\ndrwxr-xr-x 2 ops ops 4096\n")).toEqual([])
  })
})

describe("shouldProposeAnalysis", () => {
  test("triggers on errors but not on warnings alone", () => {
    expect(shouldProposeAnalysis(detectErrors("command not found\n"))).toBe(false)
    expect(shouldProposeAnalysis(detectErrors("Permission denied\n"))).toBe(true)
  })
})
