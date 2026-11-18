import type { BufferChunk, BufferSubscriber } from "./types"

/**
 * Fans one PTY stream out to several consumers and keeps a bounded scrollback for snapshots.
 *
 * - The human terminal subscribes as `human` and receives raw chunks (escape sequences intact).
 * - The AI consumer reads `snapshot()` instead of subscribing, so it only ever sees plain text.
 * - The logger subscribes as `logger` but the session manager decides what reaches it.
 */

export interface BufferBroadcasterOptions {
  readonly maxLines?: number
  readonly now?: () => number
}

const DEFAULT_MAX_LINES = 10_000

export class BufferBroadcaster {
  readonly #maxLines: number
  readonly #now: () => number
  readonly #subscribers = new Map<string, BufferSubscriber>()
  #lines: string[] = []
  #partial = ""
  #seq = 0
  #lastActivityAt: number

  constructor(options: BufferBroadcasterOptions = {}) {
    this.#maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    this.#now = options.now ?? Date.now
    this.#lastActivityAt = this.#now()
  }

  get seq(): number {
    return this.#seq
  }

  get lineCount(): number {
    return this.#lines.length
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt
  }

  /** Appends a raw PTY chunk: broadcasts it, then folds complete lines into the scrollback. */
  push(data: string): BufferChunk {
    const at = this.#now()
    this.#seq += 1
    this.#lastActivityAt = at

    const chunk: BufferChunk = { seq: this.#seq, at, data }
    for (const subscriber of this.#subscribers.values()) subscriber.write(chunk)

    this.#ingest(data)
    return chunk
  }

  /** Last `lines` completed lines (plus any in-flight partial line) as plain text. */
  snapshot(lines?: number): string {
    const all = this.#partial.length > 0 ? [...this.#lines, this.#partial] : this.#lines
    const take = lines === undefined ? all.length : Math.max(0, Math.min(lines, all.length))
    return all.slice(all.length - take).join("\n")
  }

  subscribe(subscriber: BufferSubscriber): () => void {
    this.#subscribers.set(subscriber.id, subscriber)
    return () => {
      this.#subscribers.delete(subscriber.id)
    }
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  clear(): void {
    this.#lines = []
    this.#partial = ""
  }

  #ingest(data: string): void {
    const combined = this.#partial + data
    const parts = combined.split("\n")
    this.#partial = parts.pop() ?? ""

    for (const part of parts) {
      const line = part.endsWith("\r") ? part.slice(0, -1) : part
      this.#lines.push(line)
    }

    if (this.#lines.length > this.#maxLines) {
      this.#lines = this.#lines.slice(this.#lines.length - this.#maxLines)
    }
  }
}
