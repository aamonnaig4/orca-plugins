import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { createSampler } from './sampler.ts'
import { clampCritAt, CRIT_AT, type Level } from './health.ts'
import { buildPrompt, pickAgent } from './explain.ts'
import type { AgentRow, ExplainInput } from './explain.ts'
import { nodeDeps } from './deps.ts'
import { buildCleanupPrompt, cwdPids, findSuspects, inspectPids, parseProposed, pillState } from './cleanup.ts'
import type { AgentState, CleanupSuspect, PillState } from './cleanup.ts'
import { createTracker } from './tracker.ts'

type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

const PULSE_MS = 3000
const BADGE: Record<Level, { visible: boolean; text?: string; tone?: string }> = {
  ok: { visible: false },
  warn: { visible: false },
  risk: { visible: true, text: 'Critical', tone: 'danger' },
  crit: { visible: true, text: 'Critical', tone: 'danger' }
}

const TRACK_MS = 15000
const PANEL_RECENT_MS = 10000
const START_WAIT_MS = 45000
const QUIT_HOLD_MS = 10 * 60_000
const READ_LINES = 200
const STATUS_KEEP = 64
const APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const AGENTS = ['claude', 'codex', 'grok'] as const

type CleanupAgent = (typeof AGENTS)[number]
type Prefs = { record: boolean; focus: boolean; agent: CleanupAgent; critAt: number }
type Session = { terminalId: string; suspects: CleanupSuspect[]; startedAt: number; sentAt: number; agent: AgentState | null; gone: number; quitAt: number | null }
type View = { state: PillState; count: number }
type StartResult = ({ ok: true } & View) | { ok: false; reason: string }
type Workspace = { id: string; name: string; path: string; branch: string | null; hostId: string | null }

const DEFAULT_PREFS: Prefs = { record: true, focus: true, agent: 'claude', critAt: CRIT_AT }
const REST: View = { state: { kind: 'rest' }, count: 0 }

export const seams = { run: nodeDeps.run, sampler: () => createSampler(), startWaitMs: START_WAIT_MS }

let timer: ReturnType<typeof setInterval> | null = null
let trackTimer: ReturnType<typeof setInterval> | null = null
const waiting = new Set<(ok: boolean) => void>()

function readPrefs(raw: unknown, base: Prefs): Prefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const agent = AGENTS.find((a) => a === r.agent) ?? base.agent
  return {
    record: typeof r.record === 'boolean' ? r.record : base.record,
    focus: typeof r.focus === 'boolean' ? r.focus : base.focus,
    agent,
    critAt: clampCritAt(r.critAt, base.critAt)
  }
}

const branchOf = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')
const procKey = (pid: number, start: string | null) => pid + '|' + (start ?? '')

async function orcaCli(args: string[]): Promise<boolean> {
  if ((await seams.run('orca', args)) !== null) return true
  if (process.platform === 'darwin') return (await seams.run(APP_CLI, args)) !== null
  return false
}

async function cliJson(args: string[]): Promise<unknown> {
  let out = await seams.run('orca', args, { anyExit: true })
  if (out === null && process.platform === 'darwin') out = await seams.run(APP_CLI, args, { anyExit: true })
  if (out === null) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

async function terminalAlive(terminalId: string): Promise<boolean | null> {
  const r = (await cliJson(['terminal', 'show', '--terminal', terminalId, '--json']).catch(() => null)) as {
    ok?: boolean
    error?: { code?: string }
    result?: { terminal?: { connected?: boolean; writable?: boolean } }
  } | null
  if (!r || typeof r !== 'object') return null
  if (r.ok === false) return r.error?.code === 'terminal_handle_stale' ? false : null
  const t = r.result?.terminal
  if (r.ok !== true || !t || typeof t !== 'object') return null
  return t.connected !== false && t.writable !== false
}

export default function activate(orca: OrcaWorkerApi): void {
  const sampler = seams.sampler()
  const host = (orca as unknown as { host?: { call?: HostCall } }).host
  const log = (orca as unknown as { log?: (...args: unknown[]) => void }).log
  const call: HostCall = (method, params) =>
    (host && host.call ? host.call(method, params) : Promise.reject(new Error('no host.call'))).catch((error: unknown) => {
      if (log) log(method + ' failed: ' + (error instanceof Error ? error.message : String(error)))
      return null
    })
  let shown: Level | null = null

  function badge(level: Level, tooltip: string): void {
    const next = BADGE[level]
    if (shown !== null && BADGE[shown].visible === next.visible && (!next.visible || shown === level)) return
    shown = level
    void call('statusBar.update', { id: 'health', ...next, icon: 'warning', tooltip })
  }

  sampler.onAlert((alert) => {
    if (alert.kind === 'notify') void call('notifications.show', { title: alert.title, body: alert.body })
  })

  const tracker = createTracker()
  let prefs: Prefs = { ...DEFAULT_PREFS }
  let synced = false
  let lastPanelRead = -Infinity
  let tracking = false
  let session: Session | null = null
  let starting: Promise<StartResult> | null = null
  const statuses = new Map<string, AgentState>()
  const waiters = new Map<string, (ok: boolean) => void>()

  orca.storage.get('prefs').then((stored) => {
    if (synced) return
    prefs = readPrefs(stored, DEFAULT_PREFS)
    sampler.setRecording(prefs.record)
    sampler.setCritAt(prefs.critAt)
  }, () => undefined)

  orca.events.on('agent.status.changed', (payload) => {
    const id = payload.terminalId
    if (!id) return
    const state = payload.mainAgent?.state ?? payload.state
    statuses.delete(id)
    statuses.set(id, state)
    if (statuses.size > STATUS_KEEP) statuses.delete(statuses.keys().next().value as string)
    if (session && session.terminalId === id) session.agent = state
    const waiter = waiters.get(id)
    if (waiter) waiter(true)
  })

  function firstStatus(terminalId: string): Promise<boolean> {
    if (statuses.has(terminalId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timeout)
        waiters.delete(terminalId)
        waiting.delete(done)
        resolve(ok)
      }
      const timeout = setTimeout(() => done(false), seams.startWaitMs)
      waiters.set(terminalId, done)
      waiting.add(done)
    })
  }

  async function cleanupWorkspace(): Promise<{ id: string } | { reason: string }> {
    const [listed, context] = (await Promise.all([call('workspace.list', {}), call('workspace.readContext', {})])) as [
      { workspaces?: Workspace[] } | null,
      { branch?: string; displayName?: string } | null
    ]
    if (!listed || !Array.isArray(listed.workspaces)) return { reason: 'Could not read your Orca workspaces' }
    const local = listed.workspaces.filter((w) => w.hostId == null || w.hostId === 'local')
    if (context?.displayName) {
      const named = local.filter((w) => w.name === context.displayName)
      const picks = named.length > 1 ? named.filter((w) => branchOf(w.branch) === branchOf(context.branch)) : named
      if (picks.length === 1) return { id: picks[0].id }
    }
    const usable = local.find((w) => typeof w.path === 'string' && existsSync(w.path))
    if (usable) return { id: usable.id }
    return { reason: listed.workspaces.length ? 'No Orca workspace on this computer' : 'Add a project to Orca first' }
  }

  async function collectSuspects(excludePids: number[]): Promise<CleanupSuspect[]> {
    const procs = await sampler.listProcs()
    if (!procs) return []
    const { cwds, args } = await sampler.inspect(inspectPids(procs, tracker), (found) => cwdPids(procs, found))
    const { selfPids, protectedNames } = sampler.guard()
    return findSuspects({ procs, args, cwds, cwdExists: existsSync, tracker, selfPids, excludePids, protectedNames, now: Date.now() })
  }

  async function sendPrompt(terminalId: string, text: string): Promise<boolean> {
    const sent = (await call('terminal.sendText', { terminalId, text, enter: true })) as { accepted?: boolean } | null
    if (sent?.accepted) return true
    return orcaCli(['terminal', 'send', '--terminal', terminalId, '--text', text, '--enter'])
  }

  function focus(terminalId: string): void {
    orcaCli(['terminal', 'switch', '--terminal', terminalId]).then((ok) => {
      if (!ok && log) log('could not switch to the cleanup terminal')
    }, () => undefined)
  }

  async function view(): Promise<View> {
    const s = session
    if (!s) return REST
    if ((await terminalAlive(s.terminalId)) === false) {
      if (session === s) session = null
      return REST
    }
    const read = (await call('terminal.read', { terminalId: s.terminalId, maxLines: READ_LINES })) as { lines?: string[] } | null
    if (!read || !Array.isArray(read.lines)) {
      if (session === s) session = null
      return REST
    }
    const listed = (await call('agents.list', {})) as { agents?: { terminalId: string | null; state: AgentState; stateStartedAt: number }[] } | null
    const row = (listed?.agents ?? []).find((a) => a.terminalId === s.terminalId)
    if (row && row.stateStartedAt >= s.sentAt) s.agent = row.state
    const procs = await sampler.listProcs()
    if (procs) {
      const live = new Set(procs.map((p) => procKey(p.pid, p.start)))
      s.gone = s.suspects.filter((x) => !live.has(procKey(x.pid, x.start))).length
    }
    const state = pillState({ agent: s.agent, alive: true, proposed: parseProposed(read.lines), gone: s.gone })
    if (state.kind !== 'quit') s.quitAt = null
    else if (s.quitAt === null) s.quitAt = Date.now()
    else if (Date.now() - s.quitAt >= QUIT_HOLD_MS) {
      if (session === s) session = null
      return REST
    }
    if (session !== s) return REST
    return { state, count: s.suspects.length }
  }

  async function start(): Promise<StartResult> {
    if (session) {
      const current = await view()
      if (session) {
        focus(session.terminalId)
        return { ok: true, ...current }
      }
    }
    const target = await cleanupWorkspace()
    if ('reason' in target) return { ok: false, reason: target.reason }
    const workspaceId = target.id
    const suspects = await collectSuspects([])
    const prompt = buildCleanupPrompt(suspects, process.platform)
    let terminalId: string
    try {
      if (!host || !host.call) return { ok: false, reason: 'This Orca cannot start agents' }
      const launched = (await host.call('agent.launch', { workspaceId, agent: prefs.agent })) as { terminalId?: string } | null
      if (!launched?.terminalId) return { ok: false, reason: 'Could not start your agent' }
      terminalId = launched.terminalId
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code
      if (log) log('agent.launch failed: ' + (error instanceof Error ? error.message : String(error)))
      return {
        ok: false,
        reason: code === 'capability_denied' || code === 'consent_required' ? 'Allow agent access for Activity Monitor in Orca plugin settings' : 'Could not start your agent'
      }
    }
    const s: Session = { terminalId, suspects, startedAt: Date.now(), sentAt: Infinity, agent: null, gone: 0, quitAt: null }
    session = s
    if (!(await firstStatus(terminalId))) return { ok: false, reason: 'Your agent did not start' }
    s.agent = null
    const sent = await sendPrompt(terminalId, prompt)
    s.sentAt = Date.now()
    if (prefs.focus) focus(terminalId)
    if (!sent) {
      s.agent = statuses.get(terminalId) ?? null
      return { ok: false, reason: 'Your agent did not take the cleanup prompt' }
    }
    return { ok: true, state: { kind: 'working' }, count: suspects.length }
  }

  orca.panels.handle('cleanup.start', () => {
    if (!starting) starting = start().finally(() => {
      starting = null
    })
    return starting
  })

  orca.panels.handle('cleanup.state', () => view())

  orca.panels.handle('cleanup.open', async () => {
    const current = await view()
    const s = session
    if (!s) return { ok: false, reason: 'No cleanup is running', ...current }
    focus(s.terminalId)
    if (current.state.kind === 'quit') {
      session = null
      return { ok: true, ...REST }
    }
    return { ok: true, ...current }
  })

  orca.panels.handle('prefs.sync', async (input) => {
    prefs = readPrefs(input, prefs)
    synced = true
    sampler.setRecording(prefs.record)
    sampler.setCritAt(prefs.critAt)
    try {
      await orca.storage.set('prefs', prefs)
    } catch (error: unknown) {
      if (log) log('prefs.sync failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return { ok: true, prefs }
  })

  orca.panels.handle('stats.read', async (input) => {
    lastPanelRead = Date.now()
    const out = await sampler.read(input ?? {})
    badge(out.health.level, out.health.cause)
    return out
  })
  orca.panels.handle('health.suspects', async () => sampler.suspects())
  orca.panels.handle('process.quit', async (input) =>
    sampler.quit(Number(input?.pid), String(input?.name ?? ''), input?.start ? String(input.start) : null, input?.force === true)
  )

  async function processPath(pid: number): Promise<string | null> {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null
    const out = await nodeDeps.run('ps', ['-p', String(pid), '-o', 'comm='])
    return out ? out.trim() || null : null
  }

  orca.panels.handle('process.explain', async (input) => {
    const raw = (input ?? {}) as ExplainInput
    if (!host || !host.call) return { ok: false, reason: 'This Orca cannot send to agents' }
    const prompt = buildPrompt({ ...raw, platform: process.platform }, await processPath(Number(raw.pid)))
    if (!prompt) return { ok: false, reason: 'That process is gone' }
    try {
      const listed = (await host.call('agents.list', {})) as { agents?: AgentRow[] } | null
      const pick = pickAgent(listed?.agents ?? [])
      if (!pick.ok) return { ok: false, reason: pick.reason, prompt }
      const sent = (await host.call('terminal.sendText', { terminalId: pick.terminalId, text: prompt, enter: true })) as { accepted?: boolean } | null
      if (!sent?.accepted) return { ok: false, reason: 'Your agent did not take the question', prompt }
      return { ok: true, title: pick.title }
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code
      if (log) log('process.explain failed: ' + (error instanceof Error ? error.message : String(error)))
      const reason = code === 'capability_denied' || code === 'consent_required'
        ? 'Allow agent access for Activity Monitor in Orca plugin settings'
        : 'Could not reach your agent'
      return { ok: false, reason, prompt }
    }
  })

  if (trackTimer) clearInterval(trackTimer)
  trackTimer = setInterval(() => {
    if (tracking || !(prefs.record || Date.now() - lastPanelRead < PANEL_RECENT_MS)) return
    tracking = true
    sampler.listProcs().then((list) => {
      if (list) tracker.add(list)
    }, () => undefined).finally(() => {
      tracking = false
    })
  }, TRACK_MS)

  badge('ok', '')
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    sampler.pulse().then(() => {
      const h = sampler.health()
      badge(h.level, h.cause)
    }, () => undefined)
  }, PULSE_MS)
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (trackTimer) clearInterval(trackTimer)
  trackTimer = null
  for (const done of [...waiting]) done(false)
}
