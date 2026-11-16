import type { createCli } from './orcacli.ts'
import type { Session, AgentState } from './sessions.ts'
import type { NeedKind } from './board.ts'

export type CardAction = 'allow' | 'deny' | 'peek' | 'retry' | 'details' | 'start' | 'dismiss' | 'fix'
export type NeedCard = {
  id: string
  key: string
  kind: NeedKind
  title: string
  detail: string
  actions: CardAction[]
  at: number
  resolved: string | null
}
export type ToolCall = { tool: string; input: unknown; at: number }

type Cli = ReturnType<typeof createCli>

export const PEEK_KEYS: Record<'enter' | 'esc' | '1' | '2' | '3' | '4' | '5' | 'y' | 'n', string> = {
  enter: '\r',
  esc: '\u001b',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  y: 'y',
  n: 'n'
}

const SHELL_TOOLS = new Set(['Bash', 'shell', 'run_shell_command'])
const STALE_MS = 120000

export function describeTool(call: ToolCall | undefined, now: number = Date.now()): string {
  if (!call || now - call.at > STALE_MS) return 'waiting on a prompt'
  const input = call.input as { command?: unknown } | null | undefined
  if (SHELL_TOOLS.has(call.tool) && input && typeof input.command === 'string') {
    return 'wants to run: ' + input.command.slice(0, 120)
  }
  return 'wants to use: ' + call.tool
}

const DOING_MAX = 72

export function doingText(call: ToolCall | undefined, now: number = Date.now()): string {
  if (!call || now - call.at > STALE_MS) return ''
  const input = call.input as { command?: unknown; file_path?: unknown } | null | undefined
  if (SHELL_TOOLS.has(call.tool) && input && typeof input.command === 'string') {
    const line = input.command.trim().split('\n')[0]
    if (/^(\.\/)?bin\/say\b/.test(line)) return 'Writing to you'
    if (/^(\.\/)?bin\/tell\b/.test(line)) return 'Writing to a session'
    if (/^orca orchestration worker-start\b/.test(line)) return 'Starting a worker'
    return 'Running ' + (line.length > DOING_MAX ? line.slice(0, DOING_MAX) + '…' : line)
  }
  if (call.tool === 'Read' && input && typeof input.file_path === 'string') return 'Reading ' + input.file_path.split('/').pop()
  return 'Using ' + call.tool
}

export function approvalCard(session: Session, call: ToolCall | undefined, now: number): NeedCard {
  const canAnswer = session.agent.kind === 'claude' && !!session.agent.terminalId
  return {
    id: 'approval:' + session.key,
    key: session.key,
    kind: 'approval',
    title: session.name,
    detail: describeTool(call, now),
    actions: canAnswer ? ['allow', 'deny', 'peek'] : ['peek'],
    at: now,
    resolved: null
  }
}

export function reconcile(
  open: NeedCard[],
  wanted: NeedCard[],
  now: number
): { open: NeedCard[]; added: NeedCard[]; closed: NeedCard[]; changed: NeedCard[] } {
  const wantedById = new Map(wanted.map((c) => [c.id, c]))
  const openIds = new Set(open.map((c) => c.id))
  const changed: NeedCard[] = []
  const kept = open
    .filter((c) => wantedById.has(c.id))
    .map((c) => {
      const want = wantedById.get(c.id) as NeedCard
      if (want.detail === c.detail && want.actions.join('|') === c.actions.join('|')) return c
      const next = { ...c, detail: want.detail, actions: [...want.actions] }
      changed.push(next)
      return next
    })
  const added = wanted.filter((c) => !openIds.has(c.id))
  const closed = open.filter((c) => !wantedById.has(c.id)).map((c) => ({ ...c, resolved: 'cleared' }))
  return { open: [...kept, ...added], added, closed, changed }
}

export function isPermissionPrompt(lines: string[]): boolean {
  const question = lines.some((l) => /\bDo you want to\b/.test(l))
  const option = lines.some((l) => /^[\s│]*(❯\s*)?1\.\s+Yes\b/.test(l))
  return question && option
}

export async function readScreen(cli: Cli, terminalId: string): Promise<string[]> {
  const res = await cli.json<{ terminal?: { tail?: unknown } }>(['terminal', 'read', '--screen', '--terminal', terminalId])
  const tail = res?.terminal?.tail
  return Array.isArray(tail) ? tail.map(String) : []
}

const EXPECT_CHARS = 60

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function showsCommand(lines: string[], expect: string): boolean {
  const want = squash(expect).slice(0, EXPECT_CHARS)
  if (want === '') return false
  return squash(lines.join(' ')).includes(want)
}

async function readScreenSafe(cli: Cli, terminalId: string): Promise<string[]> {
  try {
    return await readScreen(cli, terminalId)
  } catch {
    return []
  }
}

export async function answerApproval(o: {
  cli: Cli
  session: Session
  choice: 'allow' | 'deny'
  stateOf(): AgentState
  wait(ms: number): Promise<void>
  mask(): Promise<void>
  expect?: string
}): Promise<'answered' | 'use-peek'> {
  const terminalId = o.session.agent.terminalId
  const expect = typeof o.expect === 'string' ? o.expect : ''
  if (o.session.agent.kind !== 'claude' || !terminalId) return 'use-peek'
  if (o.choice === 'allow' && squash(expect) === '') return 'use-peek'
  if (o.stateOf() !== 'blocked') return 'use-peek'
  const before = await readScreenSafe(o.cli, terminalId)
  if (!isPermissionPrompt(before)) return 'use-peek'
  if (squash(expect) !== '' && !showsCommand(before, expect)) return 'use-peek'
  if (o.stateOf() !== 'blocked') return 'use-peek'
  const send = (key: string) => o.cli.json(['terminal', 'send', '--terminal', terminalId, '--text=' + key])
  if (o.choice === 'allow') {
    await send(PEEK_KEYS['1'])
    for (let waited = 0; waited < 3000; waited += 250) {
      await o.wait(250)
      if (o.stateOf() !== 'blocked') return 'answered'
    }
    return 'use-peek'
  }
  await send(PEEK_KEYS.esc)
  await o.wait(1000)
  const lines = await readScreenSafe(o.cli, terminalId)
  if (lines.length === 0 || isPermissionPrompt(lines)) return 'use-peek'
  await o.mask()
  return 'answered'
}
