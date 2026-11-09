import os from 'node:os'
import { background, osMemory, signalQuit, type Deps, type Provider } from './deps.ts'
import {
  cpuPercents,
  ifaceKind,
  linuxDefaultIface,
  linuxPressure,
  parseCpuList,
  parseDiskstats,
  parseMeminfo,
  parseNvidiaSmi,
  parseProcNetDev,
  parseProcStat,
  type Proc
} from './parse.ts'
import { linuxBattery, parseDiskstatsOps, parsePasswd, parseProcIo, parseProcNetDevPackets, parseStatusUid, type Extra } from './details.ts'

const SMI = ['--query-gpu=utilization.gpu,name', '--format=csv,noheader,nounits']
const NVIDIA_DISCOVERY_EVERY = 60_000

export function createLinux(d: Deps, root = '', home = os.homedir()): Provider {
  let tick = 100
  let page = 4096
  let tuned: Promise<void> | null = null
  let previous = new Map<number, number | null>()
  let previousAt = 0
  let gpuMode: 'nvidia' | 'amd' | 'none' | null = null
  let amdCards: string[] = []
  let nvidiaPaths: string[] | null = null
  let nvidiaDevices = new Set<string>()
  let nvidiaPathsAt = 0

  function tune() {
    if (!tuned) {
      tuned = Promise.all([d.run('getconf', ['CLK_TCK']), d.run('getconf', ['PAGESIZE'])]).then(([t, p]) => {
        tick = Number(t) || 100
        page = Number(p) || 4096
      })
    }
    return tuned
  }

  async function asleep(paths: string[]): Promise<boolean | null> {
    const states = await Promise.all(paths.map((path) => d.read(path)))
    if (states.some((s) => !s.trim())) return null
    return states.length > 0 && states.every((s) => s.trim() === 'suspended')
  }

  async function discoverNvidiaPower(devices: string[]): Promise<string[]> {
    nvidiaPaths = null
    const vendors = await Promise.all(devices.map((dev) => d.read(root + '/sys/bus/pci/devices/' + dev + '/vendor')))
    // An incomplete scan cannot establish that every NVIDIA GPU is asleep.
    if (vendors.some((v) => !v.trim())) return []
    const nvidia = devices.filter((_, i) => vendors[i].trim() === '0x10de')
    const classes = await Promise.all(nvidia.map((dev) => d.read(root + '/sys/bus/pci/devices/' + dev + '/class')))
    if (classes.some((c) => !c.trim())) return []
    const paths = nvidia
      .filter((_, i) => classes[i].trim().startsWith('0x03'))
      .map((dev) => root + '/sys/bus/pci/devices/' + dev + '/power/runtime_status')
    if (paths.length) {
      nvidiaPaths = paths
      nvidiaDevices = new Set(devices)
      nvidiaPathsAt = Date.now()
    }
    return paths
  }

  async function nvidiaPower() {
    const devices = await d.list(root + '/sys/bus/pci/devices')
    // Check topology every poll, but reuse identities while the device set is stable.
    if (nvidiaPaths && Date.now() - nvidiaPathsAt < NVIDIA_DISCOVERY_EVERY &&
      devices.length === nvidiaDevices.size && devices.every((dev) => nvidiaDevices.has(dev))) return { paths: nvidiaPaths, devices, cached: true }
    return { paths: await discoverNvidiaPower(devices), devices, cached: false }
  }

  async function readGpu() {
    if (gpuMode === null) {
      const smi = parseNvidiaSmi((await d.run('nvidia-smi', SMI)) ?? '')
      if (smi) {
        gpuMode = 'nvidia'
        return smi
      }
      const cards = (await d.list(root + '/sys/class/drm')).filter((name) => /^card\d+$/.test(name))
      for (const card of cards) {
        if ((await d.read(root + '/sys/class/drm/' + card + '/device/gpu_busy_percent')).trim()) amdCards.push(card)
      }
      gpuMode = amdCards.length ? 'amd' : 'none'
    }
    if (gpuMode === 'nvidia') {
      const power = await nvidiaPower()
      let sleeping = await asleep(power.paths)
      if (sleeping === null || (sleeping && power.cached)) {
        // A BDF can be reused by a different PCI function without changing topology.
        // Revalidate every identity before cached paths can establish that all GPUs sleep.
        nvidiaPaths = null
        const paths = sleeping ? await discoverNvidiaPower(power.devices) : (await nvidiaPower()).paths
        sleeping = await asleep(paths)
        if (sleeping === null) nvidiaPaths = null
      }
      if (sleeping) return { utilization: 0, model: 'NVIDIA GPU (asleep)' }
      return parseNvidiaSmi((await d.run('nvidia-smi', SMI)) ?? '')
    }
    if (gpuMode === 'amd') {
      if (await asleep(amdCards.map((card) => root + '/sys/class/drm/' + card + '/device/power/runtime_status'))) {
        return { utilization: 0, model: 'AMD GPU (asleep)' }
      }
      const values = await Promise.all(amdCards.map((card) => d.read(root + '/sys/class/drm/' + card + '/device/gpu_busy_percent')))
      const nums = values.filter((v) => v.trim() !== '').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v))
      return nums.length ? { utilization: nums.reduce((a, b) => a + b, 0) / nums.length, model: 'AMD GPU' } : null
    }
    return null
  }

  const gpu = background(readGpu, () => 3000)
  const battery = background(async () => {
    const base = root + '/sys/class/power_supply'
    const names = await d.list(base)
    const bat = names.find((n) => /^BAT/i.test(n))
    if (!bat) return null
    const ac = names.find((n) => /^(AC|ADP|ACAD)/i.test(n))
    const [capacity, status, online] = await Promise.all([
      d.read(base + '/' + bat + '/capacity'),
      d.read(base + '/' + bat + '/status'),
      ac ? d.read(base + '/' + ac + '/online') : Promise.resolve('')
    ])
    return linuxBattery(capacity, status, online)
  }, () => 15000)
  let users: Map<number, string> | null = null

  return {
    diskPath: home,
    diskName: 'Home',
    countIrq: true,
    procEvery: 2000,
    detailsEvery: 4000,
    protectedNames: /^(systemd|init|gnome-shell|Xorg|Xwayland|kwin_wayland|kwin_x11|plasmashell|gdm|gdm3|sddm|lightdm|dbus-daemon|dbus-broker|sshd|login)$/,
    async info() {
      const [core, atom, cpuinfo] = await Promise.all([
        d.read(root + '/sys/devices/cpu_core/cpus'),
        d.read(root + '/sys/devices/cpu_atom/cpus'),
        d.read(root + '/proc/cpuinfo')
      ])
      const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? ''
      return { performance: parseCpuList(core), efficiency: parseCpuList(atom), model }
    },
    async note() {
      if ((await d.read(root + '/.flatpak-info')).trim()) return 'Orca runs in a Flatpak sandbox, so processes and GPU may be limited'
      if (process.env.SNAP) return 'Orca runs as a Snap, so processes and GPU may be limited'
      return null
    },
    async read() {
      const [meminfo, pressure, route, netdev, diskstats] = await Promise.all([
        d.read(root + '/proc/meminfo'),
        d.read(root + '/proc/pressure/memory'),
        d.read(root + '/proc/net/route'),
        d.read(root + '/proc/net/dev'),
        d.read(root + '/proc/diskstats')
      ])
      const iface = linuxDefaultIface(route)
      const direct = iface ? parseProcNetDev(netdev, iface) : null
      const counters = direct ?? parseProcNetDev(netdev, null)
      const wireless = direct && iface ? (await d.list(root + '/sys/class/net/' + iface + '/wireless')).length > 0 : false
      const mem = meminfo ? parseMeminfo(meminfo) : { memory: osMemory(), swap: null, swapTotal: null }
      return {
        memory: mem.memory,
        swap: mem.swap,
        swapTotal: mem.swapTotal,
        pressure: linuxPressure(pressure),
        net: counters ? { ...counters, iface: direct ? iface : null, name: direct ? (wireless ? 'Wi-Fi' : ifaceKind(iface)) : null } : null,
        disk: parseDiskstats(diskstats),
        gpu: gpu.peek(),
        packets: parseProcNetDevPackets(netdev, direct ? iface : null),
        ops: parseDiskstatsOps(diskstats),
        battery: battery.peek()
      }
    },
    async procs() {
      await tune()
      const pids = (await d.list(root + '/proc')).filter((name) => /^\d+$/.test(name)).map(Number)
      if (!pids.length) return null
      const stats = await Promise.all(pids.map((pid) => d.read(root + '/proc/' + pid + '/stat')))
      const now = Date.now()
      const ticks = new Map<number, number | null>()
      const rows: Omit<Proc, 'cpu'>[] = []
      stats.forEach((text, i) => {
        const parsed = text ? parseProcStat(text) : null
        if (!parsed || parsed.kernel) return
        ticks.set(pids[i], parsed.ticks / tick)
        rows.push({ pid: pids[i], ppid: parsed.ppid, name: parsed.name, mem: parsed.rssPages * page, start: parsed.start, time: parsed.ticks / tick, threads: parsed.threads })
      })
      const pct = cpuPercents(previous, ticks, previousAt ? (now - previousAt) / 1000 : 0)
      previous = ticks
      previousAt = now
      return rows.map((r) => ({ ...r, cpu: pct.get(r.pid) ?? 0 }))
    },
    async details() {
      if (!users) users = parsePasswd(await d.read(root + '/etc/passwd'))
      const pids = (await d.list(root + '/proc')).filter((name) => /^\d+$/.test(name)).map(Number)
      if (!pids.length) return null
      const rows = new Map<number, Extra>()
      await Promise.all(pids.map(async (pid) => {
        const [status, io] = await Promise.all([d.read(root + '/proc/' + pid + '/status'), d.read(root + '/proc/' + pid + '/io')])
        const uid = parseStatusUid(status)
        const bytes = parseProcIo(io)
        rows.set(pid, { user: uid === null ? null : users?.get(uid) ?? String(uid), diskRead: bytes?.read ?? null, diskWrite: bytes?.write ?? null })
      }))
      return { rows, procs: null, threads: null }
    },
    async identify(pid) {
      const parsed = parseProcStat(await d.read(root + '/proc/' + pid + '/stat'))
      return parsed ? { name: parsed.name, start: parsed.start } : null
    },
    async cwds(pids) {
      const out = new Map<number, string | null>()
      await Promise.all(pids.map(async (pid) => {
        out.set(pid, (await d.readlink(root + '/proc/' + pid + '/cwd')) || null)
      }))
      return out
    },
    async args(pids) {
      const out = new Map<number, string>()
      await Promise.all(pids.map(async (pid) => {
        const text = (await d.read(root + '/proc/' + pid + '/cmdline')).split('\0').filter(Boolean).join(' ')
        if (text) out.set(pid, text)
      }))
      return out
    },
    quit: signalQuit
  }
}
