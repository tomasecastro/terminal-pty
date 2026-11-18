import { detectErrors, shouldProposeAnalysis } from "./ai/error-detector"
import { CredentialDetector } from "./credential-detector"
import { renderScreenText } from "./screen"
import type { SessionInfo } from "./session-manager"
import type { TerminalEngine } from "./types"

/**
 * Pure logic behind the read tools: what the assistant is allowed to see.
 *
 * Kept free of `effect` and `@opencode/*` so it can be tested anywhere, while the plugin
 * adapter in `src/tools.ts` only wraps these functions in tool metadata.
 */

export const WITHHELD = "[credential prompt active — output withheld from AI]"

export interface TerminalView {
  readonly ptyID: string
  readonly title: string
  /** `null` when the terminal does not report one (SSH sessions, host terminals). */
  readonly cwd: string | null
  readonly foregroundProcess: string | null
  readonly text: string
}

/** Blinding is per terminal, so each session keeps its own detector. */
export function createSessionDetectors() {
  const detectors = new Map<string, CredentialDetector>()
  return {
    observe(sessionID: string, text: string): boolean {
      const existing = detectors.get(sessionID) ?? new CredentialDetector()
      detectors.set(sessionID, existing)
      existing.observe(text)
      return existing.blinded
    },
    forget(sessionID: string) {
      detectors.delete(sessionID)
    },
  }
}

export function describeMissingTerminal() {
  return "No terminal is attached to this session. Open a terminal in the TUI or call terminal_open."
}

/**
 * Maps the plugin's own PTY session onto the view the read tools already know.
 *
 * `ptyID` is the session id, so the same identifier flows through read, info and write.
 * Unknown fields stay `null` instead of being invented.
 */
export function viewFromSession(
  info: SessionInfo,
  snapshot: { readonly text: string; readonly fullScreenApp?: string | null },
): TerminalView {
  return {
    ptyID: info.id,
    title: titleFor(info),
    cwd: info.cwd ?? null,
    // A full-screen app on the screen is, by definition, what owns the foreground.
    foregroundProcess: snapshot.fullScreenApp ?? info.foregroundProcess ?? null,
    // The assistant reads what the screen shows, never the repaint bytes: PSReadLine rewrites the
    // current line with cursor moves, so the raw tail must be replayed instead of stripped.
    // `renderScreenText` is idempotent, which keeps an already rendered snapshot untouched.
    text: renderScreenText(snapshot.text),
  }
}

function titleFor(info: SessionInfo): string {
  if (info.target.kind === "local") return `${info.shell ?? "shell"} (local)`
  return `${info.target.user}@${info.target.host}`
}

/** The title a terminal shows, for callers outside the read tools (the visible panel). */
export const sessionTitle = titleFor

export function formatRead(view: TerminalView) {
  const findings = detectErrors(view.text)
  return {
    content: JSON.stringify(
      {
        ptyID: view.ptyID,
        title: view.title,
        cwd: view.cwd,
        foregroundProcess: view.foregroundProcess,
        text: view.text,
        errors: findings,
      },
      null,
      2,
    ),
    metadata: {
      blinded: false,
      suggestAnalysis: shouldProposeAnalysis(findings),
      foregroundProcess: view.foregroundProcess,
    },
  }
}

export function formatWithheld(ptyID?: string) {
  return { content: WITHHELD, metadata: { blinded: true, ...(ptyID ? { ptyID } : {}) } }
}

export function formatInfo(view: TerminalView, blinded: boolean, engine?: TerminalEngine) {
  return {
    content: JSON.stringify(
      {
        ptyID: view.ptyID,
        title: view.title,
        cwd: view.cwd,
        foregroundProcess: view.foregroundProcess,
        blinded,
        ...(engine ? { engine } : {}),
      },
      null,
      2,
    ),
    metadata: { blinded, ...(engine ? { engine } : {}) },
  }
}

export function formatWait(matched: boolean, blinded: boolean, text: string) {
  return {
    content: JSON.stringify({ matched, blinded, text }, null, 2),
    metadata: { matched, blinded },
  }
}
