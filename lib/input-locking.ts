/**
 * Human-first input arbitration.
 *
 * Rule: human keystrokes always win. An AI write that arrives while the human is mid-line is
 * queued and only released once they have been idle for the priority window, so a command can
 * never land on top of a line someone is still typing. The write itself is still gated by human
 * approval; the lock only decides *when* it reaches the PTY.
 */

export const DEFAULT_HUMAN_PRIORITY_WINDOW_MS = 1_000

export interface InputLockOptions {
  /** How long after the last human keystroke the AI must wait. */
  readonly humanPriorityWindowMs?: number
  readonly now?: () => number
}

export class InputLock<T = string> {
  readonly #now: () => number
  readonly #windowMs: number
  #lastHumanAt = 0
  #lastAiAt = 0
  #queue: T[] = []
  #lineActive = false

  constructor(options: InputLockOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#windowMs = options.humanPriorityWindowMs ?? DEFAULT_HUMAN_PRIORITY_WINDOW_MS
  }

  noteHumanInput(): void {
    this.#lastHumanAt = this.#now()
  }

  noteAiInput(): void {
    this.#lastAiAt = this.#now()
  }

  /**
   * The human has an open local line (line mode).
   *
   * Unlike a keystroke, this does not expire with the priority window: the line stays open until
   * {@link submitLine}, so a command approved while the person is still composing it waits however
   * long they take.
   */
  humanLine(): void {
    this.#lineActive = true
    this.#lastHumanAt = this.#now()
  }

  /** The human submitted the line: the idle window is over and queued AI writes may follow it. */
  submitLine(): void {
    this.#lineActive = false
    // Put the last keystroke a whole window in the past, so the next drain sees an idle human even
    // when the line was open for less than the window.
    this.#lastHumanAt = this.#now() - this.#windowMs
  }

  /** Whether a local line is still being composed; independent of the idle window. */
  get lineActive(): boolean {
    return this.#lineActive
  }

  /** Raw keystroke priority: true while the human is inside the priority window. */
  get humanActive(): boolean {
    return this.humanIdleInMs > 0
  }

  /**
   * Milliseconds left until the human counts as idle; `0` when they already are.
   *
   * A caller schedules exactly one deferred release with this, so a write that arrives in the
   * middle of the window does not wait a whole window a second time.
   */
  get humanIdleInMs(): number {
    return Math.max(0, this.#windowMs - (this.#now() - this.#lastHumanAt))
  }

  get lastAiAt(): number {
    return this.#lastAiAt
  }

  get queued(): readonly T[] {
    return this.#queue
  }

  enqueue(item: T): void {
    this.#queue.push(item)
  }

  /** Releases queued items only when no human line is open and the human is idle. Clears the queue on release. */
  drain(): readonly T[] {
    if (this.#queue.length === 0) return []
    if (this.#lineActive || this.humanActive) return []
    const released = this.#queue
    this.#queue = []
    this.#lastAiAt = this.#now()
    return released
  }

  clear(): void {
    this.#queue = []
  }
}
