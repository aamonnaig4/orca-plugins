import type { Session } from './sessions.ts'
import type { PrState } from './github.ts'

export type Lane = 'needs' | 'building' | 'validating' | 'review' | 'ready' | 'idle'
export type Tone = 'bad' | 'build' | 'warn' | 'info' | 'ok'
export type NeedKind = 'approval' | 'attempts' | 'merge-blocked' | 'unreachable' | 'ask'
export type Fixing = { kind: 'ci' | 'review' | 'conflict'; sha: string; at: number } | null

export function isReady(pr: PrState): boolean {
  return (
    !pr.isDraft &&
    pr.checks.length > 0 &&
    pr.checks.every((c) => c.state === 'pass') &&
    !pr.checksTruncated &&
    !pr.threads.some((t) => t.resolved === false) &&
    pr.reviewDecision !== 'CHANGES_REQUESTED' &&
    pr.reviewRequested === false &&
    pr.mergeable === 'MERGEABLE'
  )
}

export function ago(fromMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (sec < 60) return '<1m'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

type Placement = { lane: Lane; phrase: string; tone: Tone }

export function place(input: {
  session: Session
  pr: PrState | null
  need: { kind: NeedKind; detail: string } | null
  fixing: Fixing
  now: number
}): Placement | null {
  const { session, pr, need, fixing, now } = input
  if (need) {
    const phrases: Record<NeedKind, string> = {
      approval: `Blocked · ${need.detail}`,
      attempts: `CI failing · ${need.detail}`,
      'merge-blocked': 'Merge blocked',
      unreachable: 'No agent to message',
      ask: `Waiting for your go · ${need.detail}`
    }
    return { lane: 'needs', phrase: phrases[need.kind], tone: 'bad' }
  }
  if (!pr) {
    if (session.agent.state === 'working') {
      return { lane: 'building', phrase: `Working · ${ago(session.agent.since, now)}`, tone: 'build' }
    }
    if (session.agent.state === 'none' && session.isMain) return null
    return { lane: 'idle', phrase: `Idle · last active ${ago(session.agent.since, now)} ago`, tone: 'info' }
  }
  if (pr.isDraft) return { lane: 'validating', phrase: 'Draft', tone: 'info' }
  if (pr.mergeable === 'CONFLICTING') {
    const phrase =
      fixing?.kind === 'conflict' ? `Resolving conflicts · sent ${ago(fixing.at, now)} ago` : 'Merge conflicts'
    return { lane: 'validating', phrase, tone: 'warn' }
  }
  if (pr.checks.some((c) => c.state === 'fail')) {
    const phrase =
      fixing?.kind === 'ci' && fixing.sha === pr.headSha
        ? `Fixing CI failures · sent ${ago(fixing.at, now)} ago`
        : 'CI failing'
    return { lane: 'validating', phrase, tone: 'warn' }
  }
  if (pr.checks.length === 0) return { lane: 'validating', phrase: 'Waiting for checks', tone: 'info' }
  if (pr.checks.some((c) => c.state === 'pending') || pr.checksTruncated) {
    const passed = pr.checks.filter((c) => c.state === 'pass').length
    return { lane: 'review', phrase: `Checks running · ${passed} of ${pr.checks.length}`, tone: 'info' }
  }
  if (pr.threads.some((t) => t.resolved === false)) {
    const phrase =
      fixing?.kind === 'review' ? `Addressing comments · sent ${ago(fixing.at, now)} ago` : 'Commented'
    return { lane: 'review', phrase, tone: 'warn' }
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return { lane: 'review', phrase: 'Changes requested', tone: 'warn' }
  }
  if (pr.reviewRequested) return { lane: 'review', phrase: 'Awaiting review', tone: 'info' }
  if (pr.mergeable !== 'MERGEABLE') {
    return { lane: 'validating', phrase: 'Checking mergeability', tone: 'info' }
  }
  if (!isReady(pr)) return { lane: 'validating', phrase: 'Checking mergeability', tone: 'info' }
  return { lane: 'ready', phrase: 'Mergeable', tone: 'ok' }
}

export type Column = 'building' | 'validating' | 'review' | 'ready' | 'idle'

export function columnOf(input: { session: Session; pr: PrState | null; fixing: Fixing; now: number }): Column {
  const placed = place({ ...input, need: null })
  if (!placed || placed.lane === 'needs') return 'building'
  return placed.lane
}

export function labelOf(phrase: string, lane: Lane): string {
  const cut = phrase.indexOf(' · ')
  if (cut < 0) return phrase
  if (lane === 'needs') return phrase.slice(0, cut)
  const tail = phrase.slice(cut + 3)
  return /^(sent |last active )?(<1m|\d+[mhd])( ago)?$/.test(tail) ? phrase.slice(0, cut) : phrase
}

export type PlanStep = { text: string; status: 'pending' | 'active' | 'done' }

export function parsePlan(body: string): PlanStep[] {
  const steps: PlanStep[] = []
  for (const raw of body.split('\n')) {
    const m = /^\s*\[( |x|X|~)\]\s*(\S.*?)\s*$/.exec(raw)
    if (!m) continue
    steps.push({ text: m[2], status: m[1] === ' ' ? 'pending' : m[1] === '~' ? 'active' : 'done' })
  }
  return steps.slice(0, 40)
}
