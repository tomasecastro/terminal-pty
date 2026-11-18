import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccessGate } from "../lib/access"
import { allowRead, runCommand, type ExecutionDeps } from "../lib/execution-flow"
import { createSessionDetectors, type TerminalView } from "../lib/terminal-view"

/**
 * Contract: reading needs read permission, writing needs write permission, and every guard
 * fails closed. Each test asserts the result and whether the side effect happened.
 */

const SES = "ses_test"

function view(text = "deploy@prod:~$ "): TerminalView {
  return { ptyID: "pty_1", title: "ssh prod", cwd: "/srv/app", foregroundProcess: "bash", text }
}

/**
 * `runCommand` writes three lines: the command with its output redirected to a capture file, the
 * `Get-Content`/`cat` that shows it to the human, and the sentinel command (T024, T025). Tests about
 * approval only care about the command, so they strip the redirection and the two trailing lines.
 */
function sent(written: string): string {
  const [first = ""] = written.split(/[\r\n]+/)
  return first.replace(/ \*> '[^']*'$/, "").replace(/ > '[^']*' 2>&1$/, "")
}

function commands(writes: readonly string[]): string[] {
  return writes.map(sent)
}

function harness(
  options: {
    enabled?: boolean
    allowlist?: readonly string[]
    access?: "none" | "read" | "write" | "full"
    text?: string
    /** Successive screen reads; the last one repeats. Defaults to one fixed screen of `text`. */
    screens?: readonly string[]
    /** How long `runCommand` waits for the shell to answer. Defaults to `0`: a single read. */
    outputTimeoutMs?: number
    /** Omits the timeout, so `runCommand` waits with its production default. */
    usesDefaultTimeout?: boolean
    approve?: boolean
    revokeDuringApproval?: boolean
    writeFails?: boolean
    noTerminal?: boolean
    noWrite?: boolean
    noAssert?: boolean
    /** Simulated terminal of the write target. The suite models a POSIX server by default. */
    platform?: NodeJS.Platform
    /**
     * Fake shell that answers from the bytes it received. The sentinel carries a random id, so the
     * shell can only echo it back after reading the write.
     */
    shell?: (written: string) => string
    /**
     * Content of the capture file. Left out, reading it fails, which is what a shell without the
     * redirect leaves behind: every screen-based test exercises the fallback that way.
     */
    capture?: string
    /**
     * Uses the real `node:fs` to read and delete the capture file instead of the fakes, so a fake
     * shell can write it for real. The file still lives under `tmpdir`.
     */
    onDisk?: boolean
    /** Temp directory the capture path is built from. Defaults to a fixed `/tmp`. */
    tmpdir?: () => string
  } = {},
) {
  const gate = new AccessGate({ enabled: options.enabled ?? true, allowlist: options.allowlist ?? [] })
  const access = options.access ?? "write"
  if (access === "read") gate.grantRead(SES)
  if (access === "write") gate.grantWrite(SES)
  if (access === "full") gate.grantFull(SES)

  const detectors = createSessionDetectors()
  const writes: string[] = []
  const approvals: string[] = []
  const actions: string[] = []
  /** `undefined` when the payload omits the key, which is what disables "Always allow". */
  const saves: (readonly string[] | undefined)[] = []
  let reads = 0
  /** Paths `runCommand` asked to read and to delete, in order. */
  const captured: string[] = []
  const deletions: string[] = []
  const deps: ExecutionDeps = {
    gate,
    platform: options.platform ?? "linux",
    // Reading once right after the write used to be enough for these tests; the ones that exercise
    // the wait opt in, so the suite stays fast.
    ...(options.usesDefaultTimeout ? {} : { outputTimeoutMs: options.outputTimeoutMs ?? 0 }),
    // A fixed temp directory keeps the written line assertable; the path is never touched on disk
    // unless a test asks for the real filesystem.
    tmpdir: () => options.tmpdir?.() ?? "/tmp",
    readFile: async (path: string) => {
      captured.push(path)
      if (options.onDisk) return await readFile(path, "utf8")
      if (options.capture === undefined) throw new Error("ENOENT: no such file or directory")
      return options.capture
    },
    unlink: async (path: string) => {
      deletions.push(path)
      if (options.onDisk) await unlink(path)
    },
    read: async () => {
      const screen = options.screens
      const next = reads
      reads += 1
      if (options.noTerminal) return null
      if (options.shell) return view(writes.length > 0 ? options.shell(writes[0] ?? "") : (options.text ?? "PS C:\\>"))
      if (!screen) return view(options.text)
      return view(screen[Math.min(next, screen.length - 1)])
    },
    ...(options.noWrite
      ? {}
      : {
          write: async (_ptyID: string, data: string) => {
            if (options.writeFails) throw new Error("boom")
            writes.push(data)
          },
        }),
    ...(options.noAssert
      ? {}
      : {
          assert: async (input: { action: string; resources: readonly string[]; save?: readonly string[] }) => {
            actions.push(input.action)
            approvals.push(input.resources[0] ?? "")
            saves.push(input.save)
            if (options.revokeDuringApproval) gate.revoke(SES)
            if (options.approve === false) throw new Error("rejected")
          },
        }),
    observe: (sessionID, text) => detectors.observe(sessionID, text),
  }
  return { deps, gate, writes, approvals, actions, saves, detectors, captured, deletions }
}

describe("read permission", () => {
  test("is closed by default", () => {
    const gate = new AccessGate({ enabled: true })
    const guard = allowRead(gate, SES)
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.message).toContain("read permission")
  })

  test("is closed when the human disabled terminal access", () => {
    const gate = new AccessGate({ enabled: false })
    gate.grantRead(SES)
    const guard = allowRead(gate, SES)
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.message).toContain("disabled")
  })

  test("opens with read permission and does not allow writing", () => {
    const gate = new AccessGate({ enabled: true })
    gate.grantRead(SES)
    expect(allowRead(gate, SES).ok).toBe(true)
    expect(gate.canWrite(SES)).toBe(false)
  })

  test("a read grant alone cannot run commands", async () => {
    const { deps, writes } = harness({ access: "read" })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-grant")
    expect(writes).toEqual([])
  })
})

describe("runCommand", () => {
  test("refuses when access is disabled", async () => {
    const { deps, writes } = harness({ enabled: false })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("disabled")
    expect(writes).toEqual([])
  })

  test("refuses without a grant", async () => {
    const { deps, writes } = harness({ access: "none" })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-grant")
    expect(writes).toEqual([])
  })

  test("refuses with no terminal attached", async () => {
    const { deps, writes } = harness({ noTerminal: true })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-terminal")
    expect(writes).toEqual([])
  })

  test("refuses while a credential prompt is on screen", async () => {
    const { deps, writes } = harness({ text: "[sudo] password for deploy: " })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("blinded")
    expect(writes).toEqual([])
  })

  test("refuses without a write channel", async () => {
    const { deps } = harness({ noWrite: true })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-write-channel")
  })

  test("asks the human, then writes", async () => {
    const { deps, writes, approvals } = harness()
    const result = await runCommand(deps, SES, "systemctl restart api", "restart the service")
    expect(result.executed).toBe(true)
    expect(approvals).toEqual(["systemctl restart api"])
    expect(commands(writes)).toEqual(["systemctl restart api"])
  })

  test("submits with CR on a Windows terminal", async () => {
    const { deps, writes } = harness({ platform: "win32" })

    const result = await runCommand(deps, SES, '"MARK" + "ER"')

    expect(result.executed).toBe(true)
    expect(commands(writes)).toEqual(['"MARK" + "ER"'])
    expect(writes[0]?.endsWith("\r")).toBe(true)
    expect(writes[0]?.endsWith("\n")).toBe(false)
  })

  test("submits with LF on a POSIX terminal", async () => {
    const { deps, writes } = harness({ platform: "linux" })

    await runCommand(deps, SES, "uname -a")

    expect(commands(writes)).toEqual(["uname -a"])
    expect(writes[0]?.endsWith("\n")).toBe(true)
  })

  test("does not write when the human rejects", async () => {
    const { deps, writes } = harness({ approve: false })
    const result = await runCommand(deps, SES, "rm -rf /var/data")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("rejected")
    expect(writes).toEqual([])
  })

  test("does not write when access is revoked during approval", async () => {
    const { deps, writes } = harness({ revokeDuringApproval: true })
    const result = await runCommand(deps, SES, "systemctl restart api")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-grant")
    expect(writes).toEqual([])
  })

  test("allowlisted commands skip approval but still need a grant", async () => {
    const withGrant = harness({ allowlist: ["ls"] })
    const allowed = await runCommand(withGrant.deps, SES, "ls -la")
    expect(allowed.executed).toBe(true)
    expect(withGrant.approvals).toEqual([])

    const withoutGrant = harness({ allowlist: ["ls"], access: "none" })
    const denied = await runCommand(withoutGrant.deps, SES, "ls -la")
    expect(denied.reason).toBe("no-grant")
    expect(withoutGrant.writes).toEqual([])
  })

  test("chained commands are never auto-approved", async () => {
    const { deps, writes, approvals } = harness({ allowlist: ["ls"] })
    const result = await runCommand(deps, SES, "ls; rm -rf /")
    expect(result.executed).toBe(true)
    expect(approvals).toEqual(["ls; rm -rf /"])
    expect(commands(writes)).toEqual(["ls; rm -rf /"])
  })

  test("a write failure is reported and nothing is claimed as executed", async () => {
    const { deps } = harness({ writeFails: true })
    const result = await runCommand(deps, SES, "ls -la")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("write-failed")
  })

  test("an empty command is rejected before any guard runs", async () => {
    const { deps, writes } = harness()
    const result = await runCommand(deps, SES, "   ")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("empty")
    expect(writes).toEqual([])
  })
})

/**
 * The assistant must read what the command printed, not the paint traffic around it.
 *
 * A real PowerShell session echoes the line, PSReadLine repaints it while typing
 * (`Get-LocatiGet-Location`) and the prompt comes back after the result. Returning the whole buffer
 * handed all of that to the model as `output`, which is what T022 fixes.
 */
describe("command output", () => {
  const POWERSHELL = {
    before: "PS C:\\>",
    after: "PS C:\\> Get-LocatiGet-Location\n\nPath\n----\nC:\\Proyectos\\opencodePS C:\\>",
  }

  test("returns the command's own output without the echo or the prompt", async () => {
    const { deps, writes } = harness({ screens: [POWERSHELL.before, POWERSHELL.after] })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(writes).toHaveLength(1)
    expect(commands(writes)).toEqual(["Get-Location"])
    expect(result.output).toContain("Path")
    expect(result.output).toContain("----")
    expect(result.output).toContain("C:\\Proyectos\\opencode")
    expect(result.output).not.toContain("Get-Locati")
    expect(result.output).not.toContain("PS C:\\>")
  })

  /**
   * `write` resolves as soon as the bytes reach the PTY, and the shell runs the command after that.
   * Reading once, right away, returned the still-idle prompt as `output` (`PS C:\...>`) while the
   * command ran afterwards, so the model lost the result (T023).
   */
  test("waits for the shell to answer before reading the output", async () => {
    const answered = "PS C:\\> Get-Location\nPath\n----\nC:\\Proyectos\\opencode\nPS C:\\>"
    const { deps, writes } = harness({
      screens: [POWERSHELL.before, POWERSHELL.before, POWERSHELL.before, answered],
      outputTimeoutMs: 2_000,
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(writes).toHaveLength(1)
    expect(commands(writes)).toEqual(["Get-Location"])
    expect(result.output).toContain("Path")
    expect(result.output).toContain("----")
    expect(result.output).toContain("C:\\Proyectos\\opencode")
    expect(result.output).not.toContain("Get-Location")
    expect(result.output).not.toContain("PS C:\\>")
  })

  test("waits with its production timeout when the host sets none", async () => {
    const { deps } = harness({
      text: "PS C:\\>",
      usesDefaultTimeout: true,
      shell: (written) => {
        const line = written.split(/[\r\n]+/)[0] ?? ""
        const marker = written.match(/__OC_DONE_[0-9a-f-]+__/)?.[0] ?? "missing"
        return `PS C:\\> ${line}\nPath\n${marker}\nPS C:\\>`
      },
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.output).toBe("Path")
  })

  test("a command that never returns to a prompt keeps its partial output", async () => {
    const running = "PS C:\\> bun run watch\nwatching for changes\nstep 1/3"
    const { deps } = harness({
      screens: [POWERSHELL.before, `${POWERSHELL.before} bun run watch\nwatching for changes`, running],
      outputTimeoutMs: 150,
    })

    const result = await runCommand(deps, SES, "bun run watch")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("watching for changes\nstep 1/3")
  })

  test("waits until the timeout before concluding a command printed nothing", async () => {
    const { deps } = harness({
      screens: [POWERSHELL.before, POWERSHELL.before, "PS C:\\> Get-Location\nPS C:\\>"],
      outputTimeoutMs: 2_000,
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("")
  })

  test("a command that prints nothing returns an empty output", async () => {
    const { deps } = harness({ screens: ["PS C:\\>", "PS C:\\> Get-Location\nPS C:\\>"] })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("")
  })

  test("drops a POSIX prompt that ends the output", async () => {
    const { deps } = harness({
      screens: ["deploy@prod:~$ ", "deploy@prod:~$ ls -la\ntotal 8\ndeploy@prod:~$ "],
    })

    const result = await runCommand(deps, SES, "ls -la")

    expect(result.output).toContain("total 8")
    expect(result.output).not.toContain("ls -la")
    expect(result.output).not.toContain("deploy@prod")
  })

  test("falls back to the rendered screen when it does not extend the previous one", async () => {
    const cleared = "C:\\Proyectos\\opencode\\new> "
    const { deps } = harness({ screens: ["C:\\Proyectos\\opencode> ", cleared] })

    const result = await runCommand(deps, SES, "cd new")

    expect(result.executed).toBe(true)
    expect(result.output).toBe(cleared)
  })
})

/**
 * The sentinel protocol (T024): `runCommand` writes the command, then a second command that prints
 * a unique marker, so the output is what sits between the echoed command and the printed marker,
 * whatever the buffer does around it.
 *
 * The marker carries a random id, so the fake shell only learns it from the bytes it received. Its
 * echo reaches the terminal with the marker inside quotes, right before the command's output; only
 * the unquoted occurrence is the print.
 */
describe("sentinel capture", () => {
  /** The marker the fake shell reads from the bytes it received; a run generates it at write time. */
  function markerOf(written: string): string {
    return written.match(/__OC_DONE_[^"_]+__/)?.[0] ?? "missing-marker"
  }

  /** The command under test, the first of the two lines `runCommand` writes. */
  function commandOf(written: string): string {
    return written.split(/\r?\n/)[0] ?? ""
  }

  /**
   * The screen a shell leaves behind: the command's echo, whatever it printed, the echo of the
   * marker command, the printed marker and the prompt.
   */
  function answer(written: string, body: readonly string[] = []) {
    const command = commandOf(written)
    const marker = markerOf(written)
    const text = [
      `PS C:\\> ${command}`,
      ...body,
      `PS C:\\> Write-Output "${marker}"`,
      marker,
      "PS C:\\>",
    ].join("\n")
    return { line: `${command}\nWrite-Output "${marker}"`, marker, text }
  }

  test("returns only the text between the echo and the marker", async () => {
    const { deps, writes } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => answer(written, ["Path", "----", "C:\\Proyectos"]).text,
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("Path\n----\nC:\\Proyectos")
    expect(result.output).not.toContain("Get-Location")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\>")
    // The marker is its own command line, never glued to the command with `;` (T024).
    expect(writes[0]).not.toContain(";")
    expect(writes[0]).toMatch(/[\r\n]Write-Output '__OC_DONE_[^']+__'\r$/)
  })

  /**
   * PowerShell paints the echo of the marker command where the cursor is, so the last output line
   * can carry the prompt and that echo: `C:\Proyectos\opencodePS C:\...> Write-Output "marker"`.
   * Dropping the whole line lost the path; only the echo suffix may go (T024).
   */
  test("keeps the output glued to the prompt and the marker command", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => {
        const marker = markerOf(written)
        const command = commandOf(written)
        return [
          `PS C:\\Proyectos\\opencode> ${command}`,
          "Path",
          "----",
          `C:\\Proyectos\\opencodePS C:\\Proyectos\\opencode> Write-Output "${marker}"`,
          marker,
          "PS C:\\Proyectos\\opencode>",
        ].join("\n")
      },
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.output).toBe("Path\n----\nC:\\Proyectos\\opencode")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\")
  })

  /**
   * The screen PowerShell actually leaves behind: the sentinel is printed and the prompt comes
   * back glued to it on the same line (`__OC_DONE_x__PS C:\...>`). A whole-line match never sees
   * the sentinel, waited out the timeout and handed the raw buffer to the model (T024).
   */
  function glued(written: string, body: readonly string[] = []) {
    const { line, marker } = answer(written)
    return [`PS C:\\...> Ge> ${line}`, "", "", ...body, `${marker}PS C:\\...>`].join("\n")
  }

  test("detects the marker glued to the prompt on the same line", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\...>",
      outputTimeoutMs: 2_000,
      shell: (written) => glued(written, ["Path", "----", "C:\\Proyectos\\opencode"]),
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("Path\n----\nC:\\Proyectos\\opencode")
    expect(result.output).not.toContain("Get-Location")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\")
  })

  test("a command with nothing to print and the marker glued to the prompt returns an empty output", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\...>",
      outputTimeoutMs: 2_000,
      shell: (written) => glued(written),
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("")
  })

  /**
   * A piped command's last row is the one the prompt glues itself to, so the capture must cut the
   * prompt and the marker echo off that row instead of dropping it.
   */
  test("keeps the last row of a piped command when the marker echo is glued to it", async () => {
    const body = ["    Directory: C:\\Proyectos\\opencode", "", "Mode   Name", "----   ----", "d----  packages"]
    const { deps, writes } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => {
        const marker = markerOf(written)
        return [
          `PS C:\\> ${commandOf(written)}`,
          ...body.slice(0, -1),
          `${body[body.length - 1]}PS C:\\Proyectos\\opencode> Write-Output "${marker}"`,
          `${marker}PS C:\\Proyectos\\opencode>`,
        ].join("\n")
      },
    })

    const result = await runCommand(deps, SES, "Get-ChildItem | Select-Object -First 2")

    expect(commands(writes)).toEqual(["Get-ChildItem | Select-Object -First 2"])
    expect(result.output).toBe(body.join("\n"))
    expect(result.output).not.toContain("Select-Object")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\")
  })

  test("keeps waiting while only the echoed command carries the marker", async () => {
    let reads = 0
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\...>",
      outputTimeoutMs: 2_000,
      shell: (written) => {
        reads += 1
        if (reads < 3) return `PS C:\\...> Ge> ${answer(written).line}`
        return glued(written, ["Path"])
      },
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.output).toBe("Path")
  })

  test("a command that prints nothing returns an empty output", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => answer(written).text,
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("")
  })

  test("keeps every line of a multi-line output", async () => {
    const lines = ["line one", "line two", "line three"]
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => answer(written, lines).text,
    })

    const result = await runCommand(deps, SES, "Write-Host lines")

    expect(result.output).toBe(lines.join("\n"))
  })

  test("falls back to the partial output when the marker never arrives", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 150,
      shell: (written) => `PS C:\\> ${answer(written).line}\nstill building\nstep 1/2`,
    })

    const result = await runCommand(deps, SES, "bun run build")

    expect(result.executed).toBe(true)
    expect(result.output).not.toBe("")
    expect(result.output).toContain("still building")
    expect(result.output).toContain("step 1/2")
    expect(result.output).not.toContain("__OC_DONE_")
  })

  test("writes the marker as its own command line", async () => {
    const posix = harness({ platform: "linux" })
    await runCommand(posix.deps, SES, "uname -a")
    expect(posix.writes[0]).toMatch(/^uname -a > '[^']+' 2>&1\ncat '[^']+'\necho '__OC_DONE_[0-9a-f-]+__'\n$/)

    const windows = harness({ platform: "win32" })
    await runCommand(windows.deps, SES, "Get-Date")
    expect(windows.writes[0]).toMatch(
      /^Get-Date \*> '[^']+'\rGet-Content -LiteralPath '[^']+'\rWrite-Output '__OC_DONE_[0-9a-f-]+__'\r$/,
    )
  })

  /**
   * Leaving the marker on the command line (`Get-ChildItem | Select-Object -First 2; Write-Output
   * "marker"`) put the marker into the echoed line, inside quotes, before the command had run. The
   * capture took that echo for the print and returned an empty or raw output. Now the echo and the
   * print are distinct lines and only the print ends the wait (T024).
   */
  test("keeps a piped command's output clean", async () => {
    const body = ["    Directory: C:\\Proyectos\\opencode", "", "Mode   Name", "----   ----"]
    const { deps, writes } = harness({
      platform: "win32",
      text: "PS C:\\>",
      outputTimeoutMs: 2_000,
      shell: (written) => answer(written, body).text,
    })

    const result = await runCommand(deps, SES, "Get-ChildItem | Select-Object -First 2")

    expect(commands(writes)).toEqual(["Get-ChildItem | Select-Object -First 2"])
    expect(result.output).toBe(body.join("\n"))
    expect(result.output).not.toContain("Select-Object")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\")
  })

  /**
   * The batch that exposed T024: 25 commands in a row, each leaving its echo, the echo of the
   * marker command, the printed marker and the prompt on screen. Every output must be the
   * command's own result.
   */
  test("twenty-five simulated commands keep every output clean", async () => {
    for (let i = 1; i <= 25; i += 1) {
      const target = `file-${i}.txt`
      const body = ["Length Name", "------ ----", `     0 ${target}`]
      const { deps } = harness({
        platform: "win32",
        text: "PS C:\\>",
        outputTimeoutMs: 2_000,
        shell: (written) => answer(written, body).text,
      })

      const result = await runCommand(deps, SES, `Get-Item .\\${target}`)

      expect(result.executed).toBe(true)
      expect(result.output).toBe(body.join("\n"))
      expect(result.output).not.toContain("Get-Item")
      expect(result.output).not.toContain("Write-Output")
      expect(result.output).not.toContain("__OC_DONE_")
      expect(result.output).not.toContain("PS C:\\")
    }
  })
})

/**
 * File capture (T025): `runCommand` redirects the command's output to a temp file and reads it with
 * `node:fs`. The screen is not a reliable transport: in a burst of 25 commands some outputs arrived
 * glued to the PSReadLine repaint (`Path\n----\nC:\...PS C:\...> > W`) and others fell back to the
 * raw buffer. The output does exist; only the screen is lossy.
 */
describe("file capture", () => {
  const BODY = ["Path", "----", "C:\\Proyectos\\opencode"]

  /** The marker the run generated, read from the bytes it wrote. */
  function markerOf(written: string): string {
    return written.match(/__OC_DONE_[^'_]+__/)?.[0] ?? "missing-marker"
  }

  /** The screen of a shell that echoed everything and repainted the line: the old failure mode. */
  function noise(written: string): string {
    const command = written.split(/\r?\n/)[0] ?? ""
    const marker = markerOf(written)
    return [
      `PS C:\\> ${command}`,
      "Path",
      "----",
      `C:\\Proyectos\\opencodePS C:\\...> > W${command}`,
      `PS C:\\...> Write-Output '${marker}'`,
      `${marker}PS C:\\...>`,
      "",
    ].join("\n")
  }

  test("redirects the output to a quoted temp file and reads it back", async () => {
    const { deps, writes, captured } = harness({
      platform: "win32",
      text: "PS C:\\>",
      capture: `${BODY.join("\r\n")}\r\n`,
    })

    const result = await runCommand(deps, SES, "Get-Location")

    const path = captured[0] ?? ""
    const marker = writes[0]?.match(/__OC_DONE_[0-9a-f-]+__/)?.[0] ?? ""

    expect(result.executed).toBe(true)
    // Three separate lines, the output redirected to the same quoted file it is read back from.
    expect(writes[0]).toBe(`Get-Location *> '${path}'\rGet-Content -LiteralPath '${path}'\rWrite-Output '${marker}'\r`)
    expect(captured).toHaveLength(1)
    expect(path).toMatch(/oc-pty-[0-9a-f-]{36}\.txt$/)
    expect(result.output).toBe(BODY.join("\n"))
  })

  test("redirects with 2>&1 on a POSIX shell and shows the output with cat", async () => {
    const { deps, writes, captured } = harness({ platform: "linux", text: "$ ", capture: "Linux host 6.1\n" })

    const result = await runCommand(deps, SES, "uname -a")

    const path = captured[0] ?? ""
    const marker = writes[0]?.match(/__OC_DONE_[0-9a-f-]+__/)?.[0] ?? ""

    expect(writes[0]).toBe(`uname -a > '${path}' 2>&1\ncat '${path}'\necho '${marker}'\n`)
    expect(result.output).toBe("Linux host 6.1")
  })

  /**
   * The reason T025 exists: the echo, the repaint, the marker and the prompt all sit on screen, and
   * cutting them out is a heuristic. The file holds exactly what the command printed.
   */
  test("the file wins over the echoes, the repaint and the prompt on screen", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\>",
      capture: BODY.join("\r\n"),
      shell: (written) => noise(written),
    })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.output).toBe(BODY.join("\n"))
    expect(result.output).not.toContain("Get-Location")
    expect(result.output).not.toContain("Write-Output")
    expect(result.output).not.toContain("__OC_DONE_")
    expect(result.output).not.toContain("PS C:\\")
    expect(result.output).not.toContain("> W")
  })

  test("a command that prints nothing returns an empty output", async () => {
    const { deps } = harness({ platform: "win32", text: "PS C:\\>", capture: "" })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("")
  })

  test("a capture with only a trailing newline is an empty output", async () => {
    const { deps } = harness({ platform: "win32", text: "PS C:\\>", capture: "\r\n" })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(result.output).toBe("")
  })

  test("falls back to the screen when the file cannot be read", async () => {
    const answered = "PS C:\\> Get-Location\nPath\n----\nC:\\Proyectos\nPS C:\\>"
    const { deps, captured, deletions } = harness({ platform: "win32", screens: ["PS C:\\>", answered] })

    const result = await runCommand(deps, SES, "Get-Location")

    expect(captured).toHaveLength(1)
    expect(deletions).toHaveLength(1)
    expect(result.output).toBe("Path\n----\nC:\\Proyectos")
  })

  test("deletes the capture file exactly once after a successful run", async () => {
    const { deps, captured, deletions } = harness({ platform: "win32", text: "PS C:\\>", capture: "done" })

    await runCommand(deps, SES, "Get-Location")

    expect(deletions).toHaveLength(1)
    expect(deletions[0]).toBe(captured[0] ?? "")
  })

  test("deletes the capture file exactly once when the run is withheld", async () => {
    const { deps, deletions } = harness({
      platform: "win32",
      screens: ["PS C:\\>", "[sudo] password for deploy: "],
      capture: "secret",
    })

    const result = await runCommand(deps, SES, "cat /etc/shadow")

    expect(result.output).toContain("output withheld")
    expect(deletions).toHaveLength(1)
  })

  test("reads the file when the marker never arrives", async () => {
    const { deps } = harness({
      platform: "win32",
      text: "PS C:\\> bun run build\nstill building",
      capture: "still building\nstep 1/2\n",
      outputTimeoutMs: 120,
    })

    const result = await runCommand(deps, SES, "bun run build")

    expect(result.executed).toBe(true)
    expect(result.output).toBe("still building\nstep 1/2")
  })

  test("keeps a piped command untouched before the redirection", async () => {
    const { deps, writes, captured } = harness({
      platform: "win32",
      text: "PS C:\\>",
      capture: "Mode   Name\n----   ----\nd----  packages\n",
    })

    const result = await runCommand(deps, SES, "Get-ChildItem | Select-Object -First 2")

    expect(writes[0]?.startsWith(`Get-ChildItem | Select-Object -First 2 *> '${captured[0]}'`)).toBe(true)
    expect(result.output).toBe("Mode   Name\n----   ----\nd----  packages")
  })

  test("keeps a command with quotes untouched before the redirection", async () => {
    const { deps, writes, captured } = harness({ platform: "win32", text: "PS C:\\>", capture: "MARKER" })

    const result = await runCommand(deps, SES, '"MARK" + "ER"')

    expect(writes[0]?.startsWith(`"MARK" + "ER" *> '${captured[0]}'`)).toBe(true)
    expect(result.output).toBe("MARKER")
  })

  test("caps a runaway capture and says it truncated", async () => {
    const { deps } = harness({ platform: "win32", text: "PS C:\\>", capture: "x".repeat(30_000) })

    const result = await runCommand(deps, SES, "Get-Content big.log")

    expect(result.output?.length).toBeLessThanOrEqual(20_000 + "… (truncado)".length)
    expect(result.output?.endsWith("… (truncado)")).toBe(true)
  })

  /**
   * The batch that exposed T024, against a capture file on disk instead of a canned string: the fake
   * shell writes what the redirect would write, the screen carries everything that used to leak into
   * `output`, and every one of the twenty-five results must still be the command's own output.
   */
  test("twenty-five simulated commands against a real capture file stay clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-pty-batch-"))
    const dirty: string[] = []
    try {
      for (let i = 1; i <= 25; i += 1) {
        const body = ["Length Name", "------ ----", `     0 file-${i}.txt`]
        const { deps } = harness({
          platform: "win32",
          onDisk: true,
          tmpdir: () => dir,
          text: "PS C:\\>",
          shell: (written) => {
            const [redirect = ""] = written.split(/[\r\n]+/)
            const path = redirect.match(/'([^']+)'/)?.[1] ?? ""
            writeFileSync(path, `${body.join("\r\n")}\r\n`)
            const marker = written.match(/__OC_DONE_[0-9a-f-]+__/)?.[0] ?? ""
            // Everything that used to contaminate the capture: the echo, the repaint glued to the
            // last output line, the marker echo and the prompt.
            return [
              `PS C:\\> ${redirect}`,
              `${body.join("\n")}PS C:\\...> > W${redirect}`,
              `PS C:\\> Write-Output '${marker}'`,
              `${marker}PS C:\\>`,
            ].join("\n")
          },
        })

        const result = await runCommand(deps, SES, `Get-Item .\\file-${i}.txt`)
        if (result.output !== body.join("\n")) dirty.push(`file-${i}: ${JSON.stringify(result.output)}`)
      }

      expect(dirty).toEqual([])
      // Every capture file went away with its run.
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const NON_DESTRUCTIVE_COMMANDS = [
  "Get-Location",
  "Get-Date",
  "Get-ChildItem -Force",
  "ls -la",
  "pwd",
  "git status",
  "bun test",
  "npm run build",
  "cat package.json",
  "uname -a",
]

const DESTRUCTIVE_COMMANDS = [
  "rm -rf /tmp/data",
  "rm file.txt",
  "del C:\\temp\\report.txt",
  "erase out.log",
  "rd /s /q C:\\build",
  "rmdir empty-folder",
  "format C:",
  "Remove-Item .\\archivo.txt -Force",
  "Clear-Content ./notes.md",
  "truncate -s 0 access.log",
]

describe("full grant", () => {
  test("runs ten non-destructive commands without asking", async () => {
    const { deps, writes, approvals } = harness({ access: "full" })
    for (const command of NON_DESTRUCTIVE_COMMANDS) {
      const result = await runCommand(deps, SES, command)
      expect(result.executed).toBe(true)
    }
    expect(approvals).toEqual([])
    expect(commands(writes)).toEqual(NON_DESTRUCTIVE_COMMANDS)
  })

  test("asks for ten destructive commands, one by one", async () => {
    const { deps, writes, approvals, actions } = harness({ access: "full" })
    for (const command of DESTRUCTIVE_COMMANDS) {
      const result = await runCommand(deps, SES, command)
      expect(result.executed).toBe(true)
    }
    expect(approvals).toEqual(DESTRUCTIVE_COMMANDS)
    expect(actions).toEqual(DESTRUCTIVE_COMMANDS.map(() => "terminal_pty.execute"))
    expect(commands(writes)).toEqual(DESTRUCTIVE_COMMANDS)
  })

  /**
   * A destructive command must never offer "Always allow". If the host persisted a rule for
   * `terminal_pty.execute`, every later destructive command would run without asking, which is the
   * exception FR-003 carves out. The payload therefore carries `resources` and no `save` at all.
   */
  test("the destructive approval does not persist an Always allow rule", async () => {
    const { deps, saves } = harness({ access: "full" })

    await runCommand(deps, SES, "rm -rf ./dist")

    expect(saves).toHaveLength(1)
    expect(saves[0]).toBeUndefined()
  })

  test("a destructive command asks again after an approved one", async () => {
    const { deps, approvals, writes } = harness({ access: "full" })

    const first = await runCommand(deps, SES, "rm -rf ./dist")
    const second = await runCommand(deps, SES, "rm -rf ./build")

    expect(first.executed).toBe(true)
    expect(second.executed).toBe(true)
    expect(approvals).toEqual(["rm -rf ./dist", "rm -rf ./build"])
    expect(commands(writes)).toEqual(["rm -rf ./dist", "rm -rf ./build"])
  })

  test("a rejected destructive command never reaches the terminal", async () => {    for (const command of DESTRUCTIVE_COMMANDS) {
      const { deps, writes } = harness({ access: "full", approve: false })
      const result = await runCommand(deps, SES, command)
      expect(result.executed).toBe(false)
      expect(result.reason).toBe("rejected")
      expect(writes).toEqual([])
    }
  })

  test("a command that hides a destruction behind a metacharacter still asks", async () => {
    const { deps, writes, approvals } = harness({ access: "full" })
    const command = "echo hi; Remove-Item .\\archivo.txt -Force"
    const result = await runCommand(deps, SES, command)
    expect(result.executed).toBe(true)
    expect(approvals).toEqual([command])
    expect(commands(writes)).toEqual([command])
  })

  test("a submission that hides a destruction asks too", async () => {
    const { deps, approvals } = harness({ access: "full" })
    await runCommand(deps, SES, "echo $(rm -rf /tmp/x)")
    expect(approvals).toEqual(["echo $(rm -rf /tmp/x)"])
  })

  test("a full grant revoked during the destructive approval writes nothing", async () => {
    const { deps, writes } = harness({ access: "full", revokeDuringApproval: true })
    const result = await runCommand(deps, SES, "rm -rf /tmp/data")
    expect(result.executed).toBe(false)
    expect(result.reason).toBe("no-grant")
    expect(writes).toEqual([])
  })

  test("read-write still asks for every command", async () => {
    const { deps, approvals } = harness({ access: "write" })
    await runCommand(deps, SES, "Get-Location")
    expect(approvals).toEqual(["Get-Location"])
  })

  test("a full grant still needs a terminal and an unblinded screen", async () => {
    const noTerminal = await runCommand(harness({ access: "full", noTerminal: true }).deps, SES, "Get-Location")
    expect(noTerminal.reason).toBe("no-terminal")

    const blinded = await runCommand(
      harness({ access: "full", text: "[sudo] password for deploy: " }).deps,
      SES,
      "Get-Location",
    )
    expect(blinded.reason).toBe("blinded")
  })
})
