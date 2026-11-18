/**
 * Shared types for the PTY bridge.
 *
 * The bridge is deliberately transport-agnostic: it never imports `node-pty` or `ssh2`
 * directly. A `PtySpawner` is injected, which keeps the package testable without native
 * binaries and lets the desktop main process decide which backend to load.
 */

export type SessionID = string

export interface PtyExitEvent {
  readonly exitCode: number
  readonly signal?: number
}

/** A live pseudo-terminal process. Mirrors the subset of `node-pty` the bridge needs. */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** Returns an unsubscribe function. */
  onData(listener: (data: string) => void): () => void
  /** Returns an unsubscribe function. */
  onExit(listener: (event: PtyExitEvent) => void): () => void
}

export interface PtySpawnOptions {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly cols?: number
  readonly rows?: number
  readonly name?: string
}

export interface PtySpawner {
  spawn(options: PtySpawnOptions): PtyProcess
}

/**
 * SSH destination. Authentication is intentionally delegated to the system `ssh` client
 * running inside the PTY: the password/MFA prompt is rendered in the visible terminal and
 * typed by the human, so the AI never receives the secret.
 */
export interface SshTarget {
  /** Discriminant. Optional so existing `{ host, user }` literals stay valid. */
  readonly kind?: "ssh"
  readonly host: string
  readonly user: string
  readonly port?: number
  readonly identityFile?: string
  readonly jumpHost?: string
  readonly knownHostsFile?: string
  readonly strictHostKeyChecking?: "yes" | "no" | "accept-new"
  readonly extraArgs?: readonly string[]
  /** Command executed on the remote host instead of an interactive shell. */
  readonly remoteCommand?: string
  /** When set, reattaches to this tmux session (`tmux new-session -A -s <name>`). */
  readonly tmuxSession?: string
  readonly cols?: number
  readonly rows?: number
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Local shell destination: the plugin spawns its own shell on this machine instead of
 * delegating to a host-provided terminal.
 *
 * The shell inherits the user's environment and privileges; nothing is sandboxed.
 */
export interface LocalShellTarget {
  readonly kind: "local"
  /** Shell binary. Defaults to the platform default (pwsh/powershell/cmd on Windows). */
  readonly shell?: string
  /** Arguments for the shell. Defaults to the platform default (`-NoLogo`, `-l`). */
  readonly args?: readonly string[]
  /** Working directory. Defaults to the user's home directory. */
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly cols?: number
  readonly rows?: number
}

/** Anything a connector can turn into a live PTY. */
export type PtyTarget = SshTarget | LocalShellTarget

export function isLocalTarget(target: PtyTarget): target is LocalShellTarget {
  return target.kind === "local"
}

/**
 * A backend able to turn a target into a live PTY.
 *
 * `SessionManager` depends on this interface, not on a concrete transport: SSH, a local
 * shell, or a test double are interchangeable.
 */
export interface PtyConnector {
  connect(target: PtyTarget): PtyProcess
}

/**
 * Which terminal the plugin is driving.
 *
 * - `local-pty`: the plugin spawned its own shell and owns the write channel.
 * - `host-read-only`: `node-pty` could not be loaded, so the host's read-only terminal is used.
 */
export type TerminalEngine = "local-pty" | "host-read-only"


export type SubscriberKind = "human" | "ai" | "logger"

export interface BufferChunk {
  readonly seq: number
  readonly at: number
  readonly data: string
}

export interface BufferSubscriber {
  readonly id: string
  readonly kind: SubscriberKind
  readonly write: (chunk: BufferChunk) => void
}

export type CredentialKind = "password" | "passphrase" | "mfa" | "sudo" | "host-key"

export interface CredentialPrompt {
  readonly kind: CredentialKind
  readonly text: string
  readonly at: number
  /** False for host-key confirmation, which is not a secret. */
  readonly blinds: boolean
}

export type SessionStatus = "connecting" | "authenticating" | "ready" | "closed" | "error"

export interface SessionInfo {
  readonly id: SessionID
  readonly target: PtyTarget
  readonly status: SessionStatus
  readonly pid?: number
  readonly createdAt: number
  readonly lastActivityAt: number
  /** True while a credential prompt is on screen; AI reads are withheld. */
  readonly blinded: boolean
  /** Non-null when a full-screen TUI owns the alternate screen buffer. */
  readonly fullScreenApp: string | null
  /** Working directory of a local shell; `null` for SSH sessions, where it is unknown. */
  readonly cwd?: string | null
  /** Best-effort name of the process that owns the terminal. */
  readonly foregroundProcess?: string | null
  /** Shell binary, when the session runs a local shell. */
  readonly shell?: string
}

export interface CommandProposal {
  readonly id: string
  readonly sessionId: SessionID
  readonly command: string
  readonly explanation: string
  /** True when the command's leading token is in the session's safe-command allowlist. */
  readonly safe: boolean
  readonly proposedAt: number
}
