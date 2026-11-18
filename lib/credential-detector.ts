import type { CredentialKind, CredentialPrompt } from "./types"

/**
 * Detects interactive credential prompts in PTY output.
 *
 * When a prompt is detected the detector enters a blinded state. While blinded the session
 * manager withholds buffer snapshots from the AI consumer and stops logging output, so the
 * only party that ever sees the secret is the human typing into the visible terminal.
 *
 * Prompts are matched against a rolling tail because a single prompt can be split across
 * arbitrary PTY chunks.
 */

interface PromptRule {
  readonly kind: CredentialKind
  readonly pattern: RegExp
  /** Host-key confirmation is not a secret: report it, but do not blind the AI. */
  readonly blinds: boolean
}

const RULES: readonly PromptRule[] = [
  {
    kind: "sudo",
    pattern: /\[sudo\] password for [^:\n]+:\s*$/i,
    blinds: true,
  },
  {
    kind: "password",
    pattern: /(?:^|[\s(])password(?: for [^\s:]+)?:\s*$/i,
    blinds: true,
  },
  {
    kind: "passphrase",
    pattern: /enter pass ?phrase(?: for key '[^']*')?:\s*$/i,
    blinds: true,
  },
  {
    kind: "mfa",
    pattern:
      /(?:verification code|one[- ]time password|authenticator code|two[- ]factor code|2fa code|passcode|token):\s*$/i,
    blinds: true,
  },
  {
    kind: "host-key",
    pattern: /(?:are you sure you want to continue connecting|continue connecting)[^\n]*\?\s*$/i,
    blinds: false,
  },
]

const SUCCESS_MARKERS: readonly RegExp[] = [
  /last login:/i,
  /welcome to /i,
  /connection to \S+ closed/i,
  /^[^\s@]+@[^\s]+[^$#\n]*[$#]\s*$/m,
  /^\s*[$#]\s*$/m,
]

const TAIL_BYTES = 512

export interface CredentialDetectorOptions {
  /** How long a detected prompt keeps the session blinded without further evidence. */
  readonly blindWindowMs?: number
  /** Suppresses duplicate reports of the same prompt arriving in consecutive chunks. */
  readonly cooldownMs?: number
  readonly now?: () => number
}

export class CredentialDetector {
  readonly #now: () => number
  readonly #blindWindowMs: number
  readonly #cooldownMs: number
  #tail = ""
  #blindedUntil = 0
  #lastPrompt: CredentialPrompt | null = null
  #lastReportKey: string | null = null
  #lastReportAt = 0

  constructor(options: CredentialDetectorOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#blindWindowMs = options.blindWindowMs ?? 120_000
    this.#cooldownMs = options.cooldownMs ?? 250
  }

  /** Inspects a chunk and reports a prompt when one is present. Never clears blinding. */
  inspect(chunk: string): CredentialPrompt | null {
    this.#tail = (this.#tail + chunk).slice(-TAIL_BYTES)

    const found = findPrompt(this.#tail)
    if (!found) return null

    const key = `${found.rule.kind}:${found.text.trim()}`
    const at = this.#now()
    if (key === this.#lastReportKey && at - this.#lastReportAt < this.#cooldownMs) return null

    const prompt: CredentialPrompt = {
      kind: found.rule.kind,
      text: found.text.trim(),
      at,
      blinds: found.rule.blinds,
    }
    this.#lastReportKey = key
    this.#lastReportAt = at
    this.#lastPrompt = prompt
    if (prompt.blinds) this.#blindedUntil = at + this.#blindWindowMs
    return prompt
  }

  /** Inspects a chunk and clears blinding as soon as authentication succeeds. */
  observe(chunk: string): CredentialPrompt | null {
    const prompt = this.inspect(chunk)
    if (SUCCESS_MARKERS.some((marker) => marker.test(chunk))) this.clear()
    return prompt
  }

  get blinded(): boolean {
    return this.#now() < this.#blindedUntil
  }

  get lastPrompt(): CredentialPrompt | null {
    return this.#lastPrompt
  }

  /** Milliseconds left in the blind window; 0 when not blinded. */
  get remainingBlindMs(): number {
    return Math.max(0, this.#blindedUntil - this.#now())
  }

  clear(): void {
    this.#blindedUntil = 0
    this.#lastPrompt = null
    this.#lastReportKey = null
  }
}

function findPrompt(tail: string): { rule: PromptRule; text: string } | null {
  let best: { rule: PromptRule; text: string; start: number; end: number } | null = null

  for (const rule of RULES) {
    // `matchAll` needs the global flag; clone so the shared rule stays stateless.
    const global = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    )
    for (const match of tail.matchAll(global)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      // The latest prompt wins; on a tie the longer (more specific) match wins, so
      // `[sudo] password for ops:` reports `sudo` rather than the generic `password`.
      if (!best || end > best.end || (end === best.end && start < best.start)) {
        best = { rule, text: match[0], start, end }
      }
    }
  }

  return best ? { rule: best.rule, text: best.text } : null
}
