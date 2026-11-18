import { stripAnsi } from "../ansi"

/**
 * Scans terminal output for failure signatures so the assistant can offer a diagnosis
 * without the human asking first.
 */

export type ErrorSeverity = "critical" | "error" | "warning"

export type ErrorCategory = "runtime" | "service" | "network" | "permission" | "resource" | "build"

export interface ErrorFinding {
  readonly severity: ErrorSeverity
  readonly category: ErrorCategory
  readonly pattern: string
  readonly line: string
  readonly lineNumber: number
}

interface Rule {
  readonly id: string
  readonly severity: ErrorSeverity
  readonly category: ErrorCategory
  readonly pattern: RegExp
}

const RULES: readonly Rule[] = [
  { id: "python-traceback", severity: "error", category: "runtime", pattern: /Traceback \(most recent call last\)/ },
  { id: "node-exception", severity: "error", category: "runtime", pattern: /\b(?:TypeError|ReferenceError|RangeError|SyntaxError): / },
  { id: "go-panic", severity: "critical", category: "runtime", pattern: /^panic: / },
  { id: "segfault", severity: "critical", category: "runtime", pattern: /Segmentation fault|core dumped/ },
  { id: "java-exception", severity: "error", category: "runtime", pattern: /Exception in thread "|java\.lang\.\w+Exception/ },
  { id: "systemd-failed", severity: "error", category: "service", pattern: /Failed to (?:start|restart) .+|Active: failed/ },
  { id: "service-exit", severity: "error", category: "service", pattern: /Main process exited, code=exited, status=\d+/ },
  { id: "oom-killed", severity: "critical", category: "resource", pattern: /OOMKilled|Out of memory|Killed process \d+/ },
  { id: "disk-full", severity: "critical", category: "resource", pattern: /No space left on device/ },
  { id: "permission-denied", severity: "error", category: "permission", pattern: /Permission denied/ },
  { id: "command-not-found", severity: "warning", category: "runtime", pattern: /command not found|: not found$/ },
  { id: "connection-refused", severity: "error", category: "network", pattern: /Connection refused|ECONNREFUSED/ },
  { id: "connection-timeout", severity: "warning", category: "network", pattern: /Connection timed out|ETIMEDOUT|timed out after/ },
  { id: "dns-failure", severity: "error", category: "network", pattern: /Could not resolve host|Name or service not known|ENOTFOUND/ },
  { id: "tls-failure", severity: "error", category: "network", pattern: /SSL certificate problem|CERT_HAS_EXPIRED|self[- ]signed certificate/ },
  { id: "http-5xx", severity: "error", category: "network", pattern: /\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/ },
  { id: "npm-error", severity: "error", category: "build", pattern: /npm ERR!|pnpm ERR!|yarn error/i },
  { id: "tsc-error", severity: "error", category: "build", pattern: /error TS\d+:/ },
  { id: "rust-error", severity: "error", category: "build", pattern: /^error\[E\d+\]: / },
  { id: "docker-error", severity: "error", category: "service", pattern: /Error response from daemon:/ },
]

const MAX_FINDINGS = 50

export function detectErrors(text: string): ErrorFinding[] {
  const findings: ErrorFinding[] = []
  const lines = stripAnsi(text).split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue
      findings.push({
        severity: rule.severity,
        category: rule.category,
        pattern: rule.id,
        line: line.trim().slice(0, 500),
        lineNumber: index + 1,
      })
      break
    }
    if (findings.length >= MAX_FINDINGS) break
  }

  return findings
}

/** True when at least one finding should trigger a proactive analysis proposal. */
export function shouldProposeAnalysis(findings: readonly ErrorFinding[]): boolean {
  return findings.some((finding) => finding.severity !== "warning")
}
