import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { makeTerminalTools, type LocalTerminalDeps } from "./tools"
import type { AccessPolicy } from "../lib/access"
import { panelHandlers } from "../lib/gui/host"
import { PanelRpc } from "../lib/gui/protocol"
import { LocalTerminal } from "../lib/local-engine"
import { LocalShellConnector } from "../lib/local-shell"
import { createNodePtySpawner } from "../lib/pty-host"
import { SessionManager } from "../lib/session-manager"
import type { TerminalEngine } from "../lib/types"

/**
 * Terminal plugin: a PTY the plugin drives itself, plus the host terminal as a read fallback.
 *
 * The plugin spawns its own local shell (`node-pty`) and owns both directions of it, so
 * `write` no longer depends on what the hosting build exposes. When `node-pty` cannot be
 * loaded — another platform, a missing prebuild, an unsupported runtime — the plugin still
 * loads, keeps reading the host terminal and reports `engine: "host-read-only"`.
 *
 * Access stays exactly as before: read and write are separate capabilities, both closed by
 * default, granted per session, and revocable at any moment. Writing additionally requires
 * human approval per command through `permission.assert`.
 */

type TerminalWithWrite = {
  read: (input: { sessionID: never; lines?: number }) => Effect.Effect<TerminalViewLike | null, unknown>
  write?: (input: { ptyID: string; data: string }) => Effect.Effect<void, unknown>
}

type TerminalViewLike = {
  ptyID: string
  title: string
  cwd: string
  foregroundProcess: string | null
  screen: { text: string }
}

/** The plugin's own engine: a spawner over `node-pty` and the manager that drives sessions. */
interface LocalEngine {
  readonly manager: SessionManager
  readonly connector: LocalShellConnector
}

function readPolicy(options: unknown): Partial<AccessPolicy> {
  const raw = (options as { access?: Record<string, unknown> } | undefined)?.access
  // The environment fallback matters when the plugin is discovered by folder, because
  // auto-discovery passes `options: {}` and there would be no other way to enable access.
  const fromEnv = process.env.SSH_PTY_ACCESS === "1" || process.env.SSH_PTY_ACCESS === "true"
  if (!raw || typeof raw !== "object") return fromEnv ? { enabled: true } : {}
  return {
    enabled: raw.enabled === true || fromEnv,
    ...(Array.isArray(raw.allowlist)
      ? { allowlist: raw.allowlist.filter((item): item is string => typeof item === "string") }
      : {}),
  }
}

/**
 * Loads the native PTY binding. Throws when it is unavailable, and the caller degrades to
 * host-read-only instead of taking the whole app down.
 */
async function createLocalEngine(): Promise<LocalEngine> {
  const spawner = await createNodePtySpawner()
  const connector = new LocalShellConnector(spawner)
  const manager = new SessionManager({ spawner, connector })
  return { manager, connector }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  id: "terminal-pty",
  effect: (context) =>
    Effect.gen(function* () {
      const terminal = context.experimental.terminal as unknown as TerminalWithWrite

      // Host terminal: read always, write only when this build exposes it.
      const readHost = (sessionID: string, lines?: number) =>
        terminal.read({ sessionID: sessionID as never, lines }).pipe(
          Effect.map((output) =>
            output
              ? {
                  ptyID: output.ptyID,
                  title: output.title,
                  cwd: output.cwd,
                  foregroundProcess: output.foregroundProcess,
                  text: output.screen.text,
                }
              : null,
          ),
          Effect.orElseSucceed(() => null),
        )

      const writeHost = terminal.write
        ? (ptyID: string, data: string) => terminal.write!({ ptyID, data })
        : undefined

      // Own engine. A failure here is expected on unsupported hosts and must never be fatal.
      const started = yield* Effect.tryPromise({
        try: () => createLocalEngine(),
        catch: (error) => describeError(error),
      }).pipe(
        Effect.match({
          onFailure: (message) => ({ ok: false as const, message }),
          onSuccess: (engine: LocalEngine) => ({ ok: true as const, engine }),
        }),
      )

      const engine = (): TerminalEngine => (started.ok ? "local-pty" : "host-read-only")
      const localDeps: LocalTerminalDeps | undefined = started.ok
        ? new LocalTerminal(started.engine.manager, started.engine.connector, { engine: "local-pty" })
        : undefined
      const engineError = started.ok ? null : started.message

      /**
       * The visible terminal's channel (T050/T051).
       *
       * `terminal-pty.panel` is the window's door to *this* `SessionManager`: the same instance the
       * `terminal_pty_*` tools use, so a key typed in the panel and a command run by the assistant
       * meet in one PTY. Registration is location-scoped (it happens inside this plugin's own node),
       * which is what keeps a call from reaching another directory's shells.
       *
       * A failure here is not fatal: without the RPC the panel shows "unavailable" and every tool
       * keeps working exactly as before.
       */
      const panel = localDeps ? panelHandlers(localDeps.panel(), engine) : undefined
      // The registration is kept, not just a boolean: it carries `events.emit`, the only way this
      // side can tell a window to open the terminal (FR-007).
      const registration = panel
        ? yield* context.rpc
            .register(PanelRpc, {
              open: (input: { sessionID: string; cwd?: string }) => Effect.promise(() => panel.open(input)),
              read: (input: { sessionID: string; lines?: number; sinceSeq?: number }) =>
                Effect.sync(() => panel.read(input)),
              write: (input: { sessionID: string; data: string }) => Effect.sync(() => panel.write(input)),
              submit: (input: { sessionID: string; line: string }) => Effect.sync(() => panel.submit(input)),
              line: (input: { sessionID: string; active: boolean }) => Effect.sync(() => panel.line(input)),
              resize: (input: { sessionID: string; cols: number; rows: number }) =>
                Effect.sync(() => panel.resize(input)),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.log("terminal-pty gui rpc unavailable", { error: describeError(error) }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
        : undefined

      /**
       * Tells every subscribed window that this session's terminal was just authorized.
       *
       * Without a GUI channel there is nothing to tell: the auto-open becomes a no-op and the panel
       * stays one palette command away (FR-014). A failed delivery costs the auto-open only, so it
       * is logged and never surfaced as a tool failure.
       */
      const notifyOpened = (sessionID: string) =>
        registration
          ? registration.events.emit("opened", { sessionID }).pipe(
              Effect.catch((error) =>
                Effect.log("terminal-pty auto-open event failed", { error: describeError(error) }),
              ),
            )
          : Effect.void

      const read = (sessionID: string, lines?: number) => {
        if (localDeps?.has(sessionID)) {
          const view = localDeps.view(sessionID, lines)
          if (view) return Effect.succeed(view)
        }
        return readHost(sessionID, lines)
      }

      const write = localDeps
        ? (ptyID: string, data: string) =>
            localDeps.has(ptyID)
              ? Effect.sync(() => localDeps.write(ptyID, data))
              : writeHost
                ? writeHost(ptyID, data)
                : Effect.fail(new Error("The host does not expose a write channel"))
        : writeHost

      const assert = (input: {
        sessionID: string
        action: string
        resources: readonly string[]
        save?: readonly string[]
        metadata?: Record<string, unknown>
      }) =>
        context.permission
          .assert({
            sessionID: input.sessionID as never,
            action: input.action,
            resources: input.resources as never,
            ...(input.save ? { save: input.save as never } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          })
          .pipe(Effect.mapError((error) => error))

      const tools = makeTerminalTools({
        read,
        ...(write ? { write } : {}),
        assert,
        notifyOpened,
        policy: readPolicy(context.options),
        ...(localDeps ? { local: localDeps } : {}),
        engine,
      })

      yield* context.tool.transform((editor) => {
        for (const tool of tools) editor.add(tool as never)
      })

      yield* Effect.log("terminal-pty plugin loaded", {
        directory: context.location.directory,
        engine: engine(),
        write: Boolean(write),
        engineError,
        shell: started.ok ? started.engine.connector.shell.file : null,
        accessEnabled: readPolicy(context.options).enabled === true,
        guiRpc: registration ? PanelRpc.id : null,
        tools: tools.map((tool) => tool.name),
      })
    }),
})
