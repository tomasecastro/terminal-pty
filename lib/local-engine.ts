import { type ShellSpec } from "./local-shell"
import type { PanelScreen, PanelTerminal } from "./gui/host"
import type { SessionManager } from "./session-manager"
import { sessionTitle, viewFromSession, type TerminalView } from "./terminal-view"
import type { LocalShellTarget, SessionInfo, TerminalEngine } from "./types"

/**
 * The plugin's own PTY engine, as the tools see it.
 *
 * Wraps a `SessionManager` wired to a `LocalShellConnector`, so the tools never touch the PTY
 * directly and the whole surface can be exercised with an in-memory spawner.
 */

export interface LocalSessionHandle {
  readonly sessionID: string
  readonly pid: number | null
  readonly shell: string
  readonly cwd: string
  readonly engine: TerminalEngine
}

export interface LocalTerminalDeps {
  /** Spawns or reuses the shell for this session. Throws when the PTY cannot start. */
  open(sessionID: string, cwd?: string): Promise<LocalSessionHandle>
  /** Destroys the session's shell. Returns false when there was none. */
  kill(sessionID: string): boolean
  /** Whether a live local session exists. Never throws. */
  has(sessionID: string): boolean
  /** True while a credential prompt is on screen. */
  blinded(sessionID: string): boolean
  /** Snapshot mapped to `TerminalView`, or null when there is no local session. */
  view(sessionID: string, lines?: number): TerminalView | null
  /** Writes already-approved machine input to the PTY. */
  write(sessionID: string, data: string): void
}

export interface LocalTerminalOptions {
  /** Reported to the tools. Defaults to `local-pty`. */
  readonly engine?: TerminalEngine
}

/** What `LocalTerminal` needs from the connector: its shell and its working directory. */
export interface ShellLauncher {
  readonly shell: ShellSpec
  cwdFor(target?: Pick<LocalShellTarget, "cwd">): string
}

export class LocalTerminal implements LocalTerminalDeps {
  readonly #manager: SessionManager
  readonly #launcher: ShellLauncher
  readonly #engine: TerminalEngine

  constructor(manager: SessionManager, launcher: ShellLauncher, options: LocalTerminalOptions = {}) {
    this.#manager = manager
    this.#launcher = launcher
    this.#engine = options.engine ?? "local-pty"
  }

  /** Spawns the shell once per session; later calls return the live one. */
  async open(sessionID: string, cwd?: string): Promise<LocalSessionHandle> {
    if (this.#manager.has(sessionID)) return this.#describe(this.#manager.info(sessionID))

    const directory = cwd ?? this.#launcher.cwdFor()
    const info = await this.#manager.create({
      id: sessionID,
      target: { kind: "local", cwd: directory },
    })
    return this.#describe(info)
  }

  kill(sessionID: string): boolean {
    if (!this.#manager.has(sessionID)) return false
    this.#manager.destroy(sessionID)
    return true
  }

  has(sessionID: string): boolean {
    return this.#manager.has(sessionID)
  }

  blinded(sessionID: string): boolean {
    return this.#manager.info(sessionID).blinded
  }

  view(sessionID: string, lines?: number): TerminalView | null {
    if (!this.#manager.has(sessionID)) return null
    return viewFromSession(this.#manager.info(sessionID), this.#manager.snapshot(sessionID, lines))
  }

  write(sessionID: string, data: string): void {
    this.#manager.writeAi(sessionID, data)
  }

  /**
   * The visible terminal's view: the raw tail of the same buffer, unblinded, for the panel.
   *
   * Not part of `LocalTerminalDeps` on purpose: the tools' contract has exactly one read path
   * (`view`, already blinded), and this one must stay outside it.
   */
  humanView(sessionID: string, lines?: number): PanelScreen | null {
    if (!this.#manager.has(sessionID)) return null

    const info = this.#manager.info(sessionID)
    const snapshot = this.#manager.humanSnapshot(sessionID, lines)
    return {
      text: snapshot.text,
      seq: snapshot.seq,
      blinded: snapshot.blinded,
      status: snapshot.status,
      fullScreenApp: snapshot.fullScreenApp,
      title: sessionTitle(info),
      cwd: info.cwd ?? null,
      foregroundProcess: snapshot.fullScreenApp ?? info.foregroundProcess ?? null,
    }
  }

  /** Human input, through the PTY's owned write path. Never logged, never broadcast. */
  humanWrite(sessionID: string, data: string): void {
    this.#manager.writeHuman(sessionID, data)
  }

  /**
   * A whole line the human submitted from the panel's line input.
   *
   * The line was composed in the window, so this is the moment it becomes PTY input: one write,
   * terminated, through the same lock the AI writes use. The content is never logged.
   */
  submitHumanLine(sessionID: string, line: string): void {
    this.#manager.submitHumanLine(sessionID, line)
  }

  /**
   * The panel's `line` RPC: the human's local line is open or closed (T019).
   *
   * Names the human door once, like `humanWrite` and `submitHumanLine`: it never writes to the PTY,
   * only tells the lock whether an approved AI write has to wait. On `false` the queued writes are
   * released, in approval order, the same way a submit releases them.
   */
  noteHumanLine(sessionID: string, active: boolean): void {
    this.#manager.noteHumanLine(sessionID, active)
  }

  resize(sessionID: string, cols: number, rows: number): void {
    this.#manager.resize(sessionID, cols, rows)
  }

  /**
   * The adapter the panel's RPC handlers use.
   *
   * It exists so the human paths are named once, here, next to `writeAi`: the panel's `write` is
   * `writeHuman`, and calling `LocalTerminal.write` (which is `writeAi`, the approved-machine path)
   * from the RPC would put the human's keys through the assistant's door.
   */
  panel(): PanelTerminal {
    return {
      has: (sessionID) => this.has(sessionID),
      open: (sessionID, cwd) => this.open(sessionID, cwd),
      humanView: (sessionID, lines) => this.humanView(sessionID, lines),
      write: (sessionID, data) => this.humanWrite(sessionID, data),
      submit: (sessionID, line) => this.submitHumanLine(sessionID, line),
      line: (sessionID, active) => this.noteHumanLine(sessionID, active),
      resize: (sessionID, cols, rows) => this.resize(sessionID, cols, rows),
    }
  }

  #describe(info: SessionInfo): LocalSessionHandle {
    return {
      sessionID: info.id,
      // `node-pty` reports 0 for ConPTY sessions on Windows; report "unknown" instead of a fake pid.
      pid: info.pid !== undefined && info.pid > 0 ? info.pid : null,
      shell: info.shell ?? this.#launcher.shell.file,
      cwd: info.cwd ?? this.#launcher.cwdFor(),
      engine: this.#engine,
    }
  }
}
