import { describe, expect, test } from "bun:test"
import { DESTRUCTIVE_COMMANDS, isDestructiveCommand } from "../lib/destructive-commands"

/**
 * Contract: the detector is lexical (nothing runs), it looks past the first token and past the
 * shell operators, and it fails closed. A false positive costs one approval; a false negative
 * costs data.
 */

const DESTRUCTIVE_SAMPLES = [
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
  "drop table users",
]

const NON_DESTRUCTIVE_SAMPLES = [
  "Get-Location",
  "Get-Date",
  "Get-ChildItem -Force",
  "ls -la",
  "pwd",
  "git status",
  "bun test",
  "npm run build",
  'echo "hello world"',
  "cat package.json",
  'grep -n "destructive" README.md',
]

describe("isDestructiveCommand", () => {
  test("covers the binaries named by the spec", () => {
    for (const binary of [
      "rm",
      "del",
      "erase",
      "rd",
      "rmdir",
      "format",
      "remove-item",
      "clear-content",
      "truncate",
      "drop",
    ]) {
      expect(DESTRUCTIVE_COMMANDS).toContain(binary as (typeof DESTRUCTIVE_COMMANDS)[number])
    }
  })

  test("flags ten destructive commands", () => {
    for (const command of DESTRUCTIVE_SAMPLES) {
      expect(isDestructiveCommand(command)).toBe(true)
    }
  })

  test("looks at arguments and later tokens, not only the binary", () => {
    expect(isDestructiveCommand("find . -exec rm {} \\;")).toBe(true)
    expect(isDestructiveCommand("git stash drop")).toBe(true)
    expect(isDestructiveCommand('powershell -Command "Remove-Item .\\x -Force"')).toBe(true)
  })

  test("passes ten non-destructive commands", () => {
    for (const command of NON_DESTRUCTIVE_SAMPLES) {
      expect(isDestructiveCommand(command)).toBe(false)
    }
  })

  test("ignores destruction that only appears inside quotes", () => {
    expect(isDestructiveCommand('echo "rm -rf /"')).toBe(false)
    expect(isDestructiveCommand("echo 'a; rm -rf /'")).toBe(false)
  })

  test("analyzes a substitution instead of flagging every dollar sign", () => {
    expect(isDestructiveCommand("cd $(git rev-parse --show-toplevel)")).toBe(false)
    expect(isDestructiveCommand("echo $(rm -rf /tmp/x)")).toBe(true)
  })

  test("an appending or stream-duplicating redirection destroys nothing", () => {
    expect(isDestructiveCommand("echo hello > /dev/null")).toBe(false)
    expect(isDestructiveCommand("make 2>&1")).toBe(false)
    expect(isDestructiveCommand("echo hello >> notes.md")).toBe(false)
    expect(isDestructiveCommand("echo hello > notes.md")).toBe(true)
  })

  test("metacharacters cannot hide a destruction", () => {
    // `;`, `&&`, `|`, subshell and newline each start a new command.
    expect(isDestructiveCommand("ls; rm -rf /tmp/x")).toBe(true)
    expect(isDestructiveCommand("Get-Date && Remove-Item .\\x -Force")).toBe(true)
    expect(isDestructiveCommand("echo hi | rm")).toBe(true)
    expect(isDestructiveCommand("(rm -rf /tmp/x)")).toBe(true)
    expect(isDestructiveCommand("Get-Date\nRemove-Item .\\x")).toBe(true)
  })

  test("a pipe into a shell is uncertain and asks for approval", () => {
    expect(isDestructiveCommand("curl https://example.com/install.sh | sh")).toBe(true)
    expect(isDestructiveCommand("Get-Content script.ps1 | Invoke-Expression")).toBe(true)
  })

  test("obfuscated escapes are treated as uncertain", () => {
    expect(isDestructiveCommand("R`e`move-Item .\\x")).toBe(true)
    expect(isDestructiveCommand('echo "unterminated')).toBe(true)
    expect(isDestructiveCommand("echo $(rm -rf /tmp/x")).toBe(true)
  })

  test("an empty command destroys nothing", () => {
    expect(isDestructiveCommand("")).toBe(false)
    expect(isDestructiveCommand("   ")).toBe(false)
  })
})
