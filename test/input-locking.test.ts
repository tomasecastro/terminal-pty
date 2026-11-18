import { describe, expect, test } from "bun:test"
import { InputLock } from "../lib/input-locking"

describe("InputLock", () => {
  test("blocks AI drain while the human is typing", () => {
    let now = 1_000
    const lock = new InputLock({ now: () => now, humanPriorityWindowMs: 1_000 })

    lock.enqueue("uptime")
    lock.noteHumanInput()

    expect(lock.humanActive).toBe(true)
    expect(lock.drain()).toEqual([])
    expect(lock.queued).toEqual(["uptime"])
  })

  test("releases queued commands once the human goes idle", () => {
    let now = 1_000
    const lock = new InputLock({ now: () => now, humanPriorityWindowMs: 1_000 })
    lock.enqueue("uptime")
    lock.noteHumanInput()

    now = 2_500
    expect(lock.drain()).toEqual(["uptime"])
    expect(lock.queued).toEqual([])
  })

  test("clear drops everything pending", () => {
    const lock = new InputLock({ now: () => 1_000 })
    lock.enqueue("a")
    lock.enqueue("b")
    lock.clear()

    expect(lock.queued).toEqual([])
  })

  test("an open line blocks the drain past the idle window", () => {
    let now = 1_000
    const lock = new InputLock({ now: () => now, humanPriorityWindowMs: 1_000 })
    lock.enqueue("dir")

    // The human is composing a line locally: no keystroke reaches the PTY, so this marker is what
    // tells the lock to keep the AI waiting.
    lock.humanLine()
    expect(lock.lineActive).toBe(true)

    // A whole idle window later the line is still theirs; the raw priority has expired but the
    // line has not been submitted.
    now = 5_000
    expect(lock.humanActive).toBe(false)
    expect(lock.drain()).toEqual([])
    expect(lock.queued).toEqual(["dir"])
  })

  test("submitting the line releases the queue immediately", () => {
    let now = 1_000
    const lock = new InputLock({ now: () => now, humanPriorityWindowMs: 1_000 })
    lock.enqueue("dir")
    lock.humanLine()

    now = 1_100
    lock.submitLine()

    expect(lock.lineActive).toBe(false)
    expect(lock.humanActive).toBe(false)
    expect(lock.drain()).toEqual(["dir"])
    expect(lock.queued).toEqual([])
  })
})
