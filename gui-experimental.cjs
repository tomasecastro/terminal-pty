var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/gui/index.ts
var exports_gui = {};
__export(exports_gui, {
  default: () => gui_default
});
module.exports = __toCommonJS(exports_gui);
var import_solid_js = require("solid-js");
var import_gui = require("@opencode/plugin/gui");

// lib/gui/auto-open.ts
function autoOpenHandler(deps) {
  return (event) => {
    const session = deps.current();
    if (!session)
      return;
    if (session.id !== event.data.sessionID)
      return;
    if (deps.state(session) !== "closed")
      return;
    deps.open(session);
  };
}

// lib/gui/protocol.ts
var import_effect = require("effect");
var PanelView = import_effect.Schema.Struct({
  attached: import_effect.Schema.Boolean,
  blinded: import_effect.Schema.Boolean,
  text: import_effect.Schema.String,
  seq: import_effect.Schema.Number,
  status: import_effect.Schema.String,
  title: import_effect.Schema.String,
  cwd: import_effect.Schema.NullOr(import_effect.Schema.String),
  foregroundProcess: import_effect.Schema.NullOr(import_effect.Schema.String),
  fullScreenApp: import_effect.Schema.NullOr(import_effect.Schema.String),
  engine: import_effect.Schema.String,
  reason: import_effect.Schema.optional(import_effect.Schema.String)
});
var PanelRpc = {
  id: "terminal-pty.panel",
  methods: {
    open: {
      input: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String, cwd: import_effect.Schema.optional(import_effect.Schema.String) }),
      output: PanelView
    },
    read: {
      input: import_effect.Schema.Struct({
        sessionID: import_effect.Schema.String,
        lines: import_effect.Schema.optional(import_effect.Schema.Number),
        sinceSeq: import_effect.Schema.optional(import_effect.Schema.Number)
      }),
      output: PanelView
    },
    write: {
      input: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String, data: import_effect.Schema.String }),
      output: import_effect.Schema.Struct({ written: import_effect.Schema.Boolean })
    },
    submit: {
      input: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String, line: import_effect.Schema.String }),
      output: import_effect.Schema.Struct({ submitted: import_effect.Schema.Boolean })
    },
    line: {
      input: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String, active: import_effect.Schema.Boolean }),
      output: import_effect.Schema.Struct({ active: import_effect.Schema.Boolean })
    },
    resize: {
      input: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String, cols: import_effect.Schema.Number, rows: import_effect.Schema.Number }),
      output: import_effect.Schema.Struct({ resized: import_effect.Schema.Boolean })
    }
  },
  events: {
    opened: { schema: import_effect.Schema.Struct({ sessionID: import_effect.Schema.String }) }
  }
};

// lib/screen.ts
var TAB_STOP = 8;
function renderScreenText(raw, options = {}) {
  const rows = [""];
  let row = 0;
  let column = 0;
  let index = 0;
  const rowAt = (target) => {
    while (rows.length <= target)
      rows.push("");
    return rows[target] ?? "";
  };
  const write = (character) => {
    const current = rowAt(row);
    const padding = current.length < column ? " ".repeat(column - current.length) : "";
    const line = padding.length > 0 ? current + padding : current;
    rows[row] = line.slice(0, column) + character + line.slice(column + character.length);
    column += character.length;
  };
  const eraseInLine = (mode) => {
    const current = rowAt(row);
    if (mode === 1)
      rows[row] = " ".repeat(Math.min(column, current.length)) + current.slice(column);
    else if (mode === 2)
      rows[row] = "";
    else
      rows[row] = current.slice(0, column);
  };
  while (index < raw.length) {
    const character = raw[index] ?? "";
    if (character === "\x1B") {
      const escape = readEscape(raw, index);
      index += escape.length;
      if (escape.kind !== "csi")
        continue;
      switch (escape.command) {
        case "A":
          row = Math.max(0, row - escape.amount);
          break;
        case "B":
          row += escape.amount;
          break;
        case "C":
          column += escape.amount;
          break;
        case "D":
          column = Math.max(0, column - escape.amount);
          break;
        case "G":
          column = Math.max(0, escape.amount - 1);
          break;
        case "K":
          eraseInLine(escape.amount);
          break;
        case "J":
          if (escape.amount === 2 || escape.amount === 3) {
            rows.length = 0;
            rows.push("");
            row = 0;
            column = 0;
          }
          break;
        default:
          break;
      }
      continue;
    }
    index += 1;
    if (character === `
`) {
      row += 1;
      column = 0;
      rowAt(row);
      continue;
    }
    if (character === "\r") {
      column = 0;
      continue;
    }
    if (character === "\b") {
      column = Math.max(0, column - 1);
      continue;
    }
    if (character === "\t") {
      column += TAB_STOP - column % TAB_STOP;
      continue;
    }
    if (character < " " || character === "")
      continue;
    write(character);
  }
  const visible = rows.map((line) => line.trimEnd());
  while (visible.length > 0 && visible[visible.length - 1] === "")
    visible.pop();
  const limit = options.lines ?? 400;
  return visible.slice(Math.max(0, visible.length - limit)).join(`
`);
}
function readEscape(text, start) {
  const next = text[start + 1] ?? "";
  if (next === "[") {
    let cursor = start + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 64 && code <= 126)
        break;
      cursor += 1;
    }
    if (cursor >= text.length)
      return { kind: "other", length: text.length - start };
    const body = text.slice(start + 2, cursor);
    const command = text[cursor] ?? "";
    if (!/^[0-9;]*$/.test(body))
      return { kind: "other", length: cursor - start + 1 };
    const first = body.split(";")[0] ?? "";
    const amount = first.length === 0 ? 0 : Number.parseInt(first, 10);
    return {
      kind: "csi",
      length: cursor - start + 1,
      amount: Number.isFinite(amount) ? amount : 0,
      command
    };
  }
  if (next === "]") {
    const bel = text.indexOf("\x07", start + 2);
    const st = text.indexOf("\x1B\\", start + 2);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1)
      return { kind: "other", length: text.length - start };
    return { kind: "other", length: (end === bel ? end + 1 : end + 2) - start };
  }
  return { kind: "other", length: next === "" ? 1 : 2 };
}

// lib/terminal-keys.ts
var NAMED = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "",
  Escape: "\x1B",
  Delete: "\x1B[3~",
  Insert: "\x1B[2~",
  Home: "\x1B[H",
  End: "\x1B[F",
  PageUp: "\x1B[5~",
  PageDown: "\x1B[6~",
  ArrowUp: "\x1B[A",
  ArrowDown: "\x1B[B",
  ArrowRight: "\x1B[C",
  ArrowLeft: "\x1B[D"
};
function keysToBytes(stroke) {
  const { key } = stroke;
  if (key.length === 0)
    return null;
  if (stroke.metaKey)
    return null;
  const altGraph = stroke.ctrlKey === true && stroke.altKey === true;
  if (key === "Tab" && stroke.shiftKey === true)
    return "\x1B[Z";
  const named = NAMED[key];
  if (named !== undefined) {
    if (stroke.ctrlKey === true && !altGraph)
      return controlNamed(key, named);
    return stroke.altKey === true ? `\x1B${named}` : named;
  }
  if (key.length !== 1)
    return null;
  if (altGraph)
    return key;
  if (stroke.ctrlKey === true) {
    const control = controlByte(key);
    if (control !== null)
      return stroke.altKey === true ? `\x1B${control}` : control;
    return null;
  }
  if (stroke.altKey === true)
    return `\x1B${key}`;
  return key;
}
function controlByte(key) {
  const upper = key.toUpperCase();
  if (upper.length === 1 && upper >= "A" && upper <= "Z") {
    return String.fromCharCode(upper.charCodeAt(0) - 64);
  }
  if (key === "[")
    return "\x1B";
  if (key === "\\")
    return "\x1C";
  if (key === "]")
    return "\x1D";
  if (key === "^")
    return "\x1E";
  if (key === "_")
    return "\x1F";
  if (key === " " || key === "@")
    return "\x00";
  return null;
}
function controlNamed(key, plain) {
  const final = plain.startsWith("\x1B[") ? plain.slice(2) : "";
  if (key === "Backspace")
    return "\b";
  if (final.length === 1)
    return `\x1B[1;5${final}`;
  if (final.endsWith("~"))
    return `\x1B[${final.slice(0, -1)};5~`;
  return plain;
}

// src/gui/index.ts
var TAB = "main";
var POLL_MS = 120;
var LINES = 400;
var LINE_NOTICE_MS = 150;
var LINE_HEIGHT = 16;
var setup = (host) => {
  const ctx = host;
  const key = `${ctx.id}:${TAB}`;
  const openPanel = () => {
    const session = ctx.sessions.current();
    if (session)
      ctx.layout.open(key, session, { tab: "select" });
  };
  const opened = autoOpenHandler({
    current: () => ctx.sessions.current() ?? undefined,
    state: (session) => ctx.layout.state(key, session),
    open: (session) => ctx.layout.open(key, session, { tab: "select" })
  });
  const subscribed = new Map;
  import_solid_js.createEffect(() => {
    const wanted = new Map;
    for (const id of ctx.servers.list()) {
      const client = ctx.servers.get(id)?.client;
      if (typeof client?.rpc !== "function")
        continue;
      const panel = client.rpc(PanelRpc);
      if (!panel.events)
        continue;
      wanted.set(id, panel);
    }
    for (const [id, entry] of subscribed) {
      if (wanted.get(id) === entry.client) {
        wanted.delete(id);
        continue;
      }
      entry.stop();
      subscribed.delete(id);
    }
    for (const [id, panel] of wanted) {
      const events = panel.events;
      if (!events)
        continue;
      subscribed.set(id, { client: panel, stop: events.on("opened", (event) => opened(event)) });
    }
  });
  import_solid_js.onCleanup(() => {
    for (const entry of subscribed.values())
      entry.stop();
    subscribed.clear();
  });
  ctx.add(import_gui.Command, () => ({
    id: "open",
    title: ctx.t("command.open"),
    description: ctx.t("command.open.description"),
    group: ctx.t("command.group"),
    section: "terminal",
    run: openPanel
  }));
  ctx.add(import_gui.MenuItem, () => ({
    menu: "session.panel",
    id: TAB,
    title: ctx.t("tab.title"),
    icon: "terminal",
    order: 40,
    run: openPanel
  }));
  const tab = {
    id: TAB,
    get title() {
      return ctx.t("tab.title");
    },
    closable: "hover"
  };
  ctx.add(import_gui.Style, [
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
    "border-top:1px solid rgba(224,108,117,.5)}"
  ].join(""));
  const views = new Map;
  import_solid_js.onCleanup(() => {
    for (const view of [...views.values()])
      view.dispose();
    views.clear();
  });
  ctx.add(import_gui.Panel, {
    id: TAB,
    region: "side",
    width: 460,
    mobile: {
      get title() {
        return ctx.t("tab.title");
      },
      order: 40,
      kind: "menu",
      icon: "terminal",
      cached: true
    },
    list: (input) => input.open.includes(TAB) ? [tab] : [],
    render: (props) => {
      views.get(props.tab.id)?.dispose();
      const view = createTerminalView(ctx, props);
      views.set(props.tab.id, view);
      return view.element;
    },
    focus: (input) => {
      if (!input.restored)
        views.get(input.tab.id)?.focus();
    },
    enter: (input) => views.get(input.tab.id)?.focus(),
    close: (input) => {
      views.get(input.tab.id)?.dispose();
      views.delete(input.tab.id);
    }
  });
};
var focusedViews = new Set;
var writer = null;
function claimWriter(token) {
  focusedViews.clear();
  focusedViews.add(token);
  writer = token;
}
function releaseWriter(token) {
  focusedViews.delete(token);
}
function mayWrite(token) {
  if (focusedViews.size > 0)
    return focusedViews.has(token);
  return writer === null || writer === token;
}
function createTerminalView(ctx, props) {
  const token = {};
  const element = document.createElement("div");
  element.className = "tp-root";
  element.tabIndex = -1;
  const screen = document.createElement("pre");
  screen.className = "tp-screen";
  screen.setAttribute("role", "log");
  screen.setAttribute("aria-live", "polite");
  screen.style.fontFamily = ctx.appearance.font("mono");
  let mode = props.mode === "raw" ? "raw" : "line";
  if (mode === "raw")
    element.className = "tp-root tp-raw";
  const bar = document.createElement("div");
  bar.className = "tp-mode";
  const modeLabel = document.createElement("span");
  modeLabel.className = "tp-mode-label";
  modeLabel.textContent = mode === "line" ? "Line" : "Raw";
  const toggle = document.createElement("button");
  toggle.className = "tp-mode-toggle";
  toggle.textContent = mode === "line" ? "Raw" : "Line";
  toggle.setAttribute("aria-label", ctx.t(mode === "line" ? "mode.switch.raw" : "mode.switch.line"));
  toggle.setAttribute("aria-pressed", mode === "raw" ? "true" : "false");
  bar.append(modeLabel, toggle);
  const keyboard = document.createElement("textarea");
  keyboard.className = "tp-input";
  keyboard.setAttribute("aria-label", ctx.t("input.label"));
  keyboard.spellcheck = false;
  keyboard.autocapitalize = "off";
  keyboard.autocomplete = "off";
  keyboard.rows = 1;
  const notice = document.createElement("div");
  notice.className = "tp-notice";
  notice.setAttribute("role", "alert");
  notice.style.display = "none";
  element.append(screen, bar, keyboard, notice);
  let shownSession = null;
  let shownSeq = -1;
  let text = "";
  let size = "";
  let disposed = false;
  let timer;
  let resizeTimer;
  let queue = Promise.resolve();
  let lineOpen = false;
  let linePeer = null;
  let lineTimer;
  let submitting = false;
  let blinded = false;
  const setStyle = (name, value) => {
    const style = keyboard.style;
    if (typeof style.setProperty === "function")
      style.setProperty(name, value);
    keyboard.style[name] = value;
  };
  const applyBlinding = (value) => {
    if (value === blinded)
      return;
    blinded = value;
    if (value) {
      keyboard.className = "tp-input tp-blinded";
      setStyle("-webkit-text-security", "disc");
    } else {
      keyboard.className = "tp-input";
      setStyle("-webkit-text-security", "");
    }
  };
  const connection = (session) => {
    const client = session.server.client;
    if (typeof client?.rpc !== "function")
      return null;
    const directory = session.location?.directory;
    return { rpc: client.rpc(PanelRpc), options: directory ? { location: { directory } } : undefined };
  };
  const write = (data) => {
    if (data.length === 0)
      return;
    if (!mayWrite(token))
      return;
    const session = props.session;
    const link = connection(session);
    if (!link)
      return;
    queue = queue.then(() => link.rpc.write({ sessionID: session.id, data }, link.options)).catch(() => {
      return;
    });
  };
  const notifyLine = (peer, active) => {
    queue = queue.then(() => peer.link.rpc.line({ sessionID: peer.sessionID, active }, peer.link.options)).catch(() => {
      return;
    });
  };
  const openLine = (peer) => {
    if (lineOpen)
      return;
    lineOpen = true;
    linePeer = peer;
    notifyLine(peer, true);
  };
  const closeLine = () => {
    if (lineTimer !== undefined) {
      clearTimeout(lineTimer);
      lineTimer = undefined;
    }
    if (!lineOpen)
      return;
    const peer = linePeer;
    lineOpen = false;
    linePeer = null;
    if (peer)
      notifyLine(peer, false);
  };
  const noteTyping = () => {
    if (keyboard.value.length === 0) {
      closeLine();
      return;
    }
    if (lineOpen || lineTimer !== undefined)
      return;
    const session = props.session;
    const link = connection(session);
    if (!link)
      return;
    const peer = { sessionID: session.id, link };
    lineTimer = setTimeout(() => {
      lineTimer = undefined;
      openLine(peer);
    }, LINE_NOTICE_MS);
  };
  const submitFailed = () => {
    notice.textContent = ctx.t("submit.failed");
    notice.style.display = "block";
    keyboard.setAttribute("aria-invalid", "true");
  };
  const submitSucceeded = () => {
    notice.textContent = "";
    notice.style.display = "none";
    keyboard.setAttribute("aria-invalid", "false");
  };
  const paint = (view) => {
    applyBlinding(mode === "line" && view.attached === true && view.blinded === true);
    if (!view.attached) {
      text = view.reason === "no-terminal" ? ctx.t("empty") : `${ctx.t("unavailable")}: ${view.reason ?? ""}`;
    } else if (view.fullScreenApp !== null) {
      text = ctx.t("fullscreen");
    } else if (view.text.length > 0) {
      text = renderScreenText(view.text, { lines: LINES });
      shownSeq = view.seq;
    }
    screen.textContent = text;
    screen.scrollTop = screen.scrollHeight;
  };
  const unavailable = (reason) => ({
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
    reason
  });
  const tick = async () => {
    if (disposed)
      return;
    const session = props.session;
    if (!session.location)
      return;
    const link = connection(session);
    if (!link)
      return paint(unavailable("no-rpc"));
    const fresh = shownSession !== session.id;
    if (fresh) {
      shownSession = session.id;
      shownSeq = -1;
      text = "";
    }
    try {
      const view = fresh ? await link.rpc.open({ sessionID: session.id, cwd: session.directory }, link.options) : await link.rpc.read({ sessionID: session.id, lines: LINES, sinceSeq: shownSeq }, link.options);
      if (!disposed)
        paint(view);
    } catch (error) {
      paint(unavailable(error instanceof Error ? error.message : String(error)));
    }
  };
  const fit = () => {
    if (disposed)
      return;
    const session = props.session;
    const link = connection(session);
    if (!link || screen.clientWidth === 0)
      return;
    const probe = document.createElement("span");
    probe.textContent = "MMMMMMMMMM";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = ctx.appearance.font("mono");
    element.append(probe);
    const cell = probe.getBoundingClientRect().width / 10;
    probe.remove();
    const lineHeight = Number.parseFloat(getComputedStyle(screen).lineHeight) || LINE_HEIGHT;
    const cols = cell > 0 ? Math.floor((screen.clientWidth - 20) / cell) : 0;
    const rows = Math.floor((screen.clientHeight - LINE_HEIGHT) / lineHeight);
    const next = `${cols}x${rows}`;
    if (cols < 20 || rows < 5 || next === size)
      return;
    size = next;
    queue = queue.then(() => link.rpc.resize({ sessionID: session.id, cols, rows }, link.options)).catch(() => {
      return;
    });
  };
  const submit = () => {
    if (submitting)
      return;
    if (!mayWrite(token))
      return;
    const session = props.session;
    const link = connection(session);
    if (!link) {
      submitFailed();
      return;
    }
    const line = keyboard.value;
    submitting = true;
    queue = queue.then(() => link.rpc.submit({ sessionID: session.id, line }, link.options)).then((result) => {
      submitting = false;
      if (disposed)
        return;
      if (result?.submitted !== true) {
        submitFailed();
        return;
      }
      submitSucceeded();
      if (keyboard.value === line)
        keyboard.value = "";
      closeLine();
    }).catch(() => {
      submitting = false;
      if (!disposed)
        submitFailed();
    });
  };
  const insertAtCaret = (text2) => {
    const start = keyboard.selectionStart ?? keyboard.value.length;
    const end = keyboard.selectionEnd ?? start;
    keyboard.value = `${keyboard.value.slice(0, start)}${text2}${keyboard.value.slice(end)}`;
    const caret = start + text2.length;
    keyboard.selectionStart = caret;
    keyboard.selectionEnd = caret;
  };
  const applyMode = (next) => {
    if (next === mode)
      return;
    mode = next;
    element.className = next === "raw" ? "tp-root tp-raw" : "tp-root";
    modeLabel.textContent = next === "line" ? "Line" : "Raw";
    toggle.textContent = next === "line" ? "Raw" : "Line";
    toggle.setAttribute("aria-label", ctx.t(next === "line" ? "mode.switch.raw" : "mode.switch.line"));
    toggle.setAttribute("aria-pressed", next === "raw" ? "true" : "false");
    keyboard.value = "";
    closeLine();
    if (next === "raw")
      applyBlinding(false);
    claimWriter(token);
    keyboard.focus();
  };
  const onLineKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return true;
    }
    if (event.key === "Escape" || event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      keyboard.value = "";
      closeLine();
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      insertAtCaret("\t");
      noteTyping();
      return true;
    }
    return false;
  };
  const onKeyDown = (event) => {
    if (!mayWrite(token))
      return;
    if (mode === "line") {
      onLineKeyDown(event);
      return;
    }
    if (isPasteShortcut(event))
      return;
    const bytes = keysToBytes({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey
    });
    if (bytes === null)
      return;
    event.preventDefault();
    write(bytes);
  };
  const onPaste = (event) => {
    if (mode === "line")
      return;
    if (!mayWrite(token))
      return;
    event.preventDefault();
    const pasted = event.clipboardData?.getData("text");
    keyboard.value = "";
    if (!pasted)
      return;
    write(pasted.replace(/\r\n|[\r\n]/g, "\r"));
  };
  const onCompositionEnd = (event) => {
    if (mode === "line")
      return;
    if (!mayWrite(token))
      return;
    const data = event.data;
    if (data)
      write(data);
  };
  const onInput = () => {
    if (!mayWrite(token))
      return;
    if (mode === "line") {
      noteTyping();
      return;
    }
    keyboard.value = "";
  };
  const onFocus = () => {
    claimWriter(token);
  };
  const onBlur = () => {
    releaseWriter(token);
    if (mode === "line")
      closeLine();
  };
  const onToggle = () => {
    applyMode(mode === "line" ? "raw" : "line");
  };
  const onTogglePress = (event) => event.preventDefault();
  keyboard.addEventListener("keydown", onKeyDown);
  keyboard.addEventListener("paste", onPaste);
  keyboard.addEventListener("compositionend", onCompositionEnd);
  keyboard.addEventListener("input", onInput);
  keyboard.addEventListener("focus", onFocus);
  keyboard.addEventListener("blur", onBlur);
  toggle.addEventListener("mousedown", onTogglePress);
  toggle.addEventListener("click", onToggle);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (resizeTimer !== undefined)
      clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 200);
  }) : undefined;
  observer?.observe(element);
  tick();
  timer = setInterval(() => void tick(), POLL_MS);
  return {
    element,
    focus() {
      claimWriter(token);
      keyboard.focus();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined)
        clearInterval(timer);
      if (resizeTimer !== undefined)
        clearTimeout(resizeTimer);
      closeLine();
      releaseWriter(token);
      if (writer === token)
        writer = null;
      observer?.disconnect();
      keyboard.removeEventListener("keydown", onKeyDown);
      keyboard.removeEventListener("paste", onPaste);
      keyboard.removeEventListener("compositionend", onCompositionEnd);
      keyboard.removeEventListener("input", onInput);
      keyboard.removeEventListener("focus", onFocus);
      keyboard.removeEventListener("blur", onBlur);
      toggle.removeEventListener("mousedown", onTogglePress);
      toggle.removeEventListener("click", onToggle);
    }
  };
}
function isPasteShortcut(event) {
  if (event.altKey)
    return false;
  if (event.ctrlKey)
    return event.key.toLowerCase() === "v";
  return event.shiftKey && event.key === "Insert";
}
var gui_default = import_gui.Plugin.define({
  i18n: {
    en: {
      "tab.title": "Terminal",
      "command.group": "Terminal",
      "command.open": "Open terminal",
      "command.open.description": "Show the plugin's PTY for this session",
      "input.label": "Terminal input",
      "mode.switch.raw": "Switch to raw mode (send every key immediately)",
      "mode.switch.line": "Switch to line mode (send on Enter)",
      empty: "No terminal yet. Type a command, or ask the assistant to open one.",
      fullscreen: "A full-screen program is running in this terminal; it is not rendered here.",
      unavailable: "Terminal unavailable",
      "submit.failed": "The line was not sent; the terminal did not accept it. Your text is still here."
    },
    es: {
      "tab.title": "Terminal",
      "command.group": "Terminal",
      "command.open": "Abrir terminal",
      "command.open.description": "Muestra la PTY del plugin para esta sesión",
      "input.label": "Entrada de la terminal",
      "mode.switch.raw": "Cambiar a modo raw (envía cada tecla de inmediato)",
      "mode.switch.line": "Cambiar a modo línea (envía al presionar Enter)",
      empty: "Todavía no hay terminal. Escribí un comando, o pedile al asistente que la abra.",
      fullscreen: "Hay un programa de pantalla completa en esta terminal; no se dibuja acá.",
      unavailable: "Terminal no disponible",
      "submit.failed": "La línea no se envió: la terminal no la aceptó. Tu texto sigue acá."
    }
  },
  setup
});
