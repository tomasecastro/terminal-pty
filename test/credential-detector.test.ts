import { describe, expect, test } from "bun:test"
import { CredentialDetector } from "../lib/credential-detector"

describe("CredentialDetector", () => {
  test("detects an SSH password prompt and blinds the session", () => {
    const detector = new CredentialDetector({ now: () => 1_000 })
    const prompt = detector.inspect("deploy@srv-01's password: ")

    expect(prompt?.kind).toBe("password")
    expect(detector.blinded).toBe(true)
  })

  test("detects a prompt split across two chunks", () => {
    const detector = new CredentialDetector({ now: () => 1_000 })
    expect(detector.inspect("deploy@srv-01's pass")).toBeNull()

    const prompt = detector.inspect("word: ")
    expect(prompt?.kind).toBe("password")
  })

  test("detects sudo, passphrase and MFA prompts", () => {
    const sudo = new CredentialDetector({ now: () => 1_000 })
    expect(sudo.inspect("[sudo] password for ops: ")?.kind).toBe("sudo")

    const passphrase = new CredentialDetector({ now: () => 1_000 })
    expect(passphrase.inspect("Enter passphrase for key '/home/ops/.ssh/id_ed25519': ")?.kind).toBe("passphrase")

    const mfa = new CredentialDetector({ now: () => 1_000 })
    expect(mfa.inspect("Verification code: ")?.kind).toBe("mfa")
  })

  test("reports host-key confirmation without blinding", () => {
    const detector = new CredentialDetector({ now: () => 1_000 })
    const prompt = detector.inspect("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")

    expect(prompt?.kind).toBe("host-key")
    expect(detector.blinded).toBe(false)
  })

  test("clears blinding once authentication succeeds", () => {
    let now = 1_000
    const detector = new CredentialDetector({ now: () => now })
    detector.observe("ops@srv-01's password: ")
    expect(detector.blinded).toBe(true)

    now = 1_500
    detector.observe("\nLast login: Tue Nov 11 09:12:44 2026 from 10.0.0.4\n")
    expect(detector.blinded).toBe(false)
  })

  test("stays blinded for the configured window without a success marker", () => {
    let now = 1_000
    const detector = new CredentialDetector({ now: () => now, blindWindowMs: 5_000 })
    detector.inspect("Password: ")

    now = 5_999
    expect(detector.blinded).toBe(true)

    now = 6_000
    expect(detector.blinded).toBe(false)
  })

  test("suppresses duplicate reports inside the cooldown window", () => {
    const detector = new CredentialDetector({ now: () => 1_000, cooldownMs: 250 })
    expect(detector.inspect("Password: ")?.kind).toBe("password")
    expect(detector.inspect("Password: ")).toBeNull()
  })
})
