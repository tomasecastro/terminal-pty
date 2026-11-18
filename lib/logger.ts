/**
 * JSONL session log.
 *
 * The logger is intentionally dumb: the session manager decides what may be recorded.
 * Anything that could carry a secret is redacted by key before it is serialized, as a
 * second line of defence behind credential blinding.
 */

const SECRET_KEY = /pass(?:word|phrase)?|secret|token|mfa|otp|verificationcode|credential/i

export interface SessionLogRecord {
  readonly at: string
  readonly sessionId: string
  readonly kind: string
  readonly data: Record<string, unknown>
}

export interface SessionLoggerOptions {
  readonly sessionId: string
  /** Receives one serialized line per record. Defaults to an in-memory buffer. */
  readonly sink?: (line: string) => void
  readonly now?: () => Date
}

export class SessionLogger {
  readonly #sessionId: string
  readonly #sink: ((line: string) => void) | undefined
  readonly #now: () => Date
  #records: SessionLogRecord[] = []

  constructor(options: SessionLoggerOptions) {
    this.#sessionId = options.sessionId
    this.#sink = options.sink
    this.#now = options.now ?? (() => new Date())
  }

  record(kind: string, data: Record<string, unknown>): SessionLogRecord {
    const record: SessionLogRecord = {
      at: this.#now().toISOString(),
      sessionId: this.#sessionId,
      kind,
      data: redact(data),
    }
    this.#records.push(record)
    this.#sink?.(JSON.stringify(record))
    return record
  }

  get records(): readonly SessionLogRecord[] {
    return this.#records
  }

  exportJsonl(): string {
    return this.#records.map((record) => JSON.stringify(record)).join("\n")
  }

  clear(): void {
    this.#records = []
  }
}

export function redact(value: object): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) output[key] = redactValue(entry, key)
  return output
}

function redactValue(value: unknown, key: string): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]"
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key))
  if (value !== null && typeof value === "object") return redact(value)
  return value
}
