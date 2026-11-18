import { describe, expect, test } from "bun:test"
import { renderScreenText } from "../lib/screen"

/**
 * Contract these tests protect: the panel shows what the shell actually wrote, not a pile of
 * duplicated lines. An interactive line editor redraws the current line with `\r`, `CSI K` and
 * cursor moves; if those are merely stripped, typing in the visible terminal looks broken.
 */

describe("renderScreenText", () => {
  test("keeps plain output as it is", () => {
    expect(renderScreenText("hola\nmundo")).toBe("hola\nmundo")
  })

  test("collapses a carriage-return redraw to the last state", () => {
    expect(renderScreenText("progreso 10%\rprogreso 90%")).toBe("progreso 90%")
  })

  test("erases to the end of the line with CSI K", () => {
    // PSReadLine erases the rest of the line when the user shortens it or dismisses a suggestion.
    expect(renderScreenText("PS C:\\> hola\x1b[4D\x1b[Kecho")).toBe("PS C:\\> echo")
  })

  test("moves the cursor left before writing", () => {
    expect(renderScreenText("abc\x1b[2DXY")).toBe("aXY")
  })

  test("moves the cursor to a column with CSI G", () => {
    expect(renderScreenText("abcdef\x1b[3GX")).toBe("abXdef")
  })

  test("drops colours and other non-positional escapes", () => {
    expect(renderScreenText("\x1b[31mrojo\x1b[0m y \x1b]0;titulo\x07normal")).toBe("rojo y normal")
  })

  test("drops a private mode such as a hidden cursor", () => {
    expect(renderScreenText("\x1b[?25lpwd\x1b[?25h")).toBe("pwd")
  })

  test("advances tabs to the next stop", () => {
    expect(renderScreenText("a\tb")).toBe("a       b")
  })

  test("clears the display with CSI 2J", () => {
    expect(renderScreenText("viejo\x1b[2Jnuevo")).toBe("nuevo")
  })

  test("drops trailing spaces and trailing empty lines", () => {
    expect(renderScreenText("linea   \n\n")).toBe("linea")
  })

  test("keeps only the trailing rows it is asked for", () => {
    expect(renderScreenText("uno\ndos\ntres", { lines: 2 })).toBe("dos\ntres")
  })

  test("overwrites a shorter line completely instead of gluing text", () => {
    expect(renderScreenText("echo hola\r\x1b[2Khola")).toBe("hola")
  })

  test("ignores a truncated escape at the end of the buffer", () => {
    expect(renderScreenText("texto\x1b[")).toBe("texto")
  })

  test("replays a backspace over a mistyped character", () => {
    // The person typed `s`, corrected it, and kept typing: `$ s\bssh` is one command, not three.
    expect(renderScreenText("$ s\bssh")).toBe("$ ssh")
    expect(renderScreenText("e\becho test")).toBe("echo test")
  })

  test("replays a PSReadLine repaint as the single line the person sees", () => {
    // What PSReadLine sends when it rewrites the line: the typed prefix, a cursor move back and the
    // whole line again. Stripping the escapes instead of replaying them glues the fragments into
    // `e\becho tesecho test`, which is the garbage the assistant used to read and act on.
    expect(renderScreenText("e\becho tes\x1b[9D\x1b[Kecho test")).toBe("echo test")
  })

  test("leaves no backspace, carriage return or escape in the rendered text", () => {
    const rendered = renderScreenText("$ s\bssh\r\x1b[Kecho test\x1b[?25l\tdone\x07")

    expect(rendered).not.toContain("\b")
    expect(rendered).not.toContain("\r")
    expect(rendered).not.toContain("\u001b")
    expect(rendered).not.toContain("\u0007")
    expect(rendered).toBe("echo test       done")
  })

  test("is idempotent: rendering an already rendered screen changes nothing", () => {
    const samples = [
      "",
      "echo test",
      "$ ssh",
      "progreso 90%",
      "total 0\n-rw-r--r-- 1 ops ops 0 Nov 11 09:12 notas.txt\nops@srv-01:~$ ",
      "a       b",
      "linea",
      "e\becho tes\x1b[9D\x1b[Kecho test",
    ]

    for (const sample of samples) {
      const rendered = renderScreenText(sample)
      expect(renderScreenText(rendered)).toBe(rendered)
    }
  })
})
