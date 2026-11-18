import { describe, expect, test } from "bun:test"
import { BufferBroadcaster } from "../lib/buffer-broadcaster"

describe("BufferBroadcaster", () => {
  test("keeps completed lines and exposes the tail", () => {
    const buffer = new BufferBroadcaster({ now: () => 1 })
    buffer.push("one\ntwo\nthree\n")

    expect(buffer.lineCount).toBe(3)
    expect(buffer.snapshot(2)).toBe("two\nthree")
  })

  test("keeps an in-flight partial line visible in the snapshot", () => {
    const buffer = new BufferBroadcaster({ now: () => 1 })
    buffer.push("one\ntw")

    expect(buffer.snapshot()).toBe("one\ntw")
  })

  test("trims scrollback to maxLines", () => {
    const buffer = new BufferBroadcaster({ maxLines: 2, now: () => 1 })
    buffer.push("a\nb\nc\nd\n")

    expect(buffer.lineCount).toBe(2)
    expect(buffer.snapshot()).toBe("c\nd")
  })

  test("broadcasts raw chunks to every subscriber", () => {
    const buffer = new BufferBroadcaster({ now: () => 7 })
    const human: string[] = []
    const logger: number[] = []

    buffer.subscribe({ id: "h", kind: "human", write: (chunk) => human.push(chunk.data) })
    buffer.subscribe({ id: "l", kind: "logger", write: (chunk) => logger.push(chunk.seq) })

    buffer.push("\u001b[31mred\u001b[0m\n")

    expect(human).toEqual(["\u001b[31mred\u001b[0m\n"])
    expect(logger).toEqual([1])
    expect(buffer.subscriberCount).toBe(2)
  })

  test("unsubscribe stops delivery", () => {
    const buffer = new BufferBroadcaster({ now: () => 1 })
    const seen: string[] = []
    const unsubscribe = buffer.subscribe({ id: "h", kind: "human", write: (chunk) => seen.push(chunk.data) })

    buffer.push("a")
    unsubscribe()
    buffer.push("b")

    expect(seen).toEqual(["a"])
    expect(buffer.subscriberCount).toBe(0)
  })
})
