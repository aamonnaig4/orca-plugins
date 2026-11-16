import type { HostApi, PluginEvents, StorageApi } from 'orca/worker'
import type { Deps, Settings } from './deps.ts'
import type { createCli } from './orcacli.ts'
import type { createDelivery } from './deliver.ts'
import type { AgentInfo, Session } from './sessions.ts'
import { agentFromStatus, effectiveState } from './sessions.ts'
import { ensureHome, homeOptionsOf } from './home.ts'

export type OrchRecord = {
  marker: string
  repoId: string
  workspaceId: string
  home: string
  agentKind: string
  agent: AgentInfo
}

const KEY = 'orch'
const SETTLE_MS = 5000
const ID_FIELDS = ['handle', 'terminalId', 'id'] as const

function bareId(id: string): string {
  return id.startsWith('term_') ? id.slice('term_'.length) : id
}

function lists(listed: unknown, terminalId: string): boolean {
  const rows = (listed as { terminals?: unknown } | null)?.terminals
  if (!Array.isArray(rows)) return false
  const want = bareId(terminalId)
  return rows.some((row) => {
    if (!row || typeof row !== 'object') return false
    const r = row as Record<string, unknown>
    return ID_FIELDS.some((f) => typeof r[f] === 'string' && bareId(r[f] as string) === want)
  })
}

function isTruncated(listed: unknown): boolean {
  return (listed as { truncated?: unknown } | null)?.truncated === true
}

function isRecord(value: unknown): value is OrchRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const a = v.agent
  return (
    typeof v.marker === 'string' &&
    typeof v.repoId === 'string' &&
    typeof v.workspaceId === 'string' &&
    typeof v.home === 'string' &&
    typeof v.agentKind === 'string' &&
    !!a &&
    typeof a === 'object' &&
    typeof (a as { state?: unknown }).state === 'string'
  )
}

type RepoRow = { id?: unknown; path?: unknown; hiddenAt?: unknown }

function repoRows(result: unknown): RepoRow[] {
  const rows = (result as { repos?: unknown } | null)?.repos
  return Array.isArray(rows) ? (rows as RepoRow[]) : []
}

export function createOrchestrator(o: {
  host: HostApi<'worker'>
  cli: ReturnType<typeof createCli>
  deps: Deps
  store: StorageApi
  delivery: ReturnType<typeof createDelivery>
  settings(): Settings
  id(): string
  log?: (message: string) => void
}) {
  let rec: OrchRecord | null = null
  let listState: string | null = null
  let pending: Promise<OrchRecord> | null = null
  let loading: Promise<void> | null = null
  let writing: Promise<void> = Promise.resolve()
  let dirty = false
  let confirmed = false
  let idleSince: number | null = null

  function report(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    o.log?.(message + ': ' + detail)
  }

  function persist(): Promise<void> {
    const snapshot = rec ? JSON.parse(JSON.stringify(rec)) : null
    const next = writing.then(() => (snapshot ? o.store.set(KEY, snapshot) : undefined))
    writing = next.catch(() => undefined)
    return next
  }

  async function save(): Promise<void> {
    try {
      await persist()
      dirty = false
    } catch (error) {
      dirty = true
      report('Could not save the orchestrator record; it will be retried', error)
    }
  }

  function loadOnce(): Promise<void> {
    if (!loading) {
      loading = (async () => {
        const stored = await o.store.get(KEY)
        if (isRecord(stored) && !rec) rec = JSON.parse(JSON.stringify(stored)) as OrchRecord
        await o.delivery.load()
      })().catch((error) => {
        loading = null
        throw error
      })
    }
    return loading
  }

  function homeOptions(marker: string) {
    return homeOptionsOf(marker, o.settings())
  }

  function fresh(terminalId: string, prev: AgentInfo | null, kind: string): AgentInfo {
    confirmed = false
    idleSince = null
    return {
      state: 'working',
      terminalId,
      sessionId: prev?.sessionId ?? null,
      chatId: null,
      kind,
      since: o.deps.now(),
      permissionMasked: false
    }
  }

  async function launch(workspaceId: string, kind: string): Promise<string> {
    const res = await o.host.call('agent.launch', { workspaceId, agent: kind })
    return res.terminalId
  }

  async function findRepo(home: string): Promise<RepoRow | null> {
    const rows = repoRows(await o.cli.json(['repo', 'list']))
    return rows.find((r) => r.path === home) ?? null
  }

  async function firstRun(): Promise<OrchRecord> {
    const marker = 'orch:' + o.id()
    const home = await ensureHome(o.deps, homeOptions(marker))
    let repoId: string
    const found = await findRepo(home)
    if (found && typeof found.id === 'string') {
      repoId = found.id
      if (!found.hiddenAt) await o.cli.json(['repo', 'hide', '--repo', 'id:' + repoId])
    } else {
      const added = await o.cli.json<{ repo?: { id?: unknown }; id?: unknown } | null>(['repo', 'add', '--path', home, '--kind', 'folder'])
      let id: unknown = added?.repo?.id ?? added?.id
      if (typeof id !== 'string') id = (await findRepo(home))?.id
      if (typeof id !== 'string') throw new Error('Orca did not return an id for the orchestrator home folder')
      repoId = id
      await o.cli.json(['repo', 'hide', '--repo', 'id:' + repoId])
    }
    const workspaceId = repoId + '::' + home
    const agentKind = o.settings().orchestratorAgent
    const terminalId = await launch(workspaceId, agentKind)
    const made: OrchRecord = { marker, repoId, workspaceId, home, agentKind, agent: fresh(terminalId, null, agentKind) }
    rec = made
    await save()
    return made
  }

  async function laterRun(current: OrchRecord): Promise<OrchRecord> {
    await ensureHome(o.deps, homeOptions(current.marker))
    const listed = await o.cli.json<{ terminals?: unknown; truncated?: unknown } | null>(['terminal', 'list', '--worktree', 'id:' + current.workspaceId])
    const terminalId0 = current.agent.terminalId
    if (terminalId0 !== null && (lists(listed, terminalId0) || isTruncated(listed))) return rec ?? current
    const sessionId = current.agent.sessionId
    let terminalId: string
    if (sessionId) {
      const res = await o.host.call('agent.resume', { workspaceId: current.workspaceId, agent: current.agentKind, sessionId } as never)
      terminalId = (res as { terminalId: string }).terminalId
    } else {
      terminalId = await launch(current.workspaceId, current.agentKind)
    }
    const latest = rec ?? current
    const agent: AgentInfo = latest.agent === current.agent ? fresh(terminalId, current.agent, current.agentKind) : { ...latest.agent, terminalId }
    const made: OrchRecord = { ...latest, agent }
    rec = made
    await save()
    return made
  }

  function session(): Session | null {
    if (!rec) return null
    return {
      key: 'orchestrator',
      ids: [rec.workspaceId],
      path: rec.home,
      name: 'Orchestrator',
      project: 'Orchestration',
      repoId: rec.repoId,
      repo: null,
      branch: null,
      isMain: false,
      agent: { ...rec.agent, state: effectiveState(rec.agent, listState) },
      dispatchId: null,
      started: 'you'
    }
  }

  function holding(): Session {
    return {
      key: 'orchestrator',
      ids: [rec?.workspaceId ?? ''],
      path: rec?.home ?? '',
      name: 'Orchestrator',
      project: 'Orchestration',
      repoId: rec?.repoId ?? '',
      repo: null,
      branch: null,
      isMain: false,
      agent: {
        state: 'working',
        terminalId: rec?.agent.terminalId ?? 'pending',
        sessionId: rec?.agent.sessionId ?? null,
        chatId: null,
        kind: rec?.agentKind ?? null,
        since: o.deps.now(),
        permissionMasked: false
      },
      dispatchId: null,
      started: 'you'
    }
  }

  async function ensure(): Promise<OrchRecord> {
    await loadOnce()
    if (rec && dirty) await save()
    if (!pending) {
      const run = rec ? laterRun(rec) : firstRun()
      pending = run.finally(() => {
        pending = null
      })
    }
    return pending
  }

  async function settle(): Promise<void> {
    try {
      await save()
      const s = session()
      if (s) await o.delivery.flush(s)
    } catch (error) {
      report('Could not send the queued messages to the orchestrator', error)
    }
  }

  return {
    load: loadOnce,
    record(): OrchRecord | null {
      return rec
    },
    session,
    ensure,
    async say(text: string): Promise<'sent' | 'queued'> {
      try {
        await ensure()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        let kept = true
        try {
          await o.delivery.send(holding(), 'From Aamon', text)
        } catch (queueError) {
          kept = false
          report('Could not queue the message for the orchestrator', queueError)
        }
        throw new Error('The orchestrator could not be started (' + detail + ').' + (kept ? ' Your message is queued and will be sent once it is running.' : ' Your message was not saved.'))
      }
      const s = session()
      if (!s) throw new Error('The orchestrator has no session')
      const result = await o.delivery.send(s, 'From Aamon', text)
      if (result === 'unreachable') throw new Error('The orchestrator could not be reached')
      return result
    },
    async onStatus(ev: PluginEvents['agent.status.changed']): Promise<boolean> {
      await loadOnce()
      if (!rec) return false
      const mine = ev.workspaceId === rec.workspaceId || (!!ev.sessionId && ev.sessionId === rec.agent.sessionId)
      if (!mine) return false
      confirmed = true
      idleSince = null
      rec = { ...rec, agent: agentFromStatus(rec.agent, ev, rec.agentKind) }
      await save()
      const s = session()
      if (s) await o.delivery.flush(s)
      return true
    },
    setListState(state: string | null): void {
      listState = state
      const idle = state === 'active' || state === 'done'
      if (!idle || !rec || confirmed || rec.agent.state !== 'working') {
        idleSince = null
        return
      }
      const t = o.deps.now()
      if (idleSince === null) {
        idleSince = t
        return
      }
      if (t - idleSince < SETTLE_MS) return
      idleSince = null
      rec = { ...rec, agent: { ...rec.agent, state: 'waiting', since: t } }
      void settle()
    },
    async maskPermission(): Promise<void> {
      if (!rec) return
      rec = { ...rec, agent: { ...rec.agent, permissionMasked: true } }
      await save()
    }
  }
}
