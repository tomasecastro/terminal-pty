/**
 * Minimal ANSI/VT100 helpers.
 *
 * The human terminal receives raw bytes. Everything the AI reads goes through `stripAnsi`
 * so escape sequences never leak into model context.
 */

// CSI, OSC (BEL or ST terminated), and single-character escapes.
const ANSI_PATTERN =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

/** Splits on LF, dropping a trailing CR. CR-only progress updates stay on the same line. */
export function splitLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
}

/** Returns the last `count` lines of `text` (1-based count, clamped to what exists). */
export function lastLines(text: string, count: number): string {
  if (count <= 0) return ""
  const lines = splitLines(text)
  return lines.slice(Math.max(0, lines.length - count)).join("\n")
}

/** Collapses carriage-return progress output to its final rendered state. */
export function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part.length > 0)
      return parts.length > 0 ? parts[parts.length - 1] : line
    })
    .join("\n")
}

export const ALT_SCREEN_ON = /\u001b\[\?(?:1049|1047|47)h/
export const ALT_SCREEN_OFF = /\u001b\[\?(?:1049|1047|47)l/
export const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/
