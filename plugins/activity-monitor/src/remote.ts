import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Deps, Provider, QuitResult, RunOptions } from './deps.ts'
import { createLinux } from './linux.ts'
import { createSampler } from './sampler.ts'
import type { CpuTimes } from './parse.ts'

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type SpawnResult = { code: number | null; out: string; err: string }
export type Spawn = (cmd: string, args: string[], input: string, timeoutMs: number) => Promise<SpawnResult>

export type RemoteDeps = Deps & {
  host: string
  error(): string | null
  close(): Promise<void>
}

const CONTROL_PATH = '/tmp/orca-am-' + (process.getuid ? process.getuid() : 0) + '-%C'
const BATCH_MAX = 2000
const IN_FLIGHT = 4
const EXEC_TIMEOUT_MS = 10_000
const CLOSE_TIMEOUT_MS = 5000
const SPACE_EVERY_MS = 10_000
const MAX_OUT = 32 * 1024 * 1024

export function sshArgs(host: string): string[] {
  if (!HOST_RE.test(host)) throw new Error('Invalid SSH host name')
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=' + CONTROL_PATH,
    '-o', 'ControlPersist=60',
    host,
    'sh', '-s'
  ]
}

const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'"

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

const defaultSpawn: Spawn = (cmd, args, input, timeoutMs) =>
  new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child: ReturnType<typeof spawnProcess>
    const finish = (result: SpawnResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish({ code: null, out, err: err || 'ssh timed out' })
    }, timeoutMs)
    try {
      child = spawnProcess(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
    } catch (error) {
      finish({ code: null, out: '', err: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
      if (out.length > MAX_OUT) {
        child.kill()
        finish({ code: null, out: '', err: 'ssh output too large' })
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      if (err.length < 4096) err += chunk
    })
    child.on('error', (error) => finish({ code: null, out, err: error.message }))
    child.on('close', (code) => finish({ code, out, err }))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })

type Op = { kind: 'read' | 'list' | 'readlink'; path: string; resolve: (text: string | null) => void }

export function sshDeps(host: string, spawn: Spawn = defaultSpawn): RemoteDeps {
  const args = sshArgs(host)
  let failure: string | null = null
  let queue: Op[] = []
  let scheduled = false
  let warm: Promise<unknown> | null = null
  let inFlight = 0
  const waiting: (() => void)[] = []

  async function acquire(): Promise<void> {
    if (inFlight < IN_FLIGHT) {
      inFlight += 1
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
  }

  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else inFlight -= 1
  }

  async function exec(script: string): Promise<SpawnResult> {
    const once = async () => {
      const result = await spawn('ssh', args, script, EXEC_TIMEOUT_MS)
      if (result.code === 255 || result.code === null) failure = firstLine(result.err) || 'ssh failed'
      else failure = null
      return result
    }
    if (!warm) {
      const first = once()
      warm = first.catch(() => undefined)
      return first
    }
    await warm
    await acquire()
    try {
      return await once()
    } finally {
      release()
    }
  }

  const failed = (result: SpawnResult) => result.code === 255 || result.code === null

  async function runBatch(ops: Op[]): Promise<void> {
    const mark = '@@am:' + randomBytes(8).toString('hex') + ':'
    const lines: string[] = []
    ops.forEach((op, i) => {
      lines.push("printf '\\n%s\\n' " + quote(mark + i))
      const command = op.kind === 'read' ? 'cat' : op.kind === 'list' ? 'ls -1A' : 'readlink'
      lines.push(command + ' -- ' + quote(op.path) + ' 2>/dev/null')
    })
    lines.push("printf '\\n%s\\n' " + quote(mark + 'end'))
    const result = await exec(lines.join('\n') + '\n')
    if (failed(result)) {
      for (const op of ops) op.resolve(null)
      return
    }
    const out = result.out
    let pos = out.indexOf('\n' + mark + '0\n')
    if (pos < 0) {
      for (const op of ops) op.resolve(null)
      return
    }
    pos += mark.length + 3
    for (let i = 0; i < ops.length; i++) {
      const next = '\n' + mark + (i + 1 < ops.length ? String(i + 1) : 'end') + '\n'
      const at = out.indexOf(next, pos)
      if (at < 0) {
        for (let j = i; j < ops.length; j++) ops[j].resolve(null)
        return
      }
      ops[i].resolve(out.slice(pos, at))
      pos = at + next.length
    }
  }

  function flush(): void {
    scheduled = false
    const taken = queue
    queue = []
    for (let i = 0; i < taken.length; i += BATCH_MAX) {
      runBatch(taken.slice(i, i + BATCH_MAX)).catch(() => {
        for (const op of taken.slice(i, i + BATCH_MAX)) op.resolve(null)
      })
    }
  }

  function enqueue(kind: Op['kind'], path: string): Promise<string | null> {
    return new Promise((resolve) => {
      queue.push({ kind, path, resolve })
      if (!scheduled) {
        scheduled = true
        setImmediate(flush)
      }
    })
  }

  return {
    host,
    error: () => failure,
    async run(command: string, commandArgs: string[], options?: RunOptions) {
      const script = 'exec ' + [command, ...commandArgs].map(quote).join(' ') + ' </dev/null\n'
      const result = await exec(script)
      if (failed(result)) return null
      if (result.code === 0) return result.out
      return options?.anyExit ? result.out : null
    },
    async read(path: string) {
      return (await enqueue('read', path)) ?? ''
    },
    async list(path: string) {
      return ((await enqueue('list', path)) ?? '').split('\n').filter(Boolean)
    },
    async readlink(path: string) {
      const text = await enqueue('readlink', path)
      return text === null ? null : text.trim() || null
    },
    async close() {
      await spawn('ssh', ['-O', 'exit', '-o', 'ControlPath=' + CONTROL_PATH, host], '', CLOSE_TIMEOUT_MS).catch(() => undefined)
    }
  }
}

export function sshHosts(configText: string): string[] {
  const seen = new Set<string>()
  for (const raw of configText.split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(raw.replace(/#.*$/, ''))
    if (!match) continue
    for (const token of match[1].trim().split(/\s+/)) {
      if (/[*?!]/.test(token) || !HOST_RE.test(token)) continue
      seen.add(token)
    }
  }
  return [...seen]
}

export function parseProcStatCpus(text: string): CpuTimes[] {
  const rows: { n: number; times: CpuTimes }[] = []
  for (const line of text.split('\n')) {
    const m = /^cpu(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+)\s+(\d+))?/.exec(line)
    if (!m) continue
    rows.push({ n: Number(m[1]), times: { user: Number(m[2]), nice: Number(m[3]), sys: Number(m[4]), idle: Number(m[5]), irq: Number(m[7] ?? 0) } })
  }
  return rows.sort((a, b) => a.n - b.n).map((r) => r.times)
}

export function parseStatF(text: string): { bsize: number; blocks: number; bfree: number; bavail: number } | null {
  const nums = text.trim().split(/\s+/).map(Number)
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null
  return { bsize: nums[0], blocks: nums[1], bfree: nums[2], bavail: nums[3] }
}

export function parseKill(out: string | null): QuitResult {
  if (out === null) return { ok: false, reason: 'Could not reach the machine' }
  if (/rc=0\s*$/.test(out)) return { ok: true }
  if (/No such process/i.test(out)) return { ok: false, reason: 'Already gone' }
  if (/not permitted/i.test(out)) return { ok: false, reason: 'Not allowed: another user owns it' }
  return { ok: false, reason: 'Could not quit it' }
}

export function createRemoteSampler(host: string, spawn?: Spawn) {
  const deps = sshDeps(host, spawn)
  const base = createLinux(deps, '', '.')
  const fail = (fallback: string) => new Error(deps.error() ?? fallback)
  let checked = false
  let spaceAt = 0
  let spaceLast: ReturnType<typeof parseStatF> = null
  const provider: Provider = {
    ...base,
    async info() {
      if (!checked) {
        const kernel = await deps.run('uname', ['-s'])
        if (kernel === null) throw fail('Could not reach the machine')
        if (kernel.trim() !== 'Linux') throw new Error('Only Linux machines are supported')
        checked = true
      }
      return base.info()
    },
    note: async () => null,
    async read() {
      const raw = await base.read()
      if (deps.error()) throw fail('Could not read the machine')
      return raw
    },
    quit: (pid, force) =>
      deps.run('sh', ['-c', 'kill -s "$1" "$2" 2>&1; echo "rc=$?"', 'sh', force ? 'KILL' : 'TERM', String(pid)], { anyExit: true }).then(parseKill)
  }
  const sampler = createSampler({
    provider,
    cpus: async () => {
      const list = parseProcStatCpus(await deps.read('/proc/stat'))
      if (!list.length) throw fail('Could not read CPU counters')
      return list
    },
    space: async (path) => {
      if (spaceAt && Date.now() - spaceAt < SPACE_EVERY_MS) return spaceLast
      spaceLast = parseStatF((await deps.run('stat', ['-f', '-c', '%S %b %f %a', path])) ?? '')
      spaceAt = spaceLast ? Date.now() : 0
      return spaceLast
    },
    selfPids: []
  })
  return { sampler, deps }
}
