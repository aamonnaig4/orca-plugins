import test from 'node:test'
import assert from 'node:assert/strict'
import { ago, columnOf, isReady, labelOf, parsePlan, place } from '../src/board.ts'

const NOW = 1_000_000_000

function agent(state = 'none', since = NOW - 14 * 60_000) {
  return { state, terminalId: null, sessionId: null, chatId: null, kind: null, since, permissionMasked: false }
}

function session(over = {}) {
  return {
    key: '/w/a',
    ids: ['a'],
    path: '/w/a',
    name: 'a',
    project: 'p',
    repoId: 'r',
    repo: 'o/n',
    branch: 'feat',
    isMain: false,
    agent: agent('waiting'),
    dispatchId: null,
    started: 'you',
    ...over
  }
}

function pr(over = {}) {
  return {
    repo: 'o/n',
    number: 7,
    url: 'https://github.com/o/n/pull/7',
    branch: 'feat',
    base: 'main',
    headSha: 'sha1',
    baseSha: 'sha0',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviewRequested: false,
    checks: [{ name: 'a', state: 'pass', jobId: '1', url: null }],
    checksTruncated: false,
    threads: [],
    reviews: [],
    comments: [],
    ...over
  }
}

const check = (state) => ({ name: state, state, jobId: null, url: null })
const run = (over) => place({ session: session(), pr: pr(), need: null, fixing: null, now: NOW, ...over })

test('ago formats under a minute, minutes, hours and days', () => {
  assert.equal(ago(NOW, NOW), '<1m')
  assert.equal(ago(NOW - 1000, NOW), '<1m')
  assert.equal(ago(NOW - 59_000, NOW), '<1m')
  assert.equal(ago(NOW - 60_000, NOW), '1m')
  assert.equal(ago(NOW - 14 * 60_000, NOW), '14m')
  assert.equal(ago(NOW - 2 * 3_600_000, NOW), '2h')
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), '3d')
  assert.equal(ago(NOW + 5000, NOW), '<1m')
})

test('isReady is true for a green mergeable PR', () => {
  assert.equal(isReady(pr()), true)
})

test('isReady is false for each single violation', () => {
  assert.equal(isReady(pr({ isDraft: true })), false)
  assert.equal(isReady(pr({ checks: [] })), false)
  assert.equal(isReady(pr({ checks: [check('pass'), check('fail')] })), false)
  assert.equal(isReady(pr({ checks: [check('pass'), check('pending')] })), false)
  assert.equal(isReady(pr({ checksTruncated: true })), false)
  assert.equal(isReady(pr({ threads: [{ id: 't', resolved: false, comments: [] }] })), false)
  assert.equal(isReady(pr({ reviewDecision: 'CHANGES_REQUESTED' })), false)
  assert.equal(isReady(pr({ reviewRequested: true })), false)
  assert.equal(isReady(pr({ mergeable: 'CONFLICTING' })), false)
  assert.equal(isReady(pr({ mergeable: 'UNKNOWN' })), false)
  assert.equal(isReady(pr({ threads: [{ id: 't', resolved: true, comments: [] }] })), true)
})

test('lane is ready exactly when isReady and no need', () => {
  const variants = [
    pr(),
    pr({ isDraft: true }),
    pr({ checks: [] }),
    pr({ checks: [check('fail')] }),
    pr({ checks: [check('pending')] }),
    pr({ checks: [check('weird')] }),
    pr({ checksTruncated: true }),
    pr({ threads: [{ id: 't', resolved: false, comments: [] }] }),
    pr({ reviewDecision: 'CHANGES_REQUESTED' }),
    pr({ reviewRequested: true }),
    pr({ reviewRequested: undefined }),
    pr({ mergeable: 'UNKNOWN' }),
    pr({ mergeable: 'CONFLICTING' })
  ]
  for (const p of variants) {
    assert.equal(run({ pr: p })?.lane === 'ready', isReady(p))
    assert.notEqual(run({ pr: p, need: { kind: 'merge-blocked', detail: '' } })?.lane, 'ready')
  }
})

test('a PR outside the declared types never lands in ready and says Checking mergeability', () => {
  for (const p of [pr({ checks: [check('weird')] }), pr({ reviewRequested: undefined })]) {
    assert.deepEqual(run({ pr: p }), { lane: 'validating', phrase: 'Checking mergeability', tone: 'info' })
  }
})

test('rule 1: needs phrases', () => {
  const need = (kind, detail) => run({ need: { kind, detail } })
  assert.deepEqual(need('approval', 'wants to run `ls`'), { lane: 'needs', phrase: 'Blocked · wants to run `ls`', tone: 'bad' })
  assert.deepEqual(need('attempts', '3 fix attempts used'), { lane: 'needs', phrase: 'CI failing · 3 fix attempts used', tone: 'bad' })
  assert.deepEqual(need('merge-blocked', 'x'), { lane: 'needs', phrase: 'Merge blocked', tone: 'bad' })
  assert.deepEqual(need('unreachable', 'x'), { lane: 'needs', phrase: 'No agent to message', tone: 'bad' })
})

test('a need outranks a green PR', () => {
  assert.equal(run({ need: { kind: 'approval', detail: 'd' } }).lane, 'needs')
})

test('rule 2: no PR', () => {
  const s = session({ agent: agent('working') })
  assert.deepEqual(run({ session: s, pr: null }), { lane: 'building', phrase: 'Working · 14m', tone: 'build' })
  const idle = session({ agent: agent('done', NOW - 2 * 3_600_000) })
  assert.deepEqual(run({ session: idle, pr: null }), { lane: 'idle', phrase: 'Idle · last active 2h ago', tone: 'info' })
  const main = session({ isMain: true, agent: agent('none') })
  assert.equal(run({ session: main, pr: null }), null)
  assert.equal(run({ session: main, pr: pr() }).lane, 'ready')
})

test('rule 3: draft', () => {
  assert.deepEqual(run({ pr: pr({ isDraft: true }) }), { lane: 'validating', phrase: 'Draft', tone: 'info' })
})

test('rule 4: conflicts', () => {
  const p = pr({ mergeable: 'CONFLICTING' })
  assert.deepEqual(run({ pr: p }), { lane: 'validating', phrase: 'Merge conflicts', tone: 'warn' })
  const fixing = { kind: 'conflict', sha: 'sha1', at: NOW - 60_000 }
  assert.deepEqual(run({ pr: p, fixing }), { lane: 'validating', phrase: 'Resolving conflicts · sent 1m ago', tone: 'warn' })
  assert.equal(run({ pr: p, fixing: { kind: 'ci', sha: 'sha1', at: NOW } }).phrase, 'Merge conflicts')
})

test('rule 5: failing checks', () => {
  const p = pr({ checks: [check('pass'), check('fail')] })
  assert.deepEqual(run({ pr: p }), { lane: 'validating', phrase: 'CI failing', tone: 'warn' })
  const fixing = { kind: 'ci', sha: 'sha1', at: NOW - 60_000 }
  assert.deepEqual(run({ pr: p, fixing }), { lane: 'validating', phrase: 'Fixing CI failures · sent 1m ago', tone: 'warn' })
  assert.equal(run({ pr: p, fixing: { ...fixing, sha: 'old' } }).phrase, 'CI failing')
})

test('rule 6: checks running, zero checks, truncated', () => {
  const p = pr({ checks: [check('pass'), check('pass'), check('pending'), check('pending')] })
  assert.deepEqual(run({ pr: p }), { lane: 'review', phrase: 'Checks running · 2 of 4', tone: 'info' })
  assert.deepEqual(run({ pr: pr({ checks: [] }) }), { lane: 'validating', phrase: 'Waiting for checks', tone: 'info' })
  assert.deepEqual(run({ pr: pr({ checks: [check('pass')], checksTruncated: true }) }), { lane: 'review', phrase: 'Checks running · 1 of 1', tone: 'info' })
})

test('rule 7: unresolved thread', () => {
  const p = pr({ threads: [{ id: 't', resolved: false, comments: [] }] })
  assert.deepEqual(run({ pr: p }), { lane: 'review', phrase: 'Commented', tone: 'warn' })
  const fixing = { kind: 'review', sha: 'sha1', at: NOW - 60_000 }
  assert.deepEqual(run({ pr: p, fixing }), { lane: 'review', phrase: 'Addressing comments · sent 1m ago', tone: 'warn' })
})

test('rule 8: changes requested', () => {
  assert.deepEqual(run({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }), { lane: 'review', phrase: 'Changes requested', tone: 'warn' })
})

test('rule 9: review requested', () => {
  assert.deepEqual(run({ pr: pr({ reviewRequested: true }) }), { lane: 'review', phrase: 'Awaiting review', tone: 'info' })
})

test('rule 10: mergeability unknown', () => {
  assert.deepEqual(run({ pr: pr({ mergeable: 'UNKNOWN' }) }), { lane: 'validating', phrase: 'Checking mergeability', tone: 'info' })
})

test('rule 11: mergeable', () => {
  assert.deepEqual(run(), { lane: 'ready', phrase: 'Mergeable', tone: 'ok' })
})

test('columnOf is the lane a session would have without its need', () => {
  const at = (over) => columnOf({ session: session(), pr: pr(), fixing: null, now: NOW, ...over })
  assert.equal(at({}), 'ready')
  assert.equal(at({ pr: pr({ checks: [check('fail')] }) }), 'validating')
  assert.equal(at({ pr: pr({ reviewRequested: true }) }), 'review')
  assert.equal(at({ pr: null, session: session({ agent: agent('working') }) }), 'building')
  assert.equal(at({ pr: null, session: session({ agent: agent('done') }) }), 'idle')
  assert.equal(at({ pr: null, session: session({ isMain: true, agent: agent('none') }) }), 'building')
})

test('labelOf drops the time or the need detail and keeps other detail', () => {
  assert.equal(labelOf('Working · 14m', 'building'), 'Working')
  assert.equal(labelOf('Working · <1m', 'building'), 'Working')
  assert.equal(labelOf('Fixing CI failures · sent <1m ago', 'building'), 'Fixing CI failures')
  assert.equal(labelOf('Idle · last active 2h ago', 'idle'), 'Idle')
  assert.equal(labelOf('Fixing CI failures · sent 1m ago', 'validating'), 'Fixing CI failures')
  assert.equal(labelOf('Checks running · 3 of 5', 'validating'), 'Checks running · 3 of 5')
  assert.equal(labelOf('Blocked · wants to run `ls`', 'needs'), 'Blocked')
  assert.equal(labelOf('CI failing · 3 fix attempts used', 'needs'), 'CI failing')
  assert.equal(labelOf('Mergeable', 'ready'), 'Mergeable')
})

test('parsePlan reads one marked step per line and skips the rest', () => {
  assert.deepEqual(parsePlan('[x] one\n[~] two\n[ ] three\nnot a step\n  [X]  four  \n[]\n[ ]   '), [
    { text: 'one', status: 'done' },
    { text: 'two', status: 'active' },
    { text: 'three', status: 'pending' },
    { text: 'four', status: 'done' }
  ])
  assert.deepEqual(parsePlan(''), [])
  assert.equal(parsePlan(Array.from({ length: 60 }, (_, i) => `[ ] s${i}`).join('\n')).length, 40)
})
