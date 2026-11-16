import type { HostApi, StorageApi } from 'orca/worker'
import type { Bins, Deps, FixMode, Settings } from './deps.ts'
import type { createCli } from './orcacli.ts'
import type { AgentInfo, AgentState, Session } from './sessions.ts'
import { buildSessions, createIndex, listStateOf } from './sessions.ts'
import type { GhStatus, PrState } from './github.ts'
import { failedLogTail, prFor, readRepo } from './github.ts'
import type { Column, Lane, NeedKind, PlanStep, Tone } from './board.ts'
import { columnOf, labelOf, place } from './board.ts'
import type { Ledger, RouteEvent } from './events.ts'
import { EMPTY_LEDGER, diffEvents, fixingFor, normalizeLedger, recordSent, recordSkipped, resetAttempts } from './events.ts'
import { messageFor } from './messages.ts'
import type { createDelivery, SendResult } from './deliver.ts'
import { homePath, readOutbox, writeBoard } from './home.ts'
import type { OutMsg } from './home.ts'
import type { BoardLine, ProjectLine } from './instructions.ts'
import { bestMatch, boardMarkdown } from './instructions.ts'
import type { NeedCard, ToolCall } from './needs.ts'
import { approvalCard, doingText, reconcile } from './needs.ts'
import type { createOrchestrator } from './orchestrator.ts'
import type { GuardHit } from './guard.ts'

export type ChatItem = {
  id: string
  at: number
  from: 'you' | 'orchestrator' | 'panel'
  kind: 'text' | 'progress' | 'question' | 'result' | 'card' | 'plan' | 'action'
  verb?: 'start' | 'tell'
  ref?: string
  live?: ActionLive | null
  text: string
  plan?: PlanStep[]
  options?: string[]
  answered?: string
  card?: NeedCard
}

export type ActionLive = { key: string; name: string; label: string; tone: Tone; attention: boolean; queued: number }

export type Row = {
  key: string
  name: string
  project: string
  branch: string | null
  agentKind: string | null
  started: 'orchestrator' | 'you'
  pr: number | null
  prUrl: string | null
  lane: Lane
  column: Column
  phrase: string
  label: string
  tone: Tone
  at: number | null
  draft: boolean | null
  working: boolean
  card: NeedCard | null
  autoFix: { ci: boolean; review: boolean }
  removable: boolean
  queued: number
  stale: boolean
}

export type ViewModel = {
  rev: number
  firstRun: boolean
  orch: { state: AgentState; agentKind: string; since: number; doing: string } | null
  chat: ChatItem[]
  queued: number
  rows: Row[]
  idle: Row[]
  needs: number
  asks: number
  gh: GhStatus
  watching: number
  intervalSec: number
  hooksOff: boolean
  guard: { on: boolean; blocksToday: number }
}

type AutoFix = { ci?: boolean; review?: boolean }
type GuardLog = { day: string; blocks: number }
type RepoData = { prs: PrState[]; defaultBranch: string | null }
type Unreach = { sig: string | null; tick: number }
export type PrDetail = {
  checks: { name: string; state: 'pass' | 'fail' | 'pending'; url: string | null }[]
  threads: { resolved: boolean; comments: { author: string; path: string | null; line: number | null; body: string }[] }[]
  attempts: { used: number; max: number }
  lastSent: { kind: string; sha: string; at: number } | null
}

const CHAT_CAP = 500
const TOOL_CAP = 200
const LOG_LINES = 80
const LOG_JOBS = 3
const HOOKS_EVERY_MS = 60000
const ORCH_KEY = 'orchestrator'
const PIN_CAP = 200
const UNGUARD_READS = 3
const UNGUARD_SPAN_MS = 2 * 60 * 1000
const GONE_MS = 10 * 60 * 1000
const READ_FLOOR_MS = 10000
const RATE_FLOOR_SEC = 300
const RETRY_STEP_SEC = 30
const TAIL_CAP = 200
const LANE_ORDER: Lane[] = ['needs', 'building', 'validating', 'review', 'ready', 'idle']
const LANE_LABEL: Record<Lane, string> = {
  needs: 'Needs you',
  building: 'Building',
  validating: 'Validating',
  review: 'Needs review',
  ready: 'Ready',
  idle: 'Idle'
}
const NEED_ORDER: NeedKind[] = ['approval', 'attempts', 'ask', 'merge-blocked', 'unreachable']
const START_WAIT_MS = 2 * 60 * 1000
const START_AGAIN_MS = 30 * 60 * 1000

type Modes = { ci: FixMode; conflict: FixMode; review: FixMode }

function modeFor(modes: Modes, ev: RouteEvent): FixMode {
  if (ev.kind === 'ci' || ev.kind === 'escalate') return modes.ci
  if (ev.kind === 'conflict') return modes.conflict
  return modes.review
}

function askDetail(events: RouteEvent[]): string {
  const parts: string[] = []
  if (events.some((ev) => ev.kind === 'ci' || ev.kind === 'escalate')) parts.push('CI failed')
  if (events.some((ev) => ev.kind === 'conflict')) parts.push('Merge conflicts')
  let comments = 0
  for (const ev of events) {
    if (ev.kind === 'bot-batch') comments += ev.items.length
    else if (ev.kind !== 'ci' && ev.kind !== 'conflict' && ev.kind !== 'escalate') comments += 1
  }
  if (comments > 0) parts.push(comments === 1 ? '1 review comment' : `${comments} review comments`)
  return parts.join(' · ')
}

export function appendChat(log: ChatItem[], item: ChatItem): ChatItem[] {
  const next = [...log, item]
  return next.length > CHAT_CAP ? next.slice(next.length - CHAT_CAP) : next
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOf<T>(value: unknown, ok: (v: unknown) => boolean): T[] {
  return Array.isArray(value) ? (value.filter(ok) as T[]) : []
}

function isChat(v: unknown): boolean {
  return isObj(v) && typeof v.id === 'string' && typeof v.text === 'string' && typeof v.kind === 'string'
}

function isCard(v: unknown): boolean {
  return isObj(v) && typeof v.id === 'string' && typeof v.key === 'string' && typeof v.kind === 'string'
}

function isAgent(v: unknown): boolean {
  return isObj(v) && typeof v.state === 'string'
}

function recordOf<T>(value: unknown, ok: (v: unknown) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isObj(value)) return out
  for (const [k, v] of Object.entries(value)) if (ok(v)) out[k] = v as T
  return out
}

function prKeyOf(pr: PrState): string {
  return `${pr.repo}#${pr.number}`
}

function dayOf(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function hasList(raw: unknown, key: string): boolean {
  if (Array.isArray(raw)) return true
  if (!isObj(raw)) return false
  if (Array.isArray(raw[key])) return true
  return isObj(raw.result) && Array.isArray(raw.result[key])
}

function listOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!isObj(raw)) return []
  if (Array.isArray(raw[key])) return raw[key] as unknown[]
  return isObj(raw.result) && Array.isArray(raw.result[key]) ? (raw.result[key] as unknown[]) : []
}

function idsOf(workspaces: unknown, trees: unknown): Set<string> {
  const ids = new Set<string>()
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') ids.add(v)
  }
  for (const row of listOf(workspaces, 'workspaces')) if (isObj(row)) add(row.id)
  for (const row of listOf(trees, 'worktrees')) {
    if (!isObj(row)) continue
    add(row.id)
    add(row.instanceId)
  }
  return ids
}

function agentSig(session: Session): string {
  const a = session.agent
  return JSON.stringify([a.state, a.terminalId, a.sessionId, a.chatId, session.dispatchId])
}

export function putPlan(log: ChatItem[], steps: PlanStep[], id: () => string, at: number): ChatItem[] {
  const done = steps.filter((s) => s.status === 'done').length
  const text = `Plan · ${done} of ${steps.length} done`
  let last = -1
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].from === 'you') break
    if (log[i].kind === 'plan') {
      last = i
      break
    }
  }
  if (last < 0) return appendChat(log, { id: id(), at, from: 'orchestrator', kind: 'plan', text, plan: steps.map((s) => ({ ...s })) })
  return log.map((item, i) => (i === last ? { ...item, text, plan: steps.map((s) => ({ ...s })) } : item))
}

function cardItemId(card: NeedCard): string {
  return `card:${card.id}:${card.at}`
}

function viewGh(status: GhStatus): GhStatus {
  if (status.ok) return { ok: true }
  if (status.retryInSec === undefined) return { ...status }
  return { ...status, retryInSec: Math.ceil(status.retryInSec / RETRY_STEP_SEC) * RETRY_STEP_SEC }
}

function viewSig(view: ViewModel): string {
  return JSON.stringify({ ...view, rev: 0 })
}

export function createWatcher(o: {
  deps: Deps
  bins: Bins
  cli: ReturnType<typeof createCli>
  host: HostApi<'worker'>
  store: StorageApi
  orchestrator: ReturnType<typeof createOrchestrator>
  delivery: ReturnType<typeof createDelivery>
  settings(): Settings
  onChange(view: ViewModel): void
}) {
  let chat: ChatItem[] = []
  let ledgers: Record<string, Ledger> = {}
  let cards: NeedCard[] = []
  let autofix: Record<string, AutoFix> = {}
  let tracked: string[] = []
  let guardlog: GuardLog = { day: '', blocks: 0 }
  let agentMap: Record<string, AgentInfo> = {}

  let workspaces: unknown = null
  let sessions: Session[] = []
  let idx = createIndex([])
  const prs = new Map<string, PrState>()
  const staleKeys = new Set<string>()
  const repoData = new Map<string, RepoData>()
  const readBranches = new Map<string, Set<string>>()
  const limits = new Map<string, { used: number; rounds: number }>()
  const unreachable = new Map<string, Unreach>()
  const asks = new Map<string, RouteEvent[]>()
  const approved = new Set<string>()
  const launched = new Map<string, number>()
  let tickNo = 0
  let gen = 0
  let carried: { target: string; text: string }[] = []
  const tools = new Map<string, ToolCall>()
  let guardSet = new Set<string>()
  const pinned = new Map<string, number>()
  const strikes = new Map<string, { count: number; first: number }>()
  const goneSince = new Map<string, number>()
  let seenIds = new Set<string>()
  const notes = new Map<string, { base: string; detail: string }>()
  let again = false
  let gh: GhStatus = { ok: true }
  let rateUntil = 0
  const readAt = new Map<string, number>()
  const readStatus = new Map<string, GhStatus>()
  const forced = new Set<string>()
  let readInterval: number | null = null
  const tails = new Map<string, { check: string; tail: string }[]>()
  let hooksOff = false
  let hooksAt = -Infinity
  let boardBody: string | null = null
  let readyKeys = new Set<string>()
  let rev = 0
  let current: ViewModel
  let sig = ''
  let running: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let seq = 0
  const saved = new Map<string, string>()
  let writing: Promise<void> = Promise.resolve()

  function newId(prefix: string): string {
    seq += 1
    return `${prefix}${o.deps.now()}-${seq}`
  }

  function snapshot(): Record<string, unknown> {
    return { chat, ledgers, cards, autofix, tracked, guardlog, agents: agentMap, ready: [...readyKeys], guarded: [...guardSet] }
  }

  function persist(): Promise<void> {
    const pending: [string, string][] = []
    for (const [key, value] of Object.entries(snapshot())) {
      const text = JSON.stringify(value)
      if (saved.get(key) !== text) pending.push([key, text])
    }
    if (pending.length === 0) return writing
    for (const [key, text] of pending) saved.set(key, text)
    const next = writing.then(async () => {
      for (const [key, text] of pending) {
        try {
          await o.store.set(key, JSON.parse(text))
        } catch {
          if (saved.get(key) === text) saved.delete(key)
        }
      }
    })
    writing = next.catch(() => undefined)
    return writing
  }

  function modesOf(session: Session): Modes {
    const s = o.settings()
    const base = session.started === 'orchestrator' || s.scope === 'all'
    const over = autofix[session.key] ?? {}
    const pick = (flag: boolean | undefined, mode: FixMode): FixMode => {
      if (flag === false) return 'ignore'
      if (flag === true) return mode === 'ignore' ? 'fix' : mode
      return base ? mode : 'ignore'
    }
    const conflict: FixMode = over.ci === false || !(base || over.ci === true) ? 'ignore' : s.onConflict
    return { ci: pick(over.ci, s.onCi), conflict, review: pick(over.review, s.onReview) }
  }

  function autoFixOf(session: Session): { ci: boolean; review: boolean } {
    const modes = modesOf(session)
    return { ci: modes.ci !== 'ignore', review: modes.review !== 'ignore' }
  }

  function nameOf(key: string): string {
    if (key === ORCH_KEY) return o.orchestrator.session()?.name ?? 'Orchestrator'
    return idx.byKey(key)?.name ?? key
  }

  function notify(title: string, body: string): void {
    o.host.call('notifications.show', { title, body }).catch(() => undefined)
  }

  function addCardItem(card: NeedCard): NeedCard {
    const prior = chat.find((item) => item.kind === 'card' && item.card && item.card.id === card.id && item.card.resolved === null)
    if (prior && prior.card) {
      const kept = { ...card, at: prior.card.at }
      syncCardItem(kept)
      return kept
    }
    chat = appendChat(chat, { id: cardItemId(card), at: card.at, from: 'panel', kind: 'card', text: `${card.title}: ${card.detail}`, card: { ...card } })
    notify(`${card.title} needs you`, card.detail)
    return card
  }

  function closeCardItem(card: NeedCard, how: string): void {
    const id = cardItemId(card)
    chat = chat.map((item) => (item.id === id && item.card ? { ...item, card: { ...item.card, resolved: how } } : item))
  }

  function syncCardItem(card: NeedCard): void {
    const id = cardItemId(card)
    chat = chat.map((item) => (item.id === id ? { ...item, text: `${card.title}: ${card.detail}`, card: { ...card } } : item))
  }

  function needFor(key: string): NeedCard | null {
    const mine = cards.filter((c) => c.key === key)
    for (const kind of NEED_ORDER) {
      const hit = mine.find((c) => c.kind === kind)
      if (hit) return hit
    }
    return null
  }

  function agentOf(session: Session | null): string | null {
    if (!session || session.agent.state === 'none') return null
    return session.agent.kind ?? 'running'
  }

  function boardBodyOf(rows: Row[]): { lines: BoardLine[]; projects: ProjectLine[] } {
    const lines: BoardLine[] = rows.map((r) => ({
      name: r.name,
      key: r.key,
      project: r.project,
      lane: LANE_LABEL[r.lane],
      phrase: r.phrase,
      branch: r.branch,
      pr: r.pr,
      dispatchId: idx.byKey(r.key)?.dispatchId ?? null,
      started: r.started,
      agent: agentOf(idx.byKey(r.key))
    }))
    const byRepo = new Map<string, ProjectLine>()
    for (const s of sessions) {
      if (!s.repoId) continue
      if (byRepo.has(s.repoId) && !s.isMain) continue
      byRepo.set(s.repoId, { name: s.project || s.name, repoId: s.repoId, path: s.path })
    }
    return { lines, projects: [...byRepo.values()] }
  }

  function liveFor(item: ChatItem, rows: Row[]): ActionLive | null {
    const key = item.verb === 'start' ? (sessions.find((s) => s.dispatchId === item.ref)?.key ?? null) : (item.ref ?? null)
    const row = key === null ? null : rows.find((r) => r.key === key)
    if (!row) return null
    return { key: row.key, name: row.name, label: row.label, tone: row.tone, attention: row.lane === 'needs', queued: row.queued }
  }

  function removable(session: Session): boolean {
    const record = o.orchestrator.record()
    if (session.isMain || !session.ids[1]) return false
    return !(record && (session.path === record.home || session.ids.includes(record.workspaceId)))
  }

  function buildView(): ViewModel {
    const now = o.deps.now()
    const s = o.settings()
    const all: Row[] = []
    for (const session of sessions) {
      const pr = prs.get(session.key) ?? null
      const card = needFor(session.key)
      const ledger = pr ? ledgers[prKeyOf(pr)] : undefined
      const fixing = pr && ledger ? fixingFor(ledger, pr) : null
      const placed = place({
        session,
        pr,
        need: card ? { kind: card.kind, detail: card.detail } : null,
        fixing,
        now
      })
      if (!placed) continue
      const since = session.agent.since > 0 ? session.agent.since : null
      all.push({
        key: session.key,
        name: session.name,
        project: session.project,
        branch: session.branch,
        agentKind: session.agent.kind,
        started: session.started,
        pr: pr ? pr.number : null,
        prUrl: pr ? pr.url : null,
        lane: placed.lane,
        column: columnOf({ session, pr, fixing, now }),
        phrase: placed.phrase,
        label: labelOf(placed.phrase, placed.lane),
        tone: placed.tone,
        at: fixing && placed.phrase.includes(' · sent ') ? fixing.at : since,
        draft: pr ? pr.isDraft : null,
        working: session.agent.state === 'working',
        card,
        autoFix: autoFixOf(session),
        removable: removable(session),
        queued: o.delivery.queued(session.key).length,
        stale: staleKeys.has(session.key)
      })
    }
    const ordered = LANE_ORDER.flatMap((lane) => all.filter((r) => r.lane === lane))
    const orchSession = o.orchestrator.session()
    const record = o.orchestrator.record()
    return {
      rev,
      firstRun: s.orchestratorAgent === '',
      orch: orchSession && record
        ? {
            state: orchSession.agent.state,
            agentKind: record.agentKind,
            since: orchSession.agent.since,
            doing: orchSession.agent.state === 'working' && orchSession.agent.terminalId ? doingText(tools.get(orchSession.agent.terminalId), now) : ''
          }
        : null,
      chat: chat.map((c) => (c.kind === 'action' ? { ...c, live: liveFor(c, all) } : { ...c })),
      queued: o.delivery.queued(ORCH_KEY).length,
      rows: ordered.filter((r) => r.lane !== 'idle'),
      idle: ordered.filter((r) => r.lane === 'idle'),
      needs: cards.length,
      asks: chat.filter((c) => c.kind === 'question' && !c.answered).length,
      gh: viewGh(gh),
      watching: sessions.filter((x) => prs.has(x.key)).length,
      intervalSec: s.intervalSec,
      hooksOff,
      guard: { on: s.guard, blocksToday: guardlog.day === dayOf(now) ? guardlog.blocks : 0 }
    }
  }

  function publish(): ViewModel {
    const next = buildView()
    const nextSig = viewSig(next)
    if (nextSig !== sig) {
      rev += 1
      next.rev = rev
      sig = nextSig
      current = next
      try {
        o.onChange(next)
      } catch {
        return current
      }
    } else {
      current = { ...next, rev }
    }
    return current
  }

  function sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const id of a) if (!b.has(id)) return false
    return true
  }

  function setGuarded(next: Set<string>): void {
    if (sameSet(next, guardSet)) return
    guardSet = next
    void persist()
  }

  function forget(id: string): void {
    pinned.delete(id)
    strikes.delete(id)
    goneSince.delete(id)
  }

  function rebuildGuarded(): void {
    const now = o.deps.now()
    const next = new Set<string>()
    const orchIds = new Set<string>()
    const handIds = new Set<string>()
    for (const s of sessions) {
      for (const id of s.ids) (s.started === 'orchestrator' ? orchIds : handIds).add(id)
    }
    for (const id of orchIds) {
      next.add(id)
      pinned.delete(id)
      strikes.delete(id)
      goneSince.delete(id)
    }
    const record = o.orchestrator.record()
    const home = record?.workspaceId ?? ''
    for (const id of new Set([...guardSet, ...pinned.keys()])) {
      if (orchIds.has(id) || id === home) continue
      if (handIds.has(id)) {
        goneSince.delete(id)
        const prev = strikes.get(id)
        const strike = prev ? { count: prev.count + 1, first: prev.first } : { count: 1, first: now }
        if (strike.count >= UNGUARD_READS && now - strike.first >= UNGUARD_SPAN_MS) {
          forget(id)
          continue
        }
        strikes.set(id, strike)
        next.add(id)
        continue
      }
      if (seenIds.has(id)) {
        goneSince.delete(id)
        next.add(id)
        continue
      }
      const since = goneSince.get(id) ?? now
      if (now - since >= GONE_MS) {
        forget(id)
        continue
      }
      goneSince.set(id, since)
      next.add(id)
    }
    if (home !== '') next.add(home)
    for (const id of [...strikes.keys()]) if (!next.has(id)) strikes.delete(id)
    for (const id of [...goneSince.keys()]) if (!next.has(id)) goneSince.delete(id)
    setGuarded(next)
  }

  function guardNow(ids: string[]): void {
    const next = new Set(guardSet)
    const now = o.deps.now()
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      pinned.delete(id)
      pinned.set(id, now)
      strikes.delete(id)
      goneSince.delete(id)
      next.add(id)
    }
    while (pinned.size > PIN_CAP) {
      const oldest = pinned.keys().next().value
      if (oldest === undefined || !pinned.delete(oldest)) break
      next.delete(oldest)
      strikes.delete(oldest)
      goneSince.delete(oldest)
    }
    setGuarded(next)
  }

  function homeDir(): string {
    return o.orchestrator.record()?.home ?? homePath(o.deps)
  }

  async function stepOutbox(): Promise<{ target: string; text: string }[]> {
    const tells: { target: string; text: string }[] = []
    let messages: OutMsg[] = []
    try {
      messages = await readOutbox(o.deps, homeDir())
    } catch {
      return tells
    }
    for (const msg of messages) {
      const at = o.deps.now()
      if (msg.kind === 'track') {
        if (!tracked.includes(msg.dispatchId)) {
          tracked = [...tracked, msg.dispatchId]
          chat = appendChat(chat, { id: newId('a'), at, from: 'orchestrator', kind: 'action', verb: 'start', ref: msg.dispatchId, text: 'New workspace' })
        }
      } else if (msg.kind === 'tell') {
        tells.push({ target: msg.target, text: msg.text })
      } else if (msg.kind === 'plan') {
        chat = putPlan(chat, msg.steps, () => newId('o'), at)
      } else if (msg.kind === 'question') {
        chat = appendChat(chat, { id: newId('o'), at, from: 'orchestrator', kind: 'question', text: msg.text, options: [...msg.options] })
      } else {
        chat = appendChat(chat, { id: newId('o'), at, from: 'orchestrator', kind: msg.kind, text: msg.text })
      }
    }
    return tells
  }

  async function stepSessions(): Promise<boolean> {
    try {
      const [ws, trees, workers] = await Promise.all([
        o.host.call('workspace.list', { includeStatus: true } as never),
        o.cli.json(['worktree', 'list']),
        o.cli.json(['orchestration', 'worker-list', '--limit', '100'])
      ])
      if (!isObj(ws) || !Array.isArray(ws.workspaces)) return false
      if (!hasList(trees, 'worktrees') || !hasList(workers, 'workers')) return false
      const record = o.orchestrator.record()
      const home = homeDir()
      workspaces = ws
      o.orchestrator.setListState(listStateOf(ws, home))
      sessions = buildSessions({ workspaces: ws, worktrees: trees, workers, agents: agentMap, tracked, marker: record?.marker ?? '', homePath: home })
      idx = createIndex(sessions)
      seenIds = idsOf(ws, trees)
      return true
    } catch {
      return false
    }
  }

  function findTarget(target: string): Session | null {
    return idx.byKey(target) ?? sessions.find((s) => s.name === target) ?? sessions.find((s) => s.name.toLowerCase() === target.toLowerCase()) ?? null
  }

  async function deliver(session: Session, subject: string, body: string): Promise<SendResult | null> {
    try {
      const result = await o.delivery.send(session, subject, body)
      if (result === 'unreachable') unreachable.set(session.key, { sig: agentSig(session), tick: tickNo })
      else unreachable.delete(session.key)
      return result
    } catch {
      return null
    }
  }

  async function stepTells(tells: { target: string; text: string }[], fresh: boolean): Promise<void> {
    for (const tell of tells) {
      const session = findTarget(tell.target)
      if (!session && !fresh) {
        carried = [...carried, tell]
        continue
      }
      if (!session) {
        chat = appendChat(chat, { id: newId('p'), at: o.deps.now(), from: 'panel', kind: 'text', text: `Could not find a session named "${tell.target}".` })
        continue
      }
      await deliver(session, 'From the orchestrator', tell.text)
      chat = appendChat(chat, { id: newId('a'), at: o.deps.now(), from: 'orchestrator', kind: 'action', verb: 'tell', ref: session.key, text: `Wrote to ${session.name}` })
    }
  }

  function branchesOf(repo: string): string[] {
    return [...new Set(sessions.filter((s) => s.repo === repo && s.branch !== null).map((s) => s.branch as string))].sort()
  }

  async function readOne(repo: string, branches: string[]): Promise<{ status: GhStatus; defaultBranch: string | null; prs: PrState[] }> {
    try {
      return await readRepo(o.deps, o.bins.gh, repo, branches)
    } catch {
      return { status: { ok: false, reason: 'error' }, defaultBranch: null, prs: [] }
    }
  }

  async function stepGithub(): Promise<Set<string>> {
    const okRepos = new Set<string>()
    const repos = [...new Set(sessions.map((s) => s.repo).filter((r): r is string => r !== null))]
    const now = o.deps.now()
    const intervalSec = o.settings().intervalSec
    if (readInterval !== null && readInterval !== intervalSec) for (const repo of readAt.keys()) forced.add(repo)
    readInterval = intervalSec
    const windowMs = Math.max(1, intervalSec) * 1000
    let first: GhStatus | null = null
    const failed = new Set<string>()
    if (now < rateUntil) {
      first = { ok: false, reason: 'rate-limited', retryInSec: Math.max(1, Math.ceil((rateUntil - now) / 1000)) }
      for (const repo of repos) failed.add(repo)
    } else {
      for (const repo of repos) {
        const last = readAt.get(repo)
        const since = last === undefined ? Infinity : now - last
        const kept = readStatus.get(repo)
        const branches = branchesOf(repo)
        const had = readBranches.get(repo)
        const grew = had === undefined || branches.some((b) => !had.has(b))
        if (kept && (since < READ_FLOOR_MS || (since < windowMs && !forced.has(repo) && !grew))) {
          if (kept.ok) {
            okRepos.add(repo)
            continue
          }
          failed.add(repo)
          if (!first) first = kept
          continue
        }
        forced.delete(repo)
        readAt.set(repo, now)
        const res = await readOne(repo, branches)
        readStatus.set(repo, res.status)
        if (res.status.ok) readBranches.set(repo, new Set(branches))
        if (res.status.ok) {
          repoData.set(repo, { prs: res.prs, defaultBranch: res.defaultBranch })
          okRepos.add(repo)
          continue
        }
        failed.add(repo)
        if (!first) first = res.status
        if (res.status.reason === 'rate-limited') {
          const waitSec = res.status.soft ? (res.status.retryInSec ?? RATE_FLOOR_SEC) : Math.max(res.status.retryInSec ?? 0, RATE_FLOOR_SEC)
          rateUntil = o.deps.now() + waitSec * 1000
          first = { ...res.status, retryInSec: waitSec }
          for (const rest of repos) if (!okRepos.has(rest)) failed.add(rest)
          break
        }
      }
    }
    gh = first ?? { ok: true }
    const keep = new Map(prs)
    prs.clear()
    staleKeys.clear()
    for (const session of sessions) {
      if (session.repo === null) continue
      if (failed.has(session.repo)) {
        staleKeys.add(session.key)
        const prev = keep.get(session.key)
        if (prev) prs.set(session.key, prev)
        continue
      }
      const data = repoData.get(session.repo)
      const pr = data ? prFor(data.prs, session, data.defaultBranch) : null
      if (pr) prs.set(session.key, pr)
    }
    return okRepos
  }

  async function logsFor(ev: RouteEvent, pr: PrState): Promise<{ check: string; tail: string }[]> {
    if ((ev.kind !== 'ci' && ev.kind !== 'escalate') || o.bins.gh === null) return []
    const tailKey = `${pr.repo}:ci:${prKeyOf(pr)}:${ev.sha}`
    const known = tails.get(tailKey)
    if (known) return known
    const logs: { check: string; tail: string }[] = []
    for (const check of ev.checks.filter((c) => c.jobId !== null).slice(0, LOG_JOBS)) {
      try {
        const tail = await failedLogTail(o.deps, o.bins.gh, pr.repo, check.jobId as string, LOG_LINES)
        if (tail) logs.push({ check: check.name, tail })
      } catch {
        continue
      }
    }
    tails.set(tailKey, logs)
    while (tails.size > TAIL_CAP) {
      const oldest = tails.keys().next().value
      if (oldest === undefined || !tails.delete(oldest)) break
    }
    return logs
  }

  function stillUnreachable(session: Session): boolean {
    const mark = unreachable.get(session.key)
    return mark !== undefined && mark.sig === agentSig(session)
  }

  function clearOldMark(key: string): void {
    const mark = unreachable.get(key)
    if (mark && mark.tick !== tickNo) unreachable.delete(key)
  }

  async function eventsFor(session: Session, okRepos: Set<string>): Promise<void> {
    const s = o.settings()
    const mark = unreachable.get(session.key)
    if (mark && mark.sig === null) unreachable.set(session.key, { ...mark, sig: agentSig(session) })
    if (unreachable.has(session.key) && !stillUnreachable(session)) unreachable.delete(session.key)
    const pr = prs.get(session.key)
    if (!pr) {
      if (session.repo === null || okRepos.has(session.repo)) {
        limits.delete(session.key)
        asks.delete(session.key)
        clearOldMark(session.key)
      }
      return
    }
    if (staleKeys.has(session.key)) return
    const prKey = prKeyOf(pr)
    const modes = modesOf(session)
    const diff = diffEvents(pr, ledgers[prKey] ?? EMPTY_LEDGER, {
      now: o.deps.now(),
      maxAttempts: s.attempts,
      ci: modes.ci !== 'ignore',
      conflict: modes.conflict !== 'ignore',
      review: modes.review !== 'ignore',
      escalate: o.orchestrator.session() !== null,
      rounds: s.escalations
    })
    ledgers = { ...ledgers, [prKey]: diff.ledger }
    if (diff.limitHit) limits.set(session.key, { used: diff.ledger.ciSends[prKey] ?? s.attempts, rounds: diff.ledger.escalations[prKey]?.rounds ?? 0 })
    else limits.delete(session.key)
    if (diff.events.length === 0) clearOldMark(session.key)
    const held: RouteEvent[] = []
    let stopped = false
    for (const ev of diff.events) {
      if (modeFor(modes, ev) === 'ask' && !approved.has(ev.key)) {
        held.push(ev)
        continue
      }
      if (ev.kind === 'escalate') {
        if (!(await escalate(session, pr, ev))) {
          const ledger = ledgers[prKey] ?? EMPTY_LEDGER
          limits.set(session.key, { used: ledger.ciSends[prKey] ?? s.attempts, rounds: ledger.escalations[prKey]?.rounds ?? 0 })
        }
        continue
      }
      if (stopped || stillUnreachable(session)) continue
      const result = await route(session, pr, ev)
      if (result === 'unreachable' && s.noAgent === 'start' && (await autoStart(session))) {
        unreachable.delete(session.key)
        stopped = true
      }
    }
    if (held.length > 0) asks.set(session.key, held)
    else asks.delete(session.key)
  }

  async function route(session: Session, pr: PrState, ev: RouteEvent): Promise<SendResult | null> {
    let text: { subject: string; body: string }
    try {
      text = messageFor(ev, pr, { logs: await logsFor(ev, pr) })
    } catch {
      return null
    }
    const result = await deliver(session, text.subject, text.body)
    if (result !== null && result !== 'unreachable') {
      const prKey = prKeyOf(pr)
      ledgers = { ...ledgers, [prKey]: recordSent(ledgers[prKey] ?? EMPTY_LEDGER, pr, ev, o.deps.now()) }
      approved.delete(ev.key)
      launched.delete(session.key)
    }
    return result
  }

  async function escalate(session: Session, pr: PrState, ev: RouteEvent): Promise<boolean> {
    const orch = o.orchestrator.session()
    if (!orch) return false
    try {
      const text = messageFor(ev, pr, { logs: await logsFor(ev, pr), session: session.name })
      const result = await o.delivery.send(orch, text.subject, text.body)
      if (result === 'unreachable') return false
    } catch {
      return false
    }
    const prKey = prKeyOf(pr)
    ledgers = { ...ledgers, [prKey]: recordSent(ledgers[prKey] ?? EMPTY_LEDGER, pr, ev, o.deps.now()) }
    approved.delete(ev.key)
    return true
  }

  async function autoStart(session: Session): Promise<boolean> {
    const now = o.deps.now()
    const at = launched.get(session.key)
    if (at !== undefined && now - at < START_WAIT_MS) return true
    if (at !== undefined && now - at < START_AGAIN_MS) return false
    const s = o.settings()
    const agent = s.workerAgent || s.orchestratorAgent
    const workspaceId = session.ids[0]
    if (!agent || !workspaceId) return false
    try {
      await o.host.call('agent.launch', { workspaceId, agent } as never)
    } catch {
      return false
    }
    launched.set(session.key, now)
    chat = appendChat(chat, { id: newId('p'), at: now, from: 'panel', kind: 'text', text: `Started an agent in ${session.name} to work on its pull request.` })
    return true
  }

  async function stepEvents(okRepos: Set<string>): Promise<void> {
    for (const session of sessions) {
      try {
        await eventsFor(session, okRepos)
      } catch {
        continue
      }
    }
  }

  function heldByFailedRepo(card: NeedCard, okRepos: Set<string>): boolean {
    if (card.kind !== 'attempts') return false
    const session = idx.byKey(card.key)
    return session !== null && session.repo !== null && !okRepos.has(session.repo)
  }

  function stepNeeds(fresh: boolean, okRepos: Set<string>): void {
    const now = o.deps.now()
    const wanted: NeedCard[] = []
    for (const session of sessions) {
      if (session.agent.state === 'blocked') {
        const terminal = session.agent.terminalId
        wanted.push(approvalCard(session, terminal ? tools.get(terminal) : undefined, now))
      }
      const limit = limits.get(session.key)
      if (limit !== undefined) {
        const detail = limit.rounds > 0 ? `${limit.used} fix attempts and ${limit.rounds} orchestrator rounds used` : `${limit.used} fix attempts used`
        wanted.push({ id: `attempts:${session.key}`, key: session.key, kind: 'attempts', title: session.name, detail, actions: ['retry', 'details'], at: now, resolved: null })
      }
      const held = asks.get(session.key)
      if (held && held.length > 0) {
        wanted.push({ id: `ask:${session.key}`, key: session.key, kind: 'ask', title: session.name, detail: askDetail(held), actions: ['fix', 'dismiss', 'details'], at: now, resolved: null })
      }
      if (unreachable.has(session.key)) {
        wanted.push({ id: `unreachable:${session.key}`, key: session.key, kind: 'unreachable', title: session.name, detail: 'No agent to message in this session', actions: ['start', 'dismiss', 'details'], at: now, resolved: null })
      }
    }
    const orch = o.orchestrator.session()
    if (orch && orch.agent.state === 'blocked') {
      const terminal = orch.agent.terminalId
      wanted.push(approvalCard(orch, terminal ? tools.get(terminal) : undefined, now))
    }
    const wantedIds = new Set(wanted.map((c) => c.id))
    for (const card of cards) {
      if (wantedIds.has(card.id)) continue
      if (card.kind === 'merge-blocked' || !fresh || heldByFailedRepo(card, okRepos)) wanted.push(card)
    }
    const asked = wanted.map((card) => {
      const note = notes.get(card.id)
      if (!note) return card
      if (note.base === card.detail) return { ...card, detail: note.detail }
      notes.delete(card.id)
      return card
    })
    const result = reconcile(cards, asked, now)
    const settled = new Map<string, NeedCard>()
    for (const card of result.added) settled.set(card.id, addCardItem(card))
    for (const card of result.changed) syncCardItem(card)
    cards = result.open.map((c) => settled.get(c.id) ?? c)
    for (const card of result.closed) {
      notes.delete(card.id)
      closeCardItem(card, card.resolved ?? 'cleared')
    }
  }

  function wantedDetail(id: string): string | null {
    const now = o.deps.now()
    const key = id.startsWith('approval:') ? id.slice('approval:'.length) : null
    if (key === null) return null
    const session = key === ORCH_KEY ? o.orchestrator.session() : idx.byKey(key)
    if (!session) return null
    const terminal = session.agent.terminalId
    return approvalCard(session, terminal ? tools.get(terminal) : undefined, now).detail
  }

  function stepReadyNotes(view: ViewModel): void {
    const next = new Set<string>()
    for (const r of view.rows) {
      if (r.lane !== 'ready') continue
      next.add(r.key)
      if (!readyKeys.has(r.key)) notify(`${r.name} is ready`, r.pr === null ? 'Mergeable' : `PR #${r.pr} is mergeable`)
    }
    readyKeys = next
  }

  async function attempt(fn: () => unknown): Promise<boolean> {
    try {
      await fn()
      return true
    } catch {
      return false
    }
  }

  function dropGone(okRepos: Set<string>): void {
    const live = new Set(sessions.map((s) => s.key))
    const liveRepos = new Set(sessions.map((s) => s.repo).filter((r): r is string => r !== null))
    const livePrs = new Set([...prs.values()].map(prKeyOf))
    const keptLedgers: Record<string, Ledger> = {}
    for (const [prKey, ledger] of Object.entries(ledgers)) {
      const repo = prKey.slice(0, prKey.lastIndexOf('#'))
      if (livePrs.has(prKey) || (liveRepos.has(repo) && !okRepos.has(repo))) keptLedgers[prKey] = ledger
    }
    ledgers = keptLedgers
    const keptFix: Record<string, AutoFix> = {}
    for (const [key, value] of Object.entries(autofix)) if (live.has(key)) keptFix[key] = value
    autofix = keptFix
    for (const key of [...limits.keys()]) if (!live.has(key)) limits.delete(key)
    for (const key of [...unreachable.keys()]) if (!live.has(key)) unreachable.delete(key)
    for (const key of [...asks.keys()]) if (!live.has(key)) asks.delete(key)
    for (const key of [...launched.keys()]) if (!live.has(key)) launched.delete(key)
  }

  function latestRequest(): string | null {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].from === 'you' && chat[i].kind === 'text') return chat[i].text
    return null
  }

  async function stepBoard(view: ViewModel): Promise<void> {
    if (!o.orchestrator.record()) return
    const body = boardBodyOf([...view.rows, ...view.idle])
    const request = latestRequest()
    const text = JSON.stringify({ body, request })
    if (text === boardBody) return
    const latest = request === null ? null : { request, match: bestMatch(request, body.lines) }
    await writeBoard(o.deps, homeDir(), boardMarkdown(body.lines, body.projects, o.deps.now()), latest)
    boardBody = text
  }

  async function stepHooks(): Promise<void> {
    const now = o.deps.now()
    if (now - hooksAt < HOOKS_EVERY_MS) return
    const res = await o.cli.json<{ enabled?: unknown } | null>(['agent', 'hooks', 'status'])
    hooksOff = !(isObj(res) && res.enabled === true)
    hooksAt = now
  }

  function busyIn(ws: unknown, path: string): boolean {
    return ws !== null && path !== '' && listStateOf(ws, path) === 'working'
  }

  async function flushOne(session: Session, ws: unknown): Promise<void> {
    const working = busyIn(ws, session.path)
    if (!working && o.delivery.queued(session.key).length === 0) return
    const target = working ? { ...session, agent: { ...session.agent, state: 'working' as AgentState } } : session
    try {
      await o.delivery.flush(target)
    } catch {
      return
    }
  }

  async function stepFlush(fresh: boolean): Promise<void> {
    const live = fresh ? sessions : []
    const orch = o.orchestrator.session()
    const all = orch ? [...live, orch] : live
    const queued = all.some((s) => o.delivery.queued(s.key).length > 0)
    const busy = all.some((s) => busyIn(workspaces, s.path))
    if (!queued && !busy) return
    let ws: unknown = null
    try {
      ws = await o.host.call('workspace.list', { includeStatus: true } as never)
    } catch {
      ws = null
    }
    for (const session of all) await flushOne(session, ws)
  }

  async function runTick(): Promise<void> {
    tickNo += 1
    const held = carried
    carried = []
    const tells = [...held, ...(await stepOutbox())]
    const fresh = await stepSessions()
    if (fresh) rebuildGuarded()
    await attempt(() => stepTells(tells, fresh))
    let okRepos = new Set<string>()
    await attempt(async () => {
      okRepos = await stepGithub()
    })
    if (fresh) await attempt(() => stepEvents(okRepos))
    await attempt(() => stepNeeds(fresh, okRepos))
    const view = buildView()
    if (fresh) stepReadyNotes(view)
    if (fresh) {
      const live = sessions.map((s) => s.key)
      await attempt(() => o.delivery.prune([...live, ORCH_KEY]))
      dropGone(okRepos)
    }
    await attempt(() => stepBoard(view))
    await attempt(stepHooks)
    await attempt(() => stepFlush(fresh))
    await persist()
    publish()
  }

  function run(queue: boolean): Promise<void> {
    if (running) {
      if (queue) again = true
      return running
    }
    running = runTick()
      .catch(() => undefined)
      .finally(() => {
        running = null
        if (again) {
          again = false
          void run(false)
        }
      })
    return running
  }

  function tick(): Promise<void> {
    return run(true)
  }

  function arm(g: number): void {
    if (!started || g !== gen) return
    if (timer) clearTimeout(timer)
    const ms = Math.max(1, o.settings().intervalSec) * 1000
    timer = setTimeout(() => {
      timer = null
      if (!started || g !== gen) return
      void run(false).then(() => arm(g))
    }, ms)
  }

  async function load(): Promise<void> {
    const read = async (key: string): Promise<unknown> => {
      try {
        return await o.store.get(key)
      } catch {
        return null
      }
    }
    chat = arrayOf<ChatItem>(await read('chat'), isChat).slice(-CHAT_CAP)
    const stored = recordOf<Ledger>(await read('ledgers'), (v) => isObj(v) && isObj(v.sent) && isObj(v.ciSends) && isObj(v.firstFail) && isObj(v.last))
    ledgers = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, normalizeLedger(v)]))
    cards = arrayOf<NeedCard>(await read('cards'), isCard)
    autofix = recordOf<AutoFix>(await read('autofix'), isObj)
    tracked = arrayOf<string>(await read('tracked'), (v) => typeof v === 'string')
    const log = await read('guardlog')
    guardlog = isObj(log) && typeof log.day === 'string' && typeof log.blocks === 'number' ? { day: log.day, blocks: log.blocks } : { day: '', blocks: 0 }
    agentMap = recordOf<AgentInfo>(await read('agents'), isAgent)
    unreachable.clear()
    for (const card of cards) if (card.kind === 'unreachable') unreachable.set(card.key, { sig: null, tick: 0 })
    readyKeys = new Set(arrayOf<string>(await read('ready'), (v) => typeof v === 'string'))
    const kept = arrayOf<string>(await read('guarded'), (v) => typeof v === 'string' && v !== '')
    guardSet = new Set(kept)
    pinned.clear()
    strikes.clear()
    goneSince.clear()
    seenIds = new Set<string>()
    const loadedAt = o.deps.now()
    for (const id of kept.slice(-PIN_CAP)) pinned.set(id, loadedAt)
    for (const [key, value] of Object.entries(snapshot())) saved.set(key, JSON.stringify(value))
    const record = o.orchestrator.record()
    if (record) setGuarded(new Set([...guardSet, record.workspaceId]))
    current = buildView()
    sig = viewSig(current)
  }

  current = buildView()
  sig = viewSig(current)

  return {
    load,
    tick,
    start(): void {
      if (started) return
      started = true
      gen += 1
      const g = gen
      void run(false).then(() => arm(g))
    },
    stop(): void {
      started = false
      gen += 1
      if (timer) clearTimeout(timer)
      timer = null
    },
    view(): ViewModel {
      return current
    },
    index(): ReturnType<typeof createIndex> {
      return idx
    },
    agents(): Record<string, AgentInfo> {
      return agentMap
    },
    setAgent(path: string, info: AgentInfo): void {
      agentMap = { ...agentMap, [path]: { ...info } }
      void persist()
    },
    listState(path: string): string | null {
      return listStateOf(workspaces, path)
    },
    async maskPermission(key: string): Promise<void> {
      if (key === ORCH_KEY) {
        await o.orchestrator.maskPermission()
        return
      }
      const entry = agentMap[key]
      const base: AgentInfo | null = entry ? entry : (() => {
        const session = idx.byKey(key)
        return session ? { ...session.agent, state: 'waiting' } : null
      })()
      if (!base) return
      agentMap = { ...agentMap, [key]: { ...base, permissionMasked: true } }
      await persist()
    },
    track(dispatchId: string): void {
      if (tracked.includes(dispatchId)) return
      tracked = [...tracked, dispatchId]
      void persist()
    },
    noteTool(terminalId: string, call: ToolCall): void {
      tools.delete(terminalId)
      tools.set(terminalId, call)
      while (tools.size > TOOL_CAP) {
        const oldest = tools.keys().next().value
        if (oldest === undefined || !tools.delete(oldest)) break
      }
      if (o.orchestrator.session()?.agent.terminalId === terminalId) publish()
    },
    noteGuard(key: string, hit: GuardHit, blocked: boolean): void {
      const now = o.deps.now()
      if (blocked) {
        const today = dayOf(now)
        guardlog = { day: today, blocks: (guardlog.day === today ? guardlog.blocks : 0) + 1 }
      }
      const id = `merge-blocked:${key}`
      const detail = blocked ? `Stopped: ${hit.command}` : `It attempted: ${hit.command}`
      const open = cards.find((c) => c.id === id)
      if (open) {
        const updated = { ...open, detail }
        cards = cards.map((c) => (c.id === id ? updated : c))
        syncCardItem(updated)
      } else {
        const card: NeedCard = { id, key, kind: 'merge-blocked', title: nameOf(key), detail, actions: ['dismiss', 'details'], at: now, resolved: null }
        cards = [...cards, card]
        addCardItem(card)
      }
      void persist()
      publish()
    },
    guarded(): Set<string> {
      return guardSet
    },
    guardNow,
    async addChat(entry: ChatItem): Promise<string> {
      const item = entry.id === '' ? { ...entry, id: newId('c') } : entry
      const at = chat.findIndex((c) => c.id === item.id)
      if (at < 0) chat = appendChat(chat, { ...item })
      else chat = chat.map((c, i) => (i === at ? { ...item } : c))
      if (item.card) {
        const card = item.card
        cards = cards.map((c) => (c.id === card.id && c.at === card.at && card.resolved === null ? { ...card } : c))
      }
      await persist()
      const view = publish()
      if (item.from === 'you') await attempt(() => stepBoard(view))
      return item.id
    },
    async setCardDetail(id: string, detail: string): Promise<void> {
      const open = cards.find((c) => c.id === id)
      if (!open) return
      const updated = { ...open, detail }
      const base = wantedDetail(id)
      if (base !== null) notes.set(id, { base, detail })
      cards = cards.map((c) => (c.id === id ? updated : c))
      syncCardItem(updated)
      await persist()
      publish()
    },
    async answerQuestion(id: string, option: string): Promise<boolean> {
      const item = chat.find((c) => c.id === id)
      if (!item || item.kind !== 'question' || item.answered) return false
      chat = chat.map((c) => (c.id === id ? { ...c, answered: option } : c))
      await persist()
      publish()
      return true
    },
    detail(key: string): PrDetail | null {
      const pr = prs.get(key)
      if (!pr) return null
      const prKey = prKeyOf(pr)
      const ledger = ledgers[prKey] ?? EMPTY_LEDGER
      const last = ledger.last[prKey]
      return {
        checks: pr.checks.map((c) => ({ name: c.name, state: c.state, url: c.url })),
        threads: pr.threads
          .filter((t) => !t.resolved)
          .map((t) => ({ resolved: false, comments: t.comments.map((c) => ({ author: c.author, path: c.path, line: c.line, body: c.body })) })),
        attempts: { used: ledger.ciSends[prKey] ?? 0, max: o.settings().attempts },
        lastSent: last ? { kind: last.kind, sha: last.sha, at: last.at } : null
      }
    },
    async resolveCard(id: string, how: string): Promise<void> {
      const card = cards.find((c) => c.id === id)
      if (!card) return
      cards = cards.filter((c) => c.id !== id)
      if (card.kind === 'attempts') limits.delete(card.key)
      if (card.kind === 'unreachable') unreachable.delete(card.key)
      if (card.kind === 'ask') {
        const pr = prs.get(card.key)
        if (pr) {
          const prKey = prKeyOf(pr)
          let ledger = ledgers[prKey] ?? EMPTY_LEDGER
          for (const ev of asks.get(card.key) ?? []) ledger = recordSkipped(ledger, ev, o.deps.now())
          ledgers = { ...ledgers, [prKey]: ledger }
        }
        asks.delete(card.key)
      }
      closeCardItem(card, how)
      await persist()
      publish()
    },
    async setAutoFix(key: string, which: 'ci' | 'review', on: boolean): Promise<void> {
      autofix = { ...autofix, [key]: { ...(autofix[key] ?? {}), [which]: on } }
      await persist()
      publish()
    },
    async retry(key: string): Promise<void> {
      if (running) await running
      const pr = prs.get(key)
      if (pr) {
        const prKey = prKeyOf(pr)
        const reset = resetAttempts(ledgers[prKey] ?? EMPTY_LEDGER, pr)
        const sent = { ...reset.sent }
        delete sent[`ci:${prKey}:${pr.headSha}`]
        ledgers = { ...ledgers, [prKey]: { ...reset, sent } }
      }
      limits.delete(key)
      const repo = idx.byKey(key)?.repo
      if (repo) forced.add(repo)
      const card = cards.find((c) => c.id === `attempts:${key}`)
      if (card) {
        cards = cards.filter((c) => c.id !== card.id)
        closeCardItem(card, 'retry')
      }
      await persist()
      await tick()
    },
    async fixAsked(key: string): Promise<void> {
      if (running) await running
      for (const ev of asks.get(key) ?? []) approved.add(ev.key)
      asks.delete(key)
      const card = cards.find((c) => c.id === `ask:${key}`)
      if (card) {
        cards = cards.filter((c) => c.id !== card.id)
        closeCardItem(card, 'fix')
      }
      await persist()
      await tick()
    },
    pr(key: string): PrState | null {
      return prs.get(key) ?? null
    }
  }
}
