import { lastLines } from "./ansi"

/**
 * Reconnection with exponential backoff and buffer replay.
 *
 * Replay exists so a reconnect after a dropped link shows the operator the tail of what
 * happened instead of an empty terminal.
 */

export interface ReconnectPolicyOptions {
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxAttempts?: number
  /** Injected for deterministic tests; must return a value in [0, 1). */
  readonly random?: () => number
}

export class ReconnectPolicy {
  readonly #baseDelayMs: number
  readonly #maxDelayMs: number
  readonly #maxAttempts: number
  readonly #random: () => number

  constructor(options: ReconnectPolicyOptions = {}) {
    this.#baseDelayMs = options.baseDelayMs ?? 500
    this.#maxDelayMs = options.maxDelayMs ?? 30_000
    this.#maxAttempts = options.maxAttempts ?? 10
    this.#random = options.random ?? Math.random
  }

  /** Delay before attempt `attempt` (1-based), or `null` when attempts are exhausted. */
  nextDelay(attempt: number): number | null {
    if (attempt < 1 || attempt > this.#maxAttempts) return null
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1))
    // Full jitter, capped so a test with random() = 0 still makes progress.
    return Math.max(1, Math.round(exponential * (0.5 + this.#random() * 0.5)))
  }

  get maxAttempts(): number {
    return this.#maxAttempts
  }
}

export interface RetryInfo {
  readonly attempt: number
  readonly delayMs: number
  readonly error: unknown
}

export interface WithReconnectOptions {
  readonly policy: ReconnectPolicy
  readonly onRetry?: (info: RetryInfo) => void
  readonly sleep?: (ms: number) => Promise<void>
}

/** Runs `attempt` until it resolves, retrying per policy. Rethrows the last error. */
export async function withReconnect<T>(
  options: WithReconnectOptions,
  attempt: (n: number) => Promise<T>,
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown

  for (let n = 1; ; n += 1) {
    try {
      return await attempt(n)
    } catch (error) {
      lastError = error
      const delayMs = options.policy.nextDelay(n)
      if (delayMs === null) break
      options.onRetry?.({ attempt: n, delayMs, error })
      await sleep(delayMs)
    }
  }

  throw lastError
}

/** Tail of the previous session used to prime the terminal after a reconnect. */
export function replayTail(snapshot: string, lines = 1_000): string {
  return lastLines(snapshot, lines)
}
