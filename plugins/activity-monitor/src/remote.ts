import { spawn as nodeSpawn } from 'node:child_process'
import type { Deps, Provider, QuitResult } from './deps.ts'
import { createLinux } from './linux.ts'
import type { CpuTimes } from './parse.ts'

export type SshTarget = {
  id: string
  label: string
  configHost?: string | null
  host?: string | null
  port?: number | null
  username?: string | null
  identityFile?: string | null
  identitiesOnly?: boolean | null
}

export type Snapshot = {
  at: number
  files: Map<string, string>
  stats: Map<number, string>
  uids: Map<number, number>
  df: string
  smi: string | null
  procs: boolean
}

export type Init = { clk: number; page: number; home: string; passwd: string; cpuinfo: string; host: string; os: string }

export type Space = { blocks: number; bsize: number; bavail: number; bfree: number }

export type HostInfo = {
  name: string
  load: number[] | null
  cpuLimit: number | null
  memLimit: number | null
  memUsed: number | null
}

const FILES = ['/proc/stat', '/proc/meminfo', '/proc/pressure/memory', '/proc/net/route', '/proc/net/dev', '/proc/diskstats', '/proc/loadavg']

export const SCRIPT = [
  'export LC_ALL=C',
  'cg=/sys/fs/cgroup/user.slice/user-$(id -u).slice',
  'printf "@@init\\n"',
  'printf "clk %s\\n" "$(getconf CLK_TCK 2>/dev/null)"',
  'printf "page %s\\n" "$(getconf PAGESIZE 2>/dev/null)"',
  'printf "home %s\\n" "$HOME"',
  'printf "host %s\\n" "$(hostname 2>/dev/null)"',
  'printf "os %s\\n" "$(uname -s 2>/dev/null)"',
  'printf "@@passwd\\n"; cat /etc/passwd 2>/dev/null',
  'printf "@@cpuinfo\\n"; grep -m1 "^model name" /proc/cpuinfo 2>/dev/null',
  'printf "@@ready\\n"',
  'smi=""; command -v nvidia-smi >/dev/null 2>&1 && smi=1',
  'while IFS= read -r want; do',
  '  printf "@@begin\\n"',
  '  for f in ' + FILES.join(' ') + ' $cg/cpu.max $cg/memory.max $cg/memory.current; do',
  '    [ -r "$f" ] && { printf "@@file %s\\n" "$f"; cat "$f" 2>/dev/null; }',
  '  done',
  '  printf "@@df\\n"; df -kP "$HOME" 2>/dev/null | tail -n 1',
  '  [ -n "$smi" ] && { printf "@@smi\\n"; nvidia-smi --query-gpu=utilization.gpu,name --format=csv,noheader,nounits 2>/dev/null; }',
  '  if [ "$want" = procs ]; then',
  '    printf "@@stats\\n"',
  '    for f in /proc/[0-9]*/stat; do { read -r l < "$f"; } 2>/dev/null && printf "%s\\n" "$l"; done',
  '    printf "@@uids\\n"; ps -eo pid=,uid= 2>/dev/null',
  '  fi',
  '  printf "@@end\\n"',
  'done'
].join('\n')

function sections(text: string): { name: string; arg: string; body: string[] }[] {
  const out: { name: string; arg: string; body: string[] }[] = []
  let cur: { name: string; arg: string; body: string[] } | null = null
  for (const line of text.split('\n')) {
    const m = /^@@(\w+)(?: (.*))?$/.exec(line)
    if (m) {
      cur = { name: m[1], arg: m[2] ?? '', body: [] }
      out.push(cur)
    } else if (cur) cur.body.push(line)
  }
  return out
}

const text = (lines: string[]) => lines.join('\n').replace(/\n+$/, '') + '\n'

export function parseInit(raw: string): Init {
  const init: Init = { clk: 100, page: 4096, home: '', passwd: '', cpuinfo: '', host: '', os: '' }
  for (const s of sections(raw)) {
    if (s.name === 'init') {
      for (const line of s.body) {
        const m = /^(\w+) (.*)$/.exec(line)
        if (!m) continue
        if (m[1] === 'clk') init.clk = Number(m[2]) || 100
        if (m[1] === 'page') init.page = Number(m[2]) || 4096
        if (m[1] === 'home') init.home = m[2].trim()
        if (m[1] === 'host') init.host = m[2].trim()
        if (m[1] === 'os') init.os = m[2].trim()
      }
    }
    if (s.name === 'passwd') init.passwd = text(s.body)
    if (s.name === 'cpuinfo') init.cpuinfo = text(s.body)
  }
  return init
}

export function parseSnapshot(raw: string, at = Date.now()): Snapshot {
  const snap: Snapshot = { at, files: new Map(), stats: new Map(), uids: new Map(), df: '', smi: null, procs: false }
  for (const s of sections(raw)) {
    if (s.name === 'file' && s.arg) snap.files.set(s.arg, text(s.body))
    else if (s.name === 'df') snap.df = s.body.join('\n').trim()
    else if (s.name === 'smi') snap.smi = text(s.body)
    else if (s.name === 'stats') {
      snap.procs = true
      for (const line of s.body) {
        const m = /^(\d+) \(/.exec(line)
        if (m) snap.stats.set(Number(m[1]), line)
      }
    } else if (s.name === 'uids') {
      for (const line of s.body) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (m) snap.uids.set(Number(m[1]), Number(m[2]))
      }
    }
  }
  return snap
}

export function parseCpuTimes(stat: string): CpuTimes[] {
  const out: CpuTimes[] = []
  for (const line of stat.split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = m[2].trim().split(/\s+/).map(Number)
    out[Number(m[1])] = { user, nice, sys, idle: idle + iowait, irq: irq + softirq + steal }
  }
  return out.filter(Boolean)
}

export function parseDf(line: string): Space | null {
  const f = line.trim().split(/\s+/)
  if (f.length < 6) return null
  const [blocks, used, avail] = [Number(f[1]), Number(f[2]), Number(f[3])]
  if (![blocks, used, avail].every(Number.isFinite)) return null
  return { blocks, bsize: 1024, bavail: avail, bfree: Math.max(0, blocks - used) }
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const t = v.trim()
  if (!t || t === 'max') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function hostInfo(snap: Snapshot, name: string): HostInfo {
  const files = [...snap.files.entries()]
  const pick = (suffix: string) => files.find(([path]) => path.endsWith(suffix))?.[1]
  const load = (snap.files.get('/proc/loadavg') ?? '').trim().split(/\s+/).slice(0, 3).map(Number)
  const cpuMax = (pick('/cpu.max') ?? '').trim().split(/\s+/)
  const quota = num(cpuMax[0])
  const period = num(cpuMax[1])
  return {
    name,
    load: load.length === 3 && load.every(Number.isFinite) ? load : null,
    cpuLimit: quota !== null && period ? quota / period : null,
    memLimit: num(pick('/memory.max')),
    memUsed: num(pick('/memory.current'))
  }
}

export function snapshotDeps(get: () => { snap: Snapshot | null; init: Init | null }): Deps {
  return {
    async run(command, args) {
      const { snap, init } = get()
      if (command === 'getconf' && init) return String(args[0] === 'CLK_TCK' ? init.clk : init.page)
      if (command === 'nvidia-smi') return snap?.smi ?? null
      return null
    },
    async read(path) {
      const { snap, init } = get()
      if (path === '/etc/passwd') return init?.passwd ?? ''
      if (path === '/proc/cpuinfo') return init?.cpuinfo ?? ''
      if (!snap) return ''
      const proc = /^\/proc\/(\d+)\/(stat|status)$/.exec(path)
      if (proc) {
        const pid = Number(proc[1])
        if (proc[2] === 'stat') return snap.stats.get(pid) ?? ''
        const uid = snap.uids.get(pid)
        return uid === undefined ? '' : 'Uid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid + '\n'
      }
      return snap.files.get(path) ?? ''
    },
    async list(path) {
      const { snap } = get()
      if (path === '/proc' && snap?.procs) return [...snap.stats.keys()].map(String)
      return []
    },
    async readlink() {
      return null
    }
  }
}

type Child = {
  stdin: { write(s: string): unknown; end(): unknown } | null
  stdout: { on(ev: 'data', fn: (b: Buffer | string) => void): unknown } | null
  stderr: { on(ev: 'data', fn: (b: Buffer | string) => void): unknown } | null
  on(ev: 'exit', fn: (code: number | null) => void): unknown
  on(ev: 'error', fn: (e: Error) => void): unknown
  kill(signal?: string): unknown
}

export type SpawnFn = (command: string, args: string[]) => Child

const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.:%[\]-]{0,253}$/
const SAFE_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/

export function sshArgs(t: SshTarget): string[] {
  const dest = t.configHost || t.host || t.label
  if (!SAFE_HOST.test(dest)) throw new Error('Unsupported SSH host name: ' + dest)
  if (!t.configHost && t.host && t.username && !SAFE_USER.test(t.username)) throw new Error('Unsupported SSH user name: ' + t.username)
  const opts = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
  const remote = 'exec sh -c ' + "'" + SCRIPT + "'"
  if (t.configHost) return [...opts, t.configHost, remote]
  if (!t.host) return [...opts, t.label, remote]
  const extra: string[] = []
  if (t.port && t.port !== 22) extra.push('-p', String(t.port))
  if (t.identityFile) extra.push('-i', t.identityFile)
  if (t.identitiesOnly) extra.push('-o', 'IdentitiesOnly=yes')
  return [...opts, ...extra, (t.username ? t.username + '@' : '') + t.host, remote]
}

export type LinkState = { status: 'idle' | 'connecting' | 'connected' | 'error'; error: string | null }

const SNAP_TIMEOUT_MS = 12000
const IDLE_CLOSE_MS = 60000
const RETRY_MS = 5000

export function createLink(target: SshTarget, options: { spawn?: SpawnFn; clock?: () => number } = {}) {
  const spawn: SpawnFn = options.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as Child)
  const clock = options.clock ?? Date.now
  let child: Child | null = null
  let buf = ''
  let init: Init | null = null
  let snap: Snapshot | null = null
  let ready: Promise<void> | null = null
  let onReady: (() => void) | null = null
  let onFail: ((e: Error) => void) | null = null
  let waiting: { resolve: (s: Snapshot) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  let state: LinkState = { status: 'idle', error: null }
  let stderr = ''
  let lastUse = clock()
  let failedAt = -Infinity
  const idle = setInterval(() => {
    if (child && clock() - lastUse > IDLE_CLOSE_MS) close()
  }, 15000)
  ;(idle as { unref?: () => void }).unref?.()

  function fail(error: Error): void {
    state = { status: 'error', error: error.message }
    failedAt = clock()
    if (onFail) onFail(error)
    onReady = onFail = null
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
      waiting = null
    }
    const c = child
    child = null
    ready = null
    buf = ''
    if (c) c.kill()
  }

  function consume(): void {
    if (!init) {
      const at = buf.indexOf('@@ready\n')
      if (at < 0) return
      const parsed = parseInit(buf.slice(0, at))
      if (parsed.os && parsed.os !== 'Linux') {
        fail(new Error('Only Linux servers are supported; ' + target.label + ' runs ' + parsed.os))
        return
      }
      init = parsed
      buf = buf.slice(at + '@@ready\n'.length)
      state = { status: 'connected', error: null }
      if (onReady) onReady()
      onReady = onFail = null
    }
    const end = buf.indexOf('@@end\n')
    if (end < 0) return
    const chunk = buf.slice(0, end)
    buf = buf.slice(end + '@@end\n'.length)
    snap = parseSnapshot(chunk, clock())
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.resolve(snap)
      waiting = null
    }
  }

  function open(): Promise<void> {
    if (ready) return ready
    state = { status: 'connecting', error: null }
    init = null
    stderr = ''
    const opening = new Promise<void>((resolve, reject) => {
      onReady = resolve
      onFail = reject
    })
    opening.catch(() => undefined)
    ready = opening
    let args: string[]
    try {
      args = sshArgs(target)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      return opening
    }
    const c = spawn('ssh', args)
    child = c
    c.stdout?.on('data', (b) => {
      buf += String(b)
      consume()
    })
    c.stderr?.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-2000)
    })
    c.on('error', (e) => {
      if (child === c) fail(new Error('Could not start ssh: ' + e.message))
    })
    c.on('exit', (code) => {
      if (child !== c) return
      const last = stderr.trim().split('\n').filter(Boolean).pop()
      fail(new Error(last || 'SSH to ' + target.label + ' closed' + (code === null ? '' : ' (exit ' + code + ')')))
    })
    return opening
  }

  async function snapshot(procs: boolean): Promise<Snapshot> {
    lastUse = clock()
    if (!child && state.status === 'error' && clock() - failedAt < RETRY_MS) throw new Error(state.error ?? 'No connection')
    await open()
    if (waiting) {
      const w = waiting
      return new Promise<Snapshot>((resolve, reject) => {
        const [res, rej] = [w.resolve, w.reject]
        w.resolve = (s) => { res(s); resolve(s) }
        w.reject = (e) => { rej(e); reject(e) }
      })
    }
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('No answer from ' + target.label)), SNAP_TIMEOUT_MS)
      waiting = { resolve, reject, timer }
      child?.stdin?.write(procs ? 'procs\n' : 'tick\n')
    })
  }

  function close(): void {
    const c = child
    child = null
    ready = null
    buf = ''
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('Closed'))
      waiting = null
    }
    state = { status: 'idle', error: null }
    if (c) {
      c.stdin?.end()
      c.kill()
    }
  }

  function dispose(): void {
    clearInterval(idle)
    close()
  }

  return { target, snapshot, close, dispose, state: () => state, init: () => init, latest: () => snap }
}

export type Link = ReturnType<typeof createLink>

const PROCS_WANTED_MS = 10000

export function createRemote(link: Link, clock: () => number = Date.now) {
  let wantProcsAt = -Infinity
  let refreshing: Promise<void> | null = null
  const deps = snapshotDeps(() => ({ snap: link.latest(), init: link.init() }))
  const linux = createLinux(deps, '', '')

  function refresh(): Promise<void> {
    if (!refreshing) {
      refreshing = link.snapshot(clock() - wantProcsAt < PROCS_WANTED_MS).then(() => undefined).finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  const refused = (): Promise<QuitResult> => Promise.resolve({ ok: false, reason: 'Processes on ' + link.target.label + ' are read-only here' })

  const provider: Provider & { refresh(): Promise<void> } = {
    ...linux,
    diskName: 'Home',
    procEvery: 2000,
    detailsEvery: 4000,
    refresh,
    note: async () => null,
    async read() {
      const raw = await linux.read()
      const snap = link.latest()
      return { ...raw, host: snap ? hostInfo(snap, link.init()?.host || link.target.label) : null }
    },
    async procs() {
      wantProcsAt = clock()
      return linux.procs()
    },
    async details(energy) {
      wantProcsAt = clock()
      return linux.details(energy)
    },
    quit: refused,
    cwds: async () => new Map(),
    args: async () => new Map()
  }

  return {
    provider,
    cpus: () => parseCpuTimes(link.latest()?.files.get('/proc/stat') ?? ''),
    space: async () => parseDf(link.latest()?.df ?? ''),
    host: (): HostInfo | null => {
      const snap = link.latest()
      return snap ? hostInfo(snap, link.init()?.host || link.target.label) : null
    }
  }
}
