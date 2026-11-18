import type { PtyExitEvent, PtyProcess, PtySpawnOptions, PtySpawner } from "./types"

/**
 * `node-pty` binding, loaded lazily.
 *
 * The specifier is a variable on purpose: it keeps this package type-checkable without the
 * native dependency installed, so unit tests and CI can run the pure logic everywhere.
 * `@lydell/node-pty` is the fork the repository already uses in `packages/core`.
 */
const NODE_PTY_MODULE = "@lydell/node-pty"

interface NodePtyDisposable {
  dispose(): void
}

interface NodePtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): NodePtyDisposable | void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): NodePtyDisposable | void
}

interface NodePtyModule {
  spawn(file: string, args: readonly string[], options: Record<string, unknown>): NodePtyProcess
}

/** Resolves the native spawner. Call once at process start and reuse the result. */
export async function createNodePtySpawner(
  load: () => Promise<unknown> = () => import(NODE_PTY_MODULE),
): Promise<PtySpawner> {
  const loaded = await load()
  const module = normalizeModule(loaded)
  return { spawn: (options) => adapt(module.spawn(options.file, [...options.args], toNodePtyOptions(options))) }
}

function normalizeModule(loaded: unknown): NodePtyModule {
  const candidate = (loaded as { default?: unknown }).default ?? loaded
  const spawn = (candidate as { spawn?: unknown }).spawn
  if (typeof spawn !== "function") throw new Error(`${NODE_PTY_MODULE} did not expose spawn()`)
  return candidate as NodePtyModule
}

function toNodePtyOptions(options: PtySpawnOptions): Record<string, unknown> {
  return {
    name: options.name ?? "xterm-256color",
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    cwd: options.cwd ?? process.env.HOME ?? process.cwd(),
    env: { ...process.env, ...options.env },
  }
}

function adapt(process: NodePtyProcess): PtyProcess {
  return {
    pid: process.pid,
    write: (data) => process.write(data),
    resize: (cols, rows) => process.resize(cols, rows),
    kill: (signal) => process.kill(signal),
    onData: (listener) => subscribe<string>((handler) => process.onData(handler), listener),
    onExit: (listener) =>
      subscribe<{ exitCode: number; signal?: number }>((handler) => process.onExit(handler), (event) =>
        listener(normalizeExit(event)),
      ),
  }
}

function normalizeExit(event: { exitCode: number; signal?: number }): PtyExitEvent {
  return event.signal === undefined ? { exitCode: event.exitCode } : { exitCode: event.exitCode, signal: event.signal }
}

function subscribe<T>(
  register: (handler: (value: T) => void) => NodePtyDisposable | void,
  listener: (value: T) => void,
): () => void {
  const disposable = register(listener)
  if (disposable && typeof disposable.dispose === "function") return () => disposable.dispose()
  return () => {}
}

/**
 * Single-session facade over a spawner.
 *
 * Kept separate from the session manager so the raw PTY lifecycle (spawn, resize, kill,
 * exit) can be exercised on its own.
 */
export class PtyHost {
  readonly #process: PtyProcess
  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(event: PtyExitEvent) => void>()
  #exited = false

  constructor(spawner: PtySpawner, options: PtySpawnOptions) {
    this.#process = spawner.spawn(options)
    this.#process.onData((data) => {
      for (const listener of this.#dataListeners) listener(data)
    })
    this.#process.onExit((event) => {
      this.#exited = true
      for (const listener of this.#exitListeners) listener(event)
    })
  }

  get pid(): number {
    return this.#process.pid
  }

  get exited(): boolean {
    return this.#exited
  }

  write(data: string): void {
    this.#process.write(data)
  }

  resize(cols: number, rows: number): void {
    this.#process.resize(cols, rows)
  }

  kill(signal?: string): void {
    this.#process.kill(signal)
  }

  onData(listener: (data: string) => void): () => void {
    this.#dataListeners.add(listener)
    return () => {
      this.#dataListeners.delete(listener)
    }
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.#exitListeners.add(listener)
    return () => {
      this.#exitListeners.delete(listener)
    }
  }
}
