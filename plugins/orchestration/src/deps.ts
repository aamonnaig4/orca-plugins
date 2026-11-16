import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'

export type RunResult = { code: number; stdout: string; stderr: string; missing: boolean }

export type Fs = {
  read(path: string): Promise<string | null>
  write(path: string, text: string, mode?: number): Promise<void>
  list(dir: string): Promise<string[]>
  remove(path: string): Promise<void>
  mkdir(dir: string): Promise<void>
}

export type Deps = {
  run(cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number; cwd?: string }): Promise<RunResult>
  now(): number
  home(): string
  env(name: string): string | undefined
  fs: Fs
}

const DEFAULT_TIMEOUT_MS = 20000
const MAX_BUFFER = 32 * 1024 * 1024

export const nodeFs: Fs = {
  read(path) {
    return readFile(path, 'utf8').catch(() => null)
  },
  async write(path, text, mode) {
    await writeFile(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  },
  list(dir) {
    return readdir(dir).catch(() => [] as string[])
  },
  async remove(path) {
    await rm(path, { force: true, recursive: true })
  },
  async mkdir(dir) {
    await mkdir(dir, { recursive: true })
  }
}

export const nodeDeps: Deps = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      let child: ReturnType<typeof execFile>
      try {
        child = execFile(
          cmd,
          args,
          { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, cwd: opts?.cwd, windowsHide: true },
          (error, stdout, stderr) => {
            if (!error) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), missing: false })
            const info = error as { code?: unknown; killed?: boolean; signal?: string | null }
            const code = info.code
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              return resolve({ code: 1, stdout: '', stderr: 'output too large: ' + error.message, missing: false })
            }
            if (info.killed === true) {
              return resolve({ code: 124, stdout: String(stdout), stderr: 'timeout', missing: false })
            }
            if (info.signal) {
              const err = String(stderr)
              return resolve({ code: 1, stdout: String(stdout), stderr: (err ? err + '\n' : '') + 'killed by ' + info.signal, missing: false })
            }
            if (code === 'ENOENT') {
              if (opts?.cwd === undefined || existsSync(opts.cwd)) {
                return resolve({ code: 127, stdout: '', stderr: String(stderr), missing: true })
              }
              return resolve({ code: 1, stdout: '', stderr: error.message, missing: false })
            }
            resolve({
              code: typeof code === 'number' ? code : 1,
              stdout: String(stdout),
              stderr: String(stderr) || error.message,
              missing: false
            })
          }
        )
      } catch (error) {
        resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), missing: false })
        return
      }
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts?.input)
    })
  },
  now() {
    return Date.now()
  },
  home() {
    return os.homedir()
  },
  env(name) {
    return process.env[name]
  },
  fs: nodeFs
}

export type Bins = { orca: string; gh: string | null }

export async function resolveBins(deps: Deps): Promise<Bins> {
  const override = deps.env('ORCA_CLI_COMMAND')
  const script = 'echo "orca=$(command -v orca)"; echo "gh=$(command -v gh)"'
  const result = await deps.run('/bin/zsh', ['-lc', script])
  let orca = ''
  let gh: string | null = null
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key === 'orca' && value) orca = value
    if (key === 'gh' && value) gh = value
  }
  if (!override && !orca && (await deps.fs.read(APP_ORCA)) !== null) orca = APP_ORCA
  return { orca: override || orca || 'orca', gh }
}

export const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

export type FixMode = 'fix' | 'ask' | 'ignore'

export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh'

export type PermissionMode = '' | 'auto' | 'manual' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions'

export type Settings = {
  orchestratorAgent: string
  workerAgent: string
  suffix: string
  intervalSec: number
  attempts: number
  guard: boolean
  onCi: FixMode
  onConflict: FixMode
  onReview: FixMode
  noAgent: 'start' | 'ask'
  scope: 'all' | 'workers'
  model: string
  effort: Effort
  fast: boolean
  plan: boolean
  permissionMode: PermissionMode
}

export const DEFAULT_SETTINGS: Settings = {
  orchestratorAgent: '',
  workerAgent: '',
  suffix: '-oa',
  intervalSec: 60,
  attempts: 3,
  guard: true,
  onCi: 'fix',
  onConflict: 'fix',
  onReview: 'fix',
  noAgent: 'start',
  scope: 'all',
  model: '',
  effort: '',
  fast: false,
  plan: false,
  permissionMode: ''
}

const INTERVALS = [30, 60, 120, 300]
const ATTEMPTS = [1, 2, 3, 5]
export const FIX_MODES: FixMode[] = ['fix', 'ask', 'ignore']
export const NO_AGENT: Settings['noAgent'][] = ['start', 'ask']
export const SCOPES: Settings['scope'][] = ['all', 'workers']
export const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku']
export const EFFORTS: Effort[] = ['', 'low', 'medium', 'high', 'xhigh']
export const PERMISSION_MODES: PermissionMode[] = ['', 'auto', 'manual', 'acceptEdits', 'dontAsk', 'bypassPermissions']

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function choice(value: unknown, allowed: number[], fallback: number): number {
  return typeof value === 'number' && allowed.includes(value) ? value : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function readSettings(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS
  return {
    orchestratorAgent: text(raw.orchestratorAgent, d.orchestratorAgent),
    workerAgent: text(raw.workerAgent, d.workerAgent),
    suffix: text(raw.suffix, d.suffix),
    intervalSec: choice(raw.intervalSec, INTERVALS, d.intervalSec),
    attempts: choice(raw.attempts, ATTEMPTS, d.attempts),
    guard: flag(raw.guard, d.guard),
    onCi: oneOf(raw.onCi, FIX_MODES, d.onCi),
    onConflict: oneOf(raw.onConflict, FIX_MODES, d.onConflict),
    onReview: oneOf(raw.onReview, FIX_MODES, d.onReview),
    noAgent: oneOf(raw.noAgent, NO_AGENT, d.noAgent),
    scope: oneOf(raw.scope, SCOPES, raw.autoFixYours === false ? 'workers' : d.scope),
    model: oneOf(raw.model, MODELS, d.model),
    effort: oneOf(raw.effort, EFFORTS, d.effort),
    fast: flag(raw.fast, d.fast),
    plan: flag(raw.plan, d.plan),
    permissionMode: oneOf(raw.permissionMode, PERMISSION_MODES, d.permissionMode)
  }
}
