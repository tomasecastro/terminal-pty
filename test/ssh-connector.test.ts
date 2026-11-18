import { describe, expect, test } from "bun:test"
import { buildSshArgs, shellQuote, SSHConnector } from "../lib/ssh-connector"
import { FakeSpawner } from "./fake-pty"

describe("buildSshArgs", () => {
  test("always requests a PTY", () => {
    expect(buildSshArgs({ host: "srv-01", user: "ops" })[0]).toBe("-tt")
  })

  test("includes port, identity, jump host and strict host key policy", () => {
    const args = buildSshArgs({
      host: "srv-01",
      user: "ops",
      port: 2222,
      identityFile: "/home/ops/.ssh/id_ed25519",
      jumpHost: "bastion",
      knownHostsFile: "/home/ops/.ssh/known_hosts",
      strictHostKeyChecking: "yes",
    })

    expect(args).toEqual([
      "-tt",
      "-p",
      "2222",
      "-i",
      "/home/ops/.ssh/id_ed25519",
      "-J",
      "bastion",
      "-o",
      "UserKnownHostsFile=/home/ops/.ssh/known_hosts",
      "-o",
      "StrictHostKeyChecking=yes",
      "ops@srv-01",
    ])
  })

  test("defaults to accept-new host keys", () => {
    const args = buildSshArgs({ host: "srv-01", user: "ops" })
    expect(args).toContain("StrictHostKeyChecking=accept-new")
  })

  test("reattaches a tmux session when configured", () => {
    const args = buildSshArgs({ host: "srv-01", user: "ops", tmuxSession: "deploy" })
    expect(args.at(-1)).toBe("tmux new-session -A -s 'deploy'")
  })

  test("prefers tmux over an explicit remote command", () => {
    const args = buildSshArgs({ host: "srv-01", user: "ops", remoteCommand: "uptime", tmuxSession: "ops" })
    expect(args.at(-1)).toBe("tmux new-session -A -s 'ops'")
  })

  test("quotes single quotes in the tmux session name", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe("SSHConnector", () => {
  test("spawns the ssh binary with the computed args", () => {
    const spawner = new FakeSpawner()
    new SSHConnector(spawner).connect({ host: "srv-01", user: "ops", cols: 100, rows: 40 })

    expect(spawner.lastOptions.file).toBe("ssh")
    expect(spawner.lastOptions.args).toEqual(buildSshArgs({ host: "srv-01", user: "ops" }))
    expect(spawner.lastOptions.cols).toBe(100)
    expect(spawner.lastOptions.rows).toBe(40)
  })
})
