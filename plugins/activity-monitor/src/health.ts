import type { Proc } from './parse.ts'

export type Level = 'ok' | 'warn' | 'risk' | 'crit'

export type Reading = {
  at: number
  total: number
  memory: { total: number; used: number }
  swap: number | null
  swapTotal?: number | null
  pressure: string | null
}

export type Culprit = { pid: number; name: string; start: string | null; app: string; mem: number; quittable: boolean }

export type Health = {
  level: Level
  step: Step
  word: string
  cause: string
  memPct: number
  swapPct: number | null
  swapRate: number | null
  culprit: Culprit | null
  alertAt: number
}

export type Alert = { kind: 'toast' | 'notify'; title: string; body: string }

const GB = 1024 ** 3
const RANK: Record<Level, number> = { ok: 0, warn: 1, risk: 2, crit: 3 }
const LEVELS: Level[] = ['ok', 'warn', 'risk', 'crit']
const WINDOW = 60_000
const MIN_SPAN = 20_000
const UP_AFTER_MS = 5_000
const DOWN_AFTER_MS = 15_000
export const QUIET = 10 * 60_000
export const CRIT_AT = 95
export const CRIT_MIN = 70
export const CRIT_MAX = 99

export function clampCritAt(n: unknown, fallback = CRIT_AT): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(CRIT_MAX, Math.max(CRIT_MIN, Math.round(n)))
}

export const STEPS = ['Idle', 'Healthy', 'Busy', 'Strained', 'Critical'] as const
export type Step = 0 | 1 | 2 | 3 | 4
const CPU_WINDOW = 10_000

export function stepOf(level: Level, cpu: number, memPct: number): Step {
  if (level === 'risk' || level === 'crit') return 4
  if (level === 'warn') return 3
  if (cpu >= 70) return 2
  if (cpu < 10 && memPct < 60) return 0
  return 1
}

export function swapRate(ring: Reading[]): number | null {
  const pts = ring.filter((r) => r.swap !== null)
  if (pts.length < 2) return null
  const first = pts[0]
  const last = pts[pts.length - 1]
  const span = last.at - first.at
  if (span < MIN_SPAN) return null
  return (((last.swap as number) - (first.swap as number)) / span) * 60_000
}

export function rawLevel(r: Reading, rate: number | null, critAt = CRIT_AT): Level {
  const at = clampCritAt(critAt)
  const mem = r.memory.total ? (r.memory.used / r.memory.total) * 100 : 0
  const growing = rate !== null && rate >= 0.25 * GB
  const fast = rate !== null && rate >= 1 * GB
  const reached = mem >= at
  if (reached && (r.pressure === 'critical' || fast)) return 'crit'
  if (reached && r.swap === null && r.pressure === null && mem >= Math.min(CRIT_MAX, at + 3)) return 'crit'
  if (reached) return 'risk'
  if (r.pressure === 'warning' || r.pressure === 'critical' || mem >= 90 || growing) return 'warn'
  return 'ok'
}

export function causeOf(r: Reading, rate: number | null, critAt = CRIT_AT): string {
  const at = clampCritAt(critAt)
  const mem = r.memory.total ? (r.memory.used / r.memory.total) * 100 : 0
  const parts: string[] = []
  if (mem >= at || mem >= 90) parts.push('memory ' + Math.round(mem) + '%')
  else if (r.pressure === 'critical' || r.pressure === 'warning') parts.push('memory pressure high')
  if (rate !== null && rate >= 0.1 * GB) parts.push('swap +' + (rate / GB).toFixed(1) + ' GB/min')
  return parts.join(', ') || 'plenty of headroom'
}

const HELPER = /(\s+(Helper|Web Content|WebContent|Renderer|GPU|Plugin|Networking|Utility)\b.*|\s*\(.*\))$/i

export function appName(name: string): string {
  let n = name.replace(/\.(exe|app)$/i, '')
  for (let i = 0; i < 3; i++) {
    const next = n.replace(HELPER, '').trim()
    if (next === n || !next) break
    n = next
  }
  return n
}

export function isOrca(name: string): boolean {
  return /^orca/i.test(name.trim()) || /^orca/i.test(appName(name))
}

function bare(name: string): string {
  return name.replace(/\.(exe|app)$/i, '')
}

type Group = { mem: number; mains: Proc[]; top: Proc }

export function culpritOf(list: Proc[] | null, guard: { selfPids: number[]; protectedNames: RegExp }): Culprit | null {
  if (!list || !list.length) return null
  const apps = new Map<string, Group>()
  for (const p of list) {
    const app = appName(p.name)
    const main = bare(p.name) === app
    const g = apps.get(app)
    if (!g) apps.set(app, { mem: p.mem, mains: main ? [p] : [], top: p })
    else {
      g.mem += p.mem
      if (p.mem > g.top.mem) g.top = p
      if (main) g.mains.push(p)
    }
  }
  let best: [string, Group] | null = null
  for (const entry of apps) if (!best || entry[1].mem > best[1].mem) best = entry
  if (!best) return null
  const [app, g] = best
  const target = g.mains.length === 1 ? g.mains[0] : g.top
  const quittable =
    g.mains.length === 1 &&
    !isOrca(app) &&
    !isOrca(target.name) &&
    !guard.selfPids.includes(target.pid) &&
    !guard.protectedNames.test(target.name) &&
    target.pid > 4
  return { pid: target.pid, name: target.name, start: target.start, app, mem: g.mem, quittable }
}

export type Suspect = { pid: number; name: string; start: string | null; app: string; mem: number; cpu: number; count: number; quittable: boolean }

export function topSuspects(list: Proc[] | null, guard: { selfPids: number[]; protectedNames: RegExp }, by: 'mem' | 'cpu', limit = 5): Suspect[] {
  if (!list || !list.length) return []
  const allowed = (p: Proc, app: string) =>
    !isOrca(app) && !isOrca(p.name) && !guard.selfPids.includes(p.pid) && !guard.protectedNames.test(p.name) && p.pid > 4
  const groups = new Map<string, { procs: Proc[]; mains: Proc[] }>()
  for (const p of list) {
    const app = appName(p.name)
    const g = groups.get(app) ?? { procs: [], mains: [] }
    g.procs.push(p)
    if (bare(p.name) === app) g.mains.push(p)
    groups.set(app, g)
  }
  const out: Suspect[] = []
  for (const [app, g] of groups) {
    if (g.mains.length === 1) {
      const main = g.mains[0]
      out.push({
        pid: main.pid, name: main.name, start: main.start, app, count: g.procs.length,
        mem: g.procs.reduce((s, p) => s + p.mem, 0),
        cpu: g.procs.reduce((s, p) => s + (p.cpu ?? 0), 0),
        quittable: allowed(main, app)
      })
    } else {
      for (const p of g.procs) out.push({ pid: p.pid, name: p.name, start: p.start, app: p.name, count: 1, mem: p.mem, cpu: p.cpu ?? 0, quittable: allowed(p, app) })
    }
  }
  out.sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem))
  return out.slice(0, limit)
}

function fmtGb(bytes: number): string {
  return (bytes / GB).toFixed(1) + ' GB'
}

export function createHealth(clock: () => number = Date.now) {
  const ring: Reading[] = []
  let level: Level = 'ok'
  let upSince: number | null = null
  let downSince: number | null = null
  let lastRaw: Reading | null = null
  let rate: number | null = null
  let culprit: Culprit | null = null
  let alertAt = 0
  let critAt = CRIT_AT
  const lastAlert: Record<'toast' | 'notify', number> = { toast: -Infinity, notify: -Infinity }

  function setCritAt(n: number): void {
    critAt = clampCritAt(n, critAt)
  }

  function push(r: Reading): { level: Level; escalated: boolean } {
    ring.push(r)
    while (ring.length > 2 && r.at - ring[0].at > WINDOW) ring.shift()
    rate = swapRate(ring)
    lastRaw = r
    const raw = rawLevel(r, rate, critAt)
    const before = level
    if (RANK[raw] > RANK[level]) {
      downSince = null
      if (upSince === null) upSince = r.at
      if (r.at - upSince >= UP_AFTER_MS) {
        level = raw
        upSince = null
      }
    } else if (RANK[raw] < RANK[level]) {
      upSince = null
      if (downSince === null) downSince = r.at
      if (r.at - downSince >= DOWN_AFTER_MS) {
        level = LEVELS[RANK[level] - 1]
        downSince = r.at
      }
    } else {
      upSince = null
      downSince = null
    }
    if (RANK[level] < RANK.risk) culprit = null
    return { level, escalated: RANK[level] > RANK[before] }
  }

  function alerts(): Alert[] {
    const now = level
    const t = clock()
    const out: Alert[] = []
    const cause = lastRaw ? causeOf(lastRaw, rate, critAt) : ''
    const who = culprit && !isOrca(culprit.app) ? ' ' + culprit.app + ' is using ' + fmtGb(culprit.mem) + '.' : ''
    const body = cause.charAt(0).toUpperCase() + cause.slice(1) + '.' + who
    if (RANK[now] >= RANK.risk && t - lastAlert.toast >= QUIET) {
      lastAlert.toast = t
      alertAt = t
      out.push({ kind: 'toast', title: 'Memory almost full', body })
    }
    if (now === 'crit' && t - lastAlert.notify >= QUIET) {
      lastAlert.notify = t
      out.push({ kind: 'notify', title: 'Critical', body })
    }
    return out
  }

  function setCulprit(c: Culprit | null): void {
    culprit = RANK[level] >= RANK.risk ? c : null
  }

  function snapshot(): Health {
    const r = lastRaw
    const memPct = r && r.memory.total ? (r.memory.used / r.memory.total) * 100 : 0
    const recent = r ? ring.filter((x) => r.at - x.at <= CPU_WINDOW) : []
    const cpu = recent.length ? recent.reduce((sum, x) => sum + x.total, 0) / recent.length : 0
    const step = stepOf(level, cpu, memPct)
    const raw = r ? causeOf(r, rate, critAt) : ''
    return {
      level,
      step,
      word: STEPS[step],
      cause: level !== 'ok' && raw === 'plenty of headroom' ? 'easing off' : step === 2 ? 'CPU ' + Math.round(cpu) + '% for 10s' : raw,
      memPct,
      swapPct: r && r.swap !== null && r.swapTotal ? Math.min(100, (r.swap / r.swapTotal) * 100) : null,
      swapRate: rate,
      culprit,
      alertAt
    }
  }

  return { push, alerts, setCulprit, setCritAt, snapshot, level: () => level }
}
