import path from 'node:path'
import { cpuPercents, parseNvidiaSmi, parseWindowsNetstat, parseWindowsProcs, type Proc } from './parse.ts'
import { background, osMemory, type Deps, type Provider } from './deps.ts'
import { parseCimProcs, parseWindowsBattery, parseWindowsPackets } from './details.ts'

const SELECT = "Select-Object Id,ProcessName,CPU,WorkingSet64,@{n='Start';e={if ($_.StartTime) { $_.StartTime.Ticks }}},@{n='Threads';e={$_.Threads.Count}} | ConvertTo-Csv -NoTypeInformation"
const CIM = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ThreadCount,ReadTransferCount,WriteTransferCount | ConvertTo-Csv -NoTypeInformation'
const BATTERY = 'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Csv -NoTypeInformation'
const SMI = ['--query-gpu=utilization.gpu,name', '--format=csv,noheader,nounits']

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (direct) return direct
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value
  }
  return undefined
}

export function powershellPath(env: Record<string, string | undefined>): string {
  const root = envValue(env, 'SystemRoot')
  return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

export function nvidiaSmiPaths(env: Record<string, string | undefined>): string[] {
  const out = ['nvidia-smi']
  const root = envValue(env, 'SystemRoot')
  if (root) out.push(path.win32.join(root, 'System32', 'nvidia-smi.exe'))
  const programFiles = envValue(env, 'ProgramFiles') || envValue(env, 'ProgramW6432')
  if (programFiles) out.push(path.win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
  else {
    const drive = envValue(env, 'SystemDrive')
    if (drive) out.push(path.win32.join(drive + '\\', 'Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
  }
  return out
}

export function createWindows(d: Deps, env: Record<string, string | undefined> = process.env): Provider {
  const drive = envValue(env, 'SystemDrive') || 'C:'
  const shell = powershellPath(env)
  const smiPaths = nvidiaSmiPaths(env)
  const hasProgramFiles = Boolean(envValue(env, 'ProgramFiles'))
  const programFiles = envValue(env, 'ProgramFiles') || envValue(env, 'ProgramW6432') || path.win32.join(drive + '\\', 'Program Files')
  const smiOptions = hasProgramFiles ? undefined : { env: { ProgramFiles: programFiles } }
  let previous = new Map<number, number | null>()
  let previousAt = 0
  let gpuMode: 'nvidia' | 'none' | null = null
  let smiCommand: string | null = null

  function powershell(script: string) {
    return d.run(shell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='SilentlyContinue'; " + script])
  }

  async function readGpu() {
    if (gpuMode === null) {
      for (const candidate of smiPaths) {
        const smi = parseNvidiaSmi((await d.run(candidate, SMI, smiOptions)) ?? '')
        if (smi) {
          gpuMode = 'nvidia'
          smiCommand = candidate
          return smi
        }
      }
      gpuMode = 'none'
      return null
    }
    if (gpuMode === 'nvidia' && smiCommand) {
      return parseNvidiaSmi((await d.run(smiCommand, SMI, smiOptions)) ?? '')
    }
    return null
  }

  const gpu = background(readGpu, () => 3000)
  const battery = background(async () => parseWindowsBattery((await powershell(BATTERY)) ?? ''), () => 30000)

  return {
    diskPath: drive + '\\',
    diskName: 'Drive ' + drive,
    countIrq: false,
    procEvery: 3000,
    detailsEvery: 6000,
    protectedNames: /^(System|Idle|Registry|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|fontdrvhost|MsMpEng|MemCompression|Secure System)$/i,
    async info() {
      return { performance: [], efficiency: [], model: '' }
    },
    async note() {
      return null
    },
    async read() {
      const netstat = (await d.run('netstat', ['-e'])) ?? ''
      const counters = parseWindowsNetstat(netstat)
      return {
        memory: osMemory(),
        swap: null,
        pressure: null,
        net: counters ? { ...counters, iface: null, name: null } : null,
        disk: null,
        gpu: gpu.peek(),
        packets: parseWindowsPackets(netstat),
        ops: null,
        battery: battery.peek()
      }
    },
    async procs() {
      const out = await powershell('Get-Process | ' + SELECT)
      const rows = out ? parseWindowsProcs(out) : []
      if (!rows.length) return null
      const now = Date.now()
      const seconds = new Map(rows.map((r) => [r.pid, r.seconds] as [number, number | null]))
      const pct = cpuPercents(previous, seconds, previousAt ? (now - previousAt) / 1000 : 0)
      previous = seconds
      previousAt = now
      return rows.map((r): Proc => ({ pid: r.pid, name: r.name, mem: r.mem, start: r.start, cpu: pct.get(r.pid) ?? null, time: r.seconds, threads: r.threads }))
    },
    async details() {
      const out = await powershell(CIM)
      if (!out) return null
      const rows = parseCimProcs(out)
      return rows.size ? { rows, procs: null, threads: null } : null
    },
    async identify(pid) {
      const row = parseWindowsProcs((await powershell('Get-Process -Id ' + Number(pid) + ' | ' + SELECT)) ?? '').find((r) => r.pid === pid)
      return row ? { name: row.name, start: row.start } : null
    },
    async cwds() {
      return new Map()
    },
    async args() {
      return new Map()
    },
    async quit(pid, force) {
      const out = await d.run('taskkill', force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)])
      if (out !== null) return { ok: true }
      return { ok: false, reason: force ? 'Could not force quit it' : 'It did not accept a normal quit' }
    }
  }
}
