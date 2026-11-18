import { describe, expect, test } from "bun:test"
import { LocalTerminal } from "../lib/local-engine"
import { LocalShellConnector } from "../lib/local-shell"
import { SessionManager } from "../lib/session-manager"
import { viewFromSession } from "../lib/terminal-view"
import type { PtySpawnOptions } from "../lib/types"
import type { SessionInfo } from "../lib/types"
import { FakePty, FakeSpawner } from "./fake-pty"

/**
 * The local engine end to end, minus `node-pty`: a fake spawner stands in for the native PTY,
 * so what is covered here is the wiring — spawn, mapping, write, kill — not the OS.
 */

const POWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"

const windowsOptions = {
  platform: "win32" as const,
  env: {
    PATH: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    HOME: "C:\\Users\\ana",
  },
  exists: (file: string) => file.toLowerCase() === POWSH.toLowerCase(),
}

function setup(options: { autoApproveSafeCommands?: boolean; loggerSink?: (id: string, line: string) => void } = {}) {
  const spawner = new FakeSpawner()
  const connector = new LocalShellConnector(spawner, windowsOptions)
  const manager = new SessionManager({ spawner, connector, platform: "win32", ...options })
  const terminal = new LocalTerminal(manager, connector)
  return { spawner, connector, manager, terminal }
}

describe("LocalTerminal.open", () => {
  test("spawns the local shell and describes it", async () => {
    const { spawner, terminal } = setup()

    const handle = await terminal.open("ses_1")

    expect(handle).toEqual({
      sessionID: "ses_1",
      pid: 4242,
      shell: POWSH,
      cwd: "C:\\Users\\ana",
      engine: "local-pty",
    })
    expect(spawner.spawned).toHaveLength(1)
    expect(spawner.lastOptions.file).toBe(POWSH)
    expect(terminal.has("ses_1")).toBe(true)
  })

  test("reports an unknown pid as null instead of 0", async () => {
    class ZeroPidPty extends FakePty {
      override readonly pid = 0
    }
    const spawner = {
      spawned: [] as PtySpawnOptions[],
      spawn(options: PtySpawnOptions) {
        this.spawned.push(options)
        return new ZeroPidPty()
      },
    }
    const connector = new LocalShellConnector(spawner, windowsOptions)
    const manager = new SessionManager({ spawner, connector })
    const terminal = new LocalTerminal(manager, connector)

    const handle = await terminal.open("ses_zero")

    expect(handle.pid).toBeNull()
  })

  test("is idempotent: opening twice reuses the live shell", async () => {
    const { spawner, terminal } = setup()

    await terminal.open("ses_1")
    const again = await terminal.open("ses_1")

    expect(spawner.spawned).toHaveLength(1)
    expect(again.pid).toBe(4242)
  })

  test("honours an explicit working directory", async () => {
    const { spawner, terminal } = setup()

    const handle = await terminal.open("ses_1", "C:\\work\\app")

    expect(spawner.lastOptions.cwd).toBe("C:\\work\\app")
    expect(handle.cwd).toBe("C:\\work\\app")
  })

  test("keeps sessions separate", async () => {
    const { spawner, terminal } = setup()

    await terminal.open("ses_1")
    await terminal.open("ses_2")

    expect(spawner.spawned).toHaveLength(2)
    expect(terminal.has("ses_1")).toBe(true)
    expect(terminal.has("ses_2")).toBe(true)
  })
})

describe("LocalTerminal.kill", () => {
  test("destroys the shell and reports it", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")

    expect(terminal.kill("ses_1")).toBe(true)
    expect(spawner.last.killed).toBe(true)
    expect(terminal.has("ses_1")).toBe(false)
  })

  test("is harmless when there is no session", () => {
    const { terminal } = setup()

    expect(terminal.kill("ses_missing")).toBe(false)
  })

  test("a killed session can be opened again", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    terminal.kill("ses_1")

    await terminal.open("ses_1")

    expect(spawner.spawned).toHaveLength(2)
  })
})

describe("LocalTerminal.view", () => {
  test("maps the snapshot onto the tool view", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    spawner.last.emit("PS C:\\Users\\ana> ")

    const view = terminal.view("ses_1")

    expect(view).not.toBeNull()
    expect(view?.ptyID).toBe("ses_1")
    expect(view?.title).toBe(`${POWSH} (local)`)
    expect(view?.cwd).toBe("C:\\Users\\ana")
    expect(view?.foregroundProcess).toBe("pwsh.exe")
    expect(view?.text).toContain("PS C:\\Users\\ana>")
  })

  test("returns null without a session", () => {
    const { terminal } = setup()

    expect(terminal.view("ses_missing")).toBeNull()
  })

  test("withholds the text while a credential prompt is on screen", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    spawner.last.emit("[sudo] password for ana: ")

    const view = terminal.view("ses_1")

    expect(terminal.blinded("ses_1")).toBe(true)
    expect(view?.text).toContain("withheld")
    expect(view?.text).not.toContain("password for ana")
  })

  test("keeps ANSI out of the text", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    spawner.last.emit("\u001b[32mok\u001b[0m\r\n")

    expect(terminal.view("ses_1")?.text).not.toContain("\u001b[")
  })
})

describe("LocalTerminal.write", () => {
  test("writes the command with a single terminator and audits it", async () => {
    const lines: string[] = []
    const { spawner, terminal } = setup({ loggerSink: (_id, line) => lines.push(line) })
    await terminal.open("ses_1")

    terminal.write("ses_1", "echo hi\n")
    terminal.write("ses_1", "pwd")

    expect(spawner.last.writes).toEqual(["echo hi\r", "pwd\r"])
    expect(lines.filter((line) => line.includes("ai-approved")).length).toBe(2)
  })

  test("submits with CR on a Windows shell and never with LF alone", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")

    terminal.write("ses_1", '"MARK" + "ER"\n')

    const written = spawner.last.writes[0] ?? ""
    expect(written.endsWith("\r")).toBe(true)
    expect(written.endsWith("\n")).toBe(false)
    expect(written).toBe('"MARK" + "ER"\r')
  })
})

describe("line discipline per session", () => {
  test("a local Windows shell gets CR, an SSH session keeps LF", async () => {
    const localSpawner = new FakeSpawner()
    const localManager = new SessionManager({
      spawner: localSpawner,
      connector: new LocalShellConnector(localSpawner, windowsOptions),
      platform: "win32",
    })
    const remoteSpawner = new FakeSpawner()
    const remoteManager = new SessionManager({ spawner: remoteSpawner, platform: "win32" })

    await localManager.create({ id: "local", target: { kind: "local" } })
    await remoteManager.create({ id: "remote", target: { host: "srv-01", user: "ops" } })

    localManager.writeAi("local", "echo local")
    remoteManager.writeAi("remote", "echo remote")

    expect(localSpawner.processes[0]?.writes).toEqual(["echo local\r"])
    expect(remoteSpawner.processes[0]?.writes).toEqual(["echo remote\n"])
  })
})

describe("session isolation", () => {
  test("two managers with the same session id never share a shell or a buffer", async () => {
    const first = setup()
    const second = setup()

    await first.terminal.open("ses_same")
    await second.terminal.open("ses_same")
    first.spawner.last.emit("FROM-FIRST\r\n")

    expect(first.spawner.spawned).toHaveLength(1)
    expect(second.spawner.spawned).toHaveLength(1)
    expect(first.spawner.processes[0]).not.toBe(second.spawner.processes[0])

    expect(first.terminal.view("ses_same")?.text).toContain("FROM-FIRST")
    expect(second.terminal.view("ses_same")?.text ?? "").not.toContain("FROM-FIRST")

    first.terminal.write("ses_same", "echo only-first")
    expect(first.spawner.last.writes).toEqual(["echo only-first\r"])
    expect(second.spawner.last.writes).toEqual([])
  })

  test("a fresh session starts with an empty buffer", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    spawner.last.emit("OLD-OUTPUT\r\n")
    terminal.kill("ses_1")

    await terminal.open("ses_1")

    expect(terminal.view("ses_1")?.text).toBe("")
  })

  test("a killed session does not receive later writes", async () => {
    const { spawner, terminal } = setup()
    await terminal.open("ses_1")
    const dead = spawner.last
    terminal.kill("ses_1")

    expect(terminal.has("ses_1")).toBe(false)
    expect(dead.writes).toEqual([])
    expect(() => terminal.write("ses_1", "echo after-kill")).toThrow("Unknown session")
  })
})

describe("SessionManager with a local target", () => {
  test("becomes ready on first output and reports the shell", async () => {
    const { spawner, manager } = setup()
    await manager.create({ id: "ses_1", target: { kind: "local", cwd: "C:\\Users\\ana" } })

    spawner.last.emit("PS C:\\Users\\ana> ")

    const info = manager.info("ses_1")
    expect(info.status).toBe("ready")
    expect(info.shell).toBe(POWSH)
    expect(info.cwd).toBe("C:\\Users\\ana")
    expect(info.foregroundProcess).toBe("pwsh.exe")
    expect(info.target.kind).toBe("local")
  })

  test("logs a local session without inventing a host", async () => {
    const lines: string[] = []
    const { manager } = setup({ loggerSink: (_id, line) => lines.push(line) })

    await manager.create({ id: "ses_1", target: { kind: "local", cwd: "C:\\work" } })

    const created = lines.find((line) => line.includes("session-created"))
    expect(created).toContain('"kind":"local"')
    expect(created).toContain("C:\\\\work")
    expect(created).not.toContain("host")
  })
})

describe("viewFromSession", () => {
  const base = {
    id: "ses_1",
    status: "ready" as const,
    createdAt: 1,
    lastActivityAt: 2,
    blinded: false,
    fullScreenApp: null,
  }

  test("uses the session id as ptyID and nulls unknown fields", () => {
    const info: SessionInfo = { ...base, target: { host: "srv-01", user: "ops" } }

    const view = viewFromSession(info, { text: "" })

    expect(view.ptyID).toBe("ses_1")
    expect(view.title).toBe("ops@srv-01")
    expect(view.cwd).toBeNull()
    expect(view.foregroundProcess).toBeNull()
  })

  test("falls back to the full-screen app as the foreground process", () => {
    const info: SessionInfo = {
      ...base,
      target: { host: "srv-01", user: "ops" },
      fullScreenApp: "vim",
    }

    const view = viewFromSession(info, { text: "vim", fullScreenApp: "vim" })

    expect(view.foregroundProcess).toBe("vim")
  })
})
