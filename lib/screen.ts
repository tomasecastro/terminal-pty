/**
 * Renders the PTY's raw tail as the text a person sees in the panel.
 *
 * The panel shows the *same* bytes the assistant reads, but the assistant path strips every escape
 * sequence, which loses the redraws an interactive shell depends on: PowerShell's line editor
 * (PSReadLine) rewrites the current line with `\r`, `CSI K`, `CSI <n> G` and cursor moves. Stripping
 * those leaves duplicated and half-erased lines, so typing in the panel would look broken.
 *
 * This module therefore replays the subset of VT100 that an interactive line editor and ordinary
 * command output use, and nothing else:
 *
 *  - `\r` and `\n`, `\b`, `\t`
 *  - `CSI <n> A|B|C|D` (cursor up/down/right/left), `CSI <n> G` (column), `CSI <n> K` (erase in line),
 *    `CSI <n> J` (erase display, `2` and `3`)
 *  - every other escape sequence is dropped, including colors, OSC titles and private modes
 *
 * It is deliberately *not* a terminal emulator: there is no alternate screen, no scroll region and no
 * wrapping (the view scrolls horizontally). A full-screen program therefore renders as its last
 * written lines; the panel says so instead of pretending otherwise, and the AI path already reports
 * `fullScreenApp` on its own.
 *
 * Kept free of the host SDK, `effect` and `node-pty` so it stays pure and testable.
 */

/** Columns a tab advances to. Terminal default. */
const TAB_STOP = 8

export interface ScreenOptions {
  /** Trailing rows to keep. Defaults to 400, matching the panel's read window. */
  readonly lines?: number
}

/**
 * Replays `raw` and returns the resulting text, one row per line, trailing spaces trimmed.
 *
 * @param raw - Raw PTY output, escape sequences included.
 * @param options - {@link ScreenOptions}.
 * @returns The visible text, joined with `\n`.
 */
export function renderScreenText(raw: string, options: ScreenOptions = {}): string {
  const rows: string[] = [""]
  let row = 0
  let column = 0
  let index = 0

  const rowAt = (target: number): string => {
    while (rows.length <= target) rows.push("")
    return rows[target] ?? ""
  }

  const write = (character: string) => {
    const current = rowAt(row)
    const padding = current.length < column ? " ".repeat(column - current.length) : ""
    const line = padding.length > 0 ? current + padding : current
    rows[row] = line.slice(0, column) + character + line.slice(column + character.length)
    column += character.length
  }

  const eraseInLine = (mode: number) => {
    const current = rowAt(row)
    if (mode === 1) rows[row] = " ".repeat(Math.min(column, current.length)) + current.slice(column)
    else if (mode === 2) rows[row] = ""
    else rows[row] = current.slice(0, column)
  }

  while (index < raw.length) {
    const character = raw[index] ?? ""

    if (character === "\u001b") {
      const escape = readEscape(raw, index)
      index += escape.length
      if (escape.kind !== "csi") continue

      switch (escape.command) {
        case "A":
          row = Math.max(0, row - escape.amount)
          break
        case "B":
          row += escape.amount
          break
        case "C":
          column += escape.amount
          break
        case "D":
          column = Math.max(0, column - escape.amount)
          break
        case "G":
          column = Math.max(0, escape.amount - 1)
          break
        case "K":
          eraseInLine(escape.amount)
          break
        case "J":
          if (escape.amount === 2 || escape.amount === 3) {
            rows.length = 0
            rows.push("")
            row = 0
            column = 0
          }
          break
        default:
          break
      }

      continue
    }

    index += 1

    if (character === "\n") {
      row += 1
      column = 0
      rowAt(row)
      continue
    }

    if (character === "\r") {
      column = 0
      continue
    }

    if (character === "\b") {
      column = Math.max(0, column - 1)
      continue
    }

    if (character === "\t") {
      column += TAB_STOP - (column % TAB_STOP)
      continue
    }

    // Control characters would corrupt the text view; the panel sends the user's own control keys
    // to the PTY, it never renders them.
    if (character < " " || character === "\u007f") continue

    write(character)
  }

  const visible = rows.map((line) => line.trimEnd())
  while (visible.length > 0 && visible[visible.length - 1] === "") visible.pop()

  const limit = options.lines ?? 400
  return visible.slice(Math.max(0, visible.length - limit)).join("\n")
}

type Escape =
  | { readonly kind: "other"; readonly length: number }
  | { readonly kind: "csi"; readonly length: number; readonly amount: number; readonly command: string }

/**
 * Reads one escape sequence starting at `start` (which holds `ESC`).
 *
 * Unknown introductions are consumed conservatively as two characters, so a stray `ESC` never eats
 * the text that follows it.
 */
function readEscape(text: string, start: number): Escape {
  const next = text[start + 1] ?? ""

  // CSI: `ESC [` parameters, intermediates, then one final byte in 0x40..0x7e.
  if (next === "[") {
    let cursor = start + 2
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor)
      if (code >= 0x40 && code <= 0x7e) break
      cursor += 1
    }
    if (cursor >= text.length) return { kind: "other", length: text.length - start }

    const body = text.slice(start + 2, cursor)
    const command = text[cursor] ?? ""
    // Private and intermediate forms (`ESC [ ? 25 l`) carry no text position; treat them as opaque.
    if (!/^[0-9;]*$/.test(body)) return { kind: "other", length: cursor - start + 1 }

    const first = body.split(";")[0] ?? ""
    const amount = first.length === 0 ? 0 : Number.parseInt(first, 10)
    return {
      kind: "csi",
      length: cursor - start + 1,
      amount: Number.isFinite(amount) ? amount : 0,
      command,
    }
  }

  // OSC: `ESC ]` runs to BEL or ST.
  if (next === "]") {
    const bel = text.indexOf("\u0007", start + 2)
    const st = text.indexOf("\u001b\\", start + 2)
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
    if (end === -1) return { kind: "other", length: text.length - start }
    return { kind: "other", length: (end === bel ? end + 1 : end + 2) - start }
  }

  return { kind: "other", length: next === "" ? 1 : 2 }
}
