import os from 'node:os'
import { statfs } from 'node:fs/promises'
import { background, nodeDeps, type Details, type Provider, type QuitResult } from './deps.ts'
import type { Battery } from './details.ts'
import { createLinux } from './linux.ts'
import { createMac } from './mac.ts'
import { createWindows } from './windows.ts'
import { createHistory, RAW_MS } from './history.ts'
import { createHealth, culpritOf, topSuspects, type Alert } from './health.ts'
import { coreLayout, coreLoads, rate, type Core, type CpuTimes, type Memory, type Proc } from './parse.ts'

export type Point = {
  seq: number
  at: number
  total: number
  cores: number[]
  mem: number
  down: number
  up: number
  read: number
  write: number
  gpu: number
}

export type Sample = {
  seq: number
  at: number
  cores: Core[]
  loads: number[]
  total: number
  memory: Memory
  swap: number | null
  swapTotal: number | null
  pressure: string | null
  net: {
    down: number | null
    up: number | null
    rx: number
    tx: number
    iface: string | null
    name: string | null
    packetsIn: number | null
    packetsOut: number | null
    packetsInRate: number | null
    packetsOutRate: number | null
  } | null
  disk: {
    read: number | null
    write: number | null
    used: number
    free: number
    total: number
    name: string
    readBytes: number | null
    writeBytes: number | null
    readOps: number | null
    writeOps: number | null
    readOpsRate: number | null
    writeOpsRate: number | null
  } | null
  gpu: { utilization: number; model: string } | null
  note: string | null
  split: { user: number; system: number; idle: number } | null
  counts: { procs: number | null; threads: number | null }
  battery: Battery | null
}

type Space = { blocks: number; bsize: number; bavail: number; bfree: number }

export type SamplerOptions = {
  provider?: Provider
  cpus?: () => CpuTimes[]
  space?: (path: string) => Promise<Space | null>
  settle?: number
  clock?: () => number
  selfPids?: number[]
}

const HISTORY = 900
const WINDOW_POINTS = 600
const READ_RECENT_MS = 10000
const SUSPECTS = 30
const PROC_FLOOR = 900

function cpuSplit(before: CpuTimes[], after: CpuTimes[]): Sample['split'] {
  let user = 0
  let system = 0
  let idle = 0
  after.forEach((cur, i) => {
    const prev = before[i]
    if (!prev) return
    user += cur.user - prev.user + cur.nice - prev.nice
    system += cur.sys - prev.sys + cur.irq - prev.irq
    idle += cur.idle - prev.idle
  })
  const total = user + system + idle
  return total > 0 ? { user: (user / total) * 100, system: (system / total) * 100, idle: (idle / total) * 100 } : null
}

export function providerFor(platform: string): Provider {
  if (platform === 'darwin') return createMac(nodeDeps)
  if (platform === 'win32') return createWindows(nodeDeps)
  return createLinux(nodeDeps)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createSampler(options: SamplerOptions = {}) {
  const provider = options.provider ?? providerFor(process.platform)
  const cpus = options.cpus ?? (() => os.cpus().map((cpu) => cpu.times))
  const space = options.space ?? ((path: string) => statfs(path).catch(() => null))
  const settle = options.settle ?? 300
  const boot = Math.random().toString(36).slice(2)
  let interval = 1000
  let cores: Core[] | null = null
  let note: string | null = null
  let previous: {
    at: number
    cpus: CpuTimes[]
    net: { rx: number; tx: number; key: string; pin: number | null; pout: number | null } | null
    disk: { read: number; write: number; devices: number; rops: number | null; wops: number | null } | null
  } | null = null
  let latest: Sample | null = null
  let pending: Promise<Sample> | null = null
  let seq = 0
  const clock = options.clock ?? Date.now
  const history = createHistory(clock)
  let recording = true
  let lastRead = -Infinity
  const health = createHealth(clock)
  const selfPids = options.selfPids ?? [process.pid, process.ppid]
  let alertSink: ((alert: Alert) => void) | null = null
  const procs = background<Proc[]>(() => provider.procs(), () => Math.max(provider.procEvery, PROC_FLOOR, interval * 0.9))
  let energy = false
  const details = background<Details>(() => provider.details(energy), () => Math.max(provider.detailsEvery, interval * 0.9))

  async function take(): Promise<Sample> {
    if (!cores) {
      const [info, n] = await Promise.all([provider.info(), provider.note()])
      cores = coreLayout(cpus().length, info.performance, info.efficiency)
      note = n
    }
    if (!previous) {
      previous = { at: Date.now(), cpus: cpus(), net: null, disk: null }
      await wait(settle)
    }
    const at = Date.now()
    const now = cpus()
    const [raw, fs] = await Promise.all([provider.read(), space(provider.diskPath)])
    const seconds = (at - previous.at) / 1000
    const all = coreLoads(previous.cpus, now, provider.countIrq)
    const loads = cores.map((core) => all[core.index] ?? 0)
    const total = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0
    const netKey = raw.net ? raw.net.iface ?? '*' : ''
    const sameNet = previous.net && previous.net.key === netKey
    const packets = raw.packets ?? null
    const net = raw.net
      ? {
          down: sameNet ? rate(previous.net?.rx, raw.net.rx, seconds) : null,
          up: sameNet ? rate(previous.net?.tx, raw.net.tx, seconds) : null,
          ...raw.net,
          packetsIn: packets ? packets.in : null,
          packetsOut: packets ? packets.out : null,
          packetsInRate: sameNet && packets ? rate(previous.net?.pin ?? undefined, packets.in, seconds) : null,
          packetsOutRate: sameNet && packets ? rate(previous.net?.pout ?? undefined, packets.out, seconds) : null
        }
      : null
    const io = raw.disk
    const ops = raw.ops ?? null
    const sameDisk = io && previous.disk && previous.disk.devices === io.devices
    const disk = fs || io
      ? {
          read: sameDisk ? rate(previous.disk?.read, io?.read, seconds) : null,
          write: sameDisk ? rate(previous.disk?.write, io?.write, seconds) : null,
          total: fs ? fs.blocks * fs.bsize : 0,
          used: fs ? Math.max(0, fs.blocks - fs.bfree) * fs.bsize : 0,
          free: fs ? fs.bavail * fs.bsize : 0,
          name: provider.diskName,
          readBytes: io ? io.read : null,
          writeBytes: io ? io.write : null,
          readOps: ops ? ops.in : null,
          writeOps: ops ? ops.out : null,
          readOpsRate: sameDisk && ops ? rate(previous.disk?.rops ?? undefined, ops.in, seconds) : null,
          writeOpsRate: sameDisk && ops ? rate(previous.disk?.wops ?? undefined, ops.out, seconds) : null
        }
      : null
    const split = cpuSplit(previous.cpus, now)
    previous = {
      at,
      cpus: now,
      net: raw.net ? { rx: raw.net.rx, tx: raw.net.tx, key: netKey, pin: packets ? packets.in : null, pout: packets ? packets.out : null } : null,
      disk: io ? { ...io, rops: ops ? ops.in : null, wops: ops ? ops.out : null } : null
    }
    seq += 1
    const sample: Sample = {
      seq, at, cores, loads, total, memory: raw.memory, swap: raw.swap, swapTotal: raw.swapTotal ?? null, pressure: raw.pressure, net, disk, gpu: raw.gpu, note,
      split, counts: { procs: null, threads: null }, battery: raw.battery ?? null
    }
    if (recording || clock() - lastRead < READ_RECENT_MS) history.push({
      seq,
      at,
      total,
      cores: loads,
      mem: raw.memory.total ? (raw.memory.used / raw.memory.total) * 100 : 0,
      down: net?.down ?? 0,
      up: net?.up ?? 0,
      read: disk?.read ?? 0,
      write: disk?.write ?? 0,
      gpu: raw.gpu?.utilization ?? 0
    })
    return sample
  }

  function announce(): void {
    if (alertSink) for (const alert of health.alerts()) alertSink(alert)
  }

  function blame(list: Proc[] | null): void {
    health.setCulprit(culpritOf(list, { selfPids, protectedNames: provider.protectedNames }))
  }

  function judge(sample: Sample): void {
    const { level, escalated } = health.push({ at: clock(), total: sample.total, memory: sample.memory, swap: sample.swap, swapTotal: sample.swapTotal, pressure: sample.pressure })
    if (level !== 'risk' && level !== 'crit') {
      if (escalated) announce()
      return
    }
    const cached = procs.peek()
    if (cached) {
      blame(cached)
      if (escalated) announce()
      return
    }
    procs.ready().then((list) => {
      blame(list)
      if (escalated) announce()
    }).catch(() => undefined)
  }

  function next(): Promise<Sample> {
    if (!pending) {
      pending = take().then((sample) => {
        try {
          judge(sample)
        } catch {}
        return sample
      }).finally(() => {
        pending = null
      })
    }
    return pending
  }

  function merge(list: Proc[] | null, extra: Details | null): Proc[] | null {
    if (!list || !extra) return list
    return list.map((p) => {
      const row = extra.rows.get(p.pid)
      return row ? { ...p, ...row } : p
    })
  }

  function counts(list: Proc[] | null, extra: Details | null): Sample['counts'] {
    let threads: number | null = extra?.threads ?? null
    if (threads === null && list && list.some((p) => typeof p.threads === 'number')) {
      threads = list.reduce((sum, p) => sum + (typeof p.threads === 'number' ? p.threads : 0), 0)
    }
    return { procs: extra?.procs ?? (list ? list.length : null), threads }
  }

  async function read(input: { procs?: boolean; details?: boolean; energy?: boolean; since?: number; interval?: number; boot?: string; span?: number }) {
    lastRead = clock()
    interval = Math.min(10000, Math.max(100, Number(input.interval) || 1000))
    energy = input.energy === true
    if (!latest || Date.now() - latest.at >= interval * 0.7) latest = await next()
    const wantList = input.procs || input.details
    const [list, extra] = await Promise.all([wantList ? procs.ready() : null, input.details ? details.ready() : null])
    const sample = { ...latest, counts: counts(list, extra) }
    const span = Number(input.span) || 0
    const windowed = span * 1000 > RAW_MS || span * 1000 / interval > HISTORY
    const since = input.boot === boot ? Number(input.since) || 0 : 0
    const points = windowed ? history.window(span, WINDOW_POINTS) : history.since(since).slice(-HISTORY)
    return { boot, sample, health: health.snapshot(), procs: input.procs ? merge(list, extra) : null, history: points, windowed }
  }

  async function pulse(): Promise<void> {
    if (pending) return
    if (latest && Date.now() - latest.at < 2500) return
    latest = await next()
  }

  async function suspects() {
    const snap = health.snapshot()
    const by: 'mem' | 'cpu' = snap.step === 2 ? 'cpu' : 'mem'
    const list = await procs.ready().catch(() => null)
    return { by, word: snap.word, cause: snap.cause, items: topSuspects(list, { selfPids, protectedNames: provider.protectedNames }, by, SUSPECTS) }
  }

  function listProcs(): Promise<Proc[] | null> {
    return provider.procs().catch(() => null)
  }

  async function inspect(
    pids: number[],
    pickCwds: (args: Map<number, string>) => number[] = () => pids
  ): Promise<{ cwds: Map<number, string | null>; args: Map<number, string> }> {
    const args = await provider.args(pids).catch(() => new Map<number, string>())
    const cwds = await provider.cwds(pickCwds(args)).catch(() => new Map<number, string | null>())
    return { cwds, args }
  }

  function guard(): { selfPids: number[]; protectedNames: RegExp } {
    return { selfPids, protectedNames: provider.protectedNames }
  }

  function setRecording(on: boolean): void {
    recording = on
  }

  function setCritAt(n: number): void {
    health.setCritAt(n)
  }

  function onAlert(sink: (alert: Alert) => void): void {
    alertSink = sink
  }

  async function quit(pid: number, name: string, start: string | null, force = false): Promise<QuitResult> {
    if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid || pid === process.ppid) return { ok: false, reason: 'Not allowed' }
    if (/^orca/i.test(name)) return { ok: false, reason: 'Quit Orca from its own menu' }
    if (provider.protectedNames.test(name)) return { ok: false, reason: 'Protected system process' }
    const current = await provider.identify(pid)
    if (!current) return { ok: false, reason: 'Already gone' }
    if (current.name !== name || (current.start || null) !== (start || null)) {
      return { ok: false, reason: 'That process changed; try again' }
    }
    return provider.quit(pid, force)
  }

  return { read, quit, pulse, setRecording, setCritAt, suspects, onAlert, listProcs, inspect, guard, health: () => health.snapshot() }
}
