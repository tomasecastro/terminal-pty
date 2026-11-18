import { Schema } from "effect"

/**
 * The RPC contract between the visible terminal and the PTY.
 *
 * ## Why RPC and not a shared module (T051)
 *
 * The PTY lives in the OpenCode server process, in the plugin's `SessionManager`, next to the tools.
 * The panel runs in the desktop app's window process, delivered as the `gui-experimental` CommonJS
 * bundle. A window cannot reach another process's objects, and the app gives plugin GUIs no terminal
 * channel: `@opencode/plugin/gui` exposes no terminal contract, and the one PTY API a plugin can see
 * (`experimental.terminal`) is a *read* of the host's own terminal, not the plugin's shell.
 *
 * The server's RPC registry is the documented way across that boundary: the server plugin registers
 * this definition with `ctx.rpc.register`, and the window calls it through the server's API client
 * (`server.client.rpc(PanelRpc)`), which routes by `location` to the same plugin instance that holds
 * the PTY. No port is opened, no new surface is exposed, and the credential the app already uses for
 * the server is the only one involved.
 *
 * ## Trust boundary
 *
 * Every method here is the *human's* door, and it is the panel's own session that it names. It is
 * not a second door for the assistant: the assistant has its own tools, its own grant and its own
 * per-command approval. Nothing in this contract can widen what a tool may do, read a withheld
 * credential, or reach a session in another location (the registration itself is location-scoped).
 */

/** What the panel shows: one PTY's screen, or why there is none. */
export const PanelView = Schema.Struct({
  /** A live PTY exists for the session. False means `reason` says why. */
  attached: Schema.Boolean,
  /**
   * The PTY is at a credential prompt, so the panel masks what the person types (T011, FR-009).
   *
   * This is the only piece of the detector's state the panel needs: the *text* stays unblinded (the
   * person must read their own prompt), but the local line holding the password must not be painted
   * in clear. The AI-facing view is withheld separately, in `snapshot`, and never travels here.
   */
  blinded: Schema.Boolean,
  /** Rendered screen text, empty when the caller's `sinceSeq` is current. */
  text: Schema.String,
  /** Buffer sequence; a change means `text` was re-rendered. */
  seq: Schema.Number,
  /** Session status: `connecting`, `authenticating`, `ready`, `closed` or `error`. */
  status: Schema.String,
  /** Human-readable title, e.g. `pwsh.exe (local)`. */
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  foregroundProcess: Schema.NullOr(Schema.String),
  /** Set when a full-screen program owns the terminal; the panel does not render those. */
  fullScreenApp: Schema.NullOr(Schema.String),
  /** Which engine produced the view. */
  engine: Schema.String,
  /** Why there is no view, when `attached` is false. */
  reason: Schema.optional(Schema.String),
})
export type PanelView = typeof PanelView.Type

/**
 * What the panel may ask of one session's PTY.
 *
 * Written out by hand rather than passed through `Rpc.define` on purpose. A plugin discovered by
 * folder (`~/.config/opencode/plugin/...`) is given `effect` and `@opencode/plugin/*` by the host —
 * `runtimePackages` in `packages/plugin/src/runtime-modules.ts` — and nothing else, so importing
 * `@opencode/schema/rpc` there aborts the server at load time with `Cannot find package
 * '@opencode/schema'`. `Rpc.define` validates only that no error name starts with `rpc.`, then
 * returns its argument unchanged, and no method here declares `errors`; the object below is
 * therefore the same definition `ctx.rpc.register` takes in `src/index.ts` and the same one
 * `server.client.rpc(PanelRpc)` routes on in `src/gui/index.ts`.
 */
export const PanelRpc = {
  id: "terminal-pty.panel",
  methods: {
    /** Spawns the session's shell when it has none, and returns the view. Idempotent. */
    open: {
      input: Schema.Struct({ sessionID: Schema.String, cwd: Schema.optional(Schema.String) }),
      output: PanelView,
    },
    /** Current view. `sinceSeq` skips re-sending text the panel already holds. */
    read: {
      input: Schema.Struct({
        sessionID: Schema.String,
        lines: Schema.optional(Schema.Number),
        sinceSeq: Schema.optional(Schema.Number),
      }),
      output: PanelView,
    },
    /** Human keystrokes, straight to the PTY. Never a command proposal, never audited. */
    write: {
      input: Schema.Struct({ sessionID: Schema.String, data: Schema.String }),
      output: Schema.Struct({ written: Schema.Boolean }),
    },
    /**
     * A whole line the human composed locally (line mode) and submitted with Enter.
     *
     * It is the human's door, like `write`: the server appends the newline and writes it once. The
     * content never reaches the log, so a password typed at a local prompt stays out of it.
     */
    submit: {
      input: Schema.Struct({ sessionID: Schema.String, line: Schema.String }),
      output: Schema.Struct({ submitted: Schema.Boolean }),
    },
    /**
     * The human opened or closed a local line (line mode), before any Enter (T019, FR-006).
     *
     * `active: true` at the first keystroke is what tells the server that a line is being composed
     * in the window: from then on an approved AI write is queued instead of landing on top of it,
     * however long the person takes. `active: false` (submit, blur, Escape/Ctrl+C, empty input)
     * closes it and releases what the assistant had waiting.
     *
     * `output.active` is the state the server now holds, so the panel can tell `true` from "there
     * was no session to hold it" (which answers `false`).
     */
    line: {
      input: Schema.Struct({ sessionID: Schema.String, active: Schema.Boolean }),
      output: Schema.Struct({ active: Schema.Boolean }),
    },
    /** Terminal size the panel needs, so the shell wraps where the panel does. */
    resize: {
      input: Schema.Struct({ sessionID: Schema.String, cols: Schema.Number, rows: Schema.Number }),
      output: Schema.Struct({ resized: Schema.Boolean }),
    },
  },
  events: {
    /**
     * The human just granted `full` to this session's terminal (FR-007).
     *
     * Server to window only: `src/index.ts` emits it after `grantFull` succeeds, and every window
     * subscribed to the same server answers by opening the terminal tab for the session it names
     * (`lib/gui/auto-open.ts`). It is emitted, never requested, so the contract still carries no
     * method that could widen a tool's reach. A host that cannot carry events never delivers it, and
     * the panel stays one palette command away (FR-014).
     */
    opened: { schema: Schema.Struct({ sessionID: Schema.String }) },
  },
} as const

/** The client the window builds from {@link PanelRpc}, so the panel code reads without casts. */
export interface PanelClient {
  open(
    input: { readonly sessionID: string; readonly cwd?: string },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<PanelView>
  read(
    input: { readonly sessionID: string; readonly lines?: number; readonly sinceSeq?: number },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<PanelView>
  write(
    input: { readonly sessionID: string; readonly data: string },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<{ readonly written: boolean }>
  submit(
    input: { readonly sessionID: string; readonly line: string },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<{ readonly submitted: boolean }>
  line(
    input: { readonly sessionID: string; readonly active: boolean },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<{ readonly active: boolean }>
  resize(
    input: { readonly sessionID: string; readonly cols: number; readonly rows: number },
    options?: { readonly location?: { readonly directory?: string } },
  ): Promise<{ readonly resized: boolean }>
  /**
   * Server-to-window events. Absent on a host whose API client has no event stream, which is why
   * the panel checks for it instead of assuming it.
   */
  readonly events?: {
    /** Listens to `opened`; the returned function stops listening. */
    on(
      name: "opened",
      handler: (event: { readonly data: { readonly sessionID: string } }) => void,
      options?: { readonly signal?: AbortSignal },
    ): () => void
  }
}
