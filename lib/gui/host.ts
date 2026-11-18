import { renderScreenText } from "../screen"
import type { SessionStatus, TerminalEngine } from "../types"
import type { PanelView } from "./protocol"

/**
 * The panel's side of the RPC: plain functions over the plugin's own PTY.
 *
 * Kept free of `effect` and the RPC runtime so the whole mapping is testable with a fake terminal;
 * `src/index.ts` only wraps each function in `Effect.sync`/`Effect.promise` and registers it.
 *
 * The one rule that matters here: this path never touches the assistant's gates. It calls
 * `humanView`, `write` (which the implementation routes to `SessionManager.writeHuman`),
 * `submit` (line mode, `SessionManager.submitHumanLine`) and `line` (the open local line, which
 * queues AI writes until it closes), and `humanView` is the *unblinded* view —
 * the person typing a password must see their own prompt.
 * The withheld view stays where it belongs: `terminal_pty_read_terminal`.
 */

/** Default trailing rows the panel shows. Kept modest so each poll stays small. */
export const PANEL_LINES = 400

/** Longest keystroke payload accepted in one call, so a runaway paste cannot flood the PTY. */
export const MAX_WRITE_BYTES = 65_536

export interface PanelScreen {
  /** Raw buffer tail, escape sequences included; rendered here, not by the caller. */
  readonly text: string
  readonly seq: number
  /** The detector is holding a credential prompt, so the panel must mask the local line. */
  readonly blinded: boolean
  readonly status: SessionStatus
  readonly fullScreenApp: string | null
  readonly title: string
  readonly cwd: string | null
  readonly foregroundProcess: string | null
}

/** What the handlers need from the plugin's PTY engine. `LocalTerminal` satisfies it. */
export interface PanelTerminal {
  has(sessionID: string): boolean
  open(sessionID: string, cwd?: string): Promise<{ readonly sessionID: string }>
  /** Unblinded view of the same buffer the tools read. */
  humanView(sessionID: string, lines?: number): PanelScreen | null
  /** Human input path. The implementation must use `SessionManager.writeHuman`. */
  write(sessionID: string, data: string): void
  /** Human line mode path: one composed line, terminated by the server. */
  submit(sessionID: string, line: string): void
  /** The human's local line is open (`true`) or closed (`false`); see `PanelRpc.line`. */
  line(sessionID: string, active: boolean): void
  resize(sessionID: string, cols: number, rows: number): void
}

export interface PanelHandlers {
  open(input: { readonly sessionID: string; readonly cwd?: string }): Promise<PanelView>
  read(input: { readonly sessionID: string; readonly lines?: number; readonly sinceSeq?: number }): PanelView
  write(input: { readonly sessionID: string; readonly data: string }): { readonly written: boolean }
  submit(input: { readonly sessionID: string; readonly line: string }): { readonly submitted: boolean }
  line(input: { readonly sessionID: string; readonly active: boolean }): { readonly active: boolean }
  resize(input: { readonly sessionID: string; readonly cols: number; readonly rows: number }): {
    readonly resized: boolean
  }
}

/**
 * Builds the panel handlers over one PTY engine.
 *
 * @param terminal - The plugin's PTY engine.
 * @param engine - Which engine is running, reported in every view.
 * @returns The handlers, keyed exactly as {@link PanelRpc} declares its methods.
 */
export function panelHandlers(terminal: PanelTerminal, engine: () => TerminalEngine): PanelHandlers {
  return {
    async open(input) {
      if (!terminal.has(input.sessionID)) {
        try {
          await terminal.open(input.sessionID, input.cwd)
        } catch (error) {
          return missing(engine(), "spawn-failed", error instanceof Error ? error.message : String(error))
        }
      }
      return view(terminal, input.sessionID, PANEL_LINES, engine(), undefined)
    },

    read(input) {
      const lines = clamp(input.lines ?? PANEL_LINES, 1, 2000)
      return view(terminal, input.sessionID, lines, engine(), input.sinceSeq)
    },

    write(input) {
      if (!terminal.has(input.sessionID)) return { written: false }
      const data = input.data.slice(0, MAX_WRITE_BYTES)
      if (data.length === 0) return { written: false }
      terminal.write(input.sessionID, data)
      return { written: true }
    },

    submit(input) {
      if (!terminal.has(input.sessionID)) return { submitted: false }
      // An empty line is a valid submission: a bare Enter answers a prompt with its default.
      terminal.submit(input.sessionID, input.line.slice(0, MAX_WRITE_BYTES))
      return { submitted: true }
    },

    line(input) {
      // No session, no line to hold: say `false` instead of claiming the server will queue.
      if (!terminal.has(input.sessionID)) return { active: false }
      terminal.line(input.sessionID, input.active)
      return { active: input.active }
    },

    resize(input) {
      if (!terminal.has(input.sessionID)) return { resized: false }
      const cols = clamp(input.cols, 20, 500)
      const rows = clamp(input.rows, 5, 200)
      terminal.resize(input.sessionID, cols, rows)
      return { resized: true }
    },
  }
}

/** One view, rendered unless the caller already holds this `seq`. */
function view(
  terminal: PanelTerminal,
  sessionID: string,
  lines: number,
  engine: TerminalEngine,
  sinceSeq: number | undefined,
): PanelView {
  const screen = terminal.humanView(sessionID, lines)
  if (!screen) return missing(engine, "no-terminal")

  const current = sinceSeq === screen.seq
  // A full-screen program writes the alternate buffer; replaying it as text is worse than saying so.
  const text = current || screen.fullScreenApp !== null ? "" : renderScreenText(screen.text, { lines })

  return {
    attached: true,
    blinded: screen.blinded,
    text,
    seq: screen.seq,
    status: screen.status,
    title: screen.title,
    cwd: screen.cwd,
    foregroundProcess: screen.foregroundProcess,
    fullScreenApp: screen.fullScreenApp,
    engine,
  }
}

function missing(engine: TerminalEngine, reason: string, message?: string): PanelView {
  return {
    attached: false,
    blinded: false,
    text: "",
    seq: 0,
    status: "closed",
    title: "",
    cwd: null,
    foregroundProcess: null,
    fullScreenApp: null,
    engine,
    reason: message ? `${reason}: ${message}` : reason,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(Math.max(Math.trunc(value), minimum), maximum)
}
