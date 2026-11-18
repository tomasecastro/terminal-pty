import { createEffect, onCleanup } from "solid-js"
import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Style,
  type MountedSession,
  type PanelProps,
  type PanelTab,
  type SessionRef,
} from "@opencode/plugin/gui"
import { autoOpenHandler, type PanelState } from "../../lib/gui/auto-open"
import { PanelRpc, type PanelClient, type PanelView } from "../../lib/gui/protocol"
import { renderScreenText } from "../../lib/screen"
import { keysToBytes } from "../../lib/terminal-keys"

/**
 * The visible terminal: the plugin's PTY, drawn in the session's side panel and driven by the human.
 *
 * ## What this bundle is
 *
 * `gui-experimental.cjs`, the prebuilt CommonJS bundle the desktop app evaluates in every window
 * (`packages/plugin/src/host.ts` → `Entrypoints.gui`). Its default export is a `Plugin.define`, the
 * host gives it the server plugin's id as `ctx.id`, and whatever `setup` contributes lives and dies
 * with that instance. It holds no PTY: the shell lives in the server process, in the plugin's
 * `SessionManager`, and this bundle reaches it over the {@link PanelRpc} contract (see
 * `lib/gui/protocol.ts` for why that is the only channel that does not touch the core).
 *
 * ## The terminal view
 *
 * The app's own terminal panel (`packages/gui-plugins/src/terminal/`) cannot be reused here: it is
 * bound to the server's own persistent PTY API and to a lazy chunk of its emulator, and a plugin
 * receives neither. What a plugin can render is its own markup, so this panel draws the screen text
 * the plugin already produces for the assistant, from the *same* buffer, with the escape sequences
 * replayed by `lib/screen.ts`.
 *
 * ## Keyboard (T051, T002–T003, FR-001..FR-004)
 *
 * The panel is a visible terminal: `tp-screen` shows the PTY's buffer and `tp-input` is a real,
 * visible line under it. By default the panel is in **line mode**: the textarea owns the text, the
 * caret and Backspace locally and the PTY receives nothing until Enter, when the whole line goes
 * out once through RPC `submit` (`SessionManager.submitHumanLine`). That is what stops the shell's
 * echo from turning `abc` into `a`, `aa`, `aaC`.
 *
 * `raw` mode keeps the old behaviour — a key `<textarea>` over the view, `keydown` mapped to bytes
 * by `lib/terminal-keys.ts` and sent through RPC `write` — for full-screen programs and prompts
 * that need immediate keys. The mode is the `InputMode` flag below; T008 adds its toggle.
 *
 * ## The open line, and a submit that fails (T019, T020)
 *
 * Typing is local, so the server would otherwise learn about the line only at Enter. The panel
 * therefore announces it: the first keystroke sends RPC `line { active: true }` (once, after a
 * short settle), and submit, blur, Escape/Ctrl+C or an emptied input send `active: false`, which
 * releases whatever the assistant had queued. Enter clears the input only after the server answers
 * `submitted: true`; when it fails the line stays where the person can send it again and a notice
 * under the input says so.
 *
 * ## Approvals (T052)
 *
 * This bundle contributes no permission UI at all. The server plugin asks the human through
 * `context.permission.assert`, which the app renders in its own native approval surface, the same one
 * `bash` and `edit` use; a dialog drawn here would be a second, unreviewed channel. When the user's
 * `permission` config auto-allows the action, the host never shows a prompt — that is the native
 * mechanism deciding, not this plugin hiding anything.
 */

/** Stable tab id; the stored key the host uses is `${ctx.id}:main`. */
const TAB = "main"

/** How often the panel asks the PTY for its screen, in milliseconds. */
const POLL_MS = 120

/** Rows the panel asks for; matches `PANEL_LINES` on the server. */
const LINES = 400

/**
 * How long a line stays unannounced after the first keystroke, in milliseconds (T019).
 *
 * The server only needs to know that a line is open, not that another key arrived: one RPC per
 * burst of typing is enough, and it keeps the first keystroke from costing a round trip.
 */
const LINE_NOTICE_MS = 150

/** Default line height, in pixels, when the computed style cannot be read. Matches the stylesheet. */
const LINE_HEIGHT = 16

/** What this bundle reads from the plugin context. Everything else the SDK offers stays unused. */
interface PanelContext {
  readonly id: string
  readonly t: (key: string) => string
  readonly appearance: { font(kind: "mono"): string }
  readonly layout: {
    open(key: string, session: SessionRef, options?: { tab?: "select" }): void
    state(key: string, session: SessionRef): PanelState
  }
  readonly sessions: { current(): MountedSession | null }
  /**
   * The servers this window lists, each with its API client. Read reactively: a server appears after
   * the app interface mounts, and its client is replaced when the window reconnects.
   */
  readonly servers: {
    list(): readonly string[]
    get(id: string): { readonly client: unknown } | undefined
  }
}

interface Connection {
  readonly rpc: PanelClient
  readonly options: { readonly location: { readonly directory: string } } | undefined
}

const setup: Plugin.Setup = (host) => {
  // SAFETY: the fields below are the ones the SDK documents on this context; the panel reads no
  // other member, so narrowing it here keeps the render free of the whole host surface.
  const ctx = host as unknown as PanelContext
  const key = `${ctx.id}:${TAB}`

  const openPanel = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(key, session, { tab: "select" })
  }

  /**
   * Auto-open (FR-007, FR-008).
   *
   * The server emits `opened` when the human authorizes a `full` grant. Every window is listening on
   * every server it lists; the one showing that session opens the terminal tab, so the grant and the
   * terminal appear together. The tab is opened only when the strip does not hold it yet, and the
   * host keys the strip by `${ctx.id}:${TAB}`, so a repeated event cannot add a second tab.
   *
   * A window whose client carries no event stream (an older build, a host without RPC events) skips
   * the subscription: the panel keeps working and stays one palette command away (FR-014).
   */
  const opened = autoOpenHandler({
    current: () => ctx.sessions.current() ?? undefined,
    state: (session) => ctx.layout.state(key, session),
    open: (session) => ctx.layout.open(key, session, { tab: "select" }),
  })

  const subscribed = new Map<string, { readonly client: PanelClient; readonly stop: () => void }>()

  createEffect(() => {
    const wanted = new Map<string, PanelClient>()
    for (const id of ctx.servers.list()) {
      const client = ctx.servers.get(id)?.client as { rpc?: (definition: unknown) => PanelClient } | undefined
      if (typeof client?.rpc !== "function") continue
      const panel = client.rpc(PanelRpc)
      if (!panel.events) continue
      wanted.set(id, panel)
    }
    // A client that is still the listed one keeps its listener; a replaced client (reconnect) is
    // resubscribed, because the stream it was listening on no longer exists.
    for (const [id, entry] of subscribed) {
      if (wanted.get(id) === entry.client) {
        wanted.delete(id)
        continue
      }
      entry.stop()
      subscribed.delete(id)
    }
    for (const [id, panel] of wanted) {
      const events = panel.events
      if (!events) continue
      subscribed.set(id, { client: panel, stop: events.on("opened", (event) => opened(event)) })
    }
  })

  onCleanup(() => {
    for (const entry of subscribed.values()) entry.stop()
    subscribed.clear()
  })

  // No `bind`: a shortcut that collides with the app's own would be worse than none, and the command
  // still lists in the palette and in Settings > Shortcuts, where the user can bind it.
  ctx.add(
    Command,
    (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.open.description"),
      group: ctx.t("command.group"),
      section: "terminal",
      run: openPanel,
    }),
  )

  ctx.add(
    MenuItem,
    (): MenuItem => ({
      menu: "session.panel",
      id: TAB,
      title: ctx.t("tab.title"),
      icon: "terminal",
      order: 40,
      run: openPanel,
    }),
  )

  // One tab object for the life of the instance: the host reads it again on every strip update, and a
  // fresh object would remount the trigger.
  const tab: PanelTab = {
    id: TAB,
    get title() {
      return ctx.t("tab.title")
    },
    closable: "hover",
  }

  // The panel uses the app's normal text color and the user's terminal font, so it looks like the
  // rest of the surface without carrying a palette of its own.
  ctx.add(
    Style,
    [
      ".tp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;outline:none}",
      ".tp-screen{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 10px;white-space:pre;",
      "tab-size:8;font-size:12px;line-height:16px;color:inherit;background:transparent}",
      ".tp-mode{flex:0 0 auto;display:flex;align-items:center;gap:6px;height:1.6em;padding:0 10px;",
      "font-size:11px;opacity:.7;border-top:1px solid rgba(127,127,127,.25)}",
      ".tp-mode-toggle{all:unset;cursor:pointer;padding:1px 6px;border:1px solid rgba(127,127,127,.45);",
      "border-radius:3px;font-size:10px;line-height:1.2;color:inherit}",
      ".tp-mode-toggle:focus-visible{outline:1px solid currentColor;outline-offset:1px}",
      ".tp-raw .tp-mode-toggle{border-color:rgba(229,192,123,.8);color:#e5c07b}",
      ".tp-input{flex:0 0 auto;width:100%;height:2em;margin:0;padding:4px 10px;border:0;",
      "border-top:1px solid rgba(127,127,127,.25);outline:none;resize:none;box-sizing:border-box;",
      "background:transparent;color:inherit;font:inherit;caret-color:auto;cursor:text}",
      ".tp-input.tp-blinded{-webkit-text-security:disc;border-top:1px solid rgba(229,192,123,.85);",
      "box-shadow:inset 0 1px 0 rgba(229,192,123,.45)}",
      ".tp-notice{flex:0 0 auto;display:none;padding:3px 10px;font-size:11px;color:#e06c75;",
      "border-top:1px solid rgba(224,108,117,.5)}",
    ].join(""),
  )

  const views = new Map<string, TerminalView>()

  onCleanup(() => {
    for (const view of [...views.values()]) view.dispose()
    views.clear()
  })

  ctx.add(Panel, {
    id: TAB,
    region: "side",
    width: 460,
    mobile: {
      get title() {
        return ctx.t("tab.title")
      },
      order: 40,
      kind: "menu",
      icon: "terminal",
      cached: true,
    },
    list: (input) => (input.open.includes(TAB) ? [tab] : []),
    render: (props) => {
      // A render replaces whatever was mounted for this tab before; without this, its poll timer
      // would outlive it when the host remounts the panel.
      views.get(props.tab.id)?.dispose()
      const view = createTerminalView(ctx, props)
      views.set(props.tab.id, view)
      return view.element
    },
    // A restored selection must not steal the keyboard from wherever the user is typing.
    focus: (input) => {
      if (!input.restored) views.get(input.tab.id)?.focus()
    },
    enter: (input) => views.get(input.tab.id)?.focus(),
    close: (input) => {
      views.get(input.tab.id)?.dispose()
      views.delete(input.tab.id)
    },
  })
}

interface TerminalView {
  readonly element: HTMLElement
  /** Moves the keyboard into the terminal, as clicking a terminal does. */
  focus(): void
  dispose(): void
}

/**
 * How the person's keyboard reaches the PTY.
 *
 * `line`: the text stays in the panel's own input and only Enter sends it (default, FR-001).
 * `raw`: every key goes out as it is pressed, for `vim`/`htop` and interactive prompts (FR-008).
 */
type InputMode = "line" | "raw"

/**
 * Which views currently hold the keyboard, and which one last did (T012, FR-015).
 *
 * The app can mount the same tab twice — a torn-off window, a re-render the host did not unmount —
 * and both would otherwise forward the same keystroke, so one command would be written twice. The
 * textarea's `focus` claims the pen, `blur` gives it back, and every write path checks
 * {@link mayWrite} first. The server's line lock (`lineActive`/`humanActive`) stays the last line of
 * defence: this only stops the window from sending a second copy in the first place.
 */
const focusedViews = new Set<object>()

/** The view that last held the keyboard; `null` until one takes focus. */
let writer: object | null = null

/**
 * Takes the pen for one view.
 *
 * The set is cleared rather than grown: only one element can hold focus in a document, and a stale
 * entry (a blur the host swallowed) must never keep a second panel writing alongside the focused one.
 */
function claimWriter(token: object): void {
  focusedViews.clear()
  focusedViews.add(token)
  writer = token
}

/** Gives the pen back. The last writer is remembered so an unfocused view is not silently replaced. */
function releaseWriter(token: object): void {
  focusedViews.delete(token)
}

/**
 * Whether this view may send to the PTY.
 *
 * A host that restores a tab without ever firing `focus` (the bundle tests do exactly that) must keep
 * working, so before any view claims the pen every view may write. Once one has claimed it, only the
 * focused view (or, after a blur, the last one that had it) may.
 */
function mayWrite(token: object): boolean {
  if (focusedViews.size > 0) return focusedViews.has(token)
  return writer === null || writer === token
}

/**
 * One panel render: builds the screen, keeps it current and forwards the keyboard.
 *
 * The render runs once per mounted tab; `props.session` is a live getter, so a session switch is
 * handled by reading it again rather than by remounting.
 */
function createTerminalView(ctx: PanelContext, props: PanelProps): TerminalView {
  const token = {}
  const element = document.createElement("div")
  element.className = "tp-root"
  element.tabIndex = -1

  const screen = document.createElement("pre")
  screen.className = "tp-screen"
  screen.setAttribute("role", "log")
  screen.setAttribute("aria-live", "polite")
  screen.style.fontFamily = ctx.appearance.font("mono")

  // The active mode (FR-012). Line is the default (FR-001): the person composes the command here
  // and the PTY hears nothing until Enter. T008 makes it runtime-switchable; `props.mode` stays as
  // the initial value the tests and a host that restores the selection can seed.
  let mode: InputMode = (props as { readonly mode?: InputMode }).mode === "raw" ? "raw" : "line"
  if (mode === "raw") element.className = "tp-root tp-raw"

  const bar = document.createElement("div")
  bar.className = "tp-mode"
  const modeLabel = document.createElement("span")
  modeLabel.className = "tp-mode-label"
  modeLabel.textContent = mode === "line" ? "Line" : "Raw"
  // The toggle names the mode it switches to, so both words are visible in either state: `Line` in
  // the label, `Raw` on the button while the panel is in line mode.
  const toggle = document.createElement("button")
  toggle.className = "tp-mode-toggle"
  toggle.textContent = mode === "line" ? "Raw" : "Line"
  toggle.setAttribute("aria-label", ctx.t(mode === "line" ? "mode.switch.raw" : "mode.switch.line"))
  toggle.setAttribute("aria-pressed", mode === "raw" ? "true" : "false")
  bar.append(modeLabel, toggle)

  const keyboard = document.createElement("textarea")
  keyboard.className = "tp-input"
  keyboard.setAttribute("aria-label", ctx.t("input.label"))
  keyboard.spellcheck = false
  keyboard.autocapitalize = "off"
  keyboard.autocomplete = "off"
  keyboard.rows = 1

  // T020: a failed submit says so here instead of clearing the line. Hidden until it is needed.
  const notice = document.createElement("div")
  notice.className = "tp-notice"
  notice.setAttribute("role", "alert")
  notice.style.display = "none"

  // The screen takes the free space; the mode bar and the input sit under it, the input last so it
  // reads as the line the person is typing on, and the notice under it.
  element.append(screen, bar, keyboard, notice)

  let shownSession: string | null = null
  let shownSeq = -1
  let text = ""
  let size = ""
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  // Keystrokes must reach the PTY in the order they were typed, so every call waits for the last.
  let queue: Promise<unknown> = Promise.resolve()
  // Whether the server currently holds this panel's line as open (`PanelRpc.line`, T019), and on
  // which session: a session switch does not move a line that was typed somewhere else.
  let lineOpen = false
  let linePeer: { readonly sessionID: string; readonly link: Connection } | null = null
  // The armed announcement of a line that was just opened; `undefined` when none is waiting.
  let lineTimer: ReturnType<typeof setTimeout> | undefined
  // One submit at a time: a second Enter while the first call is in flight would send the line twice.
  let submitting = false
  // T011: the PTY is at a credential prompt, so the local line is masked until the detector lets go.
  let blinded = false

  /**
   * Writes one CSS property, whichever way the host's stylesheet object exposes it.
   *
   * The window's `CSSStyleDeclaration` takes `setProperty` for a prefixed name; the bundle tests'
   * plain object only takes an index. Both end up in the same inline style the person sees.
   */
  const setStyle = (name: string, value: string) => {
    const style = keyboard.style as unknown as { setProperty?: (property: string, value: string) => void }
    if (typeof style.setProperty === "function") style.setProperty(name, value)
    else ;(keyboard.style as unknown as Record<string, string>)[name] = value
  }

  /**
   * Masks or unmasks the local line (T011, FR-009, SC-006).
   *
   * The screen keeps showing the prompt — the person has to read it — but the textarea holding the
   * password paints discs instead of characters. The class carries the stylesheet rule (and the
   * warning border); the inline property is set as well because a window that ignores the class
   * still masks, and because it is the one the tests can read back.
   */
  const applyBlinding = (value: boolean) => {
    if (value === blinded) return
    blinded = value
    if (value) {
      keyboard.className = "tp-input tp-blinded"
      setStyle("-webkit-text-security", "disc")
    } else {
      keyboard.className = "tp-input"
      setStyle("-webkit-text-security", "")
    }
  }

  const connection = (session: SessionRef): Connection | null => {
    const client = session.server.client as { rpc?: (definition: unknown) => PanelClient } | undefined
    if (typeof client?.rpc !== "function") return null
    const directory = session.location?.directory
    return { rpc: client.rpc(PanelRpc), options: directory ? { location: { directory } } : undefined }
  }

  const write = (data: string) => {
    if (data.length === 0) return
    // T012: a second mounted panel must not send the same keystroke.
    if (!mayWrite(token)) return
    const session = props.session
    const link = connection(session)
    if (!link) return
    queue = queue.then(() => link.rpc.write({ sessionID: session.id, data }, link.options)).catch(() => undefined)
  }

  /**
   * Tells the server whether a local line is open (T019, FR-006).
   *
   * Line mode keeps the text in the window, so without this the server would learn about the line
   * only at Enter — and an approved AI write landing on top of a line the person is still composing
   * is precisely what line mode has to prevent. One call per state change: the flags are the memory.
   *
   * The call joins the same queue as the writes, so it can never overtake the line's own submit.
   */
  const notifyLine = (peer: { readonly sessionID: string; readonly link: Connection }, active: boolean) => {
    queue = queue
      .then(() => peer.link.rpc.line({ sessionID: peer.sessionID, active }, peer.link.options))
      .catch(() => undefined)
  }

  /** The line is open on the session it was typed into, which is not always the one on screen now. */
  const openLine = (peer: { readonly sessionID: string; readonly link: Connection }) => {
    if (lineOpen) return
    lineOpen = true
    linePeer = peer
    notifyLine(peer, true)
  }

  /** The line is gone: cancel its announcement and close it, which releases what the AI had queued. */
  const closeLine = () => {
    if (lineTimer !== undefined) {
      clearTimeout(lineTimer)
      lineTimer = undefined
    }
    if (!lineOpen) return
    const peer = linePeer
    lineOpen = false
    linePeer = null
    if (peer) notifyLine(peer, false)
  }

  /** Line mode typed into: an empty input means no line, anything else opens one, once. */
  const noteTyping = () => {
    if (keyboard.value.length === 0) {
      closeLine()
      return
    }
    if (lineOpen || lineTimer !== undefined) return
    // The owning session is read at the keystroke, not at the timer: switching sessions in between
    // must not announce the line on the new one.
    const session = props.session
    const link = connection(session)
    if (!link) return
    const peer = { sessionID: session.id, link }
    lineTimer = setTimeout(() => {
      lineTimer = undefined
      openLine(peer)
    }, LINE_NOTICE_MS)
  }

  /** T020: the line did not go out. Say so and leave the text where the person can send it again. */
  const submitFailed = () => {
    notice.textContent = ctx.t("submit.failed")
    notice.style.display = "block"
    keyboard.setAttribute("aria-invalid", "true")
  }

  const submitSucceeded = () => {
    notice.textContent = ""
    notice.style.display = "none"
    keyboard.setAttribute("aria-invalid", "false")
  }

  const paint = (view: PanelView) => {
    // Only a line-mode input holds the credential: raw sends each key and leaves the box empty.
    applyBlinding(mode === "line" && view.attached === true && view.blinded === true)
    if (!view.attached) {
      text = view.reason === "no-terminal" ? ctx.t("empty") : `${ctx.t("unavailable")}: ${view.reason ?? ""}`
    } else if (view.fullScreenApp !== null) {
      text = ctx.t("fullscreen")
    } else if (view.text.length > 0) {
      // The panel is the last stop before the DOM, so it replays the buffer here as well: a raw tail
      // painted as-is shows `\b`, `\r` and colour codes, and typing then deleting a key would read as
      // `s\bsssh` instead of `ssh`. The server already renders `PanelView.text`; replaying it again is
      // a no-op, and it keeps the view readable when the bundle runs against a server that does not.
      text = renderScreenText(view.text, { lines: LINES })
      shownSeq = view.seq
    }
    screen.textContent = text
    screen.scrollTop = screen.scrollHeight
  }

  const unavailable = (reason: string): PanelView => ({
    attached: false,
    blinded: false,
    text: "",
    seq: 0,
    status: "closed",
    title: "",
    cwd: null,
    foregroundProcess: null,
    fullScreenApp: null,
    engine: "unknown",
    reason,
  })

  const tick = async () => {
    if (disposed) return
    const session = props.session
    // The layout writes and the RPC both need the session's location; before it is known there is
    // nothing to address, and the next tick asks again.
    if (!session.location) return

    const link = connection(session)
    if (!link) return paint(unavailable("no-rpc"))

    const fresh = shownSession !== session.id
    if (fresh) {
      shownSession = session.id
      shownSeq = -1
      text = ""
    }

    try {
      const view = fresh
        ? await link.rpc.open({ sessionID: session.id, cwd: session.directory }, link.options)
        : await link.rpc.read({ sessionID: session.id, lines: LINES, sinceSeq: shownSeq }, link.options)
      if (!disposed) paint(view)
    } catch (error) {
      paint(unavailable(error instanceof Error ? error.message : String(error)))
    }
  }

  // Terminal size, estimated from the rendered box, so the shell wraps where the panel does.
  const fit = () => {
    if (disposed) return
    const session = props.session
    const link = connection(session)
    if (!link || screen.clientWidth === 0) return

    const probe = document.createElement("span")
    probe.textContent = "MMMMMMMMMM"
    probe.style.position = "absolute"
    probe.style.visibility = "hidden"
    probe.style.whiteSpace = "pre"
    probe.style.fontFamily = ctx.appearance.font("mono")
    element.append(probe)
    const cell = probe.getBoundingClientRect().width / 10
    probe.remove()

    const lineHeight = Number.parseFloat(getComputedStyle(screen).lineHeight) || LINE_HEIGHT
    const cols = cell > 0 ? Math.floor((screen.clientWidth - 20) / cell) : 0
    const rows = Math.floor((screen.clientHeight - LINE_HEIGHT) / lineHeight)
    const next = `${cols}x${rows}`
    if (cols < 20 || rows < 5 || next === size) return

    size = next
    queue = queue.then(() => link.rpc.resize({ sessionID: session.id, cols, rows }, link.options)).catch(() => undefined)
  }

  /**
   * Sends the composed line once, on Enter.
   *
   * The input is cleared **only** after the server answers `submitted: true` (T020): a revoked
   * grant or a dropped RPC used to erase the line from the only place it existed. Nothing is
   * disabled while the call is in flight — the person keeps typing — and `submitting` only stops a
   * second Enter from sending the same line twice.
   */
  const submit = () => {
    if (submitting) return
    // T012: only the focused panel submits; a duplicate view stays a reader.
    if (!mayWrite(token)) return
    const session = props.session
    const link = connection(session)
    if (!link) {
      submitFailed()
      return
    }
    const line = keyboard.value
    submitting = true
    queue = queue
      .then(() => link.rpc.submit({ sessionID: session.id, line }, link.options))
      .then((result) => {
        submitting = false
        if (disposed) return
        if (result?.submitted !== true) {
          submitFailed()
          return
        }
        submitSucceeded()
        // Only the line that actually went out leaves the input: anything typed while the call was
        // in flight stays.
        if (keyboard.value === line) keyboard.value = ""
        // The submit already closes the line on the server; this keeps a `line` announced right
        // before Enter from staying open there.
        closeLine()
      })
      .catch(() => {
        submitting = false
        if (!disposed) submitFailed()
      })
  }

  /** Puts text where the caret is, as the browser would for a key the panel handles itself. */
  const insertAtCaret = (text: string) => {
    const start = keyboard.selectionStart ?? keyboard.value.length
    const end = keyboard.selectionEnd ?? start
    keyboard.value = `${keyboard.value.slice(0, start)}${text}${keyboard.value.slice(end)}`
    const caret = start + text.length
    keyboard.selectionStart = caret
    keyboard.selectionEnd = caret
  }

  /**
   * Switches between line and raw at runtime (T008, FR-012).
   *
   * The button names the mode it goes to, the root gets `tp-raw` so the stylesheet can mark it, and
   * the keyboard goes back to the textarea: a button that took the focus would leave the person
   * typing nowhere. The local line belongs to line mode, so switching either way clears it and
   * closes it on the server — a line nobody can see must not keep the assistant queued.
   */
  const applyMode = (next: InputMode) => {
    if (next === mode) return
    mode = next
    element.className = next === "raw" ? "tp-root tp-raw" : "tp-root"
    modeLabel.textContent = next === "line" ? "Line" : "Raw"
    toggle.textContent = next === "line" ? "Raw" : "Line"
    toggle.setAttribute("aria-label", ctx.t(next === "line" ? "mode.switch.raw" : "mode.switch.line"))
    toggle.setAttribute("aria-pressed", next === "raw" ? "true" : "false")
    keyboard.value = ""
    closeLine()
    // Raw keys are not painted in the input, so a credential mask has nothing to hide there; line
    // mode gets it back from the next poll, which reads `view.blinded`.
    if (next === "raw") applyBlinding(false)
    // Clicking the panel's own control is a claim on the keyboard like clicking the terminal area.
    claimWriter(token)
    keyboard.focus()
  }

  // Line mode keys: Enter submits (FR-002), Escape and Ctrl+C drop the local line (FR-010) and Tab
  // stays in the line instead of moving focus. Every other key is left to the textarea, so the
  // caret, Backspace and selection work locally and the PTY hears nothing (FR-004).
  const onLineKeyDown = (event: KeyboardEvent): boolean => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
      return true
    }
    if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c")) {
      event.preventDefault()
      keyboard.value = ""
      closeLine()
      return true
    }
    if (event.key === "Tab") {
      event.preventDefault()
      insertAtCaret("\t")
      // A programmatic edit fires no `input` event, so the opened line is announced here.
      noteTyping()
      return true
    }
    return false
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // T012: the panel that does not hold the keyboard ignores the key instead of forwarding it.
    if (!mayWrite(token)) return
    if (mode === "line") {
      onLineKeyDown(event)
      return
    }
    // Raw mode. The window's paste shortcuts belong to the window: it turns them into the `paste`
    // event, and `onPaste` sends the clipboard once. Forwarding the keystroke as bytes too would
    // paste twice, because the shell's line editor binds the same keys to its own paste —
    // PSReadLine's `Ctrl+v` and `Shift+Insert` are its `Paste` function, which reads the clipboard
    // of the machine the shell runs on and inserts the same text a second time.
    if (isPasteShortcut(event)) return
    const bytes = keysToBytes({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    })
    if (bytes === null) return
    event.preventDefault()
    write(bytes)
  }

  const onPaste = (event: ClipboardEvent) => {
    // In line mode the textarea takes the clipboard itself: that text is the line, and Enter is
    // what sends it (FR-011). Nothing reaches the PTY here.
    if (mode === "line") return
    // T012: a duplicate panel may not paste into the same PTY.
    if (!mayWrite(token)) return
    // The box stays empty: a paste is not a keystroke, and whatever the window inserts here would be
    // a second copy of text that already went to the PTY. `preventDefault` stops the insertion and
    // the clear covers a host where it does not.
    event.preventDefault()
    const pasted = event.clipboardData?.getData("text")
    keyboard.value = ""
    if (!pasted) return
    // The PTY's line discipline ends a line with `\r`, the same byte Enter sends; a bare `\n` from
    // the clipboard does not submit a command on a Windows console.
    write(pasted.replace(/\r\n|[\r\n]/g, "\r"))
  }

  // A composed character (CJK, dead keys) never arrives through `keydown` as text. In line mode the
  // textarea already holds it and Enter sends it with the line.
  const onCompositionEnd = (event: Event) => {
    if (mode === "line") return
    if (!mayWrite(token)) return
    const data = (event as CompositionEvent).data
    if (data) write(data)
  }

  // In raw mode nothing typed into the box is meant to stay there: every handled key was already
  // sent. In line mode the value is the line itself and must survive every input event; what the
  // server hears is only that the line opened (or closed, when the box is emptied).
  const onInput = () => {
    if (!mayWrite(token)) return
    if (mode === "line") {
      noteTyping()
      return
    }
    keyboard.value = ""
  }

  /** Taking the focus claims the pen: from then on this is the only panel that writes (T012). */
  const onFocus = () => {
    claimWriter(token)
  }

  /** Leaving the input closes the line: nobody is composing it any more, so the AI need not wait. */
  const onBlur = () => {
    releaseWriter(token)
    if (mode === "line") closeLine()
  }

  const onToggle = () => {
    applyMode(mode === "line" ? "raw" : "line")
  }

  // The mode button is a panel control, not a place to type: keeping the press from moving the focus
  // means the textarea never blurs on the way to the click.
  const onTogglePress = (event: Event) => event.preventDefault()

  keyboard.addEventListener("keydown", onKeyDown)
  keyboard.addEventListener("paste", onPaste)
  keyboard.addEventListener("compositionend", onCompositionEnd)
  keyboard.addEventListener("input", onInput)
  keyboard.addEventListener("focus", onFocus)
  keyboard.addEventListener("blur", onBlur)
  toggle.addEventListener("mousedown", onTogglePress)
  toggle.addEventListener("click", onToggle)

  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (resizeTimer !== undefined) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(fit, 200)
        })
      : undefined
  observer?.observe(element)

  void tick()
  timer = setInterval(() => void tick(), POLL_MS)

  return {
    element,
    focus() {
      claimWriter(token)
      keyboard.focus()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      // A tab closed with a line open must not leave the assistant's queue waiting for a line
      // nobody can submit any more.
      closeLine()
      releaseWriter(token)
      // A disposed view must not keep the pen: a fresh render of the same tab has to be able to write.
      if (writer === token) writer = null
      observer?.disconnect()
      keyboard.removeEventListener("keydown", onKeyDown)
      keyboard.removeEventListener("paste", onPaste)
      keyboard.removeEventListener("compositionend", onCompositionEnd)
      keyboard.removeEventListener("input", onInput)
      keyboard.removeEventListener("focus", onFocus)
      keyboard.removeEventListener("blur", onBlur)
      toggle.removeEventListener("mousedown", onTogglePress)
      toggle.removeEventListener("click", onToggle)
    },
  }
}

/**
 * Whether the window, not the PTY, owns this keystroke.
 *
 * `Ctrl+V`, `Ctrl+Shift+V` and `Shift+Insert` are the shortcuts the window turns into a `paste`
 * event. Sending them to the PTY as well would paste twice: the shell's line editor binds the same
 * keys to its own paste (PSReadLine binds `Ctrl+v` and `Shift+Insert` to `Paste`, which reads the
 * clipboard of the machine the shell runs on), so the text would be inserted once by the editor and
 * once by {@link onPaste}. `AltGr` is a character, not a shortcut — it arrives as `ctrlKey` plus
 * `altKey` and is typed, which is why `altKey` rules the predicate out first.
 *
 * A terminal's `Ctrl+V` (quoted insert, in readline) is not reachable from a window that reserves
 * the shortcut; pasting is what the key is for here.
 */
function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false
  if (event.ctrlKey) return event.key.toLowerCase() === "v"
  return event.shiftKey && event.key === "Insert"
}

export default Plugin.define({
  i18n: {
    en: {
      "tab.title": "Terminal",
      "command.group": "Terminal",
      "command.open": "Open terminal",
      "command.open.description": "Show the plugin's PTY for this session",
      "input.label": "Terminal input",
      "mode.switch.raw": "Switch to raw mode (send every key immediately)",
      "mode.switch.line": "Switch to line mode (send on Enter)",
      "empty": "No terminal yet. Type a command, or ask the assistant to open one.",
      "fullscreen": "A full-screen program is running in this terminal; it is not rendered here.",
      "unavailable": "Terminal unavailable",
      "submit.failed": "The line was not sent; the terminal did not accept it. Your text is still here.",
    },
    es: {
      "tab.title": "Terminal",
      "command.group": "Terminal",
      "command.open": "Abrir terminal",
      "command.open.description": "Muestra la PTY del plugin para esta sesión",
      "input.label": "Entrada de la terminal",
      "mode.switch.raw": "Cambiar a modo raw (envía cada tecla de inmediato)",
      "mode.switch.line": "Cambiar a modo línea (envía al presionar Enter)",
      "empty": "Todavía no hay terminal. Escribí un comando, o pedile al asistente que la abra.",
      "fullscreen": "Hay un programa de pantalla completa en esta terminal; no se dibuja acá.",
      "unavailable": "Terminal no disponible",
      "submit.failed": "La línea no se envió: la terminal no la aceptó. Tu texto sigue acá.",
    },
  },
  setup,
})
