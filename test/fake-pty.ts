import type { PtyExitEvent, PtyProcess, PtySpawnOptions, PtySpawner } from "../lib/types"

/** In-memory PTY used by the unit tests. No native binary, no real SSH. */
export class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly writes: string[] = []
  readonly resizes: Array<readonly [number, number]> = []
  killed = false

  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(event: PtyExitEvent) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(): void {
    this.killed = true
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

  emit(data: string): void {
    for (const listener of this.#dataListeners) listener(data)
  }

  exit(exitCode = 0): void {
    for (const listener of this.#exitListeners) listener({ exitCode })
  }
}

export class FakeSpawner implements PtySpawner {
  readonly spawned: PtySpawnOptions[] = []
  readonly processes: FakePty[] = []

  spawn(options: PtySpawnOptions): PtyProcess {
    this.spawned.push(options)
    const process = new FakePty()
    this.processes.push(process)
    return process
  }

  get last(): FakePty {
    const process = this.processes.at(-1)
    if (!process) throw new Error("No PTY spawned yet")
    return process
  }

  get lastOptions(): PtySpawnOptions {
    const options = this.spawned.at(-1)
    if (!options) throw new Error("No PTY spawned yet")
    return options
  }
}
