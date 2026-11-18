/**
 * T028 — opening time, PTY→read latency and panel render cost, measured on a real local PTY.
 *
 * Three metrics, 30 samples each (nearest-rank p50/p95):
 *
 *  1. open   — `LocalTerminal.open()` until the shell prints its first prompt, so it covers the
 *              ConPTY spawn, the shell start and the first output reaching the buffer.
 *  2. read   — `writeHuman("echo <token>")` until the *output line* of that token shows up in
 *              `SessionManager.snapshot()`, i.e. the AI-facing read path. The token is required to
 *              be a whole line of the snapshot so the shell's echo of the typed command (which
 *              carries a prompt prefix) cannot be mistaken for the output. Five uncounted warm-up
 *              reads (tokens `PTYWARM-W1..W5`) run first, so PSReadLine start-up and line-editor
 *              warm-up do not leak cold samples into the measured p95.
 *  3. render — `panelHandlers(...).read({ lines: 400 })` over a buffer holding 600 lines: the exact
 *              function the panel polls, including `humanView` and `renderScreenText`.
 *
 * Thresholds (spec SC-001): open p95 < 10 s, read p95 < 100 ms, render p95 < 16 ms.
 *
 * Runner: this must run under **Node**, not Bun. `@lydell/node-pty`'s ConPTY backend writes to the
 * pseudoconsole through `net.Socket`, and under Bun 1.3.14 on Windows every `PtyProcess.write()`
 * throws `Socket is closed (ERR_SOCKET_CLOSED)` from `windowsTerminal.js` `_doWrite`. Reads work, so
 * the failure is silent until the first keystroke. Build and run from the plugin directory:
 *
 *   bun build script/benchmark.ts --target=node --format=esm --external @lydell/node-pty \
 *     --outfile <dir-with-node_modules>/benchmark.mjs
 *   node <dir-with-node_modules>/benchmark.mjs
 *
 * The plugin has `@lydell/node-pty` as its only dependency, so a normal installed plugin directory
 * works as `<dir-with-node_modules>`.
 */

import os from "node:os"
import { performance } from "node:perf_hooks"
import { panelHandlers } from "../lib/gui/host"
import { LocalTerminal } from "../lib/local-engine"
import { LocalShellConnector, isPowerShell } from "../lib/local-shell"
import { createNodePtySpawner } from "../lib/pty-host"
import { SessionManager } from "../lib/session-manager"
import { renderScreenText } from "../lib/screen"

const OPENINGS = 30
const READS = 30
const RENDERS = 30
/**
 * Uncounted reads before the measured ones. The first keystrokes on a fresh pwsh pay PSReadLine
 * loading and line-editor warm-up, and without this the cold samples leak into the p95.
 */
const WARMUP_READS = 5
/** Trailing rows the panel shows; matches `PANEL_LINES` in `lib/gui/host.ts`. */
const PANEL_LINES = 400
/** Rows generated before the render benchmark, so the renderer works on a full read window. */
const FILL_LINES = 600

const THRESHOLDS = {
  openP95: 10_000,
  readP95: 100,
  renderP95: 16,
} as const

const OPEN_DEADLINE = 20_000
const READ_DEADLINE = 10_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Nearest-rank percentile: the smallest sample that is ≥ p% of the samples. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN
}

function summarize(samples: readonly number[]) {
  return {
    n: samples.length,
    min: Math.min(...samples),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
  }
}

function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  return bun ? `bun ${bun.version}` : `node ${process.version}`
}

/** Lines of an AI snapshot, so a token can be matched as a whole line instead of a substring. */
function snapshotLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim())
}

async function main() {
  const spawner = await createNodePtySpawner()
  const connector = new LocalShellConnector(spawner)
  const manager = new SessionManager({ spawner, connector })
  const terminal = new LocalTerminal(manager, connector)
  const panel = panelHandlers(terminal, () => "local-pty")
  const shell = connector.shell

  /** Waits until `condition` holds, yielding to the event loop so PTY data can arrive. */
  const waitUntil = async (condition: () => boolean, deadline: number) => {
    while (performance.now() < deadline) {
      if (condition()) return performance.now()
      await sleep(1)
    }
    return null
  }

  /** Opens a session and returns how long it took to reach a prompt. */
  const openSession = async (id: string) => {
    const start = performance.now()
    await terminal.open(id)
    const ready = await waitUntil(
      () => /[>$#]\s*$/.test(renderScreenText(manager.humanSnapshot(id).text, { lines: 60 })),
      start + OPEN_DEADLINE,
    )
    if (ready === null) throw new Error(`${id} never printed a prompt within ${OPEN_DEADLINE} ms`)
    return ready - start
  }

  const openings: number[] = []
  for (let index = 0; index < OPENINGS; index += 1) {
    const id = `bench-open-${index + 1}`
    openings.push(await openSession(id))
    terminal.kill(id)
    await sleep(100)
  }

  const readSession = "bench-read"
  await openSession(readSession)

  /** Types `echo <token>` and returns the time until the whole token line reaches `snapshot()`. */
  const measureRead = async (token: string) => {
    const start = performance.now()
    manager.writeHuman(readSession, `echo ${token}\r`)
    const found = await waitUntil(
      () => snapshotLines(manager.snapshot(readSession, PANEL_LINES).text).includes(token),
      start + READ_DEADLINE,
    )
    if (found === null) throw new Error(`output ${token} never reached snapshot() within ${READ_DEADLINE} ms`)
    return found - start
  }

  for (let index = 0; index < WARMUP_READS; index += 1) {
    await measureRead(`PTYWARM-W${index + 1}`)
  }

  const reads: number[] = []
  for (let index = 0; index < READS; index += 1) {
    reads.push(await measureRead(`PTYREAD-T${index + 1}`))
  }

  const renderSession = "bench-render"
  await openSession(renderSession)
  const filler = isPowerShell(shell.file)
    ? `1..${FILL_LINES} | ForEach-Object { "line $_" }`
    : shell.file.toLowerCase().includes("cmd")
      ? `for /l %i in (1,1,${FILL_LINES}) do @echo line %i`
      : `seq 1 ${FILL_LINES}`
  manager.writeHuman(renderSession, `${filler}\r`)
  const lastLine = `line ${FILL_LINES}`
  const filled = await waitUntil(
    () => snapshotLines(manager.snapshot(renderSession, 4000).text).includes(lastLine),
    performance.now() + 30_000,
  )
  if (filled === null) throw new Error(`could not fill the buffer with ${FILL_LINES} lines`)

  const renders: number[] = []
  let renderedLines = 0
  for (let index = 0; index < RENDERS; index += 1) {
    const start = performance.now()
    const view = panel.read({ sessionID: renderSession, lines: PANEL_LINES })
    renders.push(performance.now() - start)
    if (!view.attached) throw new Error("panel read returned a detached view")
    renderedLines = view.text.split("\n").length
  }

  const open = summarize(openings)
  const read = summarize(reads)
  const render = summarize(renders)
  const verdict = {
    open: open.p95 < THRESHOLDS.openP95,
    read: read.p95 < THRESHOLDS.readP95,
    render: render.p95 < THRESHOLDS.renderP95,
  }

  const report = {
    measuredAt: new Date().toISOString(),
    runtime: runtimeName(),
    platform: `${process.platform} ${os.release()}`,
    shell: `${shell.file} ${shell.args.join(" ")}`.trim(),
    columns: 120,
    rows: 30,
    panelLines: PANEL_LINES,
    fillLines: FILL_LINES,
    warmupReads: WARMUP_READS,
    renderedLines,
    method: {
      open: "LocalTerminal.open() until the first prompt renders; 30 sequential sessions, each killed after its sample",
      read: `writeHuman('echo <token>') until <token> appears as a whole line of SessionManager.snapshot(400); ${WARMUP_READS} uncounted warm-up reads first`,
      render: "panelHandlers.read({ lines: 400 }) over a 600-line scrollback, same function the panel polls",
      percentile: "nearest rank: sorted[ceil(p*n)-1]",
    },
    metrics: {
      openMs: { ...open, threshold: THRESHOLDS.openP95, pass: verdict.open },
      readMs: { ...read, threshold: THRESHOLDS.readP95, pass: verdict.read },
      renderMs: { ...render, threshold: THRESHOLDS.renderP95, pass: verdict.render },
    },
    pass: verdict.open && verdict.read && verdict.render,
  }

  manager.destroyAll()
  await sleep(300)

  console.log(JSON.stringify(report, null, 2))
  console.log("")
  console.log("metric      n    p50        p95        max        threshold   verdict")
  const row = (name: string, value: typeof open, threshold: number, pass: boolean) =>
    console.log(
      `${name.padEnd(11)} ${String(value.n).padEnd(4)} ${value.p50.toFixed(2).padEnd(10)} ${value.p95
        .toFixed(2)
        .padEnd(10)} ${value.max.toFixed(2).padEnd(10)} ${String(threshold).padEnd(11)} ${pass ? "pass" : "FAIL"}`,
    )
  row("open (ms)", open, THRESHOLDS.openP95, verdict.open)
  row("read (ms)", read, THRESHOLDS.readP95, verdict.read)
  row("render (ms)", render, THRESHOLDS.renderP95, verdict.render)

  return report.pass ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`benchmark failed: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
    process.exit(1)
  },
)
