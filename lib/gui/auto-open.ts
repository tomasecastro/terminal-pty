/**
 * The decision behind the auto-open (FR-007, FR-008), kept free of the window host so it can be
 * tested without a browser.
 *
 * ## The flow
 *
 * The human approves `terminal_pty_access_grant({ mode: "full" })`; the server plugin answers by
 * emitting `opened` on {@link import("./protocol").PanelRpc} with `{ sessionID }`. Every window
 * subscribed to that server runs this handler, and the one showing that session opens the terminal
 * tab, so the person sees the terminal they just authorized.
 *
 * ## Why a state check and not a "seen" set
 *
 * `Layout.open` is idempotent by key: the host's strip keeps one entry per `${plugin}:${tab}`, and a
 * second `open` selects the existing tab instead of adding another (FR-008 holds at the host). What
 * is left to decide is whether opening at all is useful. Answering "no" once the tab is already in
 * the strip keeps the auto-open from stealing the pane selection on a repeated event, and it still
 * reopens a tab the person closed before a new grant: no memory of past events, only the layout's
 * current state.
 */

/** Where the host says a panel key stands; mirrors `PanelState` in `@opencode/plugin/gui`. */
export type PanelState = "closed" | "open" | "active" | "visible"

/** One `opened` event as the RPC client delivers it: the payload under `data`. */
export interface OpenedEvent {
  readonly data: { readonly sessionID: string }
}

/** A session as far as this decision cares: the host's `SessionRef` narrowed to its id. */
export interface AutoOpenSession {
  readonly id: string
}

export interface AutoOpenDeps<S extends AutoOpenSession> {
  /** The session on screen, read at event time so the handler follows the routed session. */
  readonly current: () => S | undefined
  /** The tab's state in that session's strip. */
  readonly state: (session: S) => PanelState
  /** Opens the tab; the host keeps one entry per key. */
  readonly open: (session: S) => void
}

/**
 * Builds the handler for `opened`: it opens the terminal tab when, and only when, the grant names
 * the session on screen and that session's strip does not hold the tab yet.
 */
export function autoOpenHandler<S extends AutoOpenSession>(deps: AutoOpenDeps<S>) {
  return (event: OpenedEvent): void => {
    const session = deps.current()
    if (!session) return
    if (session.id !== event.data.sessionID) return
    if (deps.state(session) !== "closed") return
    deps.open(session)
  }
}
