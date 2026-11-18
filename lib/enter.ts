/**
 * How a line is submitted to a PTY.
 *
 * A PTY is not a file: it carries a terminal line discipline. On Windows, ConPTY has no LF→CR
 * translation, so a bare `\n` is "insert a line in the PSReadLine buffer" (the `>>` continuation
 * prompt), not "execute". A carriage return is what submits. POSIX shells expect `\n`.
 *
 * One helper, so the decision never gets re-derived in two places that can disagree.
 */

export interface LineEndingOptions {
  /** Platform whose line discipline applies. Defaults to the one running this process. */
  readonly platform?: NodeJS.Platform
}

/** The byte that makes the shell accept the line. */
export function submitSuffix(options: LineEndingOptions = {}): string {
  return (options.platform ?? process.platform) === "win32" ? "\r" : "\n"
}

/**
 * Terminates `input` for submission, replacing any trailing newline run.
 *
 * Idempotent on purpose: callers may hand over `echo hi`, `echo hi\n` or `echo hi\r\n`, and the
 * result is the same single terminator for the session's platform. Line breaks *inside* the
 * input are preserved, because "\r" in the middle of a paste is a deliberate submission.
 */
export function terminate(input: string, options: LineEndingOptions = {}): string {
  return `${input.replace(/[\r\n]+$/, "")}${submitSuffix(options)}`
}
