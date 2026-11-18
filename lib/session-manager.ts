import { ALT_SCREEN_OFF, ALT_SCREEN_ON, OSC_TITLE } from "./ansi"
import { BufferBroadcaster } from "./buffer-broadcaster"
import { CredentialDetector } from "./credential-detector"
import { terminate } from "./enter"
import { DEFAULT_HUMAN_PRIORITY_WINDOW_MS, InputLock } from "./input-locking"
import { defaultCwd, LocalShellConnector, shellName } from "./local-shell"
import { SessionLogger } from "./logger"
import { renderScreenText } from "./screen"
import { SSHConnector } from "./ssh-connector"
import { TuiDetector } from "./tui-detector"
import { isLocalTarget } from "./types"
import type {
  BufferChunk,
  CommandProposal,
  CredentialPrompt,
  PtyConnector,
  PtyExitEvent,
  PtySpawner,
  PtyTarget,
  LocalShellTarget,
  SessionID,
  SessionInfo,
  SessionStatus,
} from "./types"
/**
 * Orchestrates one PTY session: spawn, credential blinding, buffer fan-out, AI command
 * proposals with human approval, TUI detection and logging.
 *
 * The transport is injected (`PtyConnector`): a local shell in the plugin, SSH for the
 * remote workflow, a fake in the tests. Everything below the connector is shared.
 *
 * Invariants:
 * 1. Human keystrokes go straight to the PTY and are never logged or broadcast.
 * 2. While a credential prompt is active, AI snapshots are withheld entirely.
 * 3. An AI command never reaches the PTY without approval, except for allowlisted read-only
 *    commands when the session opted into auto-approve.
 * 4. An approved write never lands on a line the human is still typing: it waits out the
 *    priority window and is released once they are idle.
 */

export type SessionEvent =
  | { readonly type: "data"; readonly sessionId: SessionID; readonly chunk: BufferChunk }
  | { readonly type: "status"; readonly sessionId: SessionID; readonly status: SessionStatus }
  | { readonly type: "credential"; readonly sessionId: SessionID; readonly prompt: CredentialPrompt }
  | { readonly type: "proposal"; readonly sessionId: SessionID; readonly proposal: CommandProposal }
  | { readonly type: "approval"; readonly sessionId: SessionID; readonly command: string }
  | { readonly type: "rejection"; readonly sessionId: SessionID; readonly proposalId: string }
  | { readonly type: "tui"; readonly sessionId: SessionID; readonly app: string | null; readonly fullScreen: boolean }
  | { readonly type: "exit"; readonly sessionId: SessionID; readonly event: PtyExitEvent }

export type SessionEventListener = (event: SessionEvent) => void

export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  "ls",
  "pwd",
  "cat",
  "grep",
  "tail",
  "head",
  "df",
  "du",
  "free",
  "uptime",
  "whoami",
  "ps",
  "ss",
  "journalctl",
]

export interface SessionManagerOptions {
  readonly spawner: PtySpawner
  /**
   * Transport used for every session. Defaults to a per-target choice: `LocalShellConnector`
   * for local targets and `SSHConnector` for SSH ones, so existing SSH callers keep working.
   */
  readonly connector?: PtyConnector
  readonly sshBinary?: string
  readonly safeCommands?: readonly string[]
  readonly autoApproveSafeCommands?: boolean
  readonly maxLines?: number
  /**
   * How long the human's line keeps priority after their last keystroke. An approved write that
   * arrives inside the window waits for it to elapse instead of landing on the line being typed.
   */
  readonly humanPriorityWindowMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Schedules the deferred write. Defaults to `setTimeout`; tests inject a manual queue so the
   * priority window costs no wall-clock time. Returns the cancel function.
   */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
  readonly loggerSink?: (sessionId: SessionID, line: string) => void
  /**
   * Line discipline of local shells. Defaults to the current platform; SSH sessions always use
   * POSIX endings because the shell on the other side is POSIX.
   */
  readonly platform?: NodeJS.Platform
}

export interface SessionConfig {
  readonly id?: SessionID
  readonly target: PtyTarget
  readonly safeCommands?: readonly string[]
  readonly autoApproveSafeCommands?: boolean
}

export type ProposalOutcome =
  | { readonly status: "executed"; readonly proposal: CommandProposal }
  | { readonly status: "requires-approval"; readonly proposal: CommandProposal }
  | { readonly status: "blocked"; readonly reason: "full-screen-app"; readonly proposal: CommandProposal }

export interface Snapshot {
  /** The screen as the assistant reads it: replayed and rendered, with no `\b`, `\r` or ESC. */
  readonly text: string
  readonly blinded: boolean
  readonly fullScreenApp: string | null
  readonly status: SessionStatus
  readonly seq: number
}

/**
 * What the person in front of the screen sees.
 *
 * `text` is the raw tail of the same buffer, escape sequences included, so the visible terminal can
 * replay cursor moves and redraws. It is **never** withheld: the human is the one typing the
 * credential, and hiding their own prompt would leave them typing blind. It is not an assistant
 * view and must never be handed to a tool — `snapshot` is the only AI-facing one.
 */
export interface HumanSnapshot {
  readonly text: string
  readonly seq: number
  /** The detector holds a credential prompt: the screen is shown, the person's own input is masked. */
  readonly blinded: boolean
  readonly status: SessionStatus
  readonly fullScreenApp: string | null
}


/**
 * An approved AI write that is waiting for the human to go idle.
 *
 * The payload is already terminated for the session's line discipline: what is deferred is the
 * moment of the write, never its bytes.
 */
interface QueuedWrite {
  readonly payload: string
  readonly command: string
  readonly proposalId?: string
}

interface ManagedSession {
  readonly id: SessionID
  readonly target: PtyTarget
  readonly process: ReturnType<PtyConnector["connect"]>
  readonly buffer: BufferBroadcaster
  readonly detector: CredentialDetector
  readonly tui: TuiDetector
  readonly lock: InputLock<QueuedWrite>
  readonly logger: SessionLogger
  readonly safeCommands: readonly string[]
  readonly autoApprove: boolean
  readonly createdAt: number
  readonly disposers: (() => void)[]
  /** Working directory the PTY was spawned in; null for SSH, where it is unknown. */
  readonly cwd: string | null
  /** Process that owns the terminal when no full-screen app is known. */
  readonly defaultProcess: string | null
  /** Shell binary for local sessions. */
  readonly shell: string | null
  /** Line discipline of the shell at the other end: `win32` for a local Windows shell. */
  readonly platform: NodeJS.Platform
  status: SessionStatus
  pending: CommandProposal | null
  /** Cancels the armed drain timer; `null` when no write is waiting. */
  cancelDrain: (() => void) | null
}

export class SessionManager {
  readonly #sessions = new Map<SessionID, ManagedSession>()
  readonly #listeners = new Set<SessionEventListener>()
  readonly #spawner: PtySpawner
  readonly #connector: PtyConnector | undefined
  readonly #sshConnector: SSHConnector
  readonly #defaults: Required<
    Pick<SessionManagerOptions, "safeCommands" | "autoApproveSafeCommands" | "maxLines" | "humanPriorityWindowMs">
  >
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #schedule: (callback: () => void, delayMs: number) => () => void
  readonly #loggerSink: ((sessionId: SessionID, line: string) => void) | undefined
  readonly #platform: NodeJS.Platform | undefined
  #counter = 0
  #proposalCounter = 0

  constructor(options: SessionManagerOptions) {
    this.#spawner = options.spawner
    this.#connector = options.connector
    this.#sshConnector = new SSHConnector(options.spawner, { binary: options.sshBinary })
    this.#platform = options.platform
    this.#defaults = {
      safeCommands: options.safeCommands ?? DEFAULT_SAFE_COMMANDS,
      autoApproveSafeCommands: options.autoApproveSafeCommands ?? false,
      maxLines: options.maxLines ?? 10_000,
      humanPriorityWindowMs: options.humanPriorityWindowMs ?? DEFAULT_HUMAN_PRIORITY_WINDOW_MS,
    }
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        return () => clearTimeout(timer)
      })
    this.#loggerSink = options.loggerSink
  }

  on(listener: SessionEventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Whether a live session exists for this id. Never throws. */
  has(id: SessionID): boolean {
    return this.#sessions.has(id)
  }

  async create(config: SessionConfig): Promise<SessionInfo> {
    const id = config.id ?? `pty-${++this.#counter}`
    if (this.#sessions.has(id)) throw new Error(`Session ${id} already exists`)

    const detector = new CredentialDetector({ now: this.#now })
    const buffer = new BufferBroadcaster({ maxLines: this.#defaults.maxLines, now: this.#now })
    const tui = new TuiDetector()
    const lock = new InputLock<QueuedWrite>({
      now: this.#now,
      humanPriorityWindowMs: this.#defaults.humanPriorityWindowMs,
    })
    const logger = new SessionLogger({
      sessionId: id,
      now: () => new Date(this.#now()),
      sink: this.#loggerSink ? (line) => this.#loggerSink?.(id, line) : undefined,
    })

    const connector = this.#connectorFor(config.target)
    const process = connector.connect(config.target)
    const shell = isLocalTarget(config.target) ? shellFor(config.target, connector) : null
    const cwd = isLocalTarget(config.target) ? (config.target.cwd ?? defaultCwd()) : null

    const session: ManagedSession = {
      id,
      target: config.target,
      process,
      buffer,
      detector,
      tui,
      lock,
      logger,
      safeCommands: config.safeCommands ?? this.#defaults.safeCommands,
      autoApprove: config.autoApproveSafeCommands ?? this.#defaults.autoApproveSafeCommands,
      createdAt: this.#now(),
      disposers: [],
      cwd,
      defaultProcess: shell ? shellName(shell) : isLocalTarget(config.target) ? null : "ssh",
      shell,
      // A local shell inherits this machine's line discipline; `ssh` runs a POSIX shell remotely.
      platform: isLocalTarget(config.target) ? (this.#platform ?? process.platform) : "linux",
      status: "connecting",
      pending: null,
      cancelDrain: null,
    }
    this.#sessions.set(id, session)
    logger.record("session-created", describeTarget(session.target, cwd))

    session.disposers.push(
      process.onData((data) => this.#handleData(session, data)),
      process.onExit((event) => this.#handleExit(session, event)),
    )

    return this.info(id)
  }

  list(): readonly SessionInfo[] {
    return [...this.#sessions.keys()].map((id) => this.info(id))
  }

  info(id: SessionID): SessionInfo {
    const session = this.#require(id)
    return {
      id: session.id,
      target: session.target,
      status: session.status,
      pid: session.process.pid,
      createdAt: session.createdAt,
      lastActivityAt: session.buffer.lastActivityAt,
      blinded: session.detector.blinded,
      fullScreenApp: session.tui.app ?? (session.tui.fullScreen ? "unknown" : null),
      cwd: session.cwd,
      foregroundProcess: session.tui.app ?? (session.tui.fullScreen ? "unknown" : session.defaultProcess),
      ...(session.shell ? { shell: session.shell } : {}),
    }
  }

  /** AI-facing view. Withheld entirely while a credential prompt is active. */
  snapshot(id: SessionID, lines = 200): Snapshot {
    const session = this.#require(id)
    if (session.detector.blinded) {
      return {
        text: "[credential prompt active — output withheld from AI]",
        blinded: true,
        fullScreenApp: session.tui.app,
        status: session.status,
        seq: session.buffer.seq,
      }
    }
    const raw = session.buffer.snapshot(lines)
    return {
      // Replay the raw tail instead of stripping it. PSReadLine redraws the current line with
      // cursor moves, so removing the escapes glues the fragments together and the assistant reads
      // `e\becho tesecho test` instead of `echo test`. `renderScreenText` keeps the position and
      // still ends with plain text: no `\b`, `\r` or ESC reaches the model.
      text: renderScreenText(raw, { lines }),
      blinded: false,
      fullScreenApp: session.tui.app,
      status: session.status,
      seq: session.buffer.seq,
    }
  }

  /**
   * Human-facing view of the same buffer, for the visible terminal.
   *
   * Like `snapshot`, it reads the session's tail; unlike it, nothing is withheld and escape
   * sequences are kept, because the panel replays them (`lib/screen.ts`) instead of showing the
   * stripped text the assistant reads. It never reaches a tool: `snapshot` is the AI view.
   */
  humanSnapshot(id: SessionID, lines = 400): HumanSnapshot {
    const session = this.#require(id)
    return {
      text: session.buffer.snapshot(lines),
      seq: session.buffer.seq,
      blinded: session.detector.blinded,
      status: session.status,
      fullScreenApp: session.tui.app,
    }
  }

  /** Human keystrokes: written straight through, never logged, never broadcast. */
  writeHuman(id: SessionID, data: string): void {
    const session = this.#require(id)
    session.lock.noteHumanInput()
    session.process.write(data)
    session.logger.record("human-input", { bytes: data.length, blinded: session.detector.blinded })
  }

  /**
   * The human opened a local line in the panel (line mode) and is composing it there.
   *
   * Nothing has reached the PTY yet; the line lives in the panel until Enter. Marking it here is
   * what makes an approved AI write wait for the whole line instead of landing on top of it.
   */
  humanLine(id: SessionID): void {
    this.noteHumanLine(id, true)
  }

  /**
   * The panel's `line` RPC (T019, FR-006): the human's local line is open or closed.
   *
   * `active: true` holds the AI queue for as long as the line stays open — a keystroke alone only
   * holds it for the priority window, and a line can take minutes. `active: false` is the panel
   * saying the line is gone (blur, Escape/Ctrl+C, an emptied input): the lock closes the line and
   * whatever the assistant had waiting is released in approval order, exactly as it is after a
   * submit.
   *
   * It is deliberately not `submitHumanLine`: no bytes are written here, because the line may never
   * have been sent at all.
   */
  noteHumanLine(id: SessionID, active: boolean): void {
    const session = this.#require(id)
    if (active) {
      session.lock.humanLine()
      return
    }
    session.lock.submitLine()
    // The armed drain was waiting for the line to close; the line just closed, so release now
    // instead of waiting for a timer that would find an already idle human.
    session.cancelDrain?.()
    session.cancelDrain = null
    this.#drain(session)
  }

  /**
   * The human submitted their local line: write it once, terminated, and release whatever the AI
   * had queued behind it.
   *
   * The line is deliberately **not** logged: in line mode a password is typed here before it is
   * ever sent, and an audit trail with the text would put the credential on disk. Only its length
   * is recorded, like the raw keystroke path.
   */
  submitHumanLine(id: SessionID, line: string): void {
    const session = this.#require(id)
    session.process.write(`${line}\r`)
    session.lock.submitLine()
    session.logger.record("human-line", { bytes: line.length + 1, blinded: session.detector.blinded })

    // The queued AI writes were waiting for this submit; the armed drain is theirs, so cancel it
    // and release them now, after the line bytes, in approval order.
    session.cancelDrain?.()
    session.cancelDrain = null
    this.#drain(session)
  }

  /**
   * AI write that has **already** been approved by the caller.
   *
   * This is the only public entry point for machine input, and it assumes every gate has run:
   * `lib/execution-flow.ts` checks the grant, the blinding and the human approval before it
   * calls this. It exists so the plugin can carry the host's `write` semantics into its own PTY
   * without duplicating the lock, the newline handling or the audit record.
   */
  writeAi(id: SessionID, data: string, command?: string): void {
    const session = this.#require(id)
    this.#writeApproved(session, data, command ?? data.trim())
  }

  resize(id: SessionID, cols: number, rows: number): void {
    this.#require(id).process.resize(cols, rows)
  }

  /** AI command request. Never writes without approval (or an allowlisted auto-approve). */
  proposeCommand(id: SessionID, command: string, explanation = ""): ProposalOutcome {
    const session = this.#require(id)
    const proposal: CommandProposal = {
      id: `${id}-p${++this.#proposalCounter}`,
      sessionId: id,
      command,
      explanation,
      safe: isSafeCommand(command, session.safeCommands),
      proposedAt: this.#now(),
    }

    session.logger.record("ai-proposal", { command, explanation, safe: proposal.safe })

    if (session.tui.fullScreen) {
      this.#emit({ type: "proposal", sessionId: id, proposal })
      return { status: "blocked", reason: "full-screen-app", proposal }
    }

    if (proposal.safe && session.autoApprove) {
      this.#execute(session, proposal)
      return { status: "executed", proposal }
    }

    session.pending = proposal
    this.#emit({ type: "proposal", sessionId: id, proposal })
    return { status: "requires-approval", proposal }
  }

  /** Human approval. `command` may override the proposal (the "edit" action). */
  approve(id: SessionID, command?: string): void {
    const session = this.#require(id)
    const pending = session.pending
    if (!pending) throw new Error(`Session ${id} has no pending proposal`)

    const finalCommand = command ?? pending.command
    session.pending = null
    this.#execute(session, { ...pending, command: finalCommand })
  }

  reject(id: SessionID): void {
    const session = this.#require(id)
    const pending = session.pending
    if (!pending) return
    session.pending = null
    session.logger.record("ai-rejected", { proposalId: pending.id })
    this.#emit({ type: "rejection", sessionId: id, proposalId: pending.id })
  }

  pendingProposal(id: SessionID): CommandProposal | null {
    return this.#require(id).pending
  }

  /** Polls the AI-visible buffer until `pattern` matches or the timeout elapses. */
  async waitForPrompt(
    id: SessionID,
    pattern: RegExp | string,
    timeoutMs = 15_000,
  ): Promise<{ matched: boolean; text: string }> {
    const regex = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern
    const deadline = this.#now() + timeoutMs
    const maxAttempts = Math.ceil(timeoutMs / 50) + 1

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const snapshot = this.snapshot(id, 400)
      if (regex.test(snapshot.text)) return { matched: true, text: snapshot.text }
      if (this.#now() >= deadline) break
      await this.#sleep(50)
    }

    return { matched: false, text: this.snapshot(id, 400).text }
  }

  destroy(id: SessionID): void {
    const session = this.#sessions.get(id)
    if (!session) return
    this.#cancelDrain(session)
    for (const dispose of session.disposers) dispose()
    session.process.kill()
    session.status = "closed"
    session.logger.record("session-destroyed", {})
    this.#sessions.delete(id)
    this.#emit({ type: "status", sessionId: id, status: "closed" })
  }

  destroyAll(): void {
    for (const id of [...this.#sessions.keys()]) this.destroy(id)
  }

  #execute(session: ManagedSession, proposal: CommandProposal): void {
    this.#writeApproved(session, proposal.command, proposal.command, proposal.id)
  }

  /**
   * Single write path for approved machine input: terminate, then write — unless the human is
   * mid-line, in which case the write waits out their priority window instead of landing on the
   * line they are typing.
   */
  #writeApproved(session: ManagedSession, data: string, command: string, proposalId?: string): void {
    const write: QueuedWrite = {
      payload: terminate(data, { platform: session.platform }),
      command,
      ...(proposalId === undefined ? {} : { proposalId }),
    }

    // With a write already waiting, a newer one queues behind it: releasing it now would run the
    // commands out of order. An open human line holds the queue even after the idle window, because
    // the line is still theirs until they press Enter.
    if (!session.lock.lineActive && !session.lock.humanActive && session.lock.queued.length === 0) {
      this.#writeNow(session, write)
      return
    }

    session.lock.enqueue(write)
    session.logger.record("ai-queued", { command, waitMs: session.lock.humanIdleInMs })
    this.#scheduleDrain(session)
  }

  /** Arms one drain per session. New keystrokes push it back because it re-checks the lock. */
  #scheduleDrain(session: ManagedSession): void {
    if (session.cancelDrain) return

    const waitMs = session.lock.humanIdleInMs
    if (waitMs === 0) {
      this.#drain(session)
      return
    }

    session.cancelDrain = this.#schedule(() => {
      session.cancelDrain = null
      this.#drain(session)
    }, waitMs)
  }

  /** Releases what the human left waiting, in the order it was approved. */
  #drain(session: ManagedSession): void {
    const released = session.lock.drain()
    if (released.length === 0) {
      // The human typed again: the queue survives and tries once more after the window. An open
      // line is different: it ends at Enter, not after a window, so `submitHumanLine` drains it
      // instead of arming a poll that would never release anything.
      if (session.lock.queued.length > 0 && !session.lock.lineActive) this.#scheduleDrain(session)
      return
    }
    for (const write of released) this.#writeNow(session, write)
  }

  /** The bytes reach the PTY here: note the AI input, write, audit, announce. */
  #writeNow(session: ManagedSession, write: QueuedWrite): void {
    session.lock.noteAiInput()
    session.process.write(write.payload)
    session.logger.record(
      "ai-approved",
      write.proposalId ? { proposalId: write.proposalId, command: write.command } : { command: write.command },
    )
    this.#emit({ type: "approval", sessionId: session.id, command: write.command })
  }

  /** Drops a waiting write with the session that was going to receive it. */
  #cancelDrain(session: ManagedSession): void {
    session.cancelDrain?.()
    session.cancelDrain = null
    session.lock.clear()
  }

  #connectorFor(target: PtyTarget): PtyConnector {
    if (this.#connector) return this.#connector
    return isLocalTarget(target) ? new LocalShellConnector(this.#spawner) : this.#sshConnector
  }

  #handleData(session: ManagedSession, data: string): void {
    const prompt = session.detector.observe(data)
    const tui = session.tui.inspect(data)
    const chunk = session.buffer.push(data)

    if (!session.detector.blinded) session.logger.record("output", { bytes: data.length, seq: chunk.seq })

    this.#emit({ type: "data", sessionId: session.id, chunk })

    if (prompt) {
      session.logger.record("credential-prompt", { kind: prompt.kind })
      this.#setStatus(session, prompt.blinds ? "authenticating" : "connecting")
      this.#emit({ type: "credential", sessionId: session.id, prompt })
    } else if (session.status === "connecting" || session.status === "authenticating") {
      // Any output without an active prompt means the shell (or a success banner) is live.
      if (!session.detector.blinded) this.#setStatus(session, "ready")
    }

    if (ALT_SCREEN_ON.test(data) || ALT_SCREEN_OFF.test(data) || OSC_TITLE.test(data)) {
      this.#emit({ type: "tui", sessionId: session.id, app: tui.app, fullScreen: tui.fullScreen })
    }
  }

  #handleExit(session: ManagedSession, event: PtyExitEvent): void {
    this.#cancelDrain(session)
    session.status = "closed"
    session.logger.record("session-exit", { exitCode: event.exitCode, signal: event.signal })
    this.#sessions.delete(session.id)
    this.#emit({ type: "exit", sessionId: session.id, event })
    this.#emit({ type: "status", sessionId: session.id, status: "closed" })
  }

  #setStatus(session: ManagedSession, status: SessionStatus): void {
    if (session.status === status) return
    session.status = status
    this.#emit({ type: "status", sessionId: session.id, status })
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #require(id: SessionID): ManagedSession {
    const session = this.#sessions.get(id)
    if (!session) throw new Error(`Unknown session ${id}`)
    return session
  }
}

/**
 * A command is auto-approvable only when its first token is allowlisted and it contains no
 * shell metacharacters, so `ls; rm -rf /` and `ls > /etc/passwd` always require approval.
 */
export function isSafeCommand(command: string, allowlist: readonly string[]): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  if (/[;&|><`$(){}]/.test(trimmed)) return false
  const head = trimmed.split(/\s+/)[0]
  return head !== undefined && allowlist.includes(head)
}

/**
 * Shell a local session ended up with.
 *
 * `LocalShellConnector` resolves the platform default lazily, so the manager asks the
 * connector instead of guessing. A custom connector that does not expose `shell` leaves it
 * unknown rather than inventing a value.
 */
function shellFor(target: LocalShellTarget, connector: PtyConnector): string | null {
  if (target.shell) return target.shell
  const resolved = (connector as { shell?: { file?: string } }).shell
  return resolved?.file ?? null
}

/** Log-safe description of what a session is attached to. Never includes a credential. */
function describeTarget(target: PtyTarget, cwd: string | null): Record<string, unknown> {
  if (isLocalTarget(target)) return { kind: "local", shell: target.shell ?? null, cwd }
  return { kind: "ssh", host: target.host, user: target.user }
}
