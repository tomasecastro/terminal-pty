import { randomUUID } from "node:crypto"
import { readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccessGate, readRejection, writeRejection } from "./access"
import { isDestructiveCommand } from "./destructive-commands"
import { terminate } from "./enter"
import { WITHHELD, type TerminalView } from "./terminal-view"

/**
 * Guards for reading and for running commands, independent of `effect` and of the host.
 *
 * Every path fails closed: any missing piece (access disabled, no grant, no terminal,
 * blinding, no approval, revoked during approval, no write channel) ends with nothing done.
 *
 * Approval policy:
 *  - `full` grant + non-destructive command → no per-command approval, one session grant covers it.
 *  - `full` grant + destructive command → `terminal_pty.execute`, every time.
 *  - any other grant → `terminal_pty.execute` unless the command is allowlisted.
 */

/** How long to wait for the shell to answer a command, and how often to look at the screen. */
const OUTPUT_TIMEOUT_MS = 5_000
const OUTPUT_POLL_MS = 50

/** Ceiling for what `execute_command` hands back, so a runaway capture never floods the context. */
const MAX_OUTPUT_CHARS = 20_000

export interface ReadDeps {
  readonly gate: AccessGate
  readonly observe: (sessionID: string, text: string) => boolean
}

export type ReadGuard =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** Gate for the read tools. Call before reading anything. */
export function allowRead(gate: AccessGate, sessionID: string): ReadGuard {
  if (!gate.policy.enabled) {
    return { ok: false, message: readRejection(gate.policy, gate.status(sessionID)) }
  }
  if (!gate.canRead(sessionID)) {
    return { ok: false, message: readRejection(gate.policy, gate.status(sessionID)) }
  }
  return { ok: true }
}

export interface ExecutionDeps {
  readonly gate: AccessGate
  readonly read: (sessionID: string, lines?: number) => Promise<TerminalView | null>
  readonly write?: (ptyID: string, data: string) => Promise<void>
  readonly assert?: (input: {
    sessionID: string
    action: string
    resources: readonly string[]
    save?: readonly string[]
    metadata?: Record<string, unknown>
  }) => Promise<void>
  readonly observe: (sessionID: string, text: string) => boolean
  /**
   * Line discipline of the target shell. Defaults to the current platform; pass `"linux"` to
   * simulate a POSIX shell from a Windows test. The PTY write path re-normalizes the terminator
   * per session, so this only decides the bytes handed to `write`.
   */
  readonly platform?: NodeJS.Platform
  /**
   * How long to wait for the shell to print the command's result before returning whatever is on
   * screen. Defaults to 5 s; tests shrink it, and `0` reads the screen once without waiting.
   */
  readonly outputTimeoutMs?: number
  /**
   * Reads the capture file the command's output was redirected to. Defaults to `node:fs/promises`;
   * tests replace it to answer without touching the disk. When it fails, the screen is the fallback.
   */
  readonly readFile?: (path: string) => Promise<string>
  /** Deletes the capture file. Defaults to `node:fs/promises`. */
  readonly unlink?: (path: string) => Promise<void>
  /** Where the capture file lives. Defaults to `node:os`. */
  readonly tmpdir?: () => string
}

export interface ExecutionResult {
  readonly executed: boolean
  readonly command: string
  readonly reason?:
    | "empty"
    | "disabled"
    | "no-grant"
    | "no-terminal"
    | "blinded"
    | "no-approval-channel"
    | "no-write-channel"
    | "rejected"
    | "write-failed"
  readonly message: string
  readonly output?: string
}

export async function runCommand(
  deps: ExecutionDeps,
  sessionID: string,
  rawCommand: string,
  explanation = "",
): Promise<ExecutionResult> {
  const command = rawCommand.trim()
  if (!command) return { executed: false, command, reason: "empty", message: "Empty command." }

  const { gate } = deps
  if (!gate.policy.enabled) {
    return {
      executed: false,
      command,
      reason: "disabled",
      message: writeRejection(gate.policy, gate.status(sessionID)),
    }
  }

  if (!gate.canWrite(sessionID)) {
    return {
      executed: false,
      command,
      reason: "no-grant",
      message: writeRejection(gate.policy, gate.status(sessionID)),
    }
  }

  if (!deps.write) {
    return {
      executed: false,
      command,
      reason: "no-write-channel",
      message: "Writing to the terminal is not available in this host.",
    }
  }

  const before = await deps.read(sessionID, 40)
  if (!before) {
    return { executed: false, command, reason: "no-terminal", message: "No terminal is attached to this session." }
  }

  if (deps.observe(sessionID, before.text)) {
    return {
      executed: false,
      command,
      reason: "blinded",
      message: "A credential prompt is on screen. Execution is blocked until it clears.",
    }
  }

  const full = gate.canExecute(sessionID)
  const unsupervised = full && !isDestructiveCommand(command)
  if (!gate.autoApproved(command) && !unsupervised) {
    if (!deps.assert) {
      return {
        executed: false,
        command,
        reason: "no-approval-channel",
        message: "The host cannot prompt the human, so the command cannot be approved.",
      }
    }
    try {
      await deps.assert({
        sessionID,
        action: "terminal_pty.execute",
        // The command stays first: it is what the person approves. The sentence after it is the only
        // readable line a plugin can add to that dialog (FR-006).
        resources: [command, "Run this command in the session's terminal"],
        // No `save`: a destructive command must not offer "Always allow" nor persist a rule for
        // `terminal_pty.execute`, otherwise the next destructive command would run unattended and
        // the destructive exception would stop asking (FR-003). Every destructive command is asked
        // again, one by one.
        metadata: { explanation },
      })
    } catch {
      return { executed: false, command, reason: "rejected", message: "The human rejected the command." }
    }
  }

  // Re-check right before writing: the grant may have been revoked while the human decided.
  if (!gate.canWrite(sessionID)) {
    return { executed: false, command, reason: "no-grant", message: "Execution permission was revoked." }
  }

  const marker = `__OC_DONE_${randomUUID()}__`
  const capturePath = join((deps.tmpdir ?? tmpdir)(), `oc-pty-${randomUUID()}.txt`)
  try {
    // Three separate command lines: the command with its output redirected to the capture file, the
    // `Get-Content`/`cat` that keeps the output visible to the human in the shared terminal, and the
    // marker. Gluing them with `;` put the marker inside the shell's echo of the line, so the screen
    // showed one before the command had run and the capture mistook it for the result (T024).
    const ending = { platform: deps.platform }
    await deps.write(
      before.ptyID,
      captureLines(command, capturePath, marker, deps.platform)
        .map((line) => terminate(line, ending))
        .join(""),
    )
  } catch {
    // Nothing reached the shell, so the redirect never ran; the cleanup still runs in case the
    // shell created the file before the write failed.
    await removeCapture(deps, capturePath)
    return { executed: false, command, reason: "write-failed", message: "The terminal rejected the input." }
  }

  try {
    const after = await waitForSentinel(deps, sessionID, marker)

    // A credential prompt withholds the result whatever the capture holds.
    if (after && deps.observe(sessionID, after.text)) {
      return { executed: true, command, message: "Command sent to the terminal.", output: WITHHELD }
    }

    // The file is the ground truth (T025). The screen carries the echo, the PSReadLine repaint and
    // the prompt, and telling them apart is a heuristic that loses lines in a burst of commands. The
    // marker only says when to stop waiting: a command that outlives the timeout still wrote its
    // file, and its content wins over the screen.
    const captured = await readCapture(deps, capturePath)
    if (captured !== null) {
      return {
        executed: true,
        command,
        message: "Command sent to the terminal.",
        output: clip(capturedOutput(captured)),
      }
    }

    if (!after) {
      return { executed: true, command, message: "Command sent to the terminal.", output: WITHHELD }
    }

    // Only when the file cannot be read: the assistant reads the command's own output out of the
    // paint traffic, best effort.
    const output =
      extractOutput(after.text, command, marker) ??
      isolateOutput(before.text, after.text, command, marker) ??
      after.text
    return { executed: true, command, message: "Command sent to the terminal.", output: clip(output) }
  } finally {
    // Never leave a capture behind, on success or on error.
    await removeCapture(deps, capturePath)
  }
}

/**
 * The lines `runCommand` submits: the command with its output redirected to `path`, a `Get-Content`
 * / `cat` that keeps it visible to the human, and the marker that ends the wait.
 *
 * The path is single-quoted so a temp directory with spaces still works, and the marker is a
 * single-quoted literal so PowerShell prints it verbatim instead of interpreting it.
 */
function captureLines(command: string, path: string, marker: string, platform: NodeJS.Platform | undefined): string[] {
  const quoted = `'${path}'`
  if ((platform ?? process.platform) === "win32") {
    return [`${command} *> ${quoted}`, `Get-Content -LiteralPath ${quoted}`, `Write-Output '${marker}'`]
  }
  return [`${command} > ${quoted} 2>&1`, `cat ${quoted}`, `echo '${marker}'`]
}

/** The capture file's text, or `null` when it cannot be read (never created, already gone). */
async function readCapture(deps: ExecutionDeps, path: string): Promise<string | null> {
  try {
    return await (deps.readFile ?? readCaptureFile)(path)
  } catch {
    return null
  }
}

/**
 * Reads the capture as text, honouring the BOM.
 *
 * A PowerShell 5.1 shell writes `*>` as UTF-16LE, so decoding those bytes as UTF-8 yields NULs
 * between every character. PowerShell 7 and POSIX shells write UTF-8.
 */
async function readCaptureFile(path: string): Promise<string> {
  const bytes = await readFile(path)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le")
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8")
  return bytes.toString("utf8")
}

/** Deletes the capture file, ignoring "already gone": cleanup is not a result. */
async function removeCapture(deps: ExecutionDeps, path: string): Promise<void> {
  try {
    await (deps.unlink ?? unlink)(path)
  } catch {
    // Never created, or removed with its shell: there is nothing to clean.
  }
}

/** The capture as the model should read it: LF endings, no trailing blank lines. */
function capturedOutput(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\n+$/, "")
}

/** Caps the output so a runaway capture never floods the model's context. */
function clip(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  return `${output.slice(0, MAX_OUTPUT_CHARS)}… (truncado)`
}

/**
 * Reads until the shell has printed the sentinel, not merely until it has accepted the input.
 *
 * `write` resolves as soon as the bytes reach the PTY, but the shell runs the command afterwards.
 * A command that never prints a sentinel (a long-running process) keeps its partial output at the
 * timeout.
 */
async function waitForSentinel(
  deps: ExecutionDeps,
  sessionID: string,
  marker: string,
): Promise<TerminalView | null> {
  const deadline = Date.now() + (deps.outputTimeoutMs ?? OUTPUT_TIMEOUT_MS)
  for (;;) {
    const view = await deps.read(sessionID, 200)
    if (!view) return null
    if (sentinelPrinted(view.text, marker)) return view
    if (Date.now() >= deadline) return view
    await new Promise<void>((resolve) => setTimeout(resolve, OUTPUT_POLL_MS))
  }
}

/**
 * Whether the shell has printed `marker` after the echo of the command that prints it (T024).
 *
 * The marker command is its own line, so the screen always carries its echo first
 * (`PS C:\> Write-Output '__OC_DONE_x__'`, marker inside quotes) and the print afterwards
 * (`__OC_DONE_x__`, alone or glued to the prompt). One occurrence is only the echo, and waiting on
 * it ended the wait before the command had run. So the sentinel counts when:
 *
 *  - it appears at least twice and the last one is not quoted (the echo, then the print), or
 *  - it appears once, alone, with a prompt right after it: the screen scrolled the echo away.
 *
 * A PSReadLine repaint can echo the marker command twice, both quoted, so "two occurrences" alone
 * is not enough: the last one has to be unquoted.
 */
function sentinelPrinted(text: string, marker: string): boolean {
  const first = text.indexOf(marker)
  if (first === -1) return false
  const last = text.lastIndexOf(marker)
  // The echo quotes the marker; a repainted echo does too.
  if (last > first && !echoed(text, last, marker)) return true
  return promptFollows(text.slice(last + marker.length))
}

/**
 * Whether the occurrence of `marker` at `index` sits inside the quotes of the command that prints
 * it, which makes it the echo and not the print.
 */
function echoed(text: string, index: number, marker: string): boolean {
  const quote = text[index + marker.length]
  return quote === '"' || quote === "'"
}

/** Whether `rest` (what follows the marker) opens with a shell prompt. */
function promptFollows(rest: string): boolean {
  const tail = rest.replace(/^\s+/, "")
  if (tail.startsWith("PS ")) return tail.includes(">")
  return /^[^\s]*[$#>]/.test(tail)
}

/**
 * The text before the printed sentinel, without the echoes and without a prompt.
 *
 * The last occurrence is the print; anything before it is the command, its echo and its output.
 * Two lines have to go: the echo (or repaint) of the command under test, and the echo of the
 * marker command (`PS C:\> Write-Output "__OC_DONE_x__"`), which sits before the print in the
 * buffer and carries the marker inside its quotes. Everything after the print (the prompt glued to
 * it or not) belongs to the next interaction and is sliced off.
 *
 * @returns The command output, an empty string when it printed nothing, or `null` when the
 * sentinel never reached the screen and the caller must fall back to what it can isolate.
 */
function extractOutput(text: string, command: string, marker: string): string | null {
  const index = text.lastIndexOf(marker)
  if (index === -1) return null
  // A marker still inside the quotes of its own command line is the echo, not the print: the
  // command has not answered yet and the caller must wait or fall back.
  if (echoed(text, index, marker)) return null

  const lines = text.slice(0, index).split("\n")

  // PSReadLine repaints the line as it is typed, so the echo can arrive as `Get-LocatiGet-Location`.
  // The command is still part of that line, so containment finds it. Anything before it belongs to
  // the previous prompt and goes with it.
  const echo = lines.findIndex((line) => line.includes(command))
  if (echo !== -1) lines.splice(0, echo + 1)

  // The echo of the marker command is the last line before the print that still carries the marker.
  // It can share its line with the last output line when the cursor was still there
  // (`C:\buildPS C:\> Write-Output "__OC_DONE_x__"`), so only the echo part is removed.
  const sentinelEcho = lines.findLastIndex((line) => line.includes(marker))
  if (sentinelEcho !== -1) {
    const kept = stripSentinelEcho(lines[sentinelEcho] ?? "", marker)
    if (kept === "") lines.splice(sentinelEcho, 1)
    else lines[sentinelEcho] = kept
  }

  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift()
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop()
  return lines.join("\n")
}

/**
 * What a line keeps once the echo of the marker command is cut out of it.
 *
 * PowerShell paints that echo where the cursor is, which can be the end of the last output line:
 * `C:\buildPS C:\> Write-Output "__OC_DONE_x__"`. The prompt that the echo brought belongs to the
 * shell; what the command printed on that line stays.
 */
function stripSentinelEcho(line: string, marker: string): string {
  const at = line.indexOf(marker)
  if (at === -1) return line
  const head = line.slice(0, at)
  const cuts = ["PS ", "Write-Output", "echo "]
    .map((token) => head.lastIndexOf(token))
    .filter((index) => index !== -1)
  const kept = (cuts.length > 0 ? head.slice(0, Math.min(...cuts)) : head).trimEnd()
  // A prompt with nothing before it is not output.
  return /^(?:PS [^>]*>|[^\s]*[$#>])$/.test(kept) ? "" : kept
}

/**
 * The text `after` holds beyond `before`, without the echoed command and the new prompt.
 *
 * `after` is the whole visible buffer, so it also carries the previous screen, the echo of the
 * command and the prompt that follows its output. Only what was appended to `before` can belong to
 * the command; when `after` does not extend `before` (the screen scrolled or was cleared) there is
 * nothing to separate, and the caller keeps the whole rendered text instead.
 *
 * @returns The command output, an empty string when it printed nothing, or `null` to fall back.
 */
function isolateOutput(before: string, after: string, command: string, marker: string): string | null {
  if (after === before || !after.startsWith(before)) return null

  const lines = after.slice(before.length).split("\n")

  // PSReadLine repaints the line as it is typed, so the echo can arrive as `Get-LocatiGet-Location`.
  // The command is still part of that line, so containment finds it even when the repaint glued two
  // copies together. Blank lines before it belong to the prompt line and go with it.
  const echo = lines.findIndex((line) => line.trim().length > 0)
  if (echo !== -1 && lines[echo]?.includes(command)) lines.splice(0, echo + 1)

  // The echo of the marker command is not output: in this path the marker never printed, but its
  // command line already reached the screen, sometimes glued to the last output line.
  const sentinelEcho = lines.findIndex((line) => line.includes(marker))
  if (sentinelEcho !== -1) {
    const kept = stripSentinelEcho(lines[sentinelEcho] ?? "", marker)
    if (kept === "") lines.splice(sentinelEcho, 1)
    else lines[sentinelEcho] = kept
  }

  // The prompt that follows the result belongs to the next interaction. It can share the last line
  // with real output (`C:\buildPS C:\>`), so that line is trimmed instead of dropped.
  const last = lines.length - 1
  if (last >= 0) lines[last] = stripPrompt(lines[last] ?? "")

  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift()
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop()
  return lines.join("\n")
}

/** Removes a prompt that ends `line`, keeping whatever output shares that line. */
function stripPrompt(line: string): string {
  const powerShell = line.replace(/\s*PS [^>]*>\s*$/, "")
  if (powerShell !== line) return powerShell.trimEnd()
  return line.replace(/\s*[^\s]*[$#>]\s*$/, "").trimEnd()
}
