import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LEDGER, diffEvents, fixingFor, recordSent, recordSkipped, resetAttempts } from '../src/events.ts'

const PR_KEY = 'acme/app#42'
const ON = { now: 1000, maxAttempts: 3, ci: true, review: true }

function check(name, state) {
  return { name, state, jobId: state === 'fail' ? `job-${name}` : null, url: `https://ci/${name}` }
}

function comment(id, body, extra = {}) {
  return { id, author: 'alice', isBot: false, body, url: `https://gh/c/${id}`, path: null, line: null, ...extra }
}

function botComment(id, body) {
  return comment(id, body, { author: 'lint[bot]', isBot: true })
}

function review(id, state, body, extra = {}) {
  return { id, state, author: 'bob', isBot: false, body, url: `https://gh/r/${id}`, ...extra }
}

function thread(id, comments, resolved = false) {
  return { id, resolved, comments }
}

function pr(over = {}) {
  return {
    repo: 'acme/app',
    number: 42,
    url: 'https://github.com/acme/app/pull/42',
    branch: 'feature-oa',
    base: 'main',
    headSha: 'sha1',
    baseSha: 'base1',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviewRequested: false,
    checks: [check('build', 'pass')],
    checksTruncated: false,
    threads: [],
    reviews: [],
    comments: [],
    ...over
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value))
}

function sendAll(state, ledger, now) {
  let next = ledger
  for (const ev of diffEvents(state, next, { ...ON, now }).events) next = recordSent(next, state, ev, now)
  return next
}

function failing(sha, names = ['a']) {
  return pr({ headSha: sha, checks: names.map((n) => check(n, 'fail')) })
}

test('EMPTY_LEDGER has the four empty maps', () => {
  assert.deepEqual(EMPTY_LEDGER, { sent: {}, ciSends: {}, firstFail: {}, last: {} })
})

test('a second diff after recording every event emits nothing', () => {
  const state = pr({
    headSha: 'sha1',
    mergeable: 'CONFLICTING',
    checks: [check('a', 'fail')],
    threads: [thread('T1', [comment('c1', 'rename this', { path: 'a.ts', line: 3 })])],
    reviews: [review('r1', 'CHANGES_REQUESTED', 'please fix')],
    comments: [comment('c2', 'looks off'), botComment('b1', 'lint error')]
  })
  const first = diffEvents(state, EMPTY_LEDGER, ON)
  assert.deepEqual(first.events.map((e) => e.kind).sort(), ['bot-batch', 'ci', 'comment', 'conflict', 'review', 'thread'])
  let ledger = first.ledger
  for (const ev of first.events) ledger = recordSent(ledger, state, ev, 1000)
  const second = diffEvents(state, ledger, { ...ON, now: 2000 })
  assert.deepEqual(second.events, [])
  assert.equal(second.limitHit, false)
})

test('event keys follow the plan', () => {
  const state = pr({
    mergeable: 'CONFLICTING',
    checks: [check('a', 'fail')],
    threads: [thread('T1', [comment('c1', 'x')])],
    reviews: [review('r1', 'COMMENTED', 'y')],
    comments: [comment('c2', 'z'), botComment('b1', 'w')]
  })
  const byKind = Object.fromEntries(diffEvents(state, EMPTY_LEDGER, ON).events.map((e) => [e.kind, e]))
  assert.equal(byKind.ci.key, 'ci:acme/app#42:sha1')
  assert.equal(byKind.thread.key, 'c:c1')
  assert.equal(byKind.review.key, 'r:r1')
  assert.equal(byKind.comment.key, 'c:c2')
  assert.equal(byKind['bot-batch'].key, 'bot:acme/app#42:sha1')
  assert.equal(byKind.conflict.key, 'conflict:acme/app#42:base1')
  assert.deepEqual(byKind.conflict, { kind: 'conflict', pr: 42, base: 'main', baseSha: 'base1', key: 'conflict:acme/app#42:base1' })
  assert.equal(byKind.thread.threadId, 'T1')
  assert.equal(byKind.ci.sha, 'sha1')
  assert.equal(byKind.ci.pr, 42)
})

test('three failed checks with none pending emit one ci event with the three checks', () => {
  const state = failing('sha1', ['a', 'b', 'c'])
  const { events, ledger, limitHit } = diffEvents(state, EMPTY_LEDGER, ON)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'ci')
  assert.deepEqual(events[0].checks.map((c) => c.name), ['a', 'b', 'c'])
  assert.equal(limitHit, false)
  assert.equal(ledger.firstFail['ci:acme/app#42:sha1'], 1000)
})

test('a failure with a check still pending waits 600000 ms from the first failure', () => {
  const state = pr({ checks: [check('a', 'fail'), check('b', 'pass'), check('c', 'pending')] })
  const first = diffEvents(state, EMPTY_LEDGER, { ...ON, now: 1000 })
  assert.deepEqual(first.events, [])
  assert.equal(first.ledger.firstFail['ci:acme/app#42:sha1'], 1000)
  const early = diffEvents(state, first.ledger, { ...ON, now: 1000 + 599999 })
  assert.deepEqual(early.events, [])
  assert.equal(early.ledger.firstFail['ci:acme/app#42:sha1'], 1000)
  const due = diffEvents(state, early.ledger, { ...ON, now: 1000 + 600000 })
  assert.equal(due.events.length, 1)
  assert.equal(due.events[0].kind, 'ci')
  assert.deepEqual(due.events[0].checks.map((c) => c.name), ['a'])
})

test('a new head SHA with a failure emits a new ci event and ciSends becomes 2', () => {
  let ledger = sendAll(failing('sha1'), EMPTY_LEDGER, 1000)
  assert.equal(ledger.ciSends[PR_KEY], 1)
  const next = diffEvents(failing('sha2'), ledger, { ...ON, now: 2000 })
  assert.equal(next.events.length, 1)
  assert.equal(next.events[0].key, 'ci:acme/app#42:sha2')
  ledger = recordSent(next.ledger, failing('sha2'), next.events[0], 2000)
  assert.equal(ledger.ciSends[PR_KEY], 2)
})

test('the fix limit withholds the ci event and resetAttempts lets it through', () => {
  let ledger = EMPTY_LEDGER
  for (const sha of ['s1', 's2', 's3']) ledger = sendAll(failing(sha), ledger, 1000)
  assert.equal(ledger.ciSends[PR_KEY], 3)
  const blocked = diffEvents(failing('s4'), ledger, { ...ON, now: 2000 })
  assert.deepEqual(blocked.events, [])
  assert.equal(blocked.limitHit, true)
  const again = diffEvents(failing('s4'), blocked.ledger, { ...ON, now: 3000 })
  assert.deepEqual(again.events, [])
  assert.equal(again.limitHit, true)
  const reset = resetAttempts(again.ledger, failing('s4'))
  assert.equal(reset.ciSends[PR_KEY], undefined)
  const retried = diffEvents(failing('s4'), reset, { ...ON, now: 4000 })
  assert.equal(retried.events.length, 1)
  assert.equal(retried.events[0].key, 'ci:acme/app#42:s4')
  assert.equal(retried.limitHit, false)
})

test('a fully green SHA removes ciSends so a later failure starts at 1', () => {
  let ledger = sendAll(failing('s1'), EMPTY_LEDGER, 1000)
  ledger = sendAll(failing('s2'), ledger, 2000)
  assert.equal(ledger.ciSends[PR_KEY], 2)
  const green = diffEvents(pr({ headSha: 's3', checks: [check('a', 'pass'), check('b', 'pass')] }), ledger, ON)
  assert.equal(PR_KEY in green.ledger.ciSends, false)
  ledger = sendAll(failing('s4'), green.ledger, 3000)
  assert.equal(ledger.ciSends[PR_KEY], 1)
})

test('a SHA with pending checks or no checks keeps ciSends', () => {
  const ledger = sendAll(failing('s1'), EMPTY_LEDGER, 1000)
  const pending = diffEvents(pr({ headSha: 's2', checks: [check('a', 'pass'), check('b', 'pending')] }), ledger, ON)
  assert.equal(pending.ledger.ciSends[PR_KEY], 1)
  const none = diffEvents(pr({ headSha: 's2', checks: [] }), ledger, ON)
  assert.equal(none.ledger.ciSends[PR_KEY], 1)
})

test('with o.ci false no ci or conflict event is emitted and limitHit is false', () => {
  let ledger = EMPTY_LEDGER
  for (const sha of ['s1', 's2', 's3']) ledger = sendAll(failing(sha), ledger, 1000)
  const state = pr({ headSha: 's4', mergeable: 'CONFLICTING', checks: [check('a', 'fail')], comments: [comment('c1', 'hi')] })
  const res = diffEvents(state, ledger, { ...ON, ci: false })
  assert.deepEqual(res.events.map((e) => e.kind), ['comment'])
  assert.equal(res.limitHit, false)
})

test('with o.review false no thread, review, comment or bot-batch is emitted', () => {
  const state = pr({
    mergeable: 'CONFLICTING',
    checks: [check('a', 'fail')],
    threads: [thread('T1', [comment('c1', 'x')])],
    reviews: [review('r1', 'CHANGES_REQUESTED', 'y')],
    comments: [comment('c2', 'z'), botComment('b1', 'w')]
  })
  const res = diffEvents(state, EMPTY_LEDGER, { ...ON, review: false })
  assert.deepEqual(res.events.map((e) => e.kind).sort(), ['ci', 'conflict'])
})

test('a resolved thread emits nothing', () => {
  const state = pr({ threads: [thread('T1', [comment('c1', 'x')], true)] })
  assert.deepEqual(diffEvents(state, EMPTY_LEDGER, ON).events, [])
})

test('a new comment in an already-sent unresolved thread emits one thread event for it', () => {
  const c1 = comment('c1', 'first', { path: 'a.ts', line: 3 })
  const before = pr({ threads: [thread('T1', [c1])] })
  const ledger = sendAll(before, EMPTY_LEDGER, 1000)
  assert.deepEqual(diffEvents(before, ledger, ON).events, [])
  const c2 = comment('c2', 'second', { path: 'a.ts', line: 3 })
  const after = pr({ threads: [thread('T1', [c1, c2])] })
  const res = diffEvents(after, ledger, ON)
  assert.equal(res.events.length, 1)
  assert.deepEqual(res.events[0], { kind: 'thread', pr: 42, threadId: 'T1', comment: c2, key: 'c:c2' })
})

test('a thread whose newest comment starts with [agent] emits nothing', () => {
  const state = pr({ threads: [thread('T1', [comment('c1', 'fix this'), comment('c2', '[agent] Fixed in abc123')])] })
  assert.deepEqual(diffEvents(state, EMPTY_LEDGER, ON).events, [])
})

test('[agent] comments and reviews are never emitted', () => {
  const state = pr({
    reviews: [review('r1', 'COMMENTED', '[agent] done')],
    comments: [comment('c1', '[agent] pushed a fix'), botComment('b1', '[agent] bot echo')]
  })
  assert.deepEqual(diffEvents(state, EMPTY_LEDGER, ON).events, [])
})

test('reviews need a body and state CHANGES_REQUESTED or COMMENTED', () => {
  const state = pr({
    reviews: [
      review('r1', 'CHANGES_REQUESTED', 'fix it'),
      review('r2', 'COMMENTED', 'a thought'),
      review('r3', 'APPROVED', 'lgtm'),
      review('r4', 'OTHER', 'dismissed'),
      review('r5', 'COMMENTED', '')
    ]
  })
  const events = diffEvents(state, EMPTY_LEDGER, ON).events
  assert.deepEqual(events.map((e) => [e.kind, e.key]), [['review', 'r:r1'], ['review', 'r:r2']])
  assert.equal(events[0].review.id, 'r1')
})

test('three bot comments on one SHA produce one bot-batch with three items', () => {
  const bots = [botComment('b1', 'one'), botComment('b2', 'two'), botComment('b3', 'three')]
  const state = pr({ comments: [...bots, comment('h1', 'human')] })
  const events = diffEvents(state, EMPTY_LEDGER, ON).events
  const batches = events.filter((e) => e.kind === 'bot-batch')
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].items, bots)
  assert.equal(batches[0].sha, 'sha1')
  assert.deepEqual(events.filter((e) => e.kind === 'comment').map((e) => e.key), ['c:h1'])
})

test('bot review bodies join the bot batch', () => {
  const state = pr({
    comments: [botComment('b1', 'one')],
    reviews: [review('r1', 'COMMENTED', 'bot review', { author: 'copilot[bot]', isBot: true })]
  })
  const events = diffEvents(state, EMPTY_LEDGER, ON).events
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'bot-batch')
  assert.deepEqual(events[0].items.map((i) => [i.id, i.body, i.author, i.isBot]), [
    ['b1', 'one', 'lint[bot]', true],
    ['r1', 'bot review', 'copilot[bot]', true]
  ])
})

test('bot comments already batched are not sent again on a new SHA', () => {
  const b1 = botComment('b1', 'one')
  const ledger = sendAll(pr({ headSha: 's1', comments: [b1] }), EMPTY_LEDGER, 1000)
  assert.deepEqual(diffEvents(pr({ headSha: 's2', comments: [b1] }), ledger, ON).events, [])
  const res = diffEvents(pr({ headSha: 's2', comments: [b1, botComment('b2', 'two')] }), ledger, ON)
  assert.equal(res.events.length, 1)
  assert.deepEqual(res.events[0].items.map((i) => i.id), ['b2'])
  assert.equal(res.events[0].key, 'bot:acme/app#42:s2')
})

test('conflict is emitted once per base SHA', () => {
  const state = pr({ mergeable: 'CONFLICTING' })
  const ledger = sendAll(state, EMPTY_LEDGER, 1000)
  assert.deepEqual(diffEvents(state, ledger, ON).events, [])
  const moved = diffEvents(pr({ mergeable: 'CONFLICTING', baseSha: 'base2' }), ledger, ON)
  assert.deepEqual(moved.events.map((e) => e.key), ['conflict:acme/app#42:base2'])
})

test('recordSent sets sent, counts ci sends and records last', () => {
  const state = failing('sha1')
  const [ev] = diffEvents(state, EMPTY_LEDGER, ON).events
  const ledger = recordSent(EMPTY_LEDGER, state, ev, 5000)
  assert.deepEqual(ledger.sent, { 'ci:acme/app#42:sha1': 5000 })
  assert.deepEqual(ledger.ciSends, { [PR_KEY]: 1 })
  assert.deepEqual(ledger.last, { [PR_KEY]: { kind: 'ci', sha: 'sha1', at: 5000 } })
})

test('recordSent records conflict as conflict and review kinds as review', () => {
  const state = pr({ mergeable: 'CONFLICTING', comments: [comment('c1', 'hi')] })
  const events = diffEvents(state, EMPTY_LEDGER, ON).events
  const conflict = events.find((e) => e.kind === 'conflict')
  const human = events.find((e) => e.kind === 'comment')
  const a = recordSent(EMPTY_LEDGER, state, conflict, 10)
  assert.deepEqual(a.last[PR_KEY], { kind: 'conflict', sha: 'sha1', at: 10 })
  assert.equal(PR_KEY in a.ciSends, false)
  const b = recordSent(a, state, human, 20)
  assert.deepEqual(b.last[PR_KEY], { kind: 'review', sha: 'sha1', at: 20 })
  assert.equal(b.sent['c:c1'], 20)
  assert.equal(b.sent['conflict:acme/app#42:base1'], 10)
})

test('fixingFor returns the last send for the head SHA and null after it changes', () => {
  assert.equal(fixingFor(EMPTY_LEDGER, pr()), null)
  const ledger = sendAll(failing('sha1'), EMPTY_LEDGER, 7000)
  assert.deepEqual(fixingFor(ledger, failing('sha1')), { kind: 'ci', sha: 'sha1', at: 7000 })
  assert.equal(fixingFor(ledger, failing('sha2')), null)
})

test('ledgers are per PR', () => {
  const ledger = sendAll(failing('sha1'), EMPTY_LEDGER, 1000)
  const other = failing('sha1')
  const otherPr = { ...other, number: 43 }
  const res = diffEvents(otherPr, ledger, ON)
  assert.deepEqual(res.events.map((e) => e.key), ['ci:acme/app#43:sha1'])
  assert.equal(fixingFor(ledger, otherPr), null)
})

test('no function mutates its inputs', () => {
  const state = pr({
    mergeable: 'CONFLICTING',
    checks: [check('a', 'fail'), check('b', 'pass')],
    threads: [thread('T1', [comment('c1', 'x')])],
    reviews: [review('r1', 'COMMENTED', 'y')],
    comments: [comment('c2', 'z'), botComment('b1', 'w')]
  })
  let seeded = EMPTY_LEDGER
  for (const sha of ['s1', 's2', 's3']) seeded = sendAll(failing(sha), seeded, 1000)
  const snapshotState = structuredClone(state)
  const snapshotLedger = structuredClone(seeded)
  const frozenState = frozenCopy(state)
  const frozenLedger = frozenCopy(seeded)

  const diffed = diffEvents(frozenState, frozenLedger, ON)
  assert.deepEqual(frozenLedger, snapshotLedger)
  assert.deepEqual(frozenState, snapshotState)
  assert.equal(diffed.limitHit, true)

  const reset = resetAttempts(frozenLedger, frozenState)
  assert.deepEqual(frozenLedger, snapshotLedger)
  const events = diffEvents(frozenState, frozenCopy(reset), ON).events
  assert.ok(events.length > 0)
  for (const ev of events) {
    const frozenEv = frozenCopy(ev)
    recordSent(frozenLedger, frozenState, frozenEv, 9000)
    assert.deepEqual(frozenEv, ev)
  }
  fixingFor(frozenLedger, frozenState)
  assert.deepEqual(frozenLedger, snapshotLedger)
  assert.deepEqual(frozenState, snapshotState)

  const green = frozenCopy(pr({ headSha: 's9' }))
  diffEvents(green, frozenLedger, ON)
  assert.deepEqual(frozenLedger, snapshotLedger)
  assert.deepEqual(EMPTY_LEDGER, { sent: {}, ciSends: {}, firstFail: {}, last: {} })
})

test('the [agent] marker matches in any case after leading whitespace', () => {
  for (const marker of ['[Agent]', '[AGENT]', '  [aGeNt]', '\n\t[Agent]']) {
    const state = pr({
      threads: [thread('T1', [comment('t1', 'fix'), comment('t2', marker + ' fixed')])],
      reviews: [review('r1', 'COMMENTED', marker + ' done')],
      comments: [comment('c1', marker + ' pushed'), botComment('b1', marker + ' echo')]
    })
    assert.deepEqual(diffEvents(state, EMPTY_LEDGER, ON).events, [], marker)
  }
  const human = pr({ comments: [comment('c2', 'agent] not a marker'), comment('c3', 'see [Agent] below')] })
  assert.deepEqual(diffEvents(human, EMPTY_LEDGER, ON).events.map((e) => e.key), ['c:c2', 'c:c3'])
})

test('PR #42 in acme/app and PR #42 in c/d never share a ledger key', () => {
  const build = (repo, n) =>
    pr({
      repo,
      url: `https://github.com/${repo}/pull/42`,
      mergeable: 'CONFLICTING',
      checks: [check('a', 'fail')],
      comments: [botComment(`${n}b`, 'lint')]
    })
  const one = build('acme/app', 'x')
  const two = build('c/d', 'y')
  const ledger = sendAll(one, EMPTY_LEDGER, 1000)
  assert.deepEqual(diffEvents(one, ledger, ON).events, [])
  const res = diffEvents(two, ledger, ON)
  assert.deepEqual(res.events.map((e) => e.key).sort(), ['bot:c/d#42:sha1', 'ci:c/d#42:sha1', 'conflict:c/d#42:base1'])
  assert.equal(res.limitHit, false)
  assert.equal(fixingFor(ledger, two), null)
  assert.notEqual(fixingFor(ledger, one), null)
  let full = ledger
  for (let i = 0; i < 3; i++) full = sendAll({ ...one, headSha: 's' + i }, full, 1000)
  assert.equal(diffEvents({ ...one, headSha: 's9' }, full, ON).limitHit, true)
  assert.equal(diffEvents({ ...two, headSha: 's9' }, full, ON).limitHit, false)
})

test('conflicts follow the ci switch unless they are given their own', () => {
  const conflicting = pr({ mergeable: 'CONFLICTING' })
  const kinds = (o) => diffEvents(conflicting, EMPTY_LEDGER, { ...ON, ...o }).events.map((ev) => ev.kind)
  assert.deepEqual(kinds({ ci: false }), [])
  assert.deepEqual(kinds({ ci: false, conflict: true }), ['conflict'])
  assert.deepEqual(kinds({ ci: true, conflict: false }), [])
})

test('recordSkipped marks an event as handled without counting a fix attempt', () => {
  const failing = pr({ checks: [check('test', 'fail')] })
  const first = diffEvents(failing, EMPTY_LEDGER, ON)
  assert.equal(first.events.length, 1)
  const skipped = recordSkipped(first.ledger, first.events[0], 2000)
  assert.deepEqual(skipped.ciSends, {})
  assert.deepEqual(skipped.last, {})
  assert.deepEqual(diffEvents(failing, skipped, ON).events, [])
})
