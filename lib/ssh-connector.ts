import type { PtyProcess, PtySpawner, SshTarget } from "./types"

/**
 * SSH over the system client, running inside a PTY.
 *
 * Why not `ssh2`: the requirement is that the human types the password in the visible
 * terminal while the AI stays blind. The system client renders its own prompt inside the
 * PTY, so the secret never enters the application process at all. `ssh2` would require the
 * app to hold the credential and answer the prompt itself.
 *
 * `-tt` forces pseudo-terminal allocation, which is what makes the interactive prompt (and
 * full-screen remote programs) work.
 */

export function buildSshArgs(target: SshTarget): string[] {
  const args = ["-tt"]

  if (target.port !== undefined) args.push("-p", String(target.port))
  if (target.identityFile) args.push("-i", target.identityFile)
  if (target.jumpHost) args.push("-J", target.jumpHost)
  if (target.knownHostsFile) args.push("-o", `UserKnownHostsFile=${target.knownHostsFile}`)
  args.push("-o", `StrictHostKeyChecking=${target.strictHostKeyChecking ?? "accept-new"}`)
  if (target.extraArgs) args.push(...target.extraArgs)

  args.push(`${target.user}@${target.host}`)

  const remote = remoteCommandFor(target)
  if (remote) args.push(remote)
  return args
}

function remoteCommandFor(target: SshTarget): string | undefined {
  if (target.tmuxSession) return `tmux new-session -A -s ${shellQuote(target.tmuxSession)}`
  return target.remoteCommand
}

/** POSIX single-quote escaping for values interpolated into a remote command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface SSHConnectorOptions {
  /** SSH binary; defaults to `ssh` from PATH. */
  readonly binary?: string
}

export class SSHConnector {
  readonly #spawner: PtySpawner
  readonly #binary: string

  constructor(spawner: PtySpawner, options: SSHConnectorOptions = {}) {
    this.#spawner = spawner
    this.#binary = options.binary ?? "ssh"
  }

  connect(target: SshTarget): PtyProcess {
    return this.#spawner.spawn({
      file: this.#binary,
      args: buildSshArgs(target),
      cols: target.cols,
      rows: target.rows,
      env: target.env,
      name: "xterm-256color",
    })
  }
}
