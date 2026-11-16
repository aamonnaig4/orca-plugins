export type AgentState = 'working' | 'blocked' | 'waiting' | 'done' | 'none'

export type AgentInfo = {
  state: AgentState
  terminalId: string | null
  sessionId: string | null
  chatId: string | null
  kind: string | null
  since: number
  permissionMasked: boolean
}

export type StatusEvent = {
  state: 'working' | 'blocked' | 'waiting' | 'done'
  terminalId?: string
  sessionId?: string
  paneKey?: string
  receivedAt: number
}

export type Session = {
  key: string
  ids: string[]
  path: string
  name: string
  project: string
  repoId: string
  repo: string | null
  branch: string | null
  isMain: boolean
  agent: AgentInfo
  dispatchId: string | null
  started: 'orchestrator' | 'you'
}

type Row = Record<string, unknown>

const CHAT_PREFIX = 'structured-agent-session-'

function rowsOf(raw: unknown, key: string): Row[] {
  if (Array.isArray(raw)) return raw.filter(isRow)
  if (!isRow(raw)) return []
  const direct = raw[key]
  if (Array.isArray(direct)) return direct.filter(isRow)
  const result = raw.result
  if (isRow(result) && Array.isArray(result[key])) return (result[key] as unknown[]).filter(isRow)
  return []
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function emptyAgent(): AgentInfo {
  return { state: 'none', terminalId: null, sessionId: null, chatId: null, kind: null, since: 0, permissionMasked: false }
}

function repoOf(projectId: string): string | null {
  if (!projectId.startsWith('github:')) return null
  const parts = projectId.slice('github:'.length).split('/').filter(Boolean)
  if (parts.length < 2) return null
  return parts.slice(-2).join('/')
}

function branchOf(raw: string): string | null {
  const name = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
  return name === '' ? null : name
}

const STATES = new Set<string>(['working', 'blocked', 'waiting', 'done', 'none'])

function lastActivityOf(space: Row): number {
  const status = space.status
  const at = isRow(status) ? status.lastActivityAt : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}

function storedAgent(value: unknown): AgentInfo | undefined {
  if (!isRow(value) || typeof value.state !== 'string' || !STATES.has(value.state)) return undefined
  const since = value.since
  return {
    ...(value as AgentInfo),
    since: typeof since === 'number' && Number.isFinite(since) ? since : 0
  }
}

export function listStateOf(workspaces: unknown, path: string): string | null {
  for (const row of rowsOf(workspaces, 'workspaces')) {
    if (row.path !== path) continue
    const status = row.status
    if (isRow(status) && typeof status.state === 'string') return status.state
    return null
  }
  return null
}

export function effectiveState(agent: AgentInfo | undefined, listState: string | null): AgentState {
  if (!agent) {
    if (listState === 'working') return 'working'
    if (listState === 'permission') return 'blocked'
    if (listState === 'done') return 'done'
    if (listState === 'active') return 'waiting'
    return 'none'
  }
  if (agent.state === 'blocked') return 'blocked'
  if (agent.state === 'waiting' && listState === 'permission' && !agent.permissionMasked) return 'blocked'
  return agent.state
}

export function buildSessions(input: {
  workspaces: unknown
  worktrees: unknown
  workers: unknown
  agents: Record<string, AgentInfo>
  tracked: string[]
  marker: string
  homePath: string
}): Session[] {
  const agents: Record<string, AgentInfo | undefined> = isRow(input.agents) ? (input.agents as Record<string, AgentInfo>) : {}
  const workspaceRows = rowsOf(input.workspaces, 'workspaces')
  const workerRows = rowsOf(input.workers, 'workers')
  const byPath = new Map<string, Row>()
  for (const row of workspaceRows) byPath.set(str(row.path), row)
  const tracked = new Set(Array.isArray(input.tracked) ? input.tracked : [])
  const sessions: Session[] = []

  for (const tree of rowsOf(input.worktrees, 'worktrees')) {
    const path = str(tree.path)
    const space = byPath.get(path)
    if (!space) continue
    if (tree.hostId !== 'local' || space.hostId !== 'local') continue
    if (path === input.homePath) continue

    const ids = [str(space.id), str(tree.id), str(tree.instanceId)].filter((id) => id !== '')
    const mine = workerRows.filter((w) => ids.includes(str(w.workspace)))
    const comment = str(tree.comment)
    const marked = input.marker !== '' && comment.startsWith(input.marker)
    const orchestrated = marked || mine.some((w) => tracked.has(str(w.dispatchId)))
    const stored = storedAgent(agents[path])
    const base = stored ?? { ...emptyAgent(), since: agents[path] === undefined ? 0 : lastActivityOf(space) }
    const agent: AgentInfo = { ...base, state: effectiveState(stored, listStateOf(input.workspaces, path)) }
    const first = mine[0]

    sessions.push({
      key: path,
      ids,
      path,
      name: str(space.name) || path.split('/').filter(Boolean).pop() || path,
      project: str(space.project),
      repoId: str(tree.repoId),
      repo: repoOf(str(tree.projectId)),
      branch: branchOf(str(tree.branch)),
      isMain: tree.isMainWorktree === true,
      agent,
      dispatchId: orchestrated && first ? str(first.dispatchId) || null : null,
      started: orchestrated ? 'orchestrator' : 'you'
    })
  }
  return sessions
}

export function createIndex(sessions: Session[]) {
  const byId = new Map<string, Session>()
  const byTerm = new Map<string, Session>()
  const byKeyMap = new Map<string, Session>()
  for (const session of sessions) {
    byKeyMap.set(session.key, session)
    for (const id of session.ids) if (!byId.has(id)) byId.set(id, session)
    const terminal = session.agent.terminalId
    if (terminal && !byTerm.has(terminal)) byTerm.set(terminal, session)
  }
  return {
    byKey(key: string): Session | null {
      return byKeyMap.get(key) ?? null
    },
    byAnyId(id: string | null | undefined): Session | null {
      return id ? (byId.get(id) ?? null) : null
    },
    byTerminal(terminalId: string | null | undefined): Session | null {
      return terminalId ? (byTerm.get(terminalId) ?? null) : null
    }
  }
}

export function agentFromStatus(prev: AgentInfo | undefined, ev: StatusEvent, kind: string | null): AgentInfo {
  let chatId = prev?.chatId ?? null
  if (ev.paneKey && ev.paneKey.startsWith(CHAT_PREFIX)) {
    const rest = ev.paneKey.slice(CHAT_PREFIX.length)
    const colon = rest.indexOf(':')
    chatId = colon < 0 ? rest : rest.slice(0, colon)
  }
  return {
    state: ev.state,
    terminalId: ev.terminalId ?? prev?.terminalId ?? null,
    sessionId: ev.sessionId ?? prev?.sessionId ?? null,
    chatId,
    kind: kind ?? prev?.kind ?? null,
    since: prev && prev.state === ev.state ? prev.since : ev.receivedAt,
    permissionMasked: false
  }
}
