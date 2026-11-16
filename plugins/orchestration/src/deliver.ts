import type { HostApi, StorageApi } from 'orca/worker'
import type { AgentState, Session } from './sessions.ts'
import { effectiveState, listStateOf } from './sessions.ts'
import { CliError } from './orcacli.ts'
import type { createCli } from './orcacli.ts'

export type Outgoing = { id: string; key: string; subject: string; body: string; at: number }
export type SendResult = 'sent' | 'queued' | 'unreachable'

const QUEUE = 'queue'
const TURN_WAIT_MS = 10 * 60 * 1000
const DIVIDER = '----------'
const LIST_LIMIT = '1000'
const IDLE_LIST_STATES = new Set(['active', 'done'])
const MAX_TEXT_BYTES = 64 * 1024
const TRUNCATED = '\n[message truncated]'
const SYNTHETIC = 'pty:'

type Live = AgentState | null
type Text = { subject: string; body: string }
type Rec = Record<string, unknown>
type Liveness = 'live' | 'gone' | 'unknown'

function isIdle(state: Live): boolean {
  return state === 'waiting' || state === 'done'
}

function isBusy(state: Live): boolean {
  return state === 'working' || state === 'blocked' || state === null
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isOutgoing(value: unknown): value is Outgoing {
  if (!isRec(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.key === 'string' &&
    typeof value.subject === 'string' &&
    typeof value.body === 'string' &&
    typeof value.at === 'number'
  )
}

function hasRow(result: unknown, path: string): boolean {
  const rows = (result as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(rows)) return false
  return rows.some((row) => isRec(row) && row.path === path)
}

function rowsOf(result: unknown, key: string): Rec[] | null {
  if (!isRec(result) || result.truncated === true) return null
  const rows = result[key]
  if (!Array.isArray(rows) || !rows.every(isRec)) return null
  return rows
}

function paneKeyOf(terminal: Rec): string | null {
  if (terminal.orphaned === false) {
    if (!filled(terminal.tabId) || !filled(terminal.leafId)) return null
    if (terminal.tabId.startsWith(SYNTHETIC) || terminal.leafId.startsWith(SYNTHETIC)) return null
    return terminal.tabId + ':' + terminal.leafId
  }
  if (terminal.orphaned === true) return filled(terminal.recordedPaneKey) ? terminal.recordedPaneKey : null
  return null
}

function agentInTerminal(terminalList: unknown, worktreePs: unknown, terminalId: string): Liveness {
  const terminals = rowsOf(terminalList, 'terminals')
  const trees = rowsOf(worktreePs, 'worktrees')
  if (!filled(terminalId) || terminals === null || trees === null) return 'unknown'
  const matches = terminals.filter((t) => t.handle === terminalId)
  if (matches.length === 0) return 'gone'
  if (matches.length > 1) return 'unknown'
  const terminal = matches[0]
  if (typeof terminal.connected !== 'boolean' || typeof terminal.writable !== 'boolean') return 'unknown'
  if (!terminal.connected || !terminal.writable) return 'gone'
  if (!filled(terminal.worktreeId)) return 'unknown'
  const pane = paneKeyOf(terminal)
  if (pane === null) return 'unknown'
  const tree = trees.filter((t) => t.worktreeId === terminal.worktreeId)
  if (tree.length !== 1) return 'unknown'
  const agents = rowsOf(tree[0], 'agents')
  if (agents === null) return 'unknown'
  let result: Liveness = 'gone'
  for (const agent of agents) {
    if (agent.paneKey !== pane) continue
    if (agent.hasLivePty === true && filled(agent.agentType)) return 'live'
    if (agent.hasLivePty !== false) result = 'unknown'
  }
  return result
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytes(text: string): number {
  return encoder.encode(text).length
}

function rendered(text: Text): string {
  return text.subject + '\n\n' + text.body
}

function cut(text: string, max: number): string {
  const raw = encoder.encode(text)
  if (raw.length <= max) return text
  return decoder.decode(raw.slice(0, Math.max(0, max))).replace(/\uFFFD+$/, '')
}

function fit(text: Text): Text {
  if (bytes(rendered(text)) <= MAX_TEXT_BYTES) return text
  const room = MAX_TEXT_BYTES - bytes(TRUNCATED)
  const subject = cut(text.subject, room - 2)
  const body = cut(text.body, room - bytes(subject) - 2)
  return { subject, body: body + TRUNCATED }
}

function combine(batch: Text[]): Text {
  if (batch.length === 1) return { subject: batch[0].subject, body: batch[0].body }
  const sections = batch.map((i) => i.subject + '\n\n' + i.body)
  return { subject: batch.length + ' messages', body: sections.join('\n\n' + DIVIDER + '\n\n') }
}

function fits(batch: Text[]): boolean {
  return bytes(rendered(combine(batch))) <= MAX_TEXT_BYTES
}

export function createDelivery(o: {
  host: HostApi<'worker'>
  cli: ReturnType<typeof createCli>
  store: StorageApi
  now(): number
  id(): string
  fromHandle(): string | null
  track(dispatchId: string): void
  onDrop?: (item: Outgoing, reason: 'timeout') => void
  alive?: (terminalId: string) => Promise<boolean>
}) {
  let items: Outgoing[] = []
  let writing: Promise<void> = Promise.resolve()
  const locks = new Map<string, Promise<void>>()
  const resumed = new Set<string>()
  const inflight = new Map<string, Outgoing>()
  const timedOut = new Set<string>()
  const viaDispatch = new Set<string>()
  const awaitingTurn = new Map<string, number>()
  let dirty = false

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  function persist(): Promise<void> {
    const next = writing.then(async () => {
      try {
        await o.store.set(QUEUE, items.map((i) => ({ ...i })))
      } catch (error) {
        dirty = true
        throw error
      }
      dirty = false
    })
    writing = next.catch(() => undefined)
    return next
  }

  async function heal(): Promise<void> {
    if (dirty) await persistQuietly()
  }

  function forget(id: string): void {
    timedOut.delete(id)
    viaDispatch.delete(id)
  }

  function drop(item: Outgoing): void {
    if (!o.onDrop) return
    try {
      o.onDrop({ ...item }, 'timeout')
    } catch {
      return
    }
  }

  async function persistQuietly(): Promise<void> {
    try {
      await persist()
    } catch {
      return
    }
  }

  function head(key: string): Outgoing | undefined {
    return items.find((i) => i.key === key)
  }

  function putBack(batch: Outgoing[]): void {
    const back = batch.filter((i) => inflight.has(i.id))
    if (back.length === 0) return
    for (const i of back) inflight.delete(i.id)
    const key = back[0].key
    const at = items.findIndex((i) => i.key === key)
    items = at < 0 ? [...items, ...back] : [...items.slice(0, at), ...back, ...items.slice(at)]
  }

  async function enqueue(item: Outgoing): Promise<void> {
    items = [...items, item]
    try {
      await persist()
    } catch (error) {
      items = items.filter((i) => i.id !== item.id)
      throw error
    }
  }

  function awaiting(key: string): boolean {
    const at = awaitingTurn.get(key)
    if (at === undefined) return false
    if (o.now() - at >= TURN_WAIT_MS) {
      awaitingTurn.delete(key)
      return false
    }
    return true
  }

  function markSent(key: string): void {
    awaitingTurn.set(key, o.now())
  }

  async function cliLiveness(terminalId: string): Promise<Liveness> {
    const terminals = await o.cli.json<unknown>(['terminal', 'list', '--limit', LIST_LIMIT])
    const worktrees = await o.cli.json<unknown>(['worktree', 'ps', '--limit', LIST_LIMIT])
    return agentInTerminal(terminals, worktrees, terminalId)
  }

  async function liveness(terminalId: string): Promise<Liveness> {
    try {
      if (!o.alive) return await cliLiveness(terminalId)
      const answer: unknown = await o.alive(terminalId)
      if (answer === true) return 'live'
      if (answer === false) return 'gone'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async function liveState(session: Session): Promise<Live> {
    let result: unknown
    try {
      result = await o.host.call('workspace.list', { includeStatus: true })
    } catch {
      return null
    }
    if (!hasRow(result, session.path)) return null
    const listState = listStateOf(result, session.path)
    const state = effectiveState(session.agent, listState)
    if (listState === 'permission') return session.agent.permissionMasked ? state : 'blocked'
    if (listState === 'working') return state === 'blocked' ? 'blocked' : 'working'
    if (isIdle(state) && (listState === null || !IDLE_LIST_STATES.has(listState))) return null
    return state
  }

  function terminalArgs(terminalId: string, text: Text): string[] {
    return ['terminal', 'send', '--terminal', terminalId, '--text=' + rendered(fit(text)), '--enter']
  }

  function mailArgs(from: string, to: string, text: Text): string[] {
    const sized = fit(text)
    return ['orchestration', 'send', '--from', from, '--to', to, '--subject=' + sized.subject, '--body=' + sized.body]
  }

  function dispatchArgs(session: Session, text: Text): string[] | null {
    const from = o.fromHandle()
    if (session.started !== 'orchestrator' || !session.dispatchId || from === null) return null
    return mailArgs(from, 'dispatch:' + session.dispatchId, text)
  }

  function byMail(session: Session, item: Outgoing): string[] | null {
    return viaDispatch.has(item.id) ? dispatchArgs(session, item) : null
  }

  function trackReceipt(args: string[], receipt: unknown): void {
    if (args[0] !== 'orchestration' || args[4] !== '--to' || !args[5].startsWith('dispatch:')) return
    const id = (receipt as { dispatchId?: unknown } | null)?.dispatchId
    if (typeof id === 'string') o.track(id)
  }

  function batchFor(session: Session): Outgoing[] {
    const batch: Outgoing[] = []
    for (const item of items) {
      if (item.key !== session.key) continue
      if (byMail(session, item)) break
      if (batch.length > 0 && !fits([...batch, item])) break
      batch.push(item)
    }
    return batch
  }

  async function turnArgs(session: Session, text: Text): Promise<string[] | null> {
    const { terminalId, chatId } = session.agent
    if (terminalId) return (await liveness(terminalId)) === 'live' ? terminalArgs(terminalId, text) : null
    const from = o.fromHandle()
    if (chatId && from !== null) return mailArgs(from, 'orca_session_id:' + chatId, text)
    return null
  }

  async function deliver(session: Session, batch: Outgoing[], args: string[]): Promise<'sent' | 'stop'> {
    for (const i of batch) inflight.set(i.id, i)
    const ids = new Set(batch.map((i) => i.id))
    items = items.filter((i) => !ids.has(i.id))
    try {
      await persist()
    } catch {
      putBack(batch)
      return 'stop'
    }
    let failure: unknown = null
    let receipt: unknown = null
    try {
      receipt = await o.cli.json(args)
    } catch (error) {
      failure = error ?? new Error('send failed')
    }
    if (failure === null) {
      for (const i of batch) {
        inflight.delete(i.id)
        forget(i.id)
      }
      trackReceipt(args, receipt)
      return 'sent'
    }
    const timeout = failure instanceof CliError && failure.code === 'timeout'
    const keep: Outgoing[] = []
    for (const i of batch) {
      if (timeout && timedOut.has(i.id)) {
        inflight.delete(i.id)
        forget(i.id)
        drop(i)
        continue
      }
      if (timeout) timedOut.add(i.id)
      keep.push(i)
    }
    putBack(keep)
    await persistQuietly()
    if (failure instanceof CliError) return 'stop'
    throw failure
  }

  async function flushLocked(session: Session): Promise<string[]> {
    const sent: string[] = []
    for (;;) {
      const first = head(session.key)
      if (!first) break
      const state = await liveState(session)
      if (!isIdle(state)) break
      if (head(session.key)?.id !== first.id) continue
      const mail = byMail(session, first)
      if (mail) {
        if ((await deliver(session, [first], mail)) === 'stop') break
        sent.push(first.id)
        continue
      }
      if (awaiting(session.key)) break
      const batch = batchFor(session)
      if (batch.length === 0) break
      const args = await turnArgs(session, combine(batch))
      if (!args) break
      if (head(session.key)?.id !== first.id) continue
      const ready = batchFor(session)
      if (ready.length !== batch.length || ready.some((i, n) => i.id !== batch[n].id)) continue
      if ((await deliver(session, batch, args)) === 'stop') break
      markSent(session.key)
      for (const i of batch) sent.push(i.id)
      break
    }
    return sent
  }

  async function queueThenFlush(session: Session, item: Outgoing): Promise<SendResult> {
    await enqueue(item)
    const sent = await flushLocked(session)
    return sent.includes(item.id) ? 'sent' : 'queued'
  }

  async function resume(session: Session): Promise<boolean> {
    const { sessionId, kind } = session.agent
    if (!sessionId || !kind) return false
    const mark = session.key + '\u0000' + sessionId
    if (resumed.has(mark)) return true
    try {
      await o.host.call('agent.resume', { workspaceId: session.ids[0], agent: kind, sessionId } as never)
    } catch {
      return false
    }
    resumed.add(mark)
    return true
  }

  async function resumeOrGiveUp(session: Session, item: Outgoing): Promise<SendResult> {
    if (!(await resume(session))) return 'unreachable'
    await enqueue(item)
    return 'queued'
  }

  async function sendLocked(session: Session, subject: string, body: string): Promise<SendResult> {
    const item: Outgoing = { id: o.id(), key: session.key, subject, body, at: o.now() }
    const agent = session.agent
    const from = o.fromHandle()

    const dispatch = dispatchArgs(session, item)
    if (dispatch) {
      try {
        const receipt = await o.cli.json<{ dispatchId?: unknown } | null>(dispatch)
        if (receipt && typeof receipt.dispatchId === 'string') o.track(receipt.dispatchId)
        return 'sent'
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        if (error.code === 'timeout') {
          await enqueue(item)
          timedOut.add(item.id)
          viaDispatch.add(item.id)
          return 'queued'
        }
      }
    }

    if (agent.terminalId) {
      const state = await liveState(session)
      if (isIdle(state)) {
        if (awaiting(session.key)) {
          await enqueue(item)
          return 'queued'
        }
        const live = await liveness(agent.terminalId)
        if (live === 'gone') return resumeOrGiveUp(session, item)
        if (live === 'unknown') {
          await enqueue(item)
          return 'queued'
        }
        return queueThenFlush(session, item)
      }
      if (isBusy(state)) {
        await enqueue(item)
        return 'queued'
      }
      return 'unreachable'
    }

    if (agent.chatId) {
      const state = await liveState(session)
      if (isIdle(state) && from !== null) {
        if (head(session.key) || awaiting(session.key)) return queueThenFlush(session, item)
        try {
          await o.cli.json(mailArgs(from, 'orca_session_id:' + agent.chatId, item))
        } catch (error) {
          if (error instanceof CliError) return 'unreachable'
          throw error
        }
        markSent(session.key)
        return 'sent'
      }
      if (isBusy(state)) {
        await enqueue(item)
        return 'queued'
      }
      return 'unreachable'
    }

    return resumeOrGiveUp(session, item)
  }

  return {
    async load(): Promise<void> {
      const stored = await o.store.get(QUEUE)
      const valid = Array.isArray(stored) ? (stored as unknown[]).filter(isOutgoing).map((i) => ({ ...i })) : []
      const ids = new Set(valid.map((i) => i.id))
      items = [...valid, ...items.filter((i) => !ids.has(i.id))]
    },
    send(session: Session, subject: string, body: string): Promise<SendResult> {
      return withLock(session.key, async () => {
        await heal()
        return sendLocked(session, subject, body)
      })
    },
    flush(session: Session): Promise<number> {
      return withLock(session.key, async () => {
        await heal()
        if (session.agent.state === 'working') {
          awaitingTurn.delete(session.key)
          return 0
        }
        return (await flushLocked(session)).length
      })
    },
    async prune(liveKeys: string[]): Promise<number> {
      await heal()
      const live = new Set(liveKeys)
      for (const key of [...awaitingTurn.keys()]) if (!live.has(key)) awaitingTurn.delete(key)
      for (const [id, item] of inflight) {
        if (live.has(item.key)) continue
        inflight.delete(id)
        forget(id)
      }
      const removed = items.filter((i) => !live.has(i.key))
      if (removed.length === 0) return 0
      items = items.filter((i) => live.has(i.key))
      try {
        await persist()
      } catch (error) {
        const ids = new Set(items.map((i) => i.id))
        items = [...items, ...removed.filter((i) => !ids.has(i.id))]
        throw error
      }
      for (const i of removed) forget(i.id)
      return removed.length
    },
    queued(key: string): Outgoing[] {
      return items.filter((i) => i.key === key).map((i) => ({ ...i }))
    }
  }
}
