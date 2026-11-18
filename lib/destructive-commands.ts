/**
 * Destructive command detection for the `full` grant.
 *
 * With `full`, non-destructive commands run without a per-command approval. A command that
 * deletes or overwrites data must still ask the human, so this module has to be conservative:
 * it prefers one extra approval over one silent deletion (**fail closed**).
 *
 * The analysis is purely lexical. Nothing is executed, no shell is spawned, and the filesystem
 * is never touched: only the command text is read.
 *
 * What it looks at:
 *  - the binary, by normalized name (`rm`, `del`, `Remove-Item`, `truncate`, `drop`, ...);
 *  - the arguments, so `find . -exec rm {}` or `xargs rm` do not slip through;
 *  - chaining and substitution (`;`, `&&`, `||`, `|`, `$()`, backticks), segment by segment;
 *  - overwriting redirections (`>` to a file; `>>` appends and `2>&1` duplicates a stream);
 *  - a pipe into a shell (`curl ... | sh`), whose payload cannot be classified;
 *  - anything it cannot tokenize with certainty, such as unbalanced quotes or a backtick used
 *    as an escape inside a word (`R`e`move-Item`). Those ask for approval.
 */

/** Binaries whose normal use removes or overwrites data. Compared lowercased and path-stripped. */
export const DESTRUCTIVE_COMMANDS = [
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "format",
  "remove-item",
  "clear-content",
  "truncate",
  "drop",
  "shred",
  "unlink",
  "sdelete",
  "mkfs",
] as const

const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_COMMANDS)

/** Interpreters that run a command string. They are only dangerous when they carry code. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd", "iex", "invoke-expression"])

/** Flags whose next token is the script the interpreter runs. */
const INLINE_FLAGS = new Set(["-c", "-command", "/c", "/k"])

/** Targets where an overwriting redirection destroys nothing. */
const NULL_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"])

/** Whether a command deletes or overwrites data and therefore needs an explicit approval. */
export function isDestructiveCommand(command: string): boolean {
  const text = command.trim()
  if (!text) return false
  return inspect(text)
}

function inspect(text: string): boolean {
  const substitution = extractSubstitutions(text)
  if (substitution.uncertain) return true
  if (substitution.found.some(inspect)) return true

  const split = splitSegments(substitution.rest)
  if (split.uncertain) return true

  return split.parts.some((part, index) => {
    const lexed = tokenize(part.text)
    if (lexed.uncertain) return true
    if (lexed.overwrite) return true
    const piped = index > 0 && split.parts[index - 1]?.after === "|"
    return isDestructiveSegment(lexed.tokens, piped)
  })
}

function isDestructiveSegment(tokens: readonly string[], piped: boolean): boolean {
  const name = normalize(tokens[0] ?? "")
  if (DESTRUCTIVE.has(name)) return true
  if (SHELLS.has(name)) {
    // A shell fed from a pipe runs whatever the previous stage produced.
    if (piped) return true
    const script = inlineScript(tokens)
    if (script === undefined) return false
    if (script === null) return true
    return inspect(script)
  }
  return tokens.slice(1).some((token) => DESTRUCTIVE.has(normalize(token)))
}

/** The inline script of an interpreter, `undefined` when there is no flag, `null` when the flag has no value. */
function inlineScript(tokens: readonly string[]): string | undefined | null {
  const index = tokens.findIndex((token, position) => position > 0 && INLINE_FLAGS.has(token.toLowerCase()))
  if (index === -1) return undefined
  return tokens[index + 1] ?? null
}

function normalize(token: string): string {
  return token
    .replace(/^.*[\\/]/, "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, "")
}

interface Piece {
  readonly text: string
  /** Operator that closed this piece, or `null` for the last one. */
  readonly after: string | null
}

/** Splits on the shell operators, ignoring the ones inside quotes. */
function splitSegments(text: string): { parts: Piece[]; uncertain: boolean } {
  const parts: Piece[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let i = 0

  const push = (after: string | null) => {
    parts.push({ text: current, after })
    current = ""
  }

  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i++
      continue
    }
    if (ch === "&" && current.endsWith(">")) {
      // `2>&1` duplicates a stream, it is not a separator.
      current += ch
      i++
      continue
    }
    if (ch === ";") {
      push(";")
      i++
      continue
    }
    if (ch === "\n" || ch === "\r") {
      push(";")
      i++
      continue
    }
    if (ch === "&") {
      const double = text[i + 1] === "&"
      push(double ? "&&" : "&")
      i += double ? 2 : 1
      continue
    }
    if (ch === "|") {
      const double = text[i + 1] === "|"
      push(double ? "||" : "|")
      i += double ? 2 : 1
      continue
    }
    if (ch === "(" || ch === ")") {
      // Subshells, command groups and PowerShell subexpressions start a new command.
      push(ch)
      i++
      continue
    }
    current += ch
    i++
  }

  if (quote) return { parts: [], uncertain: true }
  push(null)
  return { parts, uncertain: false }
}

interface Lexed {
  readonly tokens: string[]
  /** An overwriting redirection to something other than a null device. */
  readonly overwrite: boolean
  readonly uncertain: boolean
}

/** Tokens of one segment, with quotes removed and redirections interpreted. */
function tokenize(text: string): Lexed {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: '"' | "'" | null = null
  let overwrite = false
  let i = 0

  const flush = () => {
    if (!started) return
    tokens.push(current)
    current = ""
    started = false
  }

  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      i++
      continue
    }
    if (ch === ">") {
      const append = text[i + 1] === ">"
      const target = readWord(text, i + (append ? 2 : 1))
      const duplicate = target.text.startsWith("&")
      if (!append && !duplicate && target.text !== "" && !NULL_DEVICES.has(target.text.toLowerCase())) {
        overwrite = true
      }
      i = target.end
      continue
    }
    if (ch === "<") {
      // Reading a file writes nothing.
      i = readWord(text, i + 1).end
      continue
    }
    if (/\s/.test(ch ?? "")) {
      flush()
      i++
      continue
    }
    current += ch
    started = true
    i++
  }

  const uncertain = quote !== null
  flush()
  return { tokens, overwrite, uncertain }
}

function readWord(text: string, from: number): { text: string; end: number } {
  let i = from
  while (i < text.length && /\s/.test(text[i] ?? "")) i++
  let word = ""
  let quote: '"' | "'" | null = null
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i++
      continue
    }
    if (/\s/.test(ch ?? "")) break
    word += ch
    i++
  }
  return { text: word, end: i }
}

interface Substitution {
  readonly found: string[]
  readonly rest: string
  readonly uncertain: boolean
}

/**
 * Pulls out the payload of `$(...)` and backtick substitutions so it can be analyzed on its own.
 * A substitution that does not close, or a backtick glued to a word, is uncertain: it may hide
 * anything.
 */
function extractSubstitutions(text: string): Substitution {
  const found: string[] = []
  let rest = ""
  let single = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (single) {
      rest += ch
      if (ch === "'") single = false
      i++
      continue
    }
    if (ch === "'") {
      single = true
      rest += ch
      i++
      continue
    }
    if (ch === "$" && text[i + 1] === "(") {
      const match = matchParenthesis(text, i + 2)
      if (!match) return { found, rest, uncertain: true }
      found.push(match.content)
      rest += " "
      i = match.end
      continue
    }
    if (ch === "`") {
      const end = findBacktick(text, i + 1)
      if (end === -1) return { found, rest, uncertain: true }
      if (!isBoundary(text[i - 1]) || !isBoundary(text[end + 1])) {
        // ``R`e`move-Item``: the backtick escapes a character instead of starting a substitution.
        return { found, rest, uncertain: true }
      }
      found.push(text.slice(i + 1, end))
      rest += " "
      i = end + 1
      continue
    }
    rest += ch
    i++
  }

  return { found, rest, uncertain: false }
}

function matchParenthesis(text: string, from: number): { content: string; end: number } | null {
  let depth = 1
  let quote: '"' | "'" | null = null
  let content = ""
  let i = from

  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      content += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      content += ch
      i++
      continue
    }
    if (ch === "(") {
      depth++
      content += ch
      i++
      continue
    }
    if (ch === ")") {
      depth--
      if (depth === 0) return { content, end: i + 1 }
      content += ch
      i++
      continue
    }
    content += ch
    i++
  }

  return null
}

function findBacktick(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === "`" && text[i - 1] !== "\\") return i
    i++
  }
  return -1
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /[\s;&|()]/.test(ch)
}
