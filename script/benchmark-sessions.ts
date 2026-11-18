/**
 * T029 — five concurrent local sessions held open for ten minutes, sampling process memory every
 * 30 seconds.
 *
 * The criterion has two halves:
 *
 *  1. No session may die during the window: the manager reports every `exit` event, and each
 *     sample records how many of the five sessions are still registered.
 *  2. Memory must not grow monotonically more than 5 % between minute 2 and minute 10. Minute 2
 *     is the baseline because PowerShell start-up, profile loading and the first prompt allocate
 *     while the shells warm up; measuring from minute 0 would charge that to a leak.
 *
 * Every plugin session lives in the same Node process (`LocalTerminal` -> `SessionManager` ->
 * `@lydell/node-pty`), so `process.memoryUsage()` is the whole process. `heapUsed` and `rss` are
 * reported both in total and divided by five, since the criterion talks about memory per session.
 *
 * Runner: this must run under **Node**, not Bun. `@lydell/node-pty`'s ConPTY backend writes to the
 * pseudoconsole through `net.Socket`, and under Bun 1.3.14 on Windows every `PtyProcess.write()`
 * throws `Socket is closed (ERR_SOCKET_CLOSED)`. Build and run from the plugin directory:
 *
 *   bun build script/benchmark-sessions.ts --target=node --format=esm \
 *     --external @lydell/node-pty --outfile <dir-with-node_modules>/benchmark-sessions.mjs
 *   node <dir-with-node_modules>/benchmark-sessions.mjs
 *
 * `BENCH_MINUTES` and `BENCH_INTERVAL_SECONDS` shorten the window for a smoke run; the defaults are
 * the criterion's 10 minutes and 30 seconds. A shortened run is not evidence for T029.
 */

import os from "node:os"
import { performance } from "node:perf_hooks"
import { LocalTerminal } from "../lib/local-engine"
import { LocalShellConnector } from "../lib/local-shell"
import { createNodePtySpawner } from "../lib/pty-host"
import { SessionManager } from "../lib/session-manager"
import { renderScreenText } from "../lib/screen"

/** Sessions held open at the same time, as required by SC-007. */
const SESSIONS = 5
const DEFAULT_MINUTES = 10
const DEFAULT_INTERVAL_SECONDS = 30
/** Memory baseline: the shells have finished warming up by here. */
const GROWTH_FROM_MINUTE = 2
/** Allowed monotonic growth over the measured window, in percent. */
const GROWTH_LIMIT_PERCENT = 5
const OPEN_DEADLINE = 20_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  return bun ? `bun ${bun.version}` : `node ${process.version}`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function growthPercent(from: number, to: number): number | null {
  if (from === 0) return null
  return round(((to - from) / from) * 100)
}

async function main() {
  const minutes = envNumber("BENCH_MINUTES", DEFAULT_MINUTES)
  const intervalSeconds = envNumber("BENCH_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS)
  const intervalMs = intervalSeconds * 1000
  const steps = Math.round((minutes * 60_000) / intervalMs)

  const spawner = await createNodePtySpawner()
  const connector = new LocalShellConnector(spawner)
  const manager = new SessionManager({ spawner, connector })
  const terminal = new LocalTerminal(manager, connector)
  const shell = connector.shell

  /** Every `exit` reported by a shell; `at` is turned into a window minute once the window opens. */
  const exits: { id: string; exitCode: number; signal: number | null; at: number }[] = []
  manager.on((event) => {
    if (event.type !== "exit") return
    exits.push({
      id: event.sessionId,
      exitCode: event.event.exitCode,
      signal: event.event.signal ?? null,
      at: performance.now(),
    })
  })

  const ids = Array.from({ length: SESSIONS }, (_, index) => `bench-session-${index + 1}`)
  const sessions: { id: string; startupMs: number; pid: number | null; aliveAtEnd: boolean }[] = []

  for (const id of ids) {
    const openStartedAt = performance.now()
    await terminal.open(id)
    const ready = await waitForPrompt(manager, id, performance.now() + OPEN_DEADLINE)
    if (ready === null) throw new Error(`${id} never printed a prompt within ${OPEN_DEADLINE} ms`)
    const info = manager.info(id)
    sessions.push({
      id,
      startupMs: round(performance.now() - openStartedAt),
      pid: info.pid !== undefined && info.pid > 0 ? info.pid : null,
      aliveAtEnd: false,
    })
    console.error(`${id} ready in ${round(performance.now() - openStartedAt)} ms`)
  }

  /** One memory reading plus how many of the five sessions are still registered. */
  const sample = (elapsedMs: number) => {
    const usage = process.memoryUsage()
    return {
      minute: round(elapsedMs / 60_000),
      elapsedMs: round(elapsedMs),
      heapUsed: usage.heapUsed,
      rss: usage.rss,
      heapUsedPerSession: Math.round(usage.heapUsed / SESSIONS),
      rssPerSession: Math.round(usage.rss / SESSIONS),
      alive: manager.list().length,
    }
  }

  // The window starts once all five shells are up and idle at their prompt. Sampling is
  // scheduled off this one timestamp, so a slow tick cannot make the grid drift.
  const windowStartedAt = performance.now()
  const samples: ReturnType<typeof sample>[] = []
  for (let step = 0; step <= steps; step += 1) {
    await sleep(Math.max(0, intervalMs * step - (performance.now() - windowStartedAt)))
    samples.push(sample(performance.now() - windowStartedAt))
  }

  // Liveness is read before destroying anything, so it describes the end of the window.
  const aliveAtEnd = ids.filter((id) => manager.has(id)).length
  for (const session of sessions) session.aliveAtEnd = manager.has(session.id)

  for (const id of ids) terminal.kill(id)
  await sleep(300)
  const afterDestroy = process.memoryUsage()

  // The baseline is the first sample at or after minute 2; the endpoint is the last sample taken.
  // When the window never reaches minute 2 the growth is not measurable and stays null.
  const baselineIndex = samples.findIndex((entry) => entry.elapsedMs >= GROWTH_FROM_MINUTE * 60_000)
  const first = baselineIndex === -1 ? null : (samples[baselineIndex] ?? null)
  const last = samples[samples.length - 1] ?? null
  const window = baselineIndex === -1 ? [] : samples.slice(baselineIndex)
  const monotonic = (values: readonly number[]) => values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0))
  const heapValues = window.map((entry) => entry.heapUsed)
  const rssValues = window.map((entry) => entry.rss)
  const measurable = window.length > 1
  const heapGrowth = measurable && first && last ? growthPercent(first.heapUsed, last.heapUsed) : null
  const rssGrowth = measurable && first && last ? growthPercent(first.rss, last.rss) : null
  const heapMonotonic = heapValues.length > 1 && monotonic(heapValues)
  const rssMonotonic = rssValues.length > 1 && monotonic(rssValues)

  // Criterion: fail only when growth is monotonic *and* above 5 %.
  const heapStable = heapGrowth !== null && (heapGrowth <= GROWTH_LIMIT_PERCENT || !heapMonotonic)
  const rssStable = rssGrowth !== null && (rssGrowth <= GROWTH_LIMIT_PERCENT || !rssMonotonic)
  const noCrashes = exits.length === 0 && aliveAtEnd === SESSIONS

  const report = {
    measuredAt: new Date().toISOString(),
    runtime: runtimeName(),
    platform: `${process.platform} ${os.release()}`,
    shell: `${shell.file} ${shell.args.join(" ")}`.trim(),
    sessionCount: SESSIONS,
    durationMinutes: minutes,
    intervalSeconds,
    method: {
      sessions: "5 concurrent LocalTerminal.open() sessions over SessionManager + LocalShellConnector + createNodePtySpawner (real ConPTY)",
      memory: "process.memoryUsage() every interval; per-session figures divide the process totals by the session count",
      growth: `baseline at minute ${GROWTH_FROM_MINUTE}, compared against minute ${round(minutes)}; monotonic means every sampled value is >= the previous one`,
      limit: `fail when growth is monotonic and > ${GROWTH_LIMIT_PERCENT} %`,
    },
    sessions,
    exits: exits.map((event) => ({
      id: event.id,
      exitCode: event.exitCode,
      signal: event.signal,
      minute: round((event.at - windowStartedAt) / 60_000),
    })),
    samples,
    growth: {
      fromMinute: first?.minute ?? null,
      toMinute: last?.minute ?? null,
      windowSamples: window.length,
      heapUsedPercent: heapGrowth,
      rssPercent: rssGrowth,
      heapUsedMonotonic: heapMonotonic,
      rssMonotonic,
      heapUsedPerSessionPercent:
        measurable && first && last ? growthPercent(first.heapUsedPerSession, last.heapUsedPerSession) : null,
      rssPerSessionPercent: measurable && first && last ? growthPercent(first.rssPerSession, last.rssPerSession) : null,
    },
    afterDestroy: { heapUsed: afterDestroy.heapUsed, rss: afterDestroy.rss },
    verdict: {
      noCrashes,
      heapStable,
      rssStable,
      pass: noCrashes && heapStable && rssStable,
      completeWindow: steps * intervalMs >= minutes * 60_000,
    },
  }

  console.log(JSON.stringify(report, null, 2))
  console.log("")
  console.log("minute  heapUsed (MB)  rss (MB)  heap/session (MB)  rss/session (MB)  alive")
  for (const entry of samples) {
    console.log(
      `${String(entry.minute).padEnd(7)} ${(entry.heapUsed / 1_048_576).toFixed(1).padEnd(14)} ${(entry.rss / 1_048_576)
        .toFixed(1)
        .padEnd(9)} ${(entry.heapUsedPerSession / 1_048_576).toFixed(1).padEnd(18)} ${(entry.rssPerSession / 1_048_576)
        .toFixed(1)
        .padEnd(17)} ${entry.alive}`,
    )
  }
  console.log("")
  console.log(
    `growth minute ${report.growth.fromMinute} -> ${report.growth.toMinute}: heap ${heapGrowth}% (monotonic ${heapMonotonic}), rss ${rssGrowth}% (monotonic ${rssMonotonic})`,
  )
  console.log(
    `verdict: noCrashes ${noCrashes}, heapStable ${heapStable}, rssStable ${rssStable} -> ${report.verdict.pass ? "pass" : "FAIL"}`,
  )

  return report.verdict.pass ? 0 : 1
}

/** Waits until the session's screen ends in a prompt, yielding so PTY output can arrive. */
async function waitForPrompt(manager: SessionManager, id: string, deadline: number): Promise<true | null> {
  while (performance.now() < deadline) {
    const screen = renderScreenText(manager.humanSnapshot(id, 60).text, { lines: 60 })
    if (/[>$#]\s*$/.test(screen)) return true
    await sleep(50)
  }
  return null
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`benchmark failed: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
    process.exit(1)
  },
)
