import type { PrState, Check, Comment, Review } from './github.ts'

export type RouteEvent =
  | { kind: 'ci'; pr: number; sha: string; checks: Check[]; key: string }
  | { kind: 'thread'; pr: number; threadId: string; comment: Comment; key: string }
  | { kind: 'review'; pr: number; review: Review; key: string }
  | { kind: 'comment'; pr: number; comment: Comment; key: string }
  | { kind: 'bot-batch'; pr: number; sha: string; items: Comment[]; key: string }
  | { kind: 'conflict'; pr: number; base: string; baseSha: string; key: string }

type LastSend = { kind: 'ci' | 'review' | 'conflict'; sha: string; at: number }

export type Ledger = {
  sent: Record<string, number>
  ciSends: Record<string, number>
  firstFail: Record<string, number>
  last: Record<string, LastSend>
}

export const EMPTY_LEDGER: Ledger = Object.freeze({
  sent: Object.freeze({}),
  ciSends: Object.freeze({}),
  firstFail: Object.freeze({}),
  last: Object.freeze({})
}) as Ledger

const CI_GRACE_MS = 600000

function prKeyOf(pr: PrState): string {
  return `${pr.repo}#${pr.number}`
}

function ciKeyOf(pr: PrState): string {
  return `ci:${prKeyOf(pr)}:${pr.headSha}`
}

function isAgentText(body: string): boolean {
  return body.trimStart().toLowerCase().startsWith('[agent]')
}

function routableReview(review: Review): boolean {
  return (
    (review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED') &&
    review.body.trim() !== '' &&
    !isAgentText(review.body)
  )
}

function reviewAsComment(review: Review): Comment {
  return { id: review.id, author: review.author, isBot: review.isBot, body: review.body, url: review.url, path: null, line: null }
}

function without(record: Record<string, number>, key: string): Record<string, number> {
  const next = { ...record }
  delete next[key]
  return next
}

function ciEvents(pr: PrState, ledger: Ledger, now: number, maxAttempts: number, firstFail: Record<string, number>): { events: RouteEvent[]; limitHit: boolean } {
  const failed = pr.checks.filter((c) => c.state === 'fail')
  const ciKey = ciKeyOf(pr)
  if (failed.length === 0 || ledger.sent[ciKey] !== undefined) return { events: [], limitHit: false }
  const pending = pr.checks.some((c) => c.state === 'pending')
  if (pending && now - firstFail[ciKey] < CI_GRACE_MS) return { events: [], limitHit: false }
  if ((ledger.ciSends[prKeyOf(pr)] ?? 0) >= maxAttempts) return { events: [], limitHit: true }
  return { events: [{ kind: 'ci', pr: pr.number, sha: pr.headSha, checks: failed.map((c) => ({ ...c })), key: ciKey }], limitHit: false }
}

function reviewEvents(pr: PrState, ledger: Ledger): RouteEvent[] {
  const unsent = (key: string) => ledger.sent[key] === undefined
  const events: RouteEvent[] = []
  for (const thread of pr.threads) {
    if (thread.resolved || thread.comments.length === 0) continue
    const newest = thread.comments[thread.comments.length - 1]
    const key = `c:${newest.id}`
    if (isAgentText(newest.body) || !unsent(key)) continue
    events.push({ kind: 'thread', pr: pr.number, threadId: thread.id, comment: { ...newest }, key })
  }
  for (const review of pr.reviews) {
    const key = `r:${review.id}`
    if (!review.isBot && routableReview(review) && unsent(key)) events.push({ kind: 'review', pr: pr.number, review: { ...review }, key })
  }
  for (const comment of pr.comments) {
    const key = `c:${comment.id}`
    if (!comment.isBot && !isAgentText(comment.body) && unsent(key)) events.push({ kind: 'comment', pr: pr.number, comment: { ...comment }, key })
  }
  const botItems: Comment[] = [
    ...pr.comments.filter((c) => c.isBot && !isAgentText(c.body)).map((c) => ({ ...c })),
    ...pr.reviews.filter((r) => r.isBot && routableReview(r)).map(reviewAsComment)
  ].filter((item) => unsent(`c:${item.id}`))
  const botKey = `bot:${prKeyOf(pr)}:${pr.headSha}`
  if (botItems.length > 0 && unsent(botKey)) events.push({ kind: 'bot-batch', pr: pr.number, sha: pr.headSha, items: botItems, key: botKey })
  return events
}

export function diffEvents(
  pr: PrState,
  ledger: Ledger,
  o: { now: number; maxAttempts: number; ci: boolean; review: boolean; conflict?: boolean }
): { events: RouteEvent[]; ledger: Ledger; limitHit: boolean } {
  const ciKey = ciKeyOf(pr)
  const prKey = prKeyOf(pr)
  const hasFail = pr.checks.some((c) => c.state === 'fail')
  const firstFail = hasFail && ledger.firstFail[ciKey] === undefined ? { ...ledger.firstFail, [ciKey]: o.now } : { ...ledger.firstFail }
  const green = pr.checks.length > 0 && !pr.checksTruncated && pr.checks.every((c) => c.state === 'pass')
  const ciSends = green ? without(ledger.ciSends, prKey) : { ...ledger.ciSends }
  const next: Ledger = { sent: { ...ledger.sent }, ciSends, firstFail, last: { ...ledger.last } }

  const events: RouteEvent[] = []
  let limitHit = false
  if (o.ci) {
    const ci = ciEvents(pr, next, o.now, o.maxAttempts, firstFail)
    events.push(...ci.events)
    limitHit = ci.limitHit
  }
  if (o.conflict ?? o.ci) {
    const conflictKey = `conflict:${prKey}:${pr.baseSha}`
    if (pr.mergeable === 'CONFLICTING' && next.sent[conflictKey] === undefined) {
      events.push({ kind: 'conflict', pr: pr.number, base: pr.base, baseSha: pr.baseSha, key: conflictKey })
    }
  }
  if (o.review) events.push(...reviewEvents(pr, next))
  return { events, ledger: next, limitHit }
}

export function recordSent(ledger: Ledger, pr: PrState, ev: RouteEvent, now: number): Ledger {
  const prKey = prKeyOf(pr)
  const sent = { ...ledger.sent, [ev.key]: now }
  if (ev.kind === 'bot-batch') for (const item of ev.items) sent[`c:${item.id}`] = now
  const ciSends = ev.kind === 'ci' ? { ...ledger.ciSends, [prKey]: (ledger.ciSends[prKey] ?? 0) + 1 } : { ...ledger.ciSends }
  const kind: LastSend['kind'] = ev.kind === 'ci' ? 'ci' : ev.kind === 'conflict' ? 'conflict' : 'review'
  return {
    sent,
    ciSends,
    firstFail: { ...ledger.firstFail },
    last: { ...ledger.last, [prKey]: { kind, sha: pr.headSha, at: now } }
  }
}

export function recordSkipped(ledger: Ledger, ev: RouteEvent, now: number): Ledger {
  const sent = { ...ledger.sent, [ev.key]: now }
  if (ev.kind === 'bot-batch') for (const item of ev.items) sent[`c:${item.id}`] = now
  return { sent, ciSends: { ...ledger.ciSends }, firstFail: { ...ledger.firstFail }, last: { ...ledger.last } }
}

export function resetAttempts(ledger: Ledger, pr: PrState): Ledger {
  return {
    sent: { ...ledger.sent },
    ciSends: without(ledger.ciSends, prKeyOf(pr)),
    firstFail: { ...ledger.firstFail },
    last: { ...ledger.last }
  }
}

export function fixingFor(ledger: Ledger, pr: PrState): LastSend | null {
  const last = ledger.last[prKeyOf(pr)]
  return last && last.sha === pr.headSha ? { ...last } : null
}
