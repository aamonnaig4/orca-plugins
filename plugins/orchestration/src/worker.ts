import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi, PluginEvents, PluginHooks } from 'orca/worker'
import type { Bins, Deps, Settings } from './deps.ts'
import { DEFAULT_SETTINGS, EFFORTS, FIX_MODES, MODELS, NO_AGENT, PERMISSION_MODES, SCOPES, nodeDeps, readSettings, resolveBins } from './deps.ts'
import { createCli } from './orcacli.ts'
import type { AgentEntry } from './agents.ts'
import { AGENT_CATALOG, detectAgents } from './agents.ts'
import type { AgentState, Session } from './sessions.ts'
import { agentFromStatus, effectiveState } from './sessions.ts'
import { prDiff } from './github.ts'
import { createDelivery } from './deliver.ts'
import type { Outgoing } from './deliver.ts'
import { ensureHome, homeOptionsOf, homePath } from './home.ts'
import { PEEK_KEYS, answerApproval, readScreen } from './needs.ts'
import type { NeedCard } from './needs.ts'
import { matchGuard } from './guard.ts'
import { createOrchestrator } from './orchestrator.ts'
import { createWatcher } from './watcher.ts'
import { createWeb } from './web.ts'
import type { ImageIo } from './images.ts'
import { readImage } from './images.ts'
import { nodeImageIo } from './images-node.ts'
import { attachedNote, checkAttachments, saveAttachment, withAttachments } from './attach.ts'
import type { AttachIo } from './attach.ts'
import { nodeAttachIo } from './attach-node.ts'
import type { ViewModel } from './watcher.ts'

export type TestDeps = {
  deps?: Deps
  wait?: (ms: number) => Promise<void>
  id?: () => string
  detectAgents?: (deps: Deps) => Promise<AgentEntry[]>
  readyMs?: number
  initMs?: number
  alive?: (terminalId: string) => Promise<boolean>
  answer?: typeof answerApproval
  watcher?: (watcher: Watcher) => Watcher
  web?: typeof createWeb
  images?: ImageIo
  attach?: AttachIo
}

export const DENY_TEXT = "Merging, force-pushing and pushing to main are Aamon's alone. Leave the PR open and report that it is ready."

const ORCH_KEY = 'orchestrator'
const MAX_TEXT = 16384
const TICK_GAP_MS = 2000
const READY_MS = 3000
const INIT_MS = 10000
const RUN_PREFIX = 'wants to run: '
const AGENT_LATER = 'The new orchestrator agent takes effect the next time the orchestrator starts.'
const KIND_CAP = 200
const CHAT_LINE = 'This session is a chat. It has no terminal to show.'
const INTERVALS = [30, 60, 120, 300]
const ATTEMPTS = [1, 2, 3, 5]
const SUFFIX = /^[A-Za-z0-9_-]{0,16}$/
const HOME_KEYS: (keyof Settings)[] = ['workerAgent', 'suffix', 'orchestratorAgent', 'model', 'effort', 'fast', 'plan', 'permissionMode']
const ROW_ACTIONS = ['message', 'retry', 'stop', 'remove', 'autofix-ci', 'autofix-review', 'open']
const TABS = ['status', 'terminal', 'diff']

type PluginToolEvent = PluginHooks['agent.tool.before']['event']

let testDeps: TestDeps | null = null
let current: { stop(): void } | null = null

export function setTestDeps(next: TestDeps | null): void {
  testDeps = next
}

type Watcher = ReturnType<typeof createWatcher>
type Orchestrator = ReturnType<typeof createOrchestrator>
type Delivery = ReturnType<typeof createDelivery>
type Cli = ReturnType<typeof createCli>

class RequestError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.code = code
  }
}

function invalid(message: string): RequestError {
  return new RequestError('invalid_params', message)
}

function conflict(message: string): RequestError {
  return new RequestError('conflict', message)
}

function failed(message: string): RequestError {
  return new RequestError('action_failed', message)
}

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inputObj(input: unknown): Record<string, unknown> {
  if (!isObj(input)) throw invalid('Expected an object')
  return input
}

function str(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value === '') throw invalid(`Expected a non-empty string for ${name}`)
  return value
}

function text(input: Record<string, unknown>, name: string): string {
  const value = str(input, name)
  if (value.length > MAX_TEXT) throw invalid(`${name} is longer than ${MAX_TEXT} characters`)
  if (value.trim() === '') throw invalid(`Expected a non-empty string for ${name}`)
  return value
}

function isCatalogAgent(id: string): boolean {
  return AGENT_CATALOG.some((a) => a.id === id)
}

function kindFromChat(paneKey: string | undefined): string | null {
  const prefix = 'structured-agent-session-'
  if (!paneKey || !paneKey.startsWith(prefix)) return null
  const head = paneKey.slice(prefix.length).split(/[_:]/)[0]
  return isCatalogAgent(head) ? head : null
}

function linesOf(result: unknown): string[] {
  if (Array.isArray(result)) return result.map(String)
  if (!isObj(result)) return []
  if (Array.isArray(result.lines)) return result.lines.map(String)
  for (const key of ['output', 'text', 'content', 'transcript']) {
    const value = result[key]
    if (typeof value === 'string') return value.replace(/\n+$/, '').split('\n')
    if (Array.isArray(value)) return value.map(String)
  }
  return []
}

function validateSettings(patch: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {}
  const unknown = Object.keys(patch).filter((key) => !own(DEFAULT_SETTINGS, key))
  if (unknown.length > 0) throw invalid(`Unknown setting: ${unknown.join(', ')}`)
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!own(patch, key)) continue
    const value = patch[key]
    if (key === 'orchestratorAgent' || key === 'workerAgent') {
      if (typeof value !== 'string' || (value !== '' && !isCatalogAgent(value))) throw invalid(`Unknown agent for ${key}`)
      out[key] = value
    } else if (key === 'suffix') {
      if (typeof value !== 'string' || !SUFFIX.test(value)) throw invalid('The suffix may hold up to 16 letters, digits, - and _')
      out.suffix = value
    } else if (key === 'intervalSec') {
      if (typeof value !== 'number' || !INTERVALS.includes(value)) throw invalid('intervalSec must be 30, 60, 120 or 300')
      out.intervalSec = value
    } else if (key === 'attempts') {
      if (typeof value !== 'number' || !ATTEMPTS.includes(value)) throw invalid('attempts must be 1, 2, 3 or 5')
      out.attempts = value
    } else if (key === 'onCi' || key === 'onConflict' || key === 'onReview') {
      if (typeof value !== 'string' || !(FIX_MODES as string[]).includes(value)) throw invalid(`${key} must be fix, ask or ignore`)
      out[key] = value as Settings['onCi']
    } else if (key === 'noAgent') {
      if (typeof value !== 'string' || !(NO_AGENT as string[]).includes(value)) throw invalid('noAgent must be start or ask')
      out.noAgent = value as Settings['noAgent']
    } else if (key === 'scope') {
      if (typeof value !== 'string' || !(SCOPES as string[]).includes(value)) throw invalid('scope must be all or workers')
      out.scope = value as Settings['scope']
    } else if (key === 'model') {
      if (typeof value !== 'string' || !MODELS.includes(value)) throw invalid('model must be one of ' + MODELS.filter((m) => m).join(', ') + ' or empty')
      out.model = value
    } else if (key === 'effort') {
      if (typeof value !== 'string' || !(EFFORTS as string[]).includes(value)) throw invalid('effort must be low, medium, high, xhigh or empty')
      out.effort = value as Settings['effort']
    } else if (key === 'permissionMode') {
      if (typeof value !== 'string' || !(PERMISSION_MODES as string[]).includes(value)) throw invalid('permissionMode must be auto, manual, acceptEdits, dontAsk, bypassPermissions or empty')
      out.permissionMode = value as Settings['permissionMode']
    } else {
      if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`)
      out[key] = value
    }
  }
  return out
}

function looksLikeView(value: Record<string, unknown>): boolean {
  return (
    typeof value.firstRun === 'boolean' &&
    Array.isArray(value.chat) &&
    Array.isArray(value.rows) &&
    Array.isArray(value.idle) &&
    typeof value.needs === 'number' &&
    typeof value.asks === 'number' &&
    isObj(value.gh) &&
    isObj(value.guard)
  )
}

function fallbackView(settings: Settings): ViewModel {
  return {
    rev: 0,
    firstRun: settings.orchestratorAgent === '',
    orch: null,
    chat: [],
    queued: 0,
    rows: [],
    idle: [],
    needs: 0,
    asks: 0,
    gh: { ok: true },
    watching: 0,
    intervalSec: settings.intervalSec,
    hooksOff: true,
    guard: { on: settings.guard, blocksToday: 0 }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  const seam = testDeps
  const deps: Deps = seam?.deps ?? nodeDeps
  const wait = seam?.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const newId = seam?.id ?? (() => randomUUID())
  const findAgents = seam?.detectAgents ?? detectAgents
  const readyMs = seam?.readyMs ?? READY_MS
  const initMs = seam?.initMs ?? INIT_MS
  const answer = seam?.answer ?? answerApproval
  const attachIo = seam?.attach ?? nodeAttachIo(homePath(deps) + '/inbox')

  let settings: Settings = { ...DEFAULT_SETTINGS }
  let bins: Bins = { orca: 'orca', gh: null }
  let cli: Cli | null = null
  let delivery: Delivery | null = null
  let orchestrator: Orchestrator | null = null
  let watcher: Watcher | null = null
  let orcaProblem = false
  let seeded: ViewModel | null = null
  let agentsCache: Promise<AgentEntry[]> | null = null
  const web = (seam?.web ?? createWeb)({
    board: () => {
      const v = view()
      return { rows: v.rows, idle: v.idle, at: deps.now() }
    }
  })
  let lastTick = -Infinity
  let tickTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let stopped = false
  let announced: string | null = null
  const kinds = new Map<string, string>()

  function log(message: string): void {
    try {
      orca.log(message)
    } catch {
      return
    }
  }

  function updateStatusBar(view: ViewModel): void {
    const n = view.needs + view.asks
    const params = n > 0 ? { id: 'needs', visible: true, text: n === 1 ? '1 needs you' : `${n} need you` } : { id: 'needs', visible: false }
    try {
      orca.host.call('statusBar.update', params).catch(() => undefined)
    } catch {
      return
    }
  }

  function onChange(view: ViewModel): void {
    updateStatusBar(view)
    try {
      orca.panels.post('view', { rev: view.rev })
    } catch {
      return
    }
  }

  function startWatcher(): void {
    if (!watcher || stopped || started) return
    started = true
    watcher.start()
  }

  function stopWatcher(): void {
    started = false
    watcher?.stop()
  }

  function requestTick(): void {
    if (!watcher || !started || stopped) return
    const now = deps.now()
    const gap = now - lastTick
    if (gap >= TICK_GAP_MS) {
      lastTick = now
      void watcher.tick()
      return
    }
    if (tickTimer) return
    tickTimer = setTimeout(() => {
      tickTimer = null
      requestTick()
    }, TICK_GAP_MS - gap)
    const t = tickTimer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  function nameOf(key: string): string {
    if (key === ORCH_KEY) return orchestrator?.session()?.name ?? 'the orchestrator'
    return watcher?.index().byKey(key)?.name ?? key
  }

  function onDrop(item: Outgoing): void {
    if (!watcher) return
    void watcher
      .addChat({ id: '', at: deps.now(), from: 'panel', kind: 'text', text: `A message for ${nameOf(item.key)} could not be delivered and was dropped.` })
      .catch(() => undefined)
  }

  const ready = (async () => {
    try {
      const raw = await orca.settings.get()
      settings = readSettings(isObj(raw) ? raw : {})
    } catch (error) {
      log('Could not read settings: ' + messageOf(error))
    }
    try {
      bins = await resolveBins(deps)
    } catch (error) {
      bins = { orca: deps.env('ORCA_CLI_COMMAND') || 'orca', gh: null }
      orcaProblem = true
      log('Could not find the orca and gh commands: ' + messageOf(error))
    }
    cli = createCli(deps, bins.orca)
    try {
      await cli.load()
    } catch (error) {
      orcaProblem = true
      log('Could not read orca agent-context: ' + messageOf(error))
    }
    const theCli = cli
    delivery = createDelivery({
      host: orca.host,
      cli: theCli,
      store: orca.storage,
      now: () => deps.now(),
      id: newId,
      fromHandle: () => orchestrator?.record()?.agent.terminalId ?? null,
      track: (id) => watcher?.track(id),
      onDrop,
      ...(seam?.alive ? { alive: seam.alive } : {})
    })
    orchestrator = createOrchestrator({
      host: orca.host,
      cli: theCli,
      deps,
      store: orca.storage,
      delivery,
      settings: () => settings,
      id: newId,
      log
    })
    const made = createWatcher({
      deps,
      bins,
      cli: theCli,
      host: orca.host,
      store: orca.storage,
      orchestrator,
      delivery,
      settings: () => settings,
      onChange
    })
    watcher = seam?.watcher ? seam.watcher(made) : made
    try {
      await delivery.load()
    } catch (error) {
      orcaProblem = true
      log('Could not load the message queue: ' + messageOf(error))
    }
    try {
      await orchestrator.load()
    } catch (error) {
      orcaProblem = true
      log('Could not load the orchestrator record: ' + messageOf(error))
    }
    try {
      await watcher.load()
    } catch (error) {
      orcaProblem = true
      log('Could not load stored state: ' + messageOf(error))
    }
    if (stopped) return
    updateStatusBar(watcher.view())
    if (settings.orchestratorAgent !== '') startWatcher()
  })().catch((error) => {
    orcaProblem = true
    log('Activation failed: ' + messageOf(error))
  })

  function need<T>(value: T | null, what: string): T {
    if (value === null) throw failed(`The ${what} is not available`)
    return value
  }

  async function removeWorktree(session: Session): Promise<void> {
    if (session.isMain) throw invalid('A main worktree cannot be removed')
    const record = orchestrator?.record() ?? null
    if (record && (session.path === record.home || session.ids.includes(record.workspaceId))) throw invalid('The orchestrator\'s home cannot be removed')
    const worktreeId = session.ids[1]
    if (!worktreeId) throw conflict('This session has no worktree id')
    try {
      await need(cli, 'orca command').json(['worktree', 'rm', '--worktree', 'id:' + worktreeId])
    } catch (error) {
      throw failed('Could not remove the worktree: ' + messageOf(error))
    }
  }

  function sessionFor(key: string, allowOrch: boolean): Session {
    if (key === ORCH_KEY) {
      const s = allowOrch ? (orchestrator?.session() ?? null) : null
      if (!s) throw invalid(`Unknown session: ${key}`)
      return s
    }
    const s = watcher?.index().byKey(key) ?? null
    if (!s) throw invalid(`Unknown session: ${key}`)
    return s
  }

  function view(): ViewModel {
    if (seeded) return seeded
    const base = watcher ? watcher.view() : fallbackView(settings)
    const out: ViewModel = {
      ...base,
      firstRun: settings.orchestratorAgent === '',
      intervalSec: settings.intervalSec,
      guard: { ...base.guard, on: settings.guard }
    }
    if (bins.gh === null && base.gh.ok) out.gh = { ok: false, reason: 'missing' }
    if (orcaProblem) out.hooksOff = true
    return out
  }

  function openCard(id: string): NeedCard | null {
    const v = watcher?.view()
    if (!v) return null
    for (const row of [...v.rows, ...v.idle]) if (row.card && row.card.id === id && row.card.resolved === null) return row.card
    for (let i = v.chat.length - 1; i >= 0; i -= 1) {
      const card = v.chat[i].card
      if (v.chat[i].kind === 'card' && card && card.id === id && card.resolved === null) return card
    }
    return null
  }

  function isOrchestrator(ev: { workspaceId: string | null; terminalId?: string }): boolean {
    const record = orchestrator?.record() ?? null
    if (!record) return false
    if (ev.terminalId && ev.terminalId === record.agent.terminalId) return true
    return !!ev.workspaceId && ev.workspaceId === record.workspaceId
  }

  function guardKey(ev: { workspaceId: string | null; terminalId?: string }): string | null {
    const w = watcher
    if (!w) return null
    if (isOrchestrator(ev)) return ORCH_KEY
    const set = w.guarded()
    const idx = w.index()
    const byTerm = idx.byTerminal(ev.terminalId)
    if (byTerm && (byTerm.started === 'orchestrator' || byTerm.ids.some((id) => set.has(id)))) return byTerm.key
    if (ev.workspaceId) {
      const byId = idx.byAnyId(ev.workspaceId)
      if (byId && (byId.started === 'orchestrator' || set.has(ev.workspaceId))) return byId.key
      if (set.has(ev.workspaceId)) return ev.workspaceId
    }
    if (ev.terminalId && set.has(ev.terminalId)) return ev.terminalId
    return null
  }

  function adopt(w: Watcher, session: Session | null, extra: (string | null | undefined)[]): boolean {
    if (!session || session.started !== 'orchestrator') return false
    const set = w.guarded()
    const ids = [...new Set([...session.ids, ...extra.filter((id): id is string => typeof id === 'string' && id !== '')])]
    if (ids.every((id) => set.has(id))) return false
    w.guardNow(ids)
    return true
  }

  function quietly(fn: () => void): void {
    try {
      fn()
    } catch {
      return
    }
  }

  function noteKind(terminalId: string | undefined, agent: unknown): void {
    if (!terminalId || typeof agent !== 'string' || agent === '') return
    kinds.delete(terminalId)
    kinds.set(terminalId, agent)
    while (kinds.size > KIND_CAP) {
      const oldest = kinds.keys().next().value
      if (oldest === undefined) break
      kinds.delete(oldest)
    }
  }

  function register(what: string, fn: () => unknown): void {
    try {
      fn()
    } catch (error) {
      log('Could not register ' + what + ': ' + messageOf(error))
    }
  }

  function later(fn: () => void): void {
    const t = setTimeout(() => {
      try {
        fn()
      } catch {
        return
      }
    }, 0) as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  function verdict(event: PluginToolEvent): { deny: string } | undefined {
    const w = watcher
    if (!w || !settings.guard) return undefined
    const key = guardKey(event)
    if (!key) return undefined
    const hit = matchGuard(event.tool, event.input)
    if (!hit) return undefined
    if (event.agent !== 'claude') return undefined
    quietly(() => later(() => w.noteGuard(key, hit, true)))
    return { deny: DENY_TEXT }
  }

  function bookkeep(event: PluginToolEvent): void {
    const w = watcher
    if (!w) return
    const terminalId = event.terminalId
    quietly(() => noteKind(terminalId, event.agent))
    quietly(() => {
      const idx = w.index()
      const session = idx.byTerminal(terminalId) ?? idx.byAnyId(event.workspaceId)
      if (adopt(w, session, [])) later(requestTick)
    })
    if (terminalId) quietly(() => w.noteTool(terminalId, { tool: event.tool, input: event.input, at: deps.now() }))
  }

  register('agent.tool.before', () => orca.hooks.on('agent.tool.before', (event) => {
    let out: { deny: string } | undefined
    try {
      out = verdict(event)
    } catch {
      out = undefined
    }
    try {
      bookkeep(event)
    } catch {
      return out
    }
    return out
  }))

  register('agent.tool.after', () => orca.hooks.on('agent.tool.after', (event) => {
    try {
      const w = watcher
      if (!w || !settings.guard) return
      if (event.agent === 'claude') return
      const key = guardKey(event)
      if (!key) return
      const hit = matchGuard(event.tool, event.input)
      if (!hit) return
      later(() => w.noteGuard(key, hit, false))
      return
    } catch {
      return
    }
  }))

  register('agent.status.changed', () => orca.events.on('agent.status.changed', async (ev: PluginEvents['agent.status.changed']) => {
    try {
      await ready
      const o = orchestrator
      const w = watcher
      const d = delivery
      if (!o || !w || !d) return
      const mine = await o.onStatus(ev)
      if (!mine) {
        const idx = w.index()
        const session = idx.byTerminal(ev.terminalId) ?? idx.byAnyId(ev.workspaceListId) ?? idx.byAnyId(ev.workspaceId)
        if (session) {
          const prev = w.agents()[session.path]
          const kind = (ev.terminalId ? kinds.get(ev.terminalId) : undefined) ?? kindFromChat(ev.paneKey) ?? null
          const info = agentFromStatus(
            prev,
            { state: ev.state, terminalId: ev.terminalId, sessionId: ev.sessionId, paneKey: ev.paneKey, receivedAt: ev.receivedAt },
            kind
          )
          w.setAgent(session.path, info)
          await d.flush({ ...session, agent: info })
        }
      }
      requestTick()
    } catch (error) {
      log('Could not handle a status change: ' + messageOf(error))
    }
  }))

  register('workspace.created', () => orca.events.on('workspace.created', async (ev: PluginEvents['workspace.created']) => {
    await ready
    quietly(() => {
      const w = watcher
      if (!w || !orchestrator?.record()) return
      const idx = w.index()
      const session = idx.byAnyId(ev.workspaceId) ?? idx.byAnyId(ev.workspaceListId) ?? (ev.path ? idx.byKey(ev.path) : null)
      adopt(w, session, [ev.workspaceId, ev.workspaceListId])
    })
    requestTick()
  }))

  register('workspace.removed', () => orca.events.on('workspace.removed', async () => {
    await ready
    requestTick()
  }))

  try {
    orca.settings.onDidChange(() => {
      void (async () => {
        await ready
        try {
          const before = settings
          const raw = await orca.settings.get()
          settings = readSettings(isObj(raw) ? raw : {})
          await applySettings(before)
        } catch (error) {
          log('Could not reload settings: ' + messageOf(error))
        }
      })()
    })
  } catch (error) {
    log('Could not watch settings: ' + messageOf(error))
  }

  async function applySettings(before: Settings): Promise<void> {
    if (settings.orchestratorAgent !== '' && !started) startWatcher()
    else if (started && settings.intervalSec !== before.intervalSec) {
      stopWatcher()
      startWatcher()
    } else if (
      started &&
      (settings.onCi !== before.onCi ||
        settings.onConflict !== before.onConflict ||
        settings.onReview !== before.onReview ||
        settings.noAgent !== before.noAgent ||
        settings.scope !== before.scope)
    ) {
      requestTick()
    }
    const home = HOME_KEYS.some((key) => settings[key] !== before[key])
    const record = orchestrator?.record() ?? null
    if (home && record) {
      try {
        await ensureHome(deps, homeOptionsOf(record.marker, settings))
      } catch (error) {
        log('Could not rewrite the home folder: ' + messageOf(error))
      }
    }
    const agentNow = settings.orchestratorAgent
    if (before.orchestratorAgent !== '' && agentNow !== before.orchestratorAgent && agentNow !== announced && watcher) {
      announced = agentNow
      try {
        await watcher.addChat({ id: '', at: deps.now(), from: 'panel', kind: 'text', text: AGENT_LATER })
      } catch (error) {
        log('Could not note the orchestrator agent change: ' + messageOf(error))
      }
    }
  }

  async function initialised(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RequestError('unavailable', 'The orchestration panel is still starting up. Try again in a moment.')), initMs)
      const t = timer as { unref?: () => void }
      if (typeof t.unref === 'function') t.unref()
    })
    late.catch(() => undefined)
    try {
      await Promise.race([ready, late])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function handle(name: string, fn: (input: unknown) => unknown): void {
    register(name, () => orca.panels.handle(name as never, (async (input: unknown) => {
      await initialised()
      return fn(input)
    }) as never))
  }

  register('view.read', () => orca.panels.handle('view.read' as never, (async () => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const gave = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, readyMs)
    })
    try {
      await Promise.race([ready, gave])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return view()
  }) as never))

  handle('instructions.read', async () => {
    const home = homePath(deps)
    try {
      const agentsMd = await deps.fs.read(`${home}/AGENTS.md`)
      if (agentsMd === null) return { started: false, files: [] }
      const files = [{ name: 'AGENTS.md', text: agentsMd }]
      if (settings.orchestratorAgent === 'claude') {
        const claude = await deps.fs.read(`${home}/.claude/settings.json`)
        if (claude !== null) files.push({ name: '.claude/settings.json', text: claude })
      }
      return { started: true, files }
    } catch (error) {
      throw failed('Could not read the orchestrator instructions: ' + messageOf(error))
    }
  })

  handle('agents.list', async () => {
    if (!agentsCache) {
      agentsCache = findAgents(deps).catch((error) => {
        agentsCache = null
        throw failed('Could not list the installed agents: ' + messageOf(error))
      })
    }
    return agentsCache
  })

  handle('firstrun.save', async (input) => {
    const agent = str(inputObj(input), 'agent')
    if (!isCatalogAgent(agent)) throw invalid(`Unknown agent: ${agent}`)
    const before = settings
    try {
      await orca.settings.set('orchestratorAgent', agent)
    } catch (error) {
      throw failed('Could not save the orchestrator agent: ' + messageOf(error))
    }
    settings = { ...settings, orchestratorAgent: agent }
    await applySettings(before)
    try {
      await need(orchestrator, 'orchestrator').ensure()
    } catch (error) {
      log('Could not start the orchestrator: ' + messageOf(error))
      throw failed('The orchestrator could not be started (' + messageOf(error) + ').')
    }
    return { ok: true }
  })

  handle('chat.attach', async (input) => {
    const obj = inputObj(input)
    const name = str(obj, 'name')
    const data = obj.data
    if (typeof data !== 'string') throw invalid('data must be the file as base64')
    const saved = await saveAttachment(attachIo, name, data, deps.now() + '-' + newId().replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase())
    if (!saved) throw invalid('Files must be 4 MB or smaller')
    return saved
  })

  handle('chat.send', async (input) => {
    const obj = inputObj(input)
    const files = await checkAttachments(attachIo, obj.files)
    if (!files) throw invalid('Attach up to 4 files, each sent with chat.attach first')
    const body = files.length > 0 && (typeof obj.text !== 'string' || obj.text.trim() === '') ? '' : text(obj, 'text')
    const w = need(watcher, 'watcher')
    await w.addChat({ id: '', at: deps.now(), from: 'you', kind: 'text', text: attachedNote(body, files) })
    try {
      return await need(orchestrator, 'orchestrator').say(withAttachments(body, files))
    } catch (error) {
      throw failed(messageOf(error))
    }
  })

  handle('chat.answer', async (input) => {
    const obj = inputObj(input)
    const id = str(obj, 'id')
    const option = text(obj, 'option')
    const w = need(watcher, 'watcher')
    const item = w.view().chat.find((c) => c.id === id)
    if (!item || item.kind !== 'question') throw invalid(`Unknown question: ${id}`)
    if (!Array.isArray(item.options) || !item.options.includes(option)) throw invalid('That option is not one of the question\'s options')
    if (item.answered) throw conflict('This question is already answered')
    const marked = await w.answerQuestion(id, option)
    if (!marked) throw conflict('This question is already answered')
    try {
      return await need(orchestrator, 'orchestrator').say(option)
    } catch (error) {
      throw failed(messageOf(error))
    }
  })

  handle('card.act', async (input) => {
    const obj = inputObj(input)
    const id = str(obj, 'id')
    const action = str(obj, 'action')
    const w = need(watcher, 'watcher')
    const card = openCard(id)
    if (!card) throw invalid(`Unknown card: ${id}`)
    if (!card.actions.includes(action as NeedCard['actions'][number])) throw invalid(`Unknown action for this card: ${action}`)
    if (action === 'peek' || action === 'details') return { open: card.key }
    if (action === 'retry') {
      await w.retry(card.key)
      return { ok: true }
    }
    if (action === 'dismiss') {
      await w.resolveCard(id, 'dismissed')
      return { ok: true }
    }
    if (action === 'fix') {
      await w.fixAsked(card.key)
      return { ok: true }
    }
    if (action === 'start') {
      const target = w.index().byKey(card.key)
      if (!target) throw conflict('This session is gone')
      const workspaceId = target.ids[0]
      const agent = settings.workerAgent || settings.orchestratorAgent
      if (!workspaceId) throw conflict('This session has no workspace to start an agent in')
      if (!agent) throw conflict('Pick an agent in the menu first')
      try {
        await orca.host.call('agent.launch', { workspaceId, agent })
      } catch (error) {
        throw failed('Could not start an agent: ' + messageOf(error))
      }
      requestTick()
      return { ok: true, open: card.key }
    }
    const choice = action as 'allow' | 'deny'
    const session = card.key === ORCH_KEY ? (orchestrator?.session() ?? null) : w.index().byKey(card.key)
    if (!session) throw conflict('This session is gone')
    const stateOf = (): AgentState => {
      if (card.key === ORCH_KEY) return orchestrator?.session()?.agent.state ?? 'none'
      return effectiveState(w.agents()[session.path], w.listState(session.path))
    }
    const expect = card.detail.startsWith(RUN_PREFIX) ? card.detail.slice(RUN_PREFIX.length) : undefined
    const result = await answer({
      cli: need(cli, 'orca command'),
      session,
      choice,
      stateOf,
      wait,
      mask: () => w.maskPermission(card.key),
      ...(expect !== undefined ? { expect } : {})
    })
    if (result === 'answered') await w.resolveCard(id, choice === 'allow' ? 'allowed' : 'denied')
    else await w.setCardDetail(id, 'Pick an answer below')
    return { result }
  })

  handle('row.act', async (input) => {
    const obj = inputObj(input)
    const key = str(obj, 'key')
    const action = str(obj, 'action')
    if (!ROW_ACTIONS.includes(action)) throw invalid(`Unknown action: ${action}`)
    const w = need(watcher, 'watcher')
    const session = sessionFor(key, false)
    if (action === 'message') {
      const body = text(obj, 'text')
      const result = await need(delivery, 'delivery').send(session, 'From Aamon', body)
      if (result === 'unreachable') throw conflict('No agent to message in this session')
      return { result }
    }
    if (action === 'retry') {
      await w.retry(key)
      return { ok: true }
    }
    if (action === 'autofix-ci' || action === 'autofix-review') {
      if (typeof obj.on !== 'boolean') throw invalid('Expected on to be true or false')
      await w.setAutoFix(key, action === 'autofix-ci' ? 'ci' : 'review', obj.on)
      return { ok: true }
    }
    if (action === 'open') {
      const terminalId = session.agent.terminalId
      try {
        if (terminalId) await need(cli, 'orca command').json(['terminal', 'switch', '--terminal', terminalId])
        else await need(cli, 'orca command').json(['worktree', 'activate', '--worktree', 'path:' + session.path])
      } catch (error) {
        throw failed('Could not open the session in Orca: ' + messageOf(error))
      }
      return { ok: true }
    }
    if (action === 'stop') {
      if (!session.dispatchId) throw conflict('This agent was not started by the orchestrator, so it cannot be stopped from here')
      try {
        await need(cli, 'orca command').json(['orchestration', 'worker-stop', '--dispatch', session.dispatchId])
      } catch (error) {
        throw failed('Could not stop the agent: ' + messageOf(error))
      }
      requestTick()
      return { ok: true }
    }
    if (obj.confirmed !== true) throw invalid('Removing a worktree needs confirmed: true')
    await removeWorktree(session)
    requestTick()
    return { ok: true }
  })

  handle('idle.clear', async (input) => {
    if (inputObj(input).confirmed !== true) throw invalid('Removing idle worktrees needs confirmed: true')
    const w = need(watcher, 'watcher')
    let removed = 0
    const kept: string[] = []
    for (const row of w.view().idle) {
      if (!row.removable) continue
      const session = w.index().byKey(row.key)
      if (!session || session.agent.state === 'working' || session.agent.state === 'blocked') continue
      try {
        await removeWorktree(session)
        removed += 1
      } catch {
        kept.push(session.name)
      }
    }
    requestTick()
    if (kept.length > 0) throw failed(`Removed ${removed}. Could not remove: ${kept.join(', ')}`)
    return { removed }
  })

  handle('row.detail', async (input) => {
    const obj = inputObj(input)
    const key = str(obj, 'key')
    const tab = str(obj, 'tab')
    if (!TABS.includes(tab)) throw invalid(`Unknown tab: ${tab}`)
    const w = need(watcher, 'watcher')
    const session = sessionFor(key, true)
    if (tab === 'status') {
      const max = settings.attempts
      const d = key === ORCH_KEY ? null : w.detail(key)
      if (!d) return { status: { checks: [], threads: [], attempts: { used: 0, max }, maxAttempts: max, lastSent: null } }
      return { status: { checks: d.checks, threads: d.threads, attempts: d.attempts, maxAttempts: d.attempts.max, lastSent: d.lastSent } }
    }
    const c = need(cli, 'orca command')
    if (tab === 'terminal') {
      const terminalId = session.agent.terminalId
      try {
        if (terminalId) return { lines: await readScreen(c, terminalId) }
        if (session.dispatchId) {
          return { lines: linesOf(await c.json(['orchestration', 'worker-read', '--dispatch', session.dispatchId, '--source', 'auto'])) }
        }
      } catch (error) {
        throw failed('Could not read the terminal: ' + messageOf(error))
      }
      return { lines: [CHAT_LINE] }
    }
    const pr = key === ORCH_KEY ? null : w.pr(key)
    if (!pr || bins.gh === null) return { diff: '' }
    return { diff: await prDiff(deps, bins.gh, pr.repo, pr.number) }
  })

  handle('peek.key', async (input) => {
    const obj = inputObj(input)
    const key = str(obj, 'key')
    const name = str(obj, 'name')
    if (!own(PEEK_KEYS, name)) throw invalid(`Unknown key: ${name}`)
    const session = sessionFor(key, true)
    const terminalId = session.agent.terminalId
    if (!terminalId) throw conflict('This session has no terminal to send keys to')
    try {
      await need(cli, 'orca command').json(['terminal', 'send', '--terminal', terminalId, '--text=' + PEEK_KEYS[name as keyof typeof PEEK_KEYS]])
    } catch (error) {
      throw failed('Could not send the key: ' + messageOf(error))
    }
    return { ok: true }
  })

  handle('settings.save', async (input) => {
    const patch = validateSettings(inputObj(input))
    const before = settings
    const next = { ...settings }
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      const value = patch[key]
      if (value === undefined || value === before[key]) continue
      try {
        await orca.settings.set(key, value)
      } catch (error) {
        throw failed(`Could not save ${key}: ` + messageOf(error))
      }
      ;(next as Record<string, unknown>)[key] = value
      settings = { ...next }
    }
    await applySettings(before)
    return { ...settings }
  })

  handle('pr.url', (input) => {
    const key = str(inputObj(input), 'key')
    const w = need(watcher, 'watcher')
    sessionFor(key, false)
    const pr = w.pr(key)
    if (!pr || !/^https:\/\//.test(pr.url)) throw conflict('This session has no pull request')
    return { url: pr.url }
  })

  handle('image.read', async (input) => {
    const data = await readImage(str(inputObj(input), 'src'), seam?.images ?? nodeImageIo)
    if (!data) throw conflict('Could not show that image')
    return { data }
  })

  handle('board.url', async () => {
    try {
      return { url: await web.start() }
    } catch (error) {
      throw failed('Could not start the board page: ' + messageOf(error))
    }
  })

  handle('dev.seed', (input) => {
    const obj = inputObj(input)
    if (!looksLikeView(obj)) throw invalid('Expected a ViewModel')
    seeded = JSON.parse(JSON.stringify(obj)) as ViewModel
    return { ok: true }
  })

  updateStatusBar(fallbackView(settings))

  current = {
    stop(): void {
      stopped = true
      if (tickTimer) clearTimeout(tickTimer)
      tickTimer = null
      stopWatcher()
      web.stop()
    }
  }
}

export function deactivate(): void {
  const run = current
  current = null
  run?.stop()
}
