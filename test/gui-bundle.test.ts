import { describe, expect, test } from "bun:test"
import path from "node:path"
import { renderScreenText } from "../lib/screen"

/**
 * Loads the built `gui-experimental.cjs` exactly as the desktop app does — one CommonJS text,
 * evaluated with a `require` that only answers the modules the window host provides — and drives it.
 *
 * This is the closest thing to a runtime check available here: the bundle cannot be installed into
 * the running app from this repository, but everything after that install is exercised — the
 * `Plugin.define` shape the host validates, the contributions `setup` makes, the panel's read loop
 * and the keyboard channel that ends in an RPC `write` call.
 *
 * Run `bun script/build-gui.ts` first; without the bundle these tests skip.
 */

const bundlePath = path.resolve(import.meta.dir, "..", "gui-experimental.cjs")
const bundle = Bun.file(bundlePath)
const built = await bundle.exists()

interface FakeElement {
  className: string
  tabIndex: number
  style: Record<string, string>
  clientWidth: number
  clientHeight: number
  scrollTop: number
  scrollHeight: number
  textContent: string
  value: string
  rows: number
  spellcheck: boolean
  autocapitalize: string
  autocomplete: string
  children: FakeElement[]
  readonly attributes: Map<string, string>
  readonly listeners: Map<string, ((event: unknown) => void)[]>
  append(...nodes: FakeElement[]): void
  remove(): void
  setAttribute(name: string, value: string): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  dispatch(type: string, event: unknown): void
  focus(): void
  /** How many times `focus()` was called; a no-op element still records it for the assertions. */
  focusCalls: number
  getBoundingClientRect(): { width: number; height: number }
}

function element(): FakeElement {
  const node: FakeElement = {
    className: "",
    tabIndex: 0,
    style: {},
    clientWidth: 600,
    clientHeight: 400,
    scrollTop: 0,
    scrollHeight: 800,
    textContent: "",
    value: "",
    rows: 1,
    spellcheck: true,
    autocapitalize: "",
    autocomplete: "",
    focusCalls: 0,
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    append(...nodes) {
      node.children.push(...nodes)
    },
    remove() {},
    setAttribute(name, value) {
      node.attributes.set(name, value)
    },
    addEventListener(type, listener) {
      node.listeners.set(type, [...(node.listeners.get(type) ?? []), listener])
    },
    removeEventListener(type, listener) {
      node.listeners.set(type, (node.listeners.get(type) ?? []).filter((item) => item !== listener))
    },
    dispatch(type, event) {
      for (const listener of node.listeners.get(type) ?? []) listener(event)
    },
    focus() {
      node.focusCalls += 1
    },
    getBoundingClientRect: () => ({ width: 100, height: 16 }),
  }
  return node
}

/** One recorded RPC call, as the panel made it. */
interface Call {
  readonly method: string
  readonly input: Record<string, unknown>
  readonly options: unknown
}

interface Harness {
  readonly contributions: { readonly token: unknown; readonly item: unknown }[]
  readonly calls: Call[]
  readonly layoutOpens: unknown[]
  readonly cleanups: (() => void)[]
  readonly root: () => FakeElement | undefined
  readonly screen: () => FakeElement | undefined
  readonly bar: () => FakeElement | undefined
  readonly keyboard: () => FakeElement | undefined
  /** The Line/Raw switch in the mode bar. */
  readonly toggle: () => FakeElement | undefined
  /** The failed-submit notice under the input. */
  readonly notice: () => FakeElement | undefined
  /** The session every render is bound to, so a test can mount a second panel. */
  readonly session: Session
  /** Mounts a second panel under a different tab id, the way two windows would. */
  readonly render: (tabID: string) => FakeElement
  /** Delivers one `opened` event, as the server's RPC stream would. */
  readonly emitOpened: (sessionID: string) => void
}

interface Session {
  readonly id: string
  readonly directory: string
  readonly location: { readonly directory: string }
  readonly server: { readonly client: { rpc(definition: unknown): unknown } }
}

/**
 * The shell behind the PTY, as far as the panel can tell.
 *
 * `text` is the raw tail the next `read` returns; `echo` is what the console and the line editor do
 * with each byte the panel sends. With a shell the view is live and the panel's own writes show up
 * on screen; without one the view is the fixed `VIEW` the other tests assert against.
 */
interface Shell {
  readonly text: string
  echo(data: string): void
}

const VIEW = {
  attached: true,
  blinded: false,
  text: "$ echo hola\nhola\n$ ",
  seq: 4,
  status: "ready",
  title: "pwsh.exe (local)",
  cwd: "C:\\work",
  foregroundProcess: "pwsh.exe",
  fullScreenApp: null,
  engine: "local-pty",
}

async function load(input: {
  readonly view?: Record<string, unknown>
  readonly shell?: Shell
  readonly mode?: "line" | "raw"
  /** Answers `submit` with `submitted: false`, the way a revoked grant or a dropped RPC does. */
  readonly submitFails?: boolean
} = {}): Promise<{
  readonly plugin: { setup?: (ctx: unknown) => void; i18n?: Record<string, Record<string, string>> }
  readonly harness: Harness
}> {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const contributions: Harness["contributions"] = []
  const calls: Call[] = []
  const layoutOpens: unknown[] = []
  const cleanups: (() => void)[] = []
  const openedListeners = new Set<(event: { readonly data: { readonly sessionID: string } }) => void>()
  // The host keys the strip by tab, so one entry means the tab is in the strip already.
  let panelState: "closed" | "open" | "active" | "visible" = "closed"

  /** The view the server answers with: the live shell buffer, or the fixed one the test passed. */
  const current = (): Record<string, unknown> =>
    input.view ?? (input.shell ? { ...VIEW, text: input.shell.text } : VIEW)

  const session: Session = {
    id: "ses_1",
    directory: "C:\\work",
    location: { directory: "C:\\work" },
    server: {
      client: {
        rpc: (definition: unknown) => {
          expect((definition as { id?: string }).id).toBe("terminal-pty.panel")
          return {
            open: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "open", input: call, options })
              return current()
            },
            read: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "read", input: call, options })
              // Without a shell the read is empty, so a later tick paints nothing; with one it is the
              // buffer as it stands, which is what the panel has to show.
              return input.shell ? current() : { ...VIEW, text: "" }
            },
            write: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "write", input: call, options })
              input.shell?.echo(String(call.data ?? ""))
              return { written: true }
            },
            submit: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "submit", input: call, options })
              if (input.submitFails) return { submitted: false }
              input.shell?.echo(`${String(call.line ?? "")}\r`)
              return { submitted: true }
            },
            line: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "line", input: call, options })
              return { active: call.active === true }
            },
            resize: async (call: Record<string, unknown>, options: unknown) => {
              calls.push({ method: "resize", input: call, options })
              return { resized: true }
            },
            events: {
              on: (name: string, handler: (event: { readonly data: { readonly sessionID: string } }) => void) => {
                expect(name).toBe("opened")
                openedListeners.add(handler)
                return () => openedListeners.delete(handler)
              },
            },
          }
        },
      },
    },
  }

  const tokens = {
    command: "command",
    menuItem: "menu-item",
    panel: "panel",
    style: "style",
  }

  const host = {
    require: (name: string): object => {
      if (name === "solid-js") {
        return {
          onCleanup: (fn: () => void) => cleanups.push(fn),
          // Solid runs a new effect once, immediately, inside its owner; that is all this bundle needs.
          createEffect: (fn: () => void) => fn(),
        }
      }
      if (name === "@opencode/plugin/gui") {
        return {
          Plugin: { define: (plugin: unknown) => plugin },
          Command: tokens.command,
          MenuItem: tokens.menuItem,
          Panel: tokens.panel,
          Style: tokens.style,
        }
      }
      if (name === "effect") {
        // The bundle only builds schema values at load time; the wire is not exercised here.
        const passthrough = () => ({
          "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
        })
        return {
          Schema: {
            Struct: passthrough,
            NullOr: passthrough,
            optional: (schema: unknown) => schema,
            String: passthrough(),
            Number: passthrough(),
            Boolean: passthrough(),
          },
        }
      }
      throw new Error(`the bundle requires a module the window host does not provide: ${name}`)
    },
  }

  const document = {
    createElement: () => element(),
  }

  Object.assign(globalThis, {
    document,
    getComputedStyle: () => ({ lineHeight: "16px" }),
  })

  new Function("require", "module", "exports", await bundle.text())(host.require, module, module.exports)

  const plugin = module.exports.default as { setup?: (ctx: unknown) => void }
  plugin.setup?.({
    id: "terminal-pty",
    t: (key: string) => key,
    appearance: { font: () => "mono" },
    layout: {
      open: (...args: unknown[]) => {
        layoutOpens.push(args)
        panelState = "open"
      },
      state: () => panelState,
    },
    sessions: { current: () => session },
    servers: {
      list: () => ["sidecar"],
      get: () => ({ client: session.server.client }),
    },
    add: (token: unknown, item: unknown) => contributions.push({ token, item }),
  })

  const panel = contributions.find((entry) => entry.token === tokens.panel)?.item as    | {
        list(input: { open: readonly string[] }): unknown[]
        render(props: unknown): FakeElement
        close(input: unknown): void
      }
    | undefined

  const tab = panel?.list({ open: ["main"] })[0] as { id: string } | undefined
  const root = panel && tab ? panel.render({ tab, session, screen: {}, ...(input.mode ? { mode: input.mode } : {}) }) : undefined

  const render = (tabID: string): FakeElement => {
    if (!panel) throw new Error("the bundle contributed no panel")
    return panel.render({ tab: { id: tabID }, session, screen: {}, ...(input.mode ? { mode: input.mode } : {}) })
  }

  return {
    plugin,
    harness: {
      contributions,
      calls,
      layoutOpens,
      cleanups,
      root: () => root,
      screen: () => root?.children.find((child) => child.className === "tp-screen"),
      bar: () => root?.children.find((child) => child.className === "tp-mode"),
      keyboard: () => root?.children.find((child) => child.className.split(" ")[0] === "tp-input"),
      toggle: () =>
        root?.children
          .find((child) => child.className === "tp-mode")
          ?.children.find((child) => child.className === "tp-mode-toggle"),
      notice: () => root?.children.find((child) => child.className === "tp-notice"),
      session,
      render,
      emitOpened: (sessionID: string) => {
        for (const handler of openedListeners) handler({ data: { sessionID } })
      },
    },
  }
}

/** Waits for the panel's first tick (an `open`, then the next tick's `read`). */
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** Presses the mode button the way the window does: mousedown first, so focus never leaves the input. */
function press(node: FakeElement | undefined): void {
  if (!node) throw new Error("the mode toggle is missing")
  node.dispatch("mousedown", { preventDefault: () => undefined })
  node.dispatch("click", {})
}

/** The bytes the panel sent through RPC `write`, in order. */
function writes(harness: Harness): unknown[] {
  return harness.calls.filter((call) => call.method === "write").map((call) => call.input.data)
}

/** One child of a rendered panel by class name prefix (`tp-input` also matches `tp-input tp-blinded`). */
function child(root: FakeElement | undefined, className: string): FakeElement | undefined {
  return root?.children.find((entry) => entry.className.split(" ")[0] === className)
}

/**
 * The value of one contribution.
 *
 * A label that follows the locale is contributed as a function (`ctx.add(Command, () => ({...}))`),
 * which the host re-runs when the language changes; the panel object is contributed as a value.
 */
function contribution<T>(harness: Harness, token: string): T {
  const item = harness.contributions.find((entry) => entry.token === token)?.item
  return (typeof item === "function" ? item() : item) as T
}

describe("gui-experimental bundle", () => {
  test.skipIf(!built)("evaluates as a CommonJS Plugin.define with a window setup", async () => {
    const { plugin } = await load()

    expect(typeof plugin.setup).toBe("function")
    expect(plugin.i18n?.en?.["tab.title"]).toBe("Terminal")
    expect(plugin.i18n?.es?.["tab.title"]).toBe("Terminal")
  })

  test.skipIf(!built)("contributes the panel, the palette command and the right-panel button", async () => {
    const { harness } = await load()

    const command = contribution<{ id: string; section: string }>(harness, "command")
    expect(command.id).toBe("open")
    expect(command.section).toBe("terminal")

    const menuItem = contribution<{ menu: string; id: string; icon: string }>(harness, "menu-item")
    expect(menuItem.menu).toBe("session.panel")
    expect(menuItem.id).toBe("main")
    expect(menuItem.icon).toBe("terminal")

    const panel = contribution<{ id: string; region: string; mobile?: { cached?: boolean } }>(harness, "panel")
    expect(panel.id).toBe("main")
    expect(panel.region).toBe("side")
    expect(panel.mobile?.cached).toBe(true)
  })

  test.skipIf(!built)("lists its tab only while the strip stores it", async () => {
    const { harness } = await load()
    const panel = contribution<{ list(input: { open: readonly string[] }): { id: string }[] }>(harness, "panel")

    expect(panel.list({ open: [] })).toEqual([])
    expect(panel.list({ open: ["main"] }).map((tab) => tab.id)).toEqual(["main"])
  })

  test.skipIf(!built)("the right-panel button opens the panel for the current session", async () => {
    const { harness } = await load()
    contribution<{ run(): void }>(harness, "menu-item").run()

    expect(harness.layoutOpens).toEqual([
      ["terminal-pty:main", expect.objectContaining({ id: "ses_1" }), { tab: "select" }],
    ])
  })

  test.skipIf(!built)("opens the session's PTY once and paints its screen", async () => {
    const { harness } = await load()
    await settle()

    expect(harness.calls[0]?.method).toBe("open")
    expect(harness.calls[0]?.input).toEqual({ sessionID: "ses_1", cwd: "C:\\work" })
    // The panel paints the replayed screen, not the buffer verbatim: `renderScreenText` trims the
    // trailing space a prompt leaves behind.
    expect(harness.screen()?.textContent).toBe(renderScreenText(VIEW.text))
  })

  test.skipIf(!built)("paints the human text, never the raw buffer", async () => {
    // The line editor's own redraws: a key erased with `\b`, a line rewritten with `\r` and a colour
    // sequence around the number. Painted verbatim this reads `$ s\bssh`, which looks like the
    // terminal is not answering.
    const raw = "$ s\bssh\r\nprogress 10%\rprogress \u001b[32m99%\u001b[0m"
    const { harness } = await load({ view: { ...VIEW, text: raw } })
    await settle()

    const painted = harness.screen()?.textContent ?? ""
    expect(painted).toBe("$ ssh\nprogress 99%")
    expect(painted).not.toContain("\b")
    expect(painted).not.toContain("\u001b")
  })

  test.skipIf(!built)("never leaves a backspace in the visible text", async () => {
    // The literal the human reported. VT makes `\b` a cursor move, not a delete, so the character it
    // steps over survives; what matters is that no control byte reaches the DOM.
    const { harness } = await load({ view: { ...VIEW, text: "s\bsssh" } })
    await settle()

    const painted = harness.screen()?.textContent ?? ""
    expect(painted).toBe("sssh")
    expect(painted).not.toContain("\b")
  })

  test.skipIf(!built)("polls with the sequence it already holds, so the text is not resent", async () => {
    const { harness } = await load()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const read = harness.calls.find((call) => call.method === "read")
    expect(read?.input).toEqual({ sessionID: "ses_1", lines: 400, sinceSeq: 4 })
  })

  test.skipIf(!built)("lays the line input under a flexible screen, with the mode bar", async () => {
    const { harness } = await load()

    const styles = contribution<string>(harness, "style")
    // The textarea is a visible line now, not the invisible overlay that covered the screen.
    expect(styles).not.toContain("opacity:0")
    expect(styles).toMatch(/\.tp-input\{[^}]*height:2em/)
    expect(styles).toMatch(/\.tp-screen\{[^}]*overflow:auto/)
    expect(styles).toContain(".tp-mode")
    expect(styles).toContain(".tp-notice")

    expect(harness.root()?.children.map((child) => child.className)).toEqual([
      "tp-screen",
      "tp-mode",
      "tp-input",
      "tp-notice",
    ])
    expect(harness.bar()?.children[0]?.textContent).toBe("Line")
    // Nothing failed yet, so the notice is there but not shown.
    expect(harness.notice()?.style.display).toBe("none")
  })

  /**
   * Line mode (FR-001, FR-003, FR-004; SC-001, SC-002).
   *
   * Typing in the panel is local: the textarea owns the text and the PTY hears nothing. The old
   * behaviour sent every key and the shell echoed it, so `abc` came back as `a`, `aa`, `aaC`.
   */
  test.skipIf(!built)("keeps typing local and never writes to the PTY", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    const prevented: string[] = []

    for (const key of ["a", "b", "c"]) {
      keyboard?.dispatch("keydown", { key, preventDefault: () => prevented.push(key) })
    }
    // What the browser does with the keys the panel left alone.
    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("input", {})
    await settle()

    // No `preventDefault`: the textarea handled the keys, caret included.
    expect(prevented).toEqual([])
    expect(keyboard?.value).toBe("abc")
    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
    // The screen shows only the PTY's history; the local line is not painted a second time there.
    expect(harness.screen()?.textContent).toBe(renderScreenText(VIEW.text))
  })

  test.skipIf(!built)("lets Backspace edit the line without reaching the PTY", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    const prevented: string[] = []

    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("keydown", { key: "Backspace", preventDefault: () => prevented.push("Backspace") })
    if (keyboard) keyboard.value = "ab"
    keyboard?.dispatch("input", {})
    await settle()

    expect(prevented).toEqual([])
    expect(keyboard?.value).toBe("ab")
    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
  })

  test.skipIf(!built)("submits the line once on Enter and clears the input", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    const prevented: string[] = []

    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => prevented.push("Enter") })
    await settle()

    expect(prevented).toEqual(["Enter"])
    const submits = harness.calls.filter((call) => call.method === "submit")
    expect(submits).toHaveLength(1)
    expect(submits[0]?.input).toEqual({ sessionID: "ses_1", line: "abc" })
    // A submitted line is not a stream of keystrokes: nothing else goes out.
    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
    expect(keyboard?.value).toBe("")
  })

  test.skipIf(!built)("drops the local line on Escape and Ctrl+C without writing", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()

    for (const event of [{ key: "Escape" }, { key: "c", ctrlKey: true }]) {
      if (keyboard) keyboard.value = "ssh root@"
      keyboard?.dispatch("keydown", { ...event, preventDefault: () => undefined })
      expect(keyboard?.value).toBe("")
    }
    await settle()

    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
    expect(harness.calls.filter((call) => call.method === "submit")).toEqual([])
  })

  /**
   * T019 (FR-006, SC-004): the line the person is composing is announced to the server.
   *
   * Line mode keeps the text in the window, so without `line` the server learns about the line only
   * at Enter — and an approved AI write could land on top of the command being typed. The first
   * keystroke opens it once, after a short settle, so a burst of typing is one call and not one per
   * key.
   */
  test.skipIf(!built)("announces the open line once, after the typing settles", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "a"
    keyboard?.dispatch("input", {})
    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("input", {})
    await settle(220)

    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input)).toEqual([
      { sessionID: "ses_1", active: true },
    ])

    // More typing in the same line: the server already knows it is open.
    if (keyboard) keyboard.value = "abcd"
    keyboard?.dispatch("input", {})
    await settle(220)

    expect(harness.calls.filter((call) => call.method === "line")).toHaveLength(1)
    // Announcing is not typing: nothing reached the PTY.
    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
  })

  test.skipIf(!built)("closes the announced line on submit, after the line goes out", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("input", {})
    await settle(220)
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle(220)

    // The line is written before the queue is released: `submit` first, then `line false`.
    expect(harness.calls.map((call) => call.method).filter((method) => method === "submit" || method === "line")).toEqual([
      "line",
      "submit",
      "line",
    ])
    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([
      true,
      false,
    ])
  })

  test.skipIf(!built)("closes the line when the input is emptied or loses focus", async () => {
    const emptied = await load()
    await settle()
    const first = emptied.harness.keyboard()

    if (first) first.value = "ssh"
    first?.dispatch("input", {})
    await settle(220)
    if (first) first.value = ""
    first?.dispatch("input", {})
    await settle()

    expect(emptied.harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([
      true,
      false,
    ])

    const blurred = await load()
    await settle()
    const second = blurred.harness.keyboard()

    if (second) second.value = "ssh"
    second?.dispatch("input", {})
    await settle(220)
    second?.dispatch("blur", {})
    await settle()

    expect(blurred.harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([
      true,
      false,
    ])
    // The text is dropped from the server's view of the line, never written to the PTY.
    expect(blurred.harness.calls.filter((call) => call.method === "write")).toEqual([])
  })

  /**
   * T020 (FR-014): a failed `submit` must not take the line with it.
   *
   * Enter used to clear the input before the RPC resolved, so a revoked grant or a dropped
   * connection erased the only copy of what the person wrote.
   */
  test.skipIf(!built)("keeps the line and says so when the submit fails", async () => {
    const { harness } = await load({ submitFails: true })
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "ssh root@172.16.1.21"
    keyboard?.dispatch("input", {})
    await settle(220)
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle(220)

    expect(keyboard?.value).toBe("ssh root@172.16.1.21")
    expect(harness.notice()?.style.display).toBe("block")
    expect(harness.notice()?.textContent).toBe("submit.failed")
    expect(keyboard?.attributes.get("aria-invalid")).toBe("true")
    // The line is still open on the server, so the person can press Enter again.
    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([true])
  })

  test.skipIf(!built)("a second Enter while the first submit is in flight sends it once", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle()

    expect(harness.calls.filter((call) => call.method === "submit")).toHaveLength(1)
  })

  test.skipIf(!built)("shows a submitted line once, only from the shell's echo", async () => {
    const shell = fakeShell("")
    const { harness } = await load({ shell })
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "abc"
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle(250)

    const painted = harness.screen()?.textContent ?? ""
    expect(painted.match(/abc/g)).toHaveLength(1)
    expect(keyboard?.value).toBe("")
  })


  test.skipIf(!built)("sends a keystroke to the same session's PTY in raw mode", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()

    const keyboard = harness.keyboard()
    const prevented: string[] = []
    keyboard?.dispatch("keydown", {
      key: "a",
      preventDefault: () => prevented.push("a"),
    })
    keyboard?.dispatch("keydown", { key: "Enter", preventDefault: () => prevented.push("Enter") })
    keyboard?.dispatch("keydown", { key: "c", ctrlKey: true, preventDefault: () => prevented.push("c") })

    await settle()

    const writes = harness.calls.filter((call) => call.method === "write")
    expect(writes.map((call) => call.input)).toEqual([
      { sessionID: "ses_1", data: "a" },
      { sessionID: "ses_1", data: "\r" },
      { sessionID: "ses_1", data: "\u0003" },
    ])
    expect(prevented).toEqual(["a", "Enter", "c"])
  })

  test.skipIf(!built)("leaves an unhandled key to the application", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()

    let prevented = 0
    harness.keyboard()?.dispatch("keydown", {
      key: "k",
      metaKey: true,
      preventDefault: () => (prevented += 1),
    })
    await settle()

    expect(prevented).toBe(0)
    expect(harness.calls.filter((call) => call.method === "write")).toEqual([])
  })

  test.skipIf(!built)("pastes a clipboard as carriage-return lines in raw mode", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()

    harness.keyboard()?.dispatch("paste", {
      clipboardData: { getData: () => "uno\ndos\r\ntres" },
      preventDefault: () => undefined,
    })
    await settle()

    const write = harness.calls.find((call) => call.method === "write")
    expect(write?.input).toEqual({ sessionID: "ses_1", data: "uno\rdos\rtres" })
  })

  /**
   * Paste (FR-018).
   *
   * The window turns a paste into a `paste` event, the panel sends the clipboard once and the shell
   * echoes it. What broke: the `Ctrl+V` keystroke was forwarded as `^V` as well, and PSReadLine's
   * own `Ctrl+v` is its `Paste` function, which reads the clipboard on the server and inserts the
   * same text a second time. The line then read `ssh root@172.16.1.21ssh root@172.16.1.21` — two
   * copies, from two channels, none of them the assistant.
   */
  const pastes = (
    harness: Harness,
    clipboard: string,
    options: { readonly shortcut?: "ctrl+v" | "ctrl+shift+v" | "shift+insert" | "none" } = {},
  ) => {
    const keyboard = harness.keyboard()
    const prevented = () => undefined
    if (options.shortcut === "ctrl+v")
      keyboard?.dispatch("keydown", { key: "v", ctrlKey: true, preventDefault: prevented })
    if (options.shortcut === "ctrl+shift+v")
      keyboard?.dispatch("keydown", { key: "V", ctrlKey: true, shiftKey: true, preventDefault: prevented })
    if (options.shortcut === "shift+insert")
      keyboard?.dispatch("keydown", { key: "Insert", shiftKey: true, preventDefault: prevented })
    keyboard?.dispatch("paste", {
      clipboardData: { getData: () => clipboard },
      preventDefault: prevented,
    })
  }

  /**
   * A shell that echoes what it receives and redraws the line the way PSReadLine does: back to
   * column 0 with `\r`, erase the row with `CSI K`, then the prompt and the line again. `\r` submits
   * a line, as the panel's own newline conversion intends.
   */
  const fakeShell = (clipboard: string): Shell => {
    const PROMPT = "PS C:\\work> "
    let raw = PROMPT
    let line = ""
    return {
      get text() {
        return raw
      },
      echo(data) {
        // `^V` is PSReadLine's `Paste`: it inserts the clipboard of the machine the shell runs on.
        if (data === "\u0016") {
          line += clipboard
        } else {
          for (const character of data) {
            if (character === "\r") {
              // The accepted line is what stays on screen, then a fresh prompt.
              raw += `\r\n${PROMPT}`
              line = ""
            } else {
              // The console echoes each printable byte as it arrives.
              raw += character
              line += character
            }
          }
        }
        raw += `\r\u001b[K${PROMPT}${line}`
      },
    }
  }

  test.skipIf(!built)("pastes a line once, from one channel only", async () => {
    const clipboard = "ssh root@172.16.1.21"
    const shell = fakeShell(clipboard)
    const { harness } = await load({ shell, mode: "raw" })
    await settle()

    pastes(harness, clipboard, { shortcut: "ctrl+v" })
    await settle(200)

    expect(harness.screen()?.textContent).toBe(`PS C:\\work> ${clipboard}`)
    // The keystroke stayed with the window; only the clipboard itself reached the PTY, once.
    expect(harness.calls.filter((call) => call.method === "write").map((call) => call.input.data)).toEqual([
      clipboard,
    ])
  })

  test.skipIf(!built)("pastes a block once per line", async () => {
    const clipboard = "uno\ndos\r\ntres"
    const shell = fakeShell(clipboard)
    const { harness } = await load({ shell, mode: "raw" })
    await settle()

    pastes(harness, clipboard, { shortcut: "ctrl+shift+v" })
    await settle(200)

    const painted = harness.screen()?.textContent ?? ""
    expect(painted).toBe("PS C:\\work> uno\nPS C:\\work> dos\nPS C:\\work> tres")
    for (const line of ["uno", "dos", "tres"]) expect(painted.split(line)).toHaveLength(2)
  })

  test.skipIf(!built)("Shift+Insert pastes once and keeps the keyboard's Insert key", async () => {
    const clipboard = "ssh root@172.16.1.21"
    const shell = fakeShell(clipboard)
    const { harness } = await load({ shell, mode: "raw" })
    await settle()

    pastes(harness, clipboard, { shortcut: "shift+insert" })
    await settle()
    // A plain Insert is still the terminal's own key.
    harness.keyboard()?.dispatch("keydown", { key: "Insert", preventDefault: () => undefined })
    await settle()

    const writes = harness.calls.filter((call) => call.method === "write").map((call) => call.input.data)
    expect(writes).toEqual([clipboard, "\u001b[2~"])
  })

  test.skipIf(!built)("a repaint after the echo does not repeat the line", async () => {
    // What the buffer holds after a paste: the console's echo, then PSReadLine redrawing the same
    // line — `\r` back to column 0, `CSI K` to erase the row, and a `\b` over the last character it
    // is about to rewrite.
    const line = "PS C:\\work> ssh root@172.16.1.21"
    const raw = `${line}\r\u001b[K${line}\b1`
    const { harness } = await load({ view: { ...VIEW, text: raw } })
    await settle()

    const painted = harness.screen()?.textContent ?? ""
    expect(painted).toBe(line)
    expect(painted.match(/ssh root@172\.16\.1\.21/g)).toHaveLength(1)

    // The server renders the tail and the panel replays it again; replaying rendered text is a
    // no-op, which is why the second pass cannot duplicate what the first one collapsed.
    const { harness: rendered } = await load({ view: { ...VIEW, text: renderScreenText(raw) } })
    await settle()
    expect(rendered.screen()?.textContent).toBe(line)
  })

  test.skipIf(!built)("says so instead of rendering a full-screen program", async () => {
    const { harness } = await load({ view: { ...VIEW, fullScreenApp: "vim", text: "" } })
    await settle()

    expect(harness.screen()?.textContent).toBe("fullscreen")
  })

  /**
   * T008/T010 (FR-008, FR-012): the Line/Raw switch.
   *
   * The panel starts in line mode and the bar names it. The button names the mode it switches to;
   * pressing it must not take the keyboard away from the input it just put back.
   */
  test.skipIf(!built)("the mode switch flips line and raw and keeps the keyboard in the input", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    const toggle = harness.toggle()
    const focused = keyboard?.focusCalls ?? 0

    expect(toggle?.textContent).toBe("Raw")
    expect(toggle?.attributes.get("aria-pressed")).toBe("false")

    press(toggle)

    expect(harness.root()?.className).toContain("tp-raw")
    expect(harness.bar()?.children[0]?.textContent).toBe("Raw")
    expect(toggle?.textContent).toBe("Line")
    expect(toggle?.attributes.get("aria-pressed")).toBe("true")
    // The button sent the keyboard back: the person keeps typing where they were typing.
    expect(keyboard?.focusCalls ?? 0).toBeGreaterThan(focused)

    const prevented: string[] = []
    keyboard?.dispatch("keydown", { key: "a", preventDefault: () => prevented.push("a") })
    await settle()
    expect(prevented).toEqual(["a"])
    expect(writes(harness)).toEqual(["a"])

    press(toggle)
    expect(harness.root()?.className).not.toContain("tp-raw")
    expect(harness.bar()?.children[0]?.textContent).toBe("Line")
    expect(toggle?.textContent).toBe("Raw")
    expect(toggle?.attributes.get("aria-pressed")).toBe("false")
  })

  test.skipIf(!built)("raw sends each key once, arrows included, and keeps the input empty", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()
    const keyboard = harness.keyboard()
    const prevented: string[] = []

    for (const key of ["a", "b", "ArrowUp"]) {
      keyboard?.dispatch("keydown", { key, preventDefault: () => prevented.push(key) })
    }
    // Whatever the textarea might hold; raw must not keep it.
    if (keyboard) keyboard.value = "a"
    keyboard?.dispatch("input", {})
    await settle()

    expect(prevented).toEqual(["a", "b", "ArrowUp"])
    expect(writes(harness)).toEqual(["a", "b", "\u001b[A"])
    expect(keyboard?.value).toBe("")
  })

  test.skipIf(!built)("raw pastes the clipboard once, into the PTY and not the input", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()
    const keyboard = harness.keyboard()

    keyboard?.dispatch("keydown", { key: "v", ctrlKey: true, preventDefault: () => undefined })
    keyboard?.dispatch("paste", {
      clipboardData: { getData: () => "ssh root@172.16.1.21" },
      preventDefault: () => undefined,
    })
    await settle()

    // One channel: the `paste` event. The shortcut itself is the window's, not the PTY's.
    expect(writes(harness)).toEqual(["ssh root@172.16.1.21"])
    expect(keyboard?.value).toBe("")
  })

  test.skipIf(!built)("line pastes into the local input and never into the PTY", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    let prevented = 0

    keyboard?.dispatch("paste", {
      clipboardData: { getData: () => "ssh root@172.16.1.21" },
      preventDefault: () => (prevented += 1),
    })
    // The textarea's own insertion, which the panel deliberately did not prevent.
    if (keyboard) keyboard.value = "ssh root@172.16.1.21"
    keyboard?.dispatch("input", {})
    await settle()

    expect(prevented).toBe(0)
    expect(keyboard?.value).toBe("ssh root@172.16.1.21")
    expect(writes(harness)).toEqual([])
  })

  test.skipIf(!built)("returning to line clears the input and closes the announced line", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()
    const toggle = harness.toggle()

    if (keyboard) keyboard.value = "ssh root@172.16.1.21"
    keyboard?.dispatch("input", {})
    await settle(220)
    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([true])

    press(toggle)
    press(toggle)
    await settle(50)

    expect(keyboard?.value).toBe("")
    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([
      true,
      false,
    ])
    // Back in line, typing is local again.
    keyboard?.dispatch("keydown", { key: "a", preventDefault: () => undefined })
    await settle()
    expect(writes(harness)).toEqual([])
  })

  /**
   * T011/T013 (FR-009, SC-006): the credential prompt masks the local line.
   *
   * The screen still shows the prompt — the person has to read it — but the line holding the
   * password paints discs. When the detector lets go, the mask goes with it.
   */
  test.skipIf(!built)("masks the line while the PTY is at a credential prompt", async () => {
    const view: Record<string, unknown> = { ...VIEW, blinded: true }
    const { harness } = await load({ view })
    await settle()
    const keyboard = harness.keyboard()

    expect(keyboard?.style["-webkit-text-security"]).toBe("disc")
    expect(keyboard?.className).toContain("tp-blinded")

    view.blinded = false
    await settle(250)

    expect(keyboard?.style["-webkit-text-security"]).toBe("")
    expect(keyboard?.className).not.toContain("tp-blinded")
  })

  test.skipIf(!built)("raw does not mask the input, which never holds the credential", async () => {
    const { harness } = await load({ mode: "raw", view: { ...VIEW, blinded: true } })
    await settle()

    expect(harness.keyboard()?.style["-webkit-text-security"] ?? "").toBe("")
    expect(harness.keyboard()?.className).not.toContain("tp-blinded")
  })

  /**
   * T012/T013 (FR-015, SC-004): one mounted panel writes.
   *
   * Two windows can show the same tab. Both would otherwise forward the same keystroke, so focus
   * decides the writer and blur hands the pen on; the server's line lock remains the last defence.
   */
  test.skipIf(!built)("two mounted panels: only the focused one writes, and focus moves the pen", async () => {
    const { harness } = await load({ mode: "raw" })
    await settle()
    const first = harness.keyboard()
    const second = child(harness.render("second"), "tp-input")
    expect(second).toBeDefined()

    first?.dispatch("focus", {})
    first?.dispatch("keydown", { key: "a", preventDefault: () => undefined })
    second?.dispatch("keydown", { key: "b", preventDefault: () => undefined })
    await settle()

    // The duplicate view saw the key and ignored it.
    expect(writes(harness)).toEqual(["a"])

    first?.dispatch("blur", {})
    second?.dispatch("focus", {})
    first?.dispatch("keydown", { key: "c", preventDefault: () => undefined })
    second?.dispatch("keydown", { key: "d", preventDefault: () => undefined })
    await settle()

    expect(writes(harness)).toEqual(["a", "d"])
  })

  test.skipIf(!built)("a duplicate line panel cannot submit the other one's line", async () => {
    const { harness } = await load()
    await settle()
    const first = harness.keyboard()
    const second = child(harness.render("second"), "tp-input")

    first?.dispatch("focus", {})
    if (second) second.value = "rm -rf /"
    second?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle()

    expect(harness.calls.filter((call) => call.method === "submit")).toEqual([])
    // The focused panel still submits its own line.
    if (first) first.value = "echo hola"
    first?.dispatch("keydown", { key: "Enter", preventDefault: () => undefined })
    await settle()

    const submits = harness.calls.filter((call) => call.method === "submit")
    expect(submits.map((call) => call.input.line)).toEqual(["echo hola"])
  })

  /**
   * Auto-open (FR-007): the server says `opened` when the human grants `full`, and the window on that
   * session opens the terminal tab. The host keys the strip by tab, so a repeated event must not ask
   * for a second tab (FR-008).
   */
  test.skipIf(!built)("opens the terminal when the server announces a full grant", async () => {
    const { harness } = await load()

    harness.emitOpened("ses_1")

    expect(harness.layoutOpens).toEqual([
      ["terminal-pty:main", expect.objectContaining({ id: "ses_1" }), { tab: "select" }],
    ])
  })

  test.skipIf(!built)("a second announcement does not open a second tab", async () => {
    const { harness } = await load()

    harness.emitOpened("ses_1")
    harness.emitOpened("ses_1")

    expect(harness.layoutOpens).toHaveLength(1)
  })

  test.skipIf(!built)("ignores an announcement for another session", async () => {
    const { harness } = await load()

    harness.emitOpened("ses_2")

    expect(harness.layoutOpens).toEqual([])
  })

  test.skipIf(!built)("stops polling and listening once its tab closes", async () => {
    const { harness } = await load()
    await settle()

    const panel = contribution<{ close(input: unknown): void }>(harness, "panel")
    const before = harness.calls.length
    panel.close({ tab: { id: "main" }, session: { id: "ses_1" }, screen: {} })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(harness.calls.length).toBe(before)
    expect(harness.keyboard()?.listeners.get("keydown")?.length ?? 0).toBe(0)
  })

  test.skipIf(!built)("closing the tab closes the line it had open", async () => {
    const { harness } = await load()
    await settle()
    const keyboard = harness.keyboard()

    if (keyboard) keyboard.value = "ssh"
    keyboard?.dispatch("input", {})
    await settle(220)

    contribution<{ close(input: unknown): void }>(harness, "panel").close({
      tab: { id: "main" },
      session: { id: "ses_1" },
      screen: {},
    })
    await settle()

    // A line nobody can submit any more must not hold the assistant's queue.
    expect(harness.calls.filter((call) => call.method === "line").map((call) => call.input.active)).toEqual([
      true,
      false,
    ])
  })
})
