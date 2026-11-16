import test from 'node:test'
import assert from 'node:assert/strict'
import { messageFor } from '../src/messages.ts'

const CLOSING = 'Fix it, push, and do not merge. Start any reply you post on the PR with [agent].'
const PR_URL = 'https://github.com/acme/app/pull/42'

const pr = {
  repo: 'acme/app',
  number: 42,
  url: PR_URL,
  branch: 'feature-oa',
  base: 'main',
  headSha: 'abc123',
  baseSha: 'def456',
  isDraft: false,
  mergeable: 'CONFLICTING',
  reviewDecision: null,
  reviewRequested: false,
  checks: [],
  checksTruncated: false,
  threads: [],
  reviews: [],
  comments: []
}

function comment(id, body, extra = {}) {
  return { id, author: 'alice', isBot: false, body, url: `https://gh/c/${id}`, path: null, line: null, ...extra }
}

test('ci message lists failed checks and fenced log tails', () => {
  const ev = {
    kind: 'ci',
    pr: 42,
    sha: 'abc123',
    key: 'ci:acme/app#42:abc123',
    checks: [
      { name: 'lint', state: 'fail', jobId: '11', url: 'https://ci/lint' },
      { name: 'test', state: 'fail', jobId: '12', url: 'https://ci/test' },
      { name: 'legacy', state: 'fail', jobId: null, url: null }
    ]
  }
  const logs = [
    { check: 'lint', tail: 'error: unused import\n1 problem' },
    { check: 'test', tail: 'expected ```1``` got 2' }
  ]
  assert.deepEqual(messageFor(ev, pr, { logs }), {
    subject: 'CI failed on #42',
    body: [
      `CI failed on #42: ${PR_URL}`,
      'Head commit: abc123',
      '',
      'Failed checks:',
      '- lint: https://ci/lint',
      '- test: https://ci/test',
      '- legacy: no link',
      '',
      'Log tail for lint:',
      '```',
      'error: unused import',
      '1 problem',
      '```',
      '',
      'Log tail for test:',
      '````',
      'expected ```1``` got 2',
      '````',
      '',
      CLOSING
    ].join('\n')
  })
})

test('ci message without logs', () => {
  const ev = { kind: 'ci', pr: 42, sha: 'abc123', key: 'k', checks: [{ name: 'build', state: 'fail', jobId: '1', url: 'https://ci/b' }] }
  assert.deepEqual(messageFor(ev, pr, {}), {
    subject: 'CI failed on #42',
    body: [`CI failed on #42: ${PR_URL}`, 'Head commit: abc123', '', 'Failed checks:', '- build: https://ci/b', '', CLOSING].join('\n')
  })
})

test('thread message has path, line, text, URL and the resolve command', () => {
  const ev = {
    kind: 'thread',
    pr: 42,
    threadId: 'PRRT_kwDO1',
    key: 'c:c9',
    comment: comment('c9', 'Rename this variable.', { path: 'src/a.ts', line: 12 })
  }
  assert.deepEqual(messageFor(ev, pr, {}), {
    subject: 'Review comment on #42',
    body: [
      `Review comment on #42: ${PR_URL}`,
      'File: src/a.ts',
      'Line: 12',
      'From: alice',
      '',
      'Rename this variable.',
      '',
      'URL: https://gh/c/c9',
      '',
      `Resolve it when fixed: gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: "PRRT_kwDO1" }) { thread { isResolved } } }'`,
      '',
      CLOSING
    ].join('\n')
  })
})

test('thread message without a path or line', () => {
  const ev = { kind: 'thread', pr: 42, threadId: 'T1', key: 'c:c1', comment: comment('c1', 'General note') }
  const { body } = messageFor(ev, pr, {})
  assert.ok(body.includes('File: none\nLine: none\n'))
})

test('review message has the body and its URL', () => {
  const ev = {
    kind: 'review',
    pr: 42,
    key: 'r:r1',
    review: { id: 'r1', state: 'CHANGES_REQUESTED', author: 'bob', isBot: false, body: 'Please add tests.', url: 'https://gh/r/r1' }
  }
  assert.deepEqual(messageFor(ev, pr, {}), {
    subject: 'Review on #42',
    body: [`bob requested changes on #42: ${PR_URL}`, '', 'Please add tests.', '', 'URL: https://gh/r/r1', '', CLOSING].join('\n')
  })
  const commented = { ...ev, review: { ...ev.review, state: 'COMMENTED' } }
  assert.equal(messageFor(commented, pr, {}).body.split('\n')[0], `bob left a review on #42: ${PR_URL}`)
})

test('comment message has the text and its URL', () => {
  const ev = { kind: 'comment', pr: 42, key: 'c:c2', comment: comment('c2', 'Why this approach?') }
  assert.deepEqual(messageFor(ev, pr, {}), {
    subject: 'Comment on #42',
    body: [`alice commented on #42: ${PR_URL}`, '', 'Why this approach?', '', 'URL: https://gh/c/c2', '', CLOSING].join('\n')
  })
})

test('bot-batch message lists every item', () => {
  const ev = {
    kind: 'bot-batch',
    pr: 42,
    sha: 'abc123',
    key: 'bot:acme/app#42:abc123',
    items: [
      comment('b1', 'Coverage dropped 2%.', { author: 'codecov[bot]', isBot: true }),
      comment('b2', 'Possible null deref.', { author: 'copilot[bot]', isBot: true })
    ]
  }
  assert.deepEqual(messageFor(ev, pr, {}), {
    subject: 'Bot comments on #42',
    body: [
      `2 bot comments on #42: ${PR_URL}`,
      '',
      'codecov[bot] (https://gh/c/b1):',
      'Coverage dropped 2%.',
      '',
      'copilot[bot] (https://gh/c/b2):',
      'Possible null deref.',
      '',
      CLOSING
    ].join('\n')
  })
})

test('conflict message names the base, gives the safe merge steps and ends with the closing line', () => {
  const ev = { kind: 'conflict', pr: 42, base: 'main', baseSha: 'def456', key: 'conflict:acme/app#42:def456' }
  const text = messageFor(ev, pr, {})
  assert.equal(text.subject, 'Merge conflict on #42')
  const lines = text.body.split('\n')
  assert.equal(lines[0], `PR #42 has merge conflicts with main: ${PR_URL}`)
  assert.ok(lines.includes('Bring origin/main into this branch with a merge and resolve the conflicts.'))
  for (const part of ['Start with git status', 'Do not rebase and do not force-push', 'git reset --hard', 'git merge --continue', 'git diff --check', 'Push the merge commit']) {
    assert.ok(text.body.includes(part), part)
  }
  assert.equal(lines[lines.length - 1], CLOSING)
})

test('every kind ends with the closing line', () => {
  const evs = [
    { kind: 'ci', pr: 42, sha: 's', key: 'k', checks: [] },
    { kind: 'thread', pr: 42, threadId: 'T', key: 'k', comment: comment('c', 'x') },
    { kind: 'review', pr: 42, key: 'k', review: { id: 'r', state: 'COMMENTED', author: 'b', isBot: false, body: 'y', url: 'u' } },
    { kind: 'comment', pr: 42, key: 'k', comment: comment('c', 'z') },
    { kind: 'bot-batch', pr: 42, sha: 's', key: 'k', items: [] },
    { kind: 'conflict', pr: 42, base: 'main', baseSha: 'b', key: 'k' }
  ]
  for (const ev of evs) assert.ok(messageFor(ev, pr, {}).body.endsWith(`\n${CLOSING}`), ev.kind)
})

test('messageFor does not mutate its inputs', () => {
  const ev = Object.freeze({ kind: 'ci', pr: 42, sha: 's', key: 'k', checks: Object.freeze([Object.freeze({ name: 'a', state: 'fail', jobId: '1', url: 'u' })]) })
  const logs = Object.freeze([Object.freeze({ check: 'a', tail: 't' })])
  const extra = Object.freeze({ logs })
  messageFor(ev, Object.freeze({ ...pr }), extra)
  assert.deepEqual(logs, [{ check: 'a', tail: 't' }])
})

test('escalate message goes to the orchestrator with the round, the log tail and a tell to the worker', () => {
  const ev = {
    kind: 'escalate',
    pr: 42,
    sha: 'abc123',
    key: 'esc:acme/app#42:1',
    round: 1,
    rounds: 2,
    attempts: 3,
    checks: [{ name: 'lint', state: 'fail', jobId: '11', url: 'https://ci/lint' }]
  }
  const { subject, body } = messageFor(ev, pr, { logs: [{ check: 'lint', tail: 'error: unused import' }], session: 'billing-oa' })
  assert.equal(subject, 'CI still failing on #42 (escalation 1 of 2)')
  const lines = body.split('\n')
  assert.equal(lines[0], `CI is still failing on #42 in billing-oa after 3 fix attempts by its worker: ${PR_URL}`)
  assert.ok(body.includes('This is escalation round 1 of 2. If CI is still red 30 minutes after the last round, the panel asks Aamon.'))
  assert.ok(body.includes('- lint: https://ci/lint'))
  assert.ok(body.includes('Log tail for lint:\n```\nerror: unused import\n```'))
  assert.ok(body.includes('./bin/tell billing-oa <instructions>'))
  assert.ok(body.includes('memory.md'))
  assert.ok(!body.includes('Fix it, push, and do not merge.'))
})
