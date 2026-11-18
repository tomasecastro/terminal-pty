import { describe, expect, test } from "bun:test"
import { SessionManager } from "../lib/session-manager"
import { createPtySessionTools, PTY_SESSION_TOOLS } from "../lib/mcp/tools"
import { FakeSpawner } from "./fake-pty"

const setup = async () => {
  const spawner = new FakeSpawner()
  const manager = new SessionManager({ spawner })
  await manager.create({ id: "s1", target: { host: "srv-01", user: "ops" } })
  return { spawner, manager, tools: createPtySessionTools(manager) }
}

describe("PTY session MCP tools", () => {
  test("exposes the four contracted tools", () => {
    expect(PTY_SESSION_TOOLS.map((tool) => tool.name)).toEqual([
      "read_terminal",
      "execute_command",
      "wait_for_prompt",
      "get_session_info",
    ])
  })

  test("read_terminal returns the plain-text tail", async () => {
    const { spawner, tools } = await setup()
    spawner.last.emit("total 0\r\ndrwxr-xr-x 2 ops ops 4096\r\n")

    const result = await tools.call({ name: "read_terminal", arguments: { sessionId: "s1", lines: 10 } })
    const payload = JSON.parse(result.content[0]?.text ?? "{}")

    expect(payload.text).toBe("total 0\ndrwxr-xr-x 2 ops ops 4096")
    expect(payload.blinded).toBe(false)
  })

  test("read_terminal withholds output while a password prompt is active", async () => {
    const { spawner, tools } = await setup()
    spawner.last.emit("ops@srv-01's password: ")

    const result = await tools.call({ name: "read_terminal", arguments: { sessionId: "s1" } })
    const payload = JSON.parse(result.content[0]?.text ?? "{}")

    expect(payload.blinded).toBe(true)
    expect(payload.text).toContain("withheld")
  })

  test("execute_command files a proposal instead of running it", async () => {
    const { spawner, tools } = await setup()

    const result = await tools.call({
      name: "execute_command",
      arguments: { sessionId: "s1", command: "systemctl restart nginx", explanation: "restart the service" },
    })
    const payload = JSON.parse(result.content[0]?.text ?? "{}")

    expect(payload.status).toBe("requires-approval")
    expect(spawner.last.writes).toEqual([])
  })

  test("wait_for_prompt matches an existing prompt", async () => {
    const { spawner, tools } = await setup()
    spawner.last.emit("root@srv-01:~# ")

    const result = await tools.call({
      name: "wait_for_prompt",
      arguments: { sessionId: "s1", prompt: "#\\s*$", timeoutMs: 50 },
    })
    const payload = JSON.parse(result.content[0]?.text ?? "{}")

    expect(payload.matched).toBe(true)
  })

  test("get_session_info reports status and host", async () => {
    const { tools } = await setup()

    const result = await tools.call({ name: "get_session_info", arguments: { sessionId: "s1" } })
    const payload = JSON.parse(result.content[0]?.text ?? "{}")

    expect(payload).toMatchObject({ id: "s1", status: "connecting" })
    expect(payload.target.host).toBe("srv-01")
  })

  test("rejects a call without sessionId", async () => {
    const { tools } = await setup()

    const result = await tools.call({ name: "read_terminal", arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("sessionId")
  })

  test("rejects an unknown tool", async () => {
    const { tools } = await setup()

    const result = await tools.call({ name: "drop_database", arguments: { sessionId: "s1" } })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("Unknown tool")
  })
})
