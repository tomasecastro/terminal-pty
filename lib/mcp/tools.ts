import { detectErrors, shouldProposeAnalysis } from "../ai/error-detector"
import type { SessionManager } from "../session-manager"

/**
 * MCP surface for the assistant.
 *
 * `execute_command` never runs anything by itself: it files a proposal and returns
 * `requires-approval`, so the human keeps the final say (FR-004).
 */

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties?: boolean
  }
}

export interface ToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly isError?: boolean
}

export const PTY_SESSION_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "read_terminal",
    description:
      "Read the plain-text tail of the session's PTY. Escape sequences are stripped. While a credential prompt is active the output is withheld.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        lines: { type: "number", description: "How many trailing lines to read (default 200)" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_command",
    description:
      "Propose a command for the session. The human must approve it before it runs, unless it is an allowlisted read-only command and auto-approve is enabled.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        command: { type: "string", description: "Exact command to run" },
        explanation: { type: "string", description: "Why this command helps, shown to the human" },
      },
      required: ["sessionId", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_prompt",
    description: "Wait until the terminal output matches a regular expression, or until the timeout elapses.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        prompt: { type: "string", description: "Regular expression to match against the buffer" },
        timeoutMs: { type: "number", description: "Maximum wait in milliseconds (default 15000)" },
      },
      required: ["sessionId", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "get_session_info",
    description: "Return status, host, credential-blinding state and full-screen app detection for a session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
]

export interface PtySessionTools {
  readonly definitions: readonly McpToolDefinition[]
  call(call: ToolCall): Promise<ToolResult>
}

export function createPtySessionTools(manager: SessionManager): PtySessionTools {
  return {
    definitions: PTY_SESSION_TOOLS,
    async call(call) {
      const sessionId = readString(call.arguments, "sessionId")
      if (sessionId === null) return error("Missing required argument: sessionId")

      switch (call.name) {
        case "read_terminal": {
          const lines = readNumber(call.arguments, "lines") ?? 200
          const snapshot = manager.snapshot(sessionId, lines)
          const findings = detectErrors(snapshot.text)
          return ok({
            ...snapshot,
            errors: findings,
            suggestAnalysis: shouldProposeAnalysis(findings),
          })
        }

        case "execute_command": {
          const command = readString(call.arguments, "command")
          if (command === null) return error("Missing required argument: command")
          const explanation = readString(call.arguments, "explanation") ?? ""
          const outcome = manager.proposeCommand(sessionId, command, explanation)
          return ok(outcome)
        }

        case "wait_for_prompt": {
          const prompt = readString(call.arguments, "prompt")
          if (prompt === null) return error("Missing required argument: prompt")
          const timeoutMs = readNumber(call.arguments, "timeoutMs") ?? 15_000
          const result = await manager.waitForPrompt(sessionId, prompt, timeoutMs)
          return ok(result)
        }

        case "get_session_info":
          return ok(manager.info(sessionId))

        default:
          return error(`Unknown tool: ${call.name}`)
      }
    },
  }
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
