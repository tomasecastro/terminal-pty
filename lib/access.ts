/**
 * Access gate: what the assistant may do with the human's terminal.
 *
 * Three capabilities, all closed by default:
 *  - **read**: read the terminal text (`read_terminal`, `terminal_info`, `wait_for_prompt`).
 *  - **write**: send commands (`execute_command`). Write implies read: you cannot run what you
 *    cannot see.
 *  - **execute**: run non-destructive commands without a per-command approval. Execute implies
 *    write and read. Destructive commands still ask, even with `execute` granted; the decision
 *    lives in `lib/destructive-commands.ts` and `lib/execution-flow.ts`.
 *
 * The three capabilities map to three grant modes:
 *  - `read` → read only.
 *  - `read-write` → read and write, one approval per command.
 *  - `full` → read, write and execute, one approval per session.
 *
 * Model (2026-11-12):
 *  - Nothing is granted until the human allows it, through the host's approval prompt.
 *  - **No time limit and no command budget.** A grant lasts while the process lives.
 *  - **Process-scoped.** Grants live in memory, so closing OpenCode discards them even when the
 *    session is resumed. A resumed session starts with nothing.
 *  - **Per session.** Two sessions have independent grants.
 *  - **Revocable at any moment**, with no approval needed to revoke.
 *  - Credential blinding sits on top: even with read granted, a password prompt returns withheld
 *    text, and even with write granted, execution is blocked while that prompt is on screen.
 *
 * Pure logic, no `effect` and no host imports.
 */

export const METACHARACTERS = /[;&|><`$(){}]/

export type Capability = "read" | "write"

export type GrantMode = "read" | "read-write" | "full"

export interface AccessPolicy {
  /** When false, the assistant cannot even ask. It never grants access on its own. Default: true. */
  readonly enabled: boolean
  /** Commands that skip the per-command approval once write is granted. Empty by default. */
  readonly allowlist: readonly string[]
}

export const DEFAULT_POLICY: AccessPolicy = {
  // "enabled" means the assistant may ASK. It never grants anything: reading and writing still
  // need an explicit, per-session grant from the human. Set to false to silence the assistant.
  enabled: true,
  allowlist: [],
}

export interface Grant {
  readonly grantedAt: number
  readonly scope: "process"
  readonly sessionID: string
  readonly read: boolean
  readonly write: boolean
  readonly execute: boolean
  readonly mode: GrantMode
}

export type AccessStatus =
  | { readonly state: "closed" }
  | {
      readonly state: "open"
      readonly scope: "process"
      readonly grantedAt: number
      readonly read: boolean
      readonly write: boolean
      readonly execute: boolean
      readonly mode: GrantMode
    }

export class AccessGate {
  readonly #policy: AccessPolicy
  readonly #now: () => number
  readonly #grants = new Map<string, Grant>()

  constructor(policy: Partial<AccessPolicy> = {}, now: () => number = Date.now) {
    this.#policy = { ...DEFAULT_POLICY, ...policy }
    this.#now = now
  }

  get policy(): AccessPolicy {
    return this.#policy
  }

  /** Grants read only. Never grants write or execute. */
  grantRead(sessionID: string): Grant {
    return this.#set(sessionID, { read: true, write: false, execute: false })
  }

  /** Grants read and write. Every command still needs its own approval. */
  grantWrite(sessionID: string): Grant {
    return this.#set(sessionID, { read: true, write: true, execute: false })
  }

  /**
   * Grants read, write and execute in one approval: non-destructive commands run without asking,
   * destructive ones still ask per command.
   */
  grantFull(sessionID: string): Grant {
    return this.#set(sessionID, { read: true, write: true, execute: true })
  }

  revoke(sessionID: string, capability?: Capability): boolean {
    if (!capability) return this.#grants.delete(sessionID)
    const grant = this.#grants.get(sessionID)
    if (!grant) return false
    if (capability === "write") {
      // Revoking write also revokes execute: both are needed to run anything.
      this.#grants.set(sessionID, { ...grant, write: false, execute: false, mode: "read" })
      return true
    }
    this.#grants.delete(sessionID)
    return true
  }

  revokeAll(): number {
    const count = this.#grants.size
    this.#grants.clear()
    return count
  }

  canRead(sessionID: string): boolean {
    return this.#grants.get(sessionID)?.read === true
  }

  canWrite(sessionID: string): boolean {
    return this.#grants.get(sessionID)?.write === true
  }

  /** Whether non-destructive commands may run without a per-command approval. */
  canExecute(sessionID: string): boolean {
    return this.#grants.get(sessionID)?.execute === true
  }

  status(sessionID: string): AccessStatus {
    const grant = this.#grants.get(sessionID)
    if (!grant) return { state: "closed" }
    return {
      state: "open",
      scope: "process",
      grantedAt: grant.grantedAt,
      read: grant.read,
      write: grant.write,
      execute: grant.execute,
      mode: grant.mode,
    }
  }

  /** Whether a command can run without a per-command approval. */
  autoApproved(command: string): boolean {
    if (METACHARACTERS.test(command)) return false
    const first = command.trim().split(/\s+/)[0] ?? ""
    return this.#policy.allowlist.includes(first)
  }

  #set(
    sessionID: string,
    capabilities: { read: boolean; write: boolean; execute: boolean },
  ): Grant {
    const grant: Grant = {
      grantedAt: this.#now(),
      scope: "process",
      sessionID,
      read: capabilities.read,
      write: capabilities.write,
      execute: capabilities.execute,
      mode: grantMode(capabilities),
    }
    this.#grants.set(sessionID, grant)
    return grant
  }
}

function grantMode(capabilities: { read: boolean; write: boolean; execute: boolean }): GrantMode {
  if (capabilities.execute) return "full"
  if (capabilities.write) return "read-write"
  return "read"
}

/**
 * The sentence a person reads in the approval dialog for a grant (FR-006).
 *
 * The host renders a request as its raw action name plus `resources`, and it carries no translation
 * key for an action a plugin invents, so the only readable text a plugin can add there is a
 * resource. Each mode says what it actually allows: a `full` grant must not read like blanket
 * permission over the shell.
 */
export function describeGrant(mode: GrantMode): string {
  if (mode === "read") return "Read this session's terminal output"
  if (mode === "read-write") return "Read this session's terminal and run commands, one approval each"
  return "Read this session's terminal and run commands, except the ones that delete data"
}

export function readRejection(policy: AccessPolicy, status: AccessStatus): string {  if (!policy.enabled) {
    return "Terminal access is disabled. The human must enable `access.enabled` in the plugin options."
  }
  if (status.state === "closed") {
    return "No read permission for this session. The human must grant it with `terminal_pty_access_grant`."
  }
  return "Read permission is not available for this session."
}

export function writeRejection(policy: AccessPolicy, status: AccessStatus): string {
  if (!policy.enabled) {
    return "Terminal access is disabled. The human must enable `access.enabled` in the plugin options."
  }
  if (status.state === "closed" || !status.write) {
    return "No execution permission for this session. The human must grant read-write access."
  }
  return "Execution permission is not available."
}
