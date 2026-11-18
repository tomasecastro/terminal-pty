import { ALT_SCREEN_OFF, ALT_SCREEN_ON, OSC_TITLE } from "./ansi"

/**
 * Detects full-screen TUI applications (vim, htop, lazygit, less, tmux status) by watching
 * the alternate screen buffer and the OSC title sequence.
 *
 * While a TUI owns the screen, injecting AI commands is unsafe: they would be interpreted
 * as keystrokes by the TUI. The session manager pauses injection and surfaces a notice.
 */

export interface TuiState {
  readonly fullScreen: boolean
  readonly app: string | null
}

const TITLE_APPS: ReadonlyArray<{ app: string; pattern: RegExp }> = [
  { app: "vim", pattern: /^\s*(?:vim?|nvim|vi)\b/i },
  { app: "nano", pattern: /^\s*nano\b/i },
  { app: "htop", pattern: /^\s*htop\b/i },
  { app: "top", pattern: /^\s*top\b/i },
  { app: "lazygit", pattern: /^\s*lazygit\b/i },
  { app: "lazydocker", pattern: /^\s*lazydocker\b/i },
  { app: "less", pattern: /^\s*less\b/i },
  { app: "man", pattern: /^\s*man\b/i },
  { app: "tmux", pattern: /^\s*tmux\b/i },
  { app: "screen", pattern: /^\s*screen\b/i },
  { app: "k9s", pattern: /^\s*k9s\b/i },
]

export class TuiDetector {
  #fullScreen = false
  #app: string | null = null

  inspect(chunk: string): TuiState {
    if (ALT_SCREEN_ON.test(chunk)) this.#fullScreen = true
    if (ALT_SCREEN_OFF.test(chunk)) {
      this.#fullScreen = false
      this.#app = null
    }

    const title = OSC_TITLE.exec(chunk)
    if (title?.[1]) this.#app = matchApp(title[1]) ?? this.#app

    return this.state
  }

  get state(): TuiState {
    return { fullScreen: this.#fullScreen, app: this.#app }
  }

  get fullScreen(): boolean {
    return this.#fullScreen
  }

  get app(): string | null {
    return this.#app
  }

  reset(): void {
    this.#fullScreen = false
    this.#app = null
  }
}

function matchApp(title: string): string | null {
  const name = title.split(/[—–-]/)[0] ?? title
  for (const entry of TITLE_APPS) {
    if (entry.pattern.test(name)) return entry.app
  }
  return null
}
