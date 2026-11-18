import { describe, expect, test } from "bun:test"
import { replayTail, ReconnectPolicy, withReconnect } from "../lib/reconnect"

describe("ReconnectPolicy", () => {
  test("backs off exponentially with full jitter", () => {
    const policy = new ReconnectPolicy({ baseDelayMs: 500, maxDelayMs: 10_000, random: () => 0 })

    expect(policy.nextDelay(1)).toBe(250)
    expect(policy.nextDelay(2)).toBe(500)
    expect(policy.nextDelay(3)).toBe(1_000)
  })

  test("caps the delay at maxDelayMs", () => {
    const policy = new ReconnectPolicy({ baseDelayMs: 1_000, maxDelayMs: 2_000, maxAttempts: 10, random: () => 1 })

    expect(policy.nextDelay(10)).toBe(2_000)
  })

  test("returns null once attempts are exhausted", () => {
    const policy = new ReconnectPolicy({ maxAttempts: 2, random: () => 0 })

    expect(policy.nextDelay(3)).toBeNull()
    expect(policy.nextDelay(0)).toBeNull()
  })
})

describe("withReconnect", () => {
  test("retries until the attempt succeeds", async () => {
    const attempts: number[] = []
    const result = await withReconnect(
      {
        policy: new ReconnectPolicy({ maxAttempts: 5, random: () => 0 }),
        sleep: async () => {},
      },
      async (n) => {
        attempts.push(n)
        if (n < 3) throw new Error(`fail ${n}`)
        return "ok"
      },
    )

    expect(result).toBe("ok")
    expect(attempts).toEqual([1, 2, 3])
  })

  test("rethrows the last error when attempts run out", async () => {
    await expect(
      withReconnect({ policy: new ReconnectPolicy({ maxAttempts: 2, random: () => 0 }), sleep: async () => {} }, async () => {
        throw new Error("nope")
      }),
    ).rejects.toThrow("nope")
  })

  test("reports each retry", async () => {
    const retries: number[] = []
    await withReconnect(
      {
        policy: new ReconnectPolicy({ maxAttempts: 3, random: () => 0 }),
        sleep: async () => {},
        onRetry: (info) => retries.push(info.attempt),
      },
      async (n) => {
        if (n === 1) throw new Error("first")
        return "done"
      },
    )

    expect(retries).toEqual([1])
  })
})

describe("replayTail", () => {
  test("keeps only the requested tail", () => {
    const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n")
    expect(replayTail(text, 2)).toBe("line 3\nline 4")
  })
})
