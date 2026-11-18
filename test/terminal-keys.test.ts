import { describe, expect, test } from "bun:test"
import { keysToBytes } from "../lib/terminal-keys"

/**
 * Contract these tests protect: what the human types in the panel reaches the PTY byte for byte.
 * This is the keyboard half of T051 — the RPC half is covered by `gui-bundle.test.ts`, which drives
 * this module through the built bundle.
 */

describe("keysToBytes", () => {
  test("sends a printable character as it is", () => {
    expect(keysToBytes({ key: "a" })).toBe("a")
    expect(keysToBytes({ key: "ñ" })).toBe("ñ")
  })

  test("sends a capital letter typed with shift", () => {
    expect(keysToBytes({ key: "A", shiftKey: true })).toBe("A")
  })

  test("ends a line with carriage return, not line feed", () => {
    expect(keysToBytes({ key: "Enter" })).toBe("\r")
  })

  test("sends tab and shift+tab", () => {
    expect(keysToBytes({ key: "Tab" })).toBe("\t")
    expect(keysToBytes({ key: "Tab", shiftKey: true })).toBe("\u001b[Z")
  })

  test("sends backspace and escape the way a terminal reports them", () => {
    expect(keysToBytes({ key: "Backspace" })).toBe("\u007f")
    expect(keysToBytes({ key: "Escape" })).toBe("\u001b")
  })

  test("sends the arrow and navigation keys", () => {
    expect(keysToBytes({ key: "ArrowUp" })).toBe("\u001b[A")
    expect(keysToBytes({ key: "ArrowDown" })).toBe("\u001b[B")
    expect(keysToBytes({ key: "ArrowRight" })).toBe("\u001b[C")
    expect(keysToBytes({ key: "ArrowLeft" })).toBe("\u001b[D")
    expect(keysToBytes({ key: "Home" })).toBe("\u001b[H")
    expect(keysToBytes({ key: "End" })).toBe("\u001b[F")
    expect(keysToBytes({ key: "Delete" })).toBe("\u001b[3~")
  })

  test("turns ctrl+letter into its control code", () => {
    expect(keysToBytes({ key: "c", ctrlKey: true })).toBe("\u0003")
    expect(keysToBytes({ key: "d", ctrlKey: true })).toBe("\u0004")
    expect(keysToBytes({ key: "Z", ctrlKey: true })).toBe("\u001a")
  })

  test("sends ctrl+backspace, ctrl+space and the punctuation pairs", () => {
    expect(keysToBytes({ key: "Backspace", ctrlKey: true })).toBe("\u0008")
    expect(keysToBytes({ key: " ", ctrlKey: true })).toBe("\u0000")
    expect(keysToBytes({ key: "[", ctrlKey: true })).toBe("\u001b")
    expect(keysToBytes({ key: "]", ctrlKey: true })).toBe("\u001d")
  })

  test("keeps ctrl+arrow in the xterm modifier form both readline and PSReadLine read", () => {
    expect(keysToBytes({ key: "ArrowLeft", ctrlKey: true })).toBe("\u001b[1;5D")
    expect(keysToBytes({ key: "PageUp", ctrlKey: true })).toBe("\u001b[5;5~")
  })

  test("prefixes alt+key with escape", () => {
    expect(keysToBytes({ key: "b", altKey: true })).toBe("\u001bb")
  })

  test("leaves command shortcuts to the application", () => {
    expect(keysToBytes({ key: "k", metaKey: true })).toBeNull()
    expect(keysToBytes({ key: "Enter", metaKey: true })).toBeNull()
  })

  test("types an AltGr character instead of making it a control code", () => {
    // Windows reports AltGr as ctrl+alt; `@` on a Spanish layout arrives this way.
    expect(keysToBytes({ key: "@", ctrlKey: true, altKey: true })).toBe("@")
  })

  test("returns null for keys that are not the terminal's", () => {
    expect(keysToBytes({ key: "F5" })).toBeNull()
    expect(keysToBytes({ key: "Shift" })).toBeNull()
    expect(keysToBytes({ key: "" })).toBeNull()
  })
})
