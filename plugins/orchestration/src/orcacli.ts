import type { Deps } from './deps.ts'

export class CliError extends Error {
  code: string
  retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.retryable = retryable
  }
}

const RETRYABLE = new Set(['runtime_unavailable', 'timeout'])

type Envelope = { ok?: boolean; result?: unknown; error?: { code?: unknown; message?: unknown } }

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && code ? code : fallback
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
  return typeof message === 'string' && message ? message : fallback
}

export function createCli(deps: Deps, bin: string) {
  let commands = new Set<string>()

  async function json<T>(args: string[]): Promise<T> {
    const argv = args[args.length - 1] === '--json' ? args : [...args, '--json']
    const res = await deps.run(bin, argv)
    if (res.missing) throw new CliError('orca_missing', 'The orca command was not found')
    let body: Envelope | null = null
    try {
      body = JSON.parse(res.stdout) as Envelope
    } catch {
      body = null
    }
    if (body && typeof body === 'object' && body.ok === false) {
      const code = errorCode(body.error, 'unknown')
      throw new CliError(code, errorMessage(body.error, code), RETRYABLE.has(code))
    }
    if (res.code === 124) throw new CliError('timeout', 'orca timed out', true)
    if (res.code !== 0) throw new CliError('exit_' + res.code, res.stderr.trim() || 'orca exited with ' + res.code)
    if (!body || typeof body !== 'object' || body.ok !== true || !('result' in body)) {
      throw new CliError('bad_output', 'orca printed something that is not a result envelope')
    }
    return body.result as T
  }

  function has(command: string): boolean {
    return commands.has(command)
  }

  async function load(): Promise<void> {
    const res = await deps.run(bin, ['agent-context', '--json'])
    if (res.missing) throw new CliError('orca_missing', 'The orca command was not found')
    let parsed: unknown
    try {
      parsed = JSON.parse(res.stdout)
    } catch {
      parsed = null
    }
    const body =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { ok?: unknown; error?: unknown; commands?: unknown })
        : null
    if (body && body.ok === false) {
      const code = errorCode(body.error, 'bad_output')
      throw new CliError(code, errorMessage(body.error, code), RETRYABLE.has(code))
    }
    if (res.code === 124) throw new CliError('timeout', 'orca timed out', true)
    if (res.code !== 0) throw new CliError('bad_output', res.stderr.trim() || 'orca exited with ' + res.code)
    if (!body || !Array.isArray(body.commands)) {
      throw new CliError('bad_output', 'orca agent-context printed something that is not a command list')
    }
    const next = new Set<string>()
    for (const entry of body.commands as unknown[]) {
      if (entry && typeof entry === 'object' && typeof (entry as { command?: unknown }).command === 'string') {
        next.add((entry as { command: string }).command)
      }
    }
    commands = next
  }

  return { json, has, load }
}
