import { describe, expect, test } from "bun:test"
import { defaultCwd, defaultShell, LocalShellConnector, resolveOnPath, shellName } from "../lib/local-shell"
import type { SshTarget } from "../lib/types"
import { FakeSpawner } from "./fake-pty"

/**
 * Shell selection is the difference between "the plugin runs commands" and "the plugin opens
 * a shell the user does not expect". These tests pin the choice per platform, and prove that
 * nothing is spawned at random: every candidate must exist first.
 */

const WINDOWS_PATH = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7"

function windowsEnv(extra: Record<string, string | undefined> = {}) {
  return {
    PATH: WINDOWS_PATH,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    ...extra,
  }
}

/** Case-insensitive existence check, like the Windows filesystem. */
function onDisk(files: readonly string[]) {
  const known = new Set(files.map((file) => file.toLowerCase()))
  return (file: string) => known.has(file.toLowerCase())
}

const POWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const LEGACY_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const CMD = "C:\\Windows\\System32\\cmd.exe"

describe("defaultShell", () => {
  test("Windows prefers pwsh.exe when it is on PATH", () => {
    const shell = defaultShell({ platform: "win32", env: windowsEnv(), exists: onDisk([POWSH, CMD]) })

    expect(shell).toEqual({ file: POWSH, args: ["-NoLogo"] })
  })

  test("Windows falls back to powershell.exe when pwsh.exe is absent", () => {
    const shell = defaultShell({
      platform: "win32",
      env: windowsEnv({
        PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      }),
      exists: onDisk([LEGACY_POWERSHELL, CMD]),
    })

    expect(shell).toEqual({ file: LEGACY_POWERSHELL, args: ["-NoLogo"] })
  })

  test("Windows falls back to %COMSPEC% when neither PowerShell is installed", () => {
    const shell = defaultShell({ platform: "win32", env: windowsEnv(), exists: onDisk([CMD]) })

    expect(shell).toEqual({ file: CMD, args: [] })
  })

  test("Windows falls back to cmd.exe from PATH when COMSPEC is unusable", () => {
    const shell = defaultShell({
      platform: "win32",
      env: windowsEnv({ COMSPEC: "D:\\missing\\cmd.exe" }),
      exists: onDisk([CMD]),
    })

    expect(shell).toEqual({ file: CMD, args: [] })
  })

  test("POSIX uses $SHELL as a login shell", () => {
    const shell = defaultShell({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/zsh" },
      exists: onDisk(["/usr/bin/zsh", "/bin/bash"]),
    })

    expect(shell).toEqual({ file: "/usr/bin/zsh", args: ["-l"] })
  })

  test("POSIX ignores a $SHELL that does not exist and uses /bin/bash", () => {
    const shell = defaultShell({
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin", SHELL: "/opt/homebrew/bin/fish" },
      exists: onDisk(["/bin/bash"]),
    })

    expect(shell).toEqual({ file: "/bin/bash", args: ["-l"] })
  })

  test("POSIX falls back to /bin/sh as a last resort", () => {
    const shell = defaultShell({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false })

    expect(shell).toEqual({ file: "/bin/sh", args: ["-l"] })
  })
})

describe("resolveOnPath", () => {
  test("finds a command in a later PATH entry", () => {
    const resolved = resolveOnPath("pwsh.exe", {
      platform: "win32",
      env: windowsEnv(),
      exists: onDisk([POWSH]),
    })

    expect(resolved).toBe(POWSH)
  })

  test("expands PATHEXT for an extensionless command", () => {
    const resolved = resolveOnPath("pwsh", {
      platform: "win32",
      env: windowsEnv(),
      exists: onDisk([POWSH]),
    })

    expect(resolved).toBe(POWSH)
  })

  test("returns null for an absolute path that does not exist", () => {
    const resolved = resolveOnPath("C:\\nope\\pwsh.exe", {
      platform: "win32",
      env: windowsEnv(),
      exists: onDisk([POWSH]),
    })

    expect(resolved).toBeNull()
  })

  test("returns null when nothing matches", () => {
    expect(resolveOnPath("ghost", { platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false })).toBeNull()
  })
})

describe("defaultCwd", () => {
  test("prefers HOME", () => {
    expect(defaultCwd({ HOME: "/home/ana", USERPROFILE: "C:\\Users\\ana" })).toBe("/home/ana")
  })

  test("uses USERPROFILE on Windows", () => {
    expect(defaultCwd({ USERPROFILE: "C:\\Users\\ana" })).toBe("C:\\Users\\ana")
  })

  test("falls back to the process directory", () => {
    expect(defaultCwd({})).toBe(process.cwd())
  })
})

describe("LocalShellConnector", () => {
  const options = {
    platform: "win32" as const,
    env: windowsEnv({ HOME: "C:\\Users\\ana" }),
    exists: onDisk([POWSH, CMD]),
  }

  test("spawns the resolved shell inside a PTY with the default working directory", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, options)

    const process = connector.connect({ kind: "local" })

    expect(process.pid).toBe(4242)
    expect(spawner.lastOptions).toMatchObject({
      file: POWSH,
      cwd: "C:\\Users\\ana",
      name: "xterm-256color",
    })
    expect(spawner.lastOptions.args.slice(0, 1)).toEqual(["-NoLogo"])
  })

  test("keeps PowerShell history predictions out of the buffer", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, options)

    connector.connect({ kind: "local" })

    expect(spawner.lastOptions.args).toEqual([
      "-NoLogo",
      "-NoExit",
      "-Command",
      "try { Set-PSReadLineOption -PredictionSource None } catch { }",
    ])
  })

  test("does not touch the startup of a non-PowerShell shell", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, {
      platform: "win32",
      env: windowsEnv({ COMSPEC: CMD }),
      exists: onDisk([CMD]),
    })

    connector.connect({ kind: "local" })

    expect(spawner.lastOptions.file).toBe(CMD)
    expect(spawner.lastOptions.args).toEqual([])
  })

  test("an explicit target shell or arguments win over the defaults", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, options)

    connector.connect({ kind: "local", shell: "C:\\tools\\nu.exe", args: ["--login"] })
    connector.connect({ kind: "local", args: ["-NoLogo", "-NoProfile"] })

    expect(spawner.spawned[0]).toMatchObject({ file: "C:\\tools\\nu.exe", args: ["--login"] })
    expect(spawner.spawned[1]).toMatchObject({ file: POWSH, args: ["-NoLogo", "-NoProfile"] })
  })

  test("quiet can be turned off", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, { ...options, quiet: false })

    connector.connect({ kind: "local" })

    expect(spawner.lastOptions.args).toEqual(["-NoLogo"])
  })

  test("a target can override the shell, arguments, geometry and environment", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, options)

    connector.connect({
      kind: "local",
      shell: "C:\\tools\\nu.exe",
      args: ["--login"],
      cwd: "C:\\work",
      cols: 100,
      rows: 40,
      env: { TERM_PROGRAM: "opencode" },
    })

    expect(spawner.lastOptions).toMatchObject({
      file: "C:\\tools\\nu.exe",
      args: ["--login"],
      cwd: "C:\\work",
      cols: 100,
      rows: 40,
      env: { TERM_PROGRAM: "opencode" },
    })
  })

  test("resolves the default shell once and reuses it", () => {
    const spawner = new FakeSpawner()
    let lookups = 0
    const connector = new LocalShellConnector(spawner, {
      ...options,
      exists: (file) => {
        lookups += 1
        return onDisk([POWSH, CMD])(file)
      },
    })

    connector.connect({ kind: "local" })
    const afterFirst = lookups
    connector.connect({ kind: "local" })

    expect(afterFirst).toBeGreaterThan(0)
    expect(lookups).toBe(afterFirst)
  })

  test("refuses an SSH target instead of spawning the wrong thing", () => {
    const spawner = new FakeSpawner()
    const connector = new LocalShellConnector(spawner, options)
    const ssh: SshTarget = { host: "srv-01", user: "ops" }

    expect(() => connector.connect(ssh)).toThrow("local targets")
    expect(spawner.spawned).toHaveLength(0)
  })

  test("shellName is the file name of the shell", () => {
    expect(shellName(POWSH)).toBe("pwsh.exe")
    expect(shellName("/bin/bash")).toBe("bash")
  })
})
