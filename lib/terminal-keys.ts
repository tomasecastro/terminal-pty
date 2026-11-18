/**
 * Human keyboard input as PTY bytes.
 *
 * ## The channel (T051)
 *
 * The panel is a `gui-experimental` bundle running in the desktop's window process; the PTY lives in
 * the OpenCode *server* process, inside the plugin's `SessionManager`. The two cannot share memory,
 * so the channel is:
 *
 *   `keydown` in the panel  →  `bytes` from this module  →  RPC `terminal-pty.panel.write`
 *     →  `LocalTerminal.humanWrite`  →  `SessionManager.writeHuman`  →  the same PTY the tools read.
 *
 * The RPC method calls `writeHuman`, never `writeAi`: human keystrokes are not a command proposal and
 * need no approval, and `writeHuman` is the only entry point that is never logged, never broadcast to
 * the assistant and never written to the audit trail. The assistant reaches the same PTY through
 * `terminal_pty_*`, which is the pair that *does* need a grant and an approval. One PTY, two doors,
 * each with its own gate.
 *
 * ## Why a mapping table and not `KeyboardEvent`
 *
 * The desktop reads `key` names, not hardware codes, so this module maps the small set of names a
 * terminal needs and returns `null` for everything else, which leaves the key to the application
 * (Cmd shortcuts, F5, browser reload). AltGr on Windows arrives as `ctrlKey && altKey`; it is a real
 * character on the user's keyboard, so it is typed, not turned into a control code.
 */

/** The fields this module reads from a key event. */
export interface KeyStroke {
  /** `KeyboardEvent.key`, e.g. `"a"`, `"Enter"`, `"ArrowUp"`. */
  readonly key: string
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
}

/** Named keys and the bytes they send, without modifiers. */
const NAMED: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "\u007f",
  Escape: "\u001b",
  Delete: "\u001b[3~",
  Insert: "\u001b[2~",
  Home: "\u001b[H",
  End: "\u001b[F",
  PageUp: "\u001b[5~",
  PageDown: "\u001b[6~",
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowRight: "\u001b[C",
  ArrowLeft: "\u001b[D",
}

/**
 * Bytes for one keystroke.
 *
 * @param stroke - The key event's fields.
 * @returns The bytes to write, or `null` when the key is not the terminal's.
 */
export function keysToBytes(stroke: KeyStroke): string | null {
  const { key } = stroke
  if (key.length === 0) return null

  // Command shortcuts belong to the application: copy, reload, and the rest.
  if (stroke.metaKey) return null

  // AltGr: a character composed by the keyboard layout, sent as typed.
  const altGraph = stroke.ctrlKey === true && stroke.altKey === true

  if (key === "Tab" && stroke.shiftKey === true) return "\u001b[Z"

  const named = NAMED[key]
  if (named !== undefined) {
    // Ctrl turns the navigation keys into their word/line variants, as xterm reports them.
    if (stroke.ctrlKey === true && !altGraph) return controlNamed(key, named)
    return stroke.altKey === true ? `\u001b${named}` : named
  }

  if (key.length !== 1) return null
  if (altGraph) return key

  if (stroke.ctrlKey === true) {
    const control = controlByte(key)
    if (control !== null) return stroke.altKey === true ? `\u001b${control}` : control
    return null
  }

  if (stroke.altKey === true) return `\u001b${key}`

  return key
}

/** `^A`..`^Z`, plus the punctuation pairs a terminal defines. */
function controlByte(key: string): string | null {
  const upper = key.toUpperCase()
  if (upper.length === 1 && upper >= "A" && upper <= "Z") {
    return String.fromCharCode(upper.charCodeAt(0) - 64)
  }
  if (key === "[") return "\u001b"
  if (key === "\\") return "\u001c"
  if (key === "]") return "\u001d"
  if (key === "^") return "\u001e"
  if (key === "_") return "\u001f"
  if (key === " " || key === "@") return "\u0000"
  return null
}

/**
 * Named keys under Ctrl.
 *
 * Word-wise movement is not portable across shells, so these send the xterm modifier form
 * (`CSI 1 ; 5 <final>`), which both PowerShell (PSReadLine) and bash/readline understand.
 */
function controlNamed(key: string, plain: string): string {
  const final = plain.startsWith("\u001b[") ? plain.slice(2) : ""
  if (key === "Backspace") return "\u0008"
  if (final.length === 1) return `\u001b[1;5${final}`
  if (final.endsWith("~")) return `\u001b[${final.slice(0, -1)};5~`
  return plain
}
