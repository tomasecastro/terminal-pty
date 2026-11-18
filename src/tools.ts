import { Effect, Schema } from "effect"
// Type-only: the host gives a folder-discovered plugin `effect` and `@opencode/plugin/*` only, so
// this import must not survive transpilation as a runtime dependency on `@opencode/schema`.
import type { Tool } from "@opencode/schema/tool"
import { AccessGate, describeGrant, readRejection, type AccessPolicy, type GrantMode } from "../lib/access"
import { allowRead, runCommand } from "../lib/execution-flow"
import type { LocalSessionHandle, LocalTerminalDeps } from "../lib/local-engine"
import {
  createSessionDetectors,
  describeMissingTerminal,
  formatInfo,
  formatRead,
  formatWait,
  formatWithheld,
  WITHHELD,
  type TerminalView,
} from "../lib/terminal-view"
import type { TerminalEngine } from "../lib/types"

/**
 * Terminal tools over a PTY the plugin drives itself.
 *
 * Reading is **not** free: both read and write start closed and need the human's permission.
 * Reading and writing are separate capabilities; write implies read.
 *
 * Two backends share one contract:
 *  - the plugin's own local shell (`terminal_open`), which supports read and write, and
 *  - the host terminal, read-only, used only when `node-pty` is unavailable.
 *
 * Credential blinding sits above the permission: with read granted, a password prompt still
 * returns withheld text.
 *
 * Decision logic lives in `lib/access.ts` and `lib/execution-flow.ts`, free of `effect`, covered
 * by tests.
 */

export { WITHHELD }
export type { LocalSessionHandle, LocalTerminalDeps }

export interface TerminalToolsDeps {
  readonly read: (sessionID: string, lines?: number) => Effect.Effect<TerminalView | null, unknown>
  readonly write?: (ptyID: string, data: string) => Effect.Effect<void, unknown>
  readonly assert?: (input: {
    sessionID: string
    action: string
    resources: readonly string[]
    save?: readonly string[]
    metadata?: Record<string, unknown>
  }) => Effect.Effect<void, unknown>
  /**
   * Announces a `full` grant to the visible terminal (FR-007). Called after the grant is active, so
   * the panel it opens finds the same session the tools will use. Absent when the host has no GUI
   * channel, which makes the auto-open a no-op (FR-014).
   */
  readonly notifyOpened?: (sessionID: string) => Effect.Effect<void, unknown>
  readonly policy?: Partial<AccessPolicy>
  /** Local PTY engine. Absent when `node-pty` could not be loaded. */
  readonly local?: LocalTerminalDeps
  /** Which engine this process is running. */
  readonly engine?: () => TerminalEngine
}

export function makeTerminalTools(deps: TerminalToolsDeps) {
  const detectors = createSessionDetectors()
  const gate = new AccessGate(deps.policy)

  const engine = (): TerminalEngine => deps.engine?.() ?? (deps.local ? "local-pty" : "host-read-only")
  const localBackend = (): LocalTerminalDeps | undefined => deps.local

  /**
   * Reads through the local PTY when it owns the session, otherwise through the host.
   * Blinding comes from the local session when it exists, because its snapshot is already
   * withheld and no prompt text reaches the detector.
   */
  const inspect = (sessionID: string, lines?: number) =>
    Effect.gen(function* () {
      const local = deps.local
      const owned = local ? local.has(sessionID) : false
      const own = owned && local ? local.view(sessionID, lines) : null
      const view = own ?? (yield* deps.read(sessionID, lines))
      if (!view) return null
      const blinded = (owned && local ? local.blinded(sessionID) : false) || detectors.observe(sessionID, view.text)
      return { view, blinded }
    })

  const gateMessage = (sessionID: string) => readRejection(gate.policy, gate.status(sessionID))

  const openTerminal = {
    name: "terminal_open",
    description:
      "Open, or reuse, the plugin's own local shell for this session. Idempotent. Returns the session id, pid, shell, working directory and engine. The shell starts with your user's privileges; nothing can be read or run in it until you grant access.",
    input: Schema.Struct({
      cwd: Schema.optional(
        Schema.String.annotate({ description: "Working directory for the shell (defaults to your home directory)" }),
      ),
    }),
    execute: (input: { cwd?: string }, context: Tool.Context) =>
      Effect.gen(function* () {
        const local = localBackend()
        if (!local) {
          return {
            content: JSON.stringify(
              {
                opened: false,
                engine: engine(),
                reason: "local-pty-unavailable",
                message:
                  "The local PTY engine is not available in this host, so there is no shell to open. Reads fall back to the host terminal.",
              },
              null,
              2,
            ),
            metadata: { opened: false, engine: engine() },
          }
        }

        const outcome = yield* Effect.tryPromise({
          try: () => local.open(context.sessionID, input.cwd),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.match({
            onFailure: (message) => ({ ok: false as const, message }),
            onSuccess: (handle) => ({ ok: true as const, handle }),
          }),
        )

        if (!outcome.ok) {
          return {
            content: JSON.stringify(
              { opened: false, engine: engine(), reason: "spawn-failed", message: outcome.message },
              null,
              2,
            ),
            metadata: { opened: false, engine: engine(), reason: "spawn-failed" },
          }
        }

        return {
          content: JSON.stringify({ opened: true, ...outcome.handle, engine: engine() }, null, 2),
          metadata: { opened: true, engine: engine(), pid: outcome.handle.pid },
        }
      }),
  }

  const killTerminal = {
    name: "terminal_kill",
    description:
      "Close the plugin's local shell for this session. Destroys the PTY and drops its buffer. Never needs approval, like revoking access.",
    input: Schema.Struct({}),
    execute: (_input: {}, context: Tool.Context) =>
      Effect.sync(() => {
        const local = localBackend()
        if (!local) {
          return {
            content: JSON.stringify({ killed: false, engine: engine(), reason: "local-pty-unavailable" }, null, 2),
            metadata: { killed: false, engine: engine() },
          }
        }
        const killed = local.kill(context.sessionID)
        if (killed) detectors.forget(context.sessionID)
        return {
          content: JSON.stringify({ sessionID: context.sessionID, killed, engine: engine() }, null, 2),
          metadata: { killed, engine: engine() },
        }
      }),
  }

  const readTerminal = {
    name: "terminal_pty_read_terminal",
    description:
      "Read the text of the session's terminal. Requires read permission granted by the human. Escape sequences are stripped. While a credential prompt is on screen the output is withheld.",
    input: Schema.Struct({
      lines: Schema.optional(Schema.Number.annotate({ description: "Trailing lines to read (default 200)" })),
    }),
    execute: (input: { lines?: number }, context: Tool.Context) =>
      Effect.gen(function* () {
        const guard = allowRead(gate, context.sessionID)
        if (!guard.ok) return { content: guard.message, metadata: { permitted: false } }
        const inspected = yield* inspect(context.sessionID, input.lines)
        if (!inspected) return { content: describeMissingTerminal(), metadata: { attached: false } }
        if (inspected.blinded) return formatWithheld(inspected.view.ptyID)
        return formatRead(inspected.view)
      }),
  }

  const terminalInfo = {
    name: "terminal_pty_terminal_info",
    description:
      "Return metadata for the session's terminal without its contents: title, working directory, foreground process and engine. Requires read permission.",
    input: Schema.Struct({}),
    execute: (_input: {}, context: Tool.Context) =>
      Effect.gen(function* () {
        const guard = allowRead(gate, context.sessionID)
        if (!guard.ok) return { content: guard.message, metadata: { permitted: false } }
        const inspected = yield* inspect(context.sessionID, 1)
        if (!inspected) return { content: describeMissingTerminal(), metadata: { attached: false } }
        return formatInfo(inspected.view, inspected.blinded, engine())
      }),
  }

  const waitForPrompt = {
    name: "terminal_pty_wait_for_prompt",
    description:
      "Poll the terminal until its text matches a regular expression, or until the timeout elapses. Requires read permission.",
    input: Schema.Struct({
      prompt: Schema.String.annotate({ description: "Regular expression to match against the terminal text" }),
      timeoutMs: Schema.optional(
        Schema.Number.annotate({ description: "Maximum wait in milliseconds (default 15000, max 120000)" }),
      ),
      intervalMs: Schema.optional(Schema.Number.annotate({ description: "Poll interval in milliseconds (default 250)" })),
    }),
    execute: (input: { prompt: string; timeoutMs?: number; intervalMs?: number }, context: Tool.Context) =>
      Effect.gen(function* () {
        const guard = allowRead(gate, context.sessionID)
        if (!guard.ok) return { content: guard.message, metadata: { permitted: false, matched: false } }

        const timeout = Math.min(Math.max(input.timeoutMs ?? 15_000, 100), 120_000)
        const interval = Math.min(Math.max(input.intervalMs ?? 250, 50), 5_000)
        const deadline = Date.now() + timeout
        let last = ""
        let matched = false
        let blinded = false

        while (Date.now() < deadline) {
          const inspected = yield* inspect(context.sessionID)
          if (!inspected) {
            return { content: describeMissingTerminal(), metadata: { matched: false, attached: false } }
          }
          blinded = inspected.blinded
          if (blinded) {
            last = WITHHELD
            break
          }
          last = inspected.view.text
          if (new RegExp(input.prompt).test(last)) {
            matched = true
            break
          }
          yield* Effect.sleep(interval)
        }

        return formatWait(matched, blinded, last)
      }),
  }

  const accessStatus = {
    name: "terminal_pty_access_status",
    description:
      "Report what the assistant may do with this session's terminal: read, write, or nothing, and which engine is running. A grant lasts until this OpenCode process exits and can be revoked at any time.",
    input: Schema.Struct({}),
    execute: (_input: {}, context: Tool.Context) =>
      Effect.sync(() => {
        const status = gate.status(context.sessionID)
        return {
          content: JSON.stringify(
            { sessionID: context.sessionID, ...status, engine: engine(), policy: gate.policy },
            null,
            2,
          ),
          metadata: { state: status.state, engine: engine() },
        }
      }),
  }

  const accessGrant = {
    name: "terminal_pty_access_grant",
    description:
      "Ask the human to allow read access, read and write access, or full access (read, write and run commands without a per-command approval), to this session's terminal. The grant lasts until this OpenCode process exits (closing the app ends it), applies only to this session, and can be revoked at any moment.",
    input: Schema.Struct({
      mode: Schema.Literals(["read", "read-write", "full"]).annotate({
        description:
          "`read` only reads the terminal; `read-write` also allows running commands with one approval each; `full` also runs non-destructive commands without asking again",
      }),
    }),
    execute: (input: { mode: GrantMode }, context: Tool.Context) =>
      Effect.gen(function* () {
        if (!gate.policy.enabled) {
          return {
            content:
              "Terminal access is disabled by the human. They must set `access.enabled` to true in the plugin options.",
            metadata: { granted: false, reason: "policy-disabled" },
          }
        }
        if (!deps.assert) {
          return {
            content: "The host cannot prompt the human, so the assistant cannot request access.",
            metadata: { granted: false, reason: "no-approval-channel" },
          }
        }
        const granted = yield* deps
          .assert({
            sessionID: context.sessionID,
            action: "terminal_pty.access",
            // The dialog has no i18n key for an action a plugin invents, so the pattern list is the
            // only line of text this plugin can add there: keep the mode first and the sentence
            // after it (FR-006).
            resources: [input.mode, describeGrant(input.mode)],
            // Every resource of this action is what "Always allow" persists (FR-005): the host saves
            // the rule for `terminal_pty.access` with these patterns, so the next grant is silent.
            save: ["*"],
            metadata: { capability: input.mode },
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        if (!granted) {
          return { content: "The human rejected the access request.", metadata: { granted: false } }
        }
        const grant =
          input.mode === "full"
            ? gate.grantFull(context.sessionID)
            : input.mode === "read-write"
              ? gate.grantWrite(context.sessionID)
              : gate.grantRead(context.sessionID)
        // After the grant, never before: the panel the event opens reads the same access gate, and a
        // listener that ran first would find the terminal still closed. A failure here costs the
        // auto-open, not the grant, so it is swallowed rather than turned into a tool error.
        if (input.mode === "full" && deps.notifyOpened) {
          yield* deps.notifyOpened(context.sessionID).pipe(Effect.catch(() => Effect.void))
        }
        return {
          content: JSON.stringify(
            {
              granted: true,
              read: grant.read,
              write: grant.write,
              execute: grant.execute,
              mode: grant.mode,
              scope: grant.scope,
              grantedAt: grant.grantedAt,
              note: "Lasts until this OpenCode process exits. Revoke any time with terminal_pty_access_revoke.",
            },
            null,
            2,
          ),
          metadata: { granted: true, read: grant.read, write: grant.write, execute: grant.execute, mode: grant.mode },
        }
      }),
  }

  const accessRevoke = {
    name: "terminal_pty_access_revoke",
    description:
      "Revoke terminal access immediately. Revoking never needs approval. Without `capability`, removes read and write for this session.",
    input: Schema.Struct({
      all: Schema.optional(Schema.Boolean.annotate({ description: "Revoke every session" })),
      capability: Schema.optional(
        Schema.Literals(["read", "write"]).annotate({
          description: "Revoke only writing, or all reading. Omit to revoke both for this session",
        }),
      ),
    }),
    execute: (input: { all?: boolean; capability?: "read" | "write" }, context: Tool.Context) =>
      Effect.sync(() => {
        if (input.all) {
          const revoked = gate.revokeAll()
          return { content: JSON.stringify({ revoked, scope: "all" }, null, 2), metadata: { revoked } }
        }
        const revoked = gate.revoke(context.sessionID, input.capability) ? 1 : 0
        const status = gate.status(context.sessionID)
        return {
          content: JSON.stringify({ revoked, status }, null, 2),
          metadata: { revoked, state: status.state },
        }
      }),
  }

  const executeCommand = {
    name: "terminal_pty_execute_command",
    description:
      "Run a command in the session's terminal. Requires read-write permission for this session and, unless the command is allowlisted, human approval for that exact command. Never runs while a credential prompt is on screen.",
    input: Schema.Struct({
      command: Schema.String.annotate({ description: "Exact command to run" }),
      explanation: Schema.optional(Schema.String.annotate({ description: "Why this command helps, shown to the human" })),
    }),
    execute: (input: { command: string; explanation?: string }, context: Tool.Context) =>
      Effect.gen(function* () {
        const local = deps.local
        const canWrite = Boolean(local) || Boolean(deps.write)

        // Reads prefer the plugin's own PTY; the host terminal is only a fallback.
        const read = async (sessionID: string, lines?: number): Promise<TerminalView | null> => {
          const own = local?.has(sessionID) ? local.view(sessionID, lines) : null
          if (own) return own
          return Effect.runPromise(deps.read(sessionID, lines).pipe(Effect.orElseSucceed(() => null)))
        }

        const write = async (ptyID: string, data: string): Promise<void> => {
          if (local?.has(ptyID)) {
            local.write(ptyID, data)
            return
          }
          if (!deps.write) throw new Error("The host does not expose a write channel")
          await Effect.runPromise(deps.write(ptyID, data))
        }

        const result = yield* Effect.promise(() =>
          runCommand(
            {
              gate,
              read,
              ...(canWrite ? { write } : {}),
              ...(deps.assert
                ? {
                    assert: async (input: {
                      sessionID: string
                      action: string
                      resources: readonly string[]
                      save?: readonly string[]
                      metadata?: Record<string, unknown>
                    }) => Effect.runPromise(deps.assert!(input)),
                  }
                : {}),
              // The local session knows it is blinded even though its snapshot is withheld, so
              // ask it first: a password prompt must block execution, not just reads.
              observe: (sessionID: string, text: string) =>
                (local?.has(sessionID) ? local.blinded(sessionID) : false) || detectors.observe(sessionID, text),
            },
            context.sessionID,
            input.command,
            input.explanation ?? "",
          ),
        )
        return {
          content: JSON.stringify(result, null, 2),
          metadata: { executed: result.executed, ...(result.reason ? { reason: result.reason } : {}) },
        }
      }),
  }

  return [
    openTerminal,
    killTerminal,
    readTerminal,
    terminalInfo,
    waitForPrompt,
    accessStatus,
    accessGrant,
    accessRevoke,
    executeCommand,
  ] as const
}

export { gateMessage }
