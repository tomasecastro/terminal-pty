import { statSync } from "node:fs"
import { basename, delimiter, extname, isAbsolute, join } from "node:path"
import type { PtyConnector, PtyProcess, PtySpawner, PtyTarget, LocalShellTarget } from "./types"

/**
 * Local shell engine.
 *
 * Instead of borrowing a terminal from the host, the plugin spawns its own shell inside a PTY
 * and owns both ends of it: reading is a buffer snapshot, writing is a PTY write. That makes
 * `write` independent of what the OpenCode build exposes to plugins.
 *
 * The shell runs with the user's privileges and environment. Nothing here is sandboxed: the
 * isolation guarantee is the permission gate in `lib/access.ts`, not the process boundary.
 */

export interface ShellSpec {
  readonly file: string
  readonly args: readonly string[]
}

/** Returns true when `file` exists. Injectable so shell selection is testable. */
export type PathLookup = (file: string) => boolean

export interface ShellResolveOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exists?: PathLookup
}

/** Windows shells in preference order. `-NoLogo` keeps the banner out of the buffer. */
const WINDOWS_SHELLS: readonly ShellSpec[] = [
  { file: "pwsh.exe", args: ["-NoLogo"] },
  { file: "powershell.exe", args: ["-NoLogo"] },
]

const DEFAULT_WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD" as const

/**
 * Picks the shell to spawn for the current platform.
 *
 * - Windows: `pwsh.exe`, then `powershell.exe`, then `%COMSPEC%` (or `cmd.exe` from PATH).
 * - POSIX: `$SHELL` when it exists, then `/bin/bash`, then `/bin/sh`, always as a login shell.
 *
 * Every candidate is checked for existence before it is chosen.
 */
export function defaultShell(options: ShellResolveOptions = {}): ShellSpec {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? defaultExists

  if (platform === "win32") {
    for (const candidate of WINDOWS_SHELLS) {
      const resolved = resolveOnPath(candidate.file, { env, exists, platform })
      if (resolved) return { file: resolved, args: candidate.args }
    }
    const comspec = env.COMSPEC ?? env.ComSpec
    if (comspec && exists(comspec)) return { file: comspec, args: [] }
    const fromPath = resolveOnPath("cmd.exe", { env, exists, platform })
    return { file: fromPath ?? comspec ?? "cmd.exe", args: [] }
  }

  const configured = env.SHELL
  if (configured && exists(configured)) return { file: configured, args: ["-l"] }
  if (exists("/bin/bash")) return { file: "/bin/bash", args: ["-l"] }
  return { file: "/bin/sh", args: ["-l"] }
}

/**
 * Resolves a command against `PATH` without shelling out to `which`/`where`.
 *
 * On Windows extensionless commands also try `PATHEXT`, in lower case, which every Windows
 * filesystem resolves case-insensitively.
 */
export function resolveOnPath(command: string, options: ShellResolveOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? defaultExists

  if (isAbsolute(command)) return exists(command) ? command : null

  const rawPath = env.PATH ?? env.Path ?? ""
  const directories = rawPath
    .split(platform === "win32" ? ";" : delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const extensions =
    platform === "win32" && extname(command).length === 0
      ? (env.PATHEXT ?? DEFAULT_WINDOWS_EXTENSIONS)
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter((extension) => extension.length > 0)
      : [""]

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (exists(candidate)) return candidate
    }
  }

  return null
}

/** Working directory a local shell starts in when the target does not set one. */
export function defaultCwd(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? process.cwd()
}

/**
 * Powershell binaries, which paint history suggestions into the PTY.
 *
 * PSReadLine's inline predictive IntelliSense renders the *previous command from the shared
 * history file* next to the prompt, in dim italic, as soon as the first character arrives. In an
 * AI-driven terminal that is noise at best and a privacy leak at worst: the suggestion can be a
 * command another session ran, including whatever it typed. It also leaves `>>` continuation
 * markers in the buffer. Only this shell gets the setting; the user's own shells keep their
 * preferences.
 */
const POWERSHELL_BINARY = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i

const QUIET_POWERSHELL_STARTUP = "try { Set-PSReadLineOption -PredictionSource None } catch { }"

/** True when the binary is `pwsh` or `powershell` (any path, optional `.exe`). */
export function isPowerShell(file: string): boolean {
  return POWERSHELL_BINARY.test(file)
}

/**
 * Startup arguments that keep a PowerShell shell readable.
 *
 * `-NoExit` keeps the shell interactive, and `-Command` runs after the profile so the setting
 * wins for this PTY only. Non-PowerShell shells, and callers that brought their own `-Command`,
 * are left untouched.
 */
export function quietStartupArgs(file: string, args: readonly string[]): readonly string[] {
  if (!isPowerShell(file)) return args
  if (args.includes("-Command") || args.includes("-c")) return args
  return [...args, "-NoExit", "-Command", QUIET_POWERSHELL_STARTUP]
}

/** Environment variable that `TERM` is set to, so full-screen programs render correctly. */
const TERMINAL_NAME = "xterm-256color"

export interface LocalShellConnectorOptions extends ShellResolveOptions {
  /** Fixed shell. When omitted it is resolved once, on first use, from the platform. */
  readonly shell?: ShellSpec
  /** Overrides the `TERM` name advertised to the shell. */
  readonly terminalName?: string
  /** Adds the PowerShell quiet startup. Defaults to true. */
  readonly quiet?: boolean
}

/**
 * Spawns a local shell inside a PTY.
 *
 * Mirrors `SSHConnector`: the connector decides the program and its arguments, the manager
 * never learns how the PTY was created.
 */
export class LocalShellConnector implements PtyConnector {
  readonly #spawner: PtySpawner
  readonly #options: LocalShellConnectorOptions
  #resolved: ShellSpec | undefined

  constructor(spawner: PtySpawner, options: LocalShellConnectorOptions = {}) {
    this.#spawner = spawner
    this.#options = options
    if (options.shell) this.#resolved = options.shell
  }

  /** Shell used by targets that do not name one. Resolved once and cached. */
  get shell(): ShellSpec {
    this.#resolved ??= defaultShell(this.#options)
    return this.#resolved
  }

  connect(target: PtyTarget): PtyProcess {
    if (target.kind !== "local") {
      throw new Error("LocalShellConnector can only connect to local targets")
    }

    const local: LocalShellTarget = target
    const base = this.shell
    const file = local.shell ?? base.file
    const args = local.args ?? (this.#options.quiet === false ? base.args : quietStartupArgs(file, base.args))

    return this.#spawner.spawn({
      file,
      args,
      cwd: this.cwdFor(local),
      cols: local.cols,
      rows: local.rows,
      env: local.env,
      name: this.#options.terminalName ?? TERMINAL_NAME,
    })
  }

  /**
   * Working directory this connector will spawn in. Single source of truth, so callers do not
   * have to re-derive the same default and drift from it.
   */
  cwdFor(target: Pick<LocalShellTarget, "cwd"> = {}): string {
    return target.cwd ?? defaultCwd(this.#options.env ?? process.env)
  }
}

/** File name of a shell, for display (`pwsh.exe`, `bash`). */
export function shellName(file: string): string {
  return basename(file)
}

function defaultExists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}
