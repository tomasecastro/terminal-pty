import { describe, expect, test } from "bun:test"
import { TuiDetector } from "../lib/tui-detector"

describe("TuiDetector", () => {
  test("tracks the alternate screen buffer", () => {
    const detector = new TuiDetector()
    detector.inspect("\u001b[?1049h")

    expect(detector.fullScreen).toBe(true)

    detector.inspect("\u001b[?1049l")
    expect(detector.fullScreen).toBe(false)
  })

  test("reads the application name from the OSC title", () => {
    const detector = new TuiDetector()
    const state = detector.inspect("\u001b]0;vim - notes.txt\u0007")

    expect(state.app).toBe("vim")
  })

  test("recognises htop and lazygit titles", () => {
    expect(new TuiDetector().inspect("\u001b]0;htop\u0007").app).toBe("htop")
    expect(new TuiDetector().inspect("\u001b]0;lazygit\u0007").app).toBe("lazygit")
  })

  test("leaves plain shell output alone", () => {
    const detector = new TuiDetector()
    const state = detector.inspect("total 12\ndrwxr-xr-x 2 ops ops 4096\n")

    expect(state.fullScreen).toBe(false)
    expect(state.app).toBeNull()
  })
})
