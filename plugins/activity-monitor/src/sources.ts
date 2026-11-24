import os from 'node:os'
import { readdir, readFile } from 'node:fs/promises'
import type { SshTarget } from './remote.ts'

export type HostRow = {
  kind: string
  id: string
  name: string
  connected?: boolean
  connectionStatus?: string
  machineName?: string
}

export type Source = {
  id: string
  label: string
  kind: 'local' | 'ssh'
  connected: boolean
  server: boolean
}

export type Sources = { sources: Source[]; targets: Map<string, SshTarget> }

export const LOCAL: Source = { id: 'local', label: 'This computer', kind: 'local', connected: true, server: false }

export function buildSources(hosts: HostRow[], targets: Map<string, SshTarget>, serverTargets: Set<string>): Sources {
  const local = hosts.find((h) => h.kind === 'local')
  const sources: Source[] = [{ ...LOCAL, label: local?.machineName || LOCAL.label }]
  const byId = new Map<string, SshTarget>()
  for (const h of hosts) {
    if (h.kind !== 'ssh' || !h.connected) continue
    const id = 'ssh:' + h.id
    const record = targets.get(h.id)
    byId.set(id, { ...(record ?? {}), id: h.id, label: h.name, configHost: record?.configHost ?? (record?.host ? null : h.name) })
    sources.push({ id, label: h.name, kind: 'ssh', connected: true, server: serverTargets.has(h.id) })
  }
  return { sources, targets: byId }
}

function profileDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') return [home + '/Library/Application Support/orca/profiles']
  if (process.platform === 'win32') return [(process.env.APPDATA ?? home + '/AppData/Roaming') + '/orca/profiles']
  return [(process.env.XDG_CONFIG_HOME ?? home + '/.config') + '/orca/profiles']
}

export async function readTargets(dirs: string[] = profileDirs()): Promise<Map<string, SshTarget>> {
  const out = new Map<string, SshTarget>()
  for (const dir of dirs) {
    const profiles = await readdir(dir).catch(() => [] as string[])
    for (const profile of profiles) {
      const raw = await readFile(dir + '/' + profile + '/orca-data.json', 'utf8').catch(() => '')
      if (!raw) continue
      let parsed: { sshTargets?: unknown } | null = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const list = Array.isArray(parsed?.sshTargets) ? (parsed!.sshTargets as Record<string, unknown>[]) : []
      for (const t of list) {
        if (typeof t.id !== 'string' || out.has(t.id)) continue
        out.set(t.id, {
          id: t.id,
          label: typeof t.label === 'string' ? t.label : t.id,
          configHost: typeof t.configHost === 'string' && t.configHost ? t.configHost : null,
          host: typeof t.host === 'string' ? t.host : null,
          port: typeof t.port === 'number' ? t.port : null,
          username: typeof t.username === 'string' ? t.username : null,
          identityFile: typeof t.identityFile === 'string' ? t.identityFile : null,
          identitiesOnly: t.identitiesOnly === true
        })
      }
    }
  }
  return out
}

type CliJson = (args: string[]) => Promise<unknown>

export async function discover(cli: CliJson, targets: () => Promise<Map<string, SshTarget>> = () => readTargets()): Promise<Sources | null> {
  const listed = (await cli(['host', 'list', '--json'])) as { ok?: boolean; result?: { hosts?: HostRow[] } } | null
  const hosts = listed?.ok ? listed.result?.hosts : null
  if (!Array.isArray(hosts)) return null
  const servers = new Set<string>()
  await Promise.all(hosts.filter((h) => h.kind === 'environment').map(async (h) => {
    const shown = (await cli(['environment', 'show', '--environment', h.id, '--json'])) as {
      result?: { environment?: { orcadDeployment?: { sshTargetId?: string } } }
    } | null
    const id = shown?.result?.environment?.orcadDeployment?.sshTargetId
    if (id) servers.add(id)
  }))
  return buildSources(hosts, await targets(), servers)
}
