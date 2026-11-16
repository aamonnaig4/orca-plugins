import test from 'node:test'
import assert from 'node:assert/strict'
import { boardMarkdown, standingInstructions } from '../src/instructions.ts'

const O = { marker: 'orch:abc', workerAgent: 'codex', suffix: '-oa' }

test('standingInstructions contains every required command and rule', () => {
  const text = standingInstructions(O)
  const needles = [
    'orca skills get orchestration',
    '--spec',
    '--agent codex',
    'exactly the `check` command it asks for',
    'board.md',
    'orca orchestration worker-start --spec-file - --agent codex --worktree new-top-level --repo id:<repoId> --name <short-name>-oa --comment "orch:abc" --json',
    '--worktree new-top-level --repo id:<repoId>',
    '--name <short-name>-oa',
    '--comment "orch:abc"',
    './bin/say track <dispatch_id>',
    './bin/say question --options',
    './bin/tell',
    'never merge',
    'never poll',
    'draft',
    'end your turn'
  ]
  for (const needle of needles) assert.ok(text.includes(needle), needle)
})

test('standingInstructions lets the agent run check only when Orca asks', () => {
  const text = standingInstructions(O)
  assert.ok(text.includes('Run orca orchestration check --run <id>'))
  assert.ok(text.includes('on your own initiative, in a loop or in a watch script'))
  assert.ok(text.includes('Never run `orca orchestration reset`'))
  assert.ok(!text.includes('never run `orca orchestration check` yourself'))
  assert.ok(!text.includes('arrives in your terminal'))
  assert.ok(text.includes('handle the whole batch'))
})

test('standingInstructions passes the task through a quoted heredoc, not double quotes', () => {
  const text = standingInstructions(O)
  assert.ok(text.includes("<<'ORCA_SPEC_END'"))
  assert.ok(text.includes('\nORCA_SPEC_END\n'))
  assert.ok(!text.includes('or in single quotes'))
  assert.ok(!text.includes("--spec '"))
  assert.ok(text.includes('--spec-file -'))
  assert.ok(!text.includes('--spec "'))
  assert.ok(text.includes('never in double quotes'))
})

test('standingInstructions says its own text wins over the skill guide and keeps routed fixes out of the batch', () => {
  const text = standingInstructions(O)
  assert.ok(text.includes('these instructions win'))
  assert.ok(text.includes('do nothing for that item'))
  assert.ok(text.includes('Finish the rest of the batch'))
  assert.ok(!text.includes('say nothing and end your turn at once'))
})

test('standingInstructions substitutes the given values', () => {
  const text = standingInstructions({ marker: 'orch:zzz', workerAgent: 'gemini', suffix: '-bot' })
  assert.ok(text.includes('--agent gemini'))
  assert.ok(text.includes('--name <short-name>-bot'))
  assert.ok(text.includes('--comment "orch:zzz"'))
  assert.ok(!text.includes('-oa'))
  assert.ok(!text.includes('orch:abc'))
})

test('standingInstructions forbids force-push and typing into terminals', () => {
  const text = standingInstructions(O)
  assert.ok(text.includes('never force-push'))
  assert.ok(text.includes('terminal send'))
})

const ROW = {
  name: 'login-fix-oa',
  key: 'k1',
  project: 'acme',
  lane: 'Validating',
  phrase: 'Draft',
  branch: 'me/login-fix',
  pr: 12,
  dispatchId: 'ctx_1',
  started: 'orchestrator'
}

test('boardMarkdown groups rows under lane headings in Board order', () => {
  const rows = [
    { ...ROW, name: 'ready-one', lane: 'Ready', pr: 3, phrase: 'Mergeable' },
    { ...ROW, name: 'needs-one', lane: 'Needs you', pr: null, branch: null, dispatchId: null, started: 'you', phrase: 'Blocked · waiting on a prompt' },
    { ...ROW, name: 'idle-one', lane: 'Idle', pr: null, phrase: 'Idle' },
    { ...ROW, name: 'build-one', lane: 'Building', pr: null, phrase: 'Working · 14m' },
    { ...ROW, name: 'review-one', lane: 'Needs review', phrase: 'Awaiting review' },
    ROW
  ]
  const md = boardMarkdown(rows, [], 0)
  const order = ['## Needs you', '## Building', '## Validating', '## Needs review', '## Ready', '## Idle']
  const at = order.map((h) => md.indexOf(h))
  assert.ok(at.every((n) => n >= 0), String(at))
  assert.deepEqual([...at].sort((a, b) => a - b), at)
  for (const r of rows) assert.equal(md.split('\n').filter((l) => l.includes(r.name)).length, 1)
  const line = md.split('\n').find((l) => l.includes('login-fix-oa'))
  for (const part of ['k1', 'acme', 'Draft', 'me/login-fix', '#12', 'ctx_1', 'orchestrator']) assert.ok(line.includes(part), part)
  const none = md.split('\n').find((l) => l.includes('needs-one'))
  assert.ok(none.includes('no PR'))
  assert.ok(none.includes('you'))
})

test('boardMarkdown lists each project with its repo id and path', () => {
  const md = boardMarkdown([], [{ name: 'acme', repoId: 'r-123', path: '/code/acme' }], 0)
  const line = md.split('\n').find((l) => l.includes('acme'))
  assert.ok(line.includes('r-123'))
  assert.ok(line.includes('/code/acme'))
})

test('boardMarkdown with a different now differs only in the first line', () => {
  const projects = [{ name: 'acme', repoId: 'r-123', path: '/code/acme' }]
  const a = boardMarkdown([ROW], projects, 1_700_000_000_000).split('\n')
  const b = boardMarkdown([ROW], projects, 1_700_000_999_000).split('\n')
  assert.notEqual(a[0], b[0])
  assert.deepEqual(a.slice(1), b.slice(1))
})

test('boardMarkdown keeps hostile text as written', () => {
  const md = boardMarkdown([{ ...ROW, name: '<img src=x onerror=1>' }], [], 0)
  assert.ok(md.includes('<img src=x onerror=1>'))
})

test('standingInstructions ends the batch paragraph with end your turn, after board.md', () => {
  const text = standingInstructions(O)
  const start = text.indexOf('## When a worker finishes')
  const end = text.indexOf('When you have nothing left to do')
  const section = text.slice(start, end)
  assert.ok(section.includes('board.md'))
  assert.ok(section.lastIndexOf('end your turn') > section.lastIndexOf('board.md'))
  assert.ok(section.lastIndexOf('end your turn') > section.lastIndexOf('do nothing for that item'))
  assert.ok(section.trimEnd().endsWith('end your turn.'))
})

test('standingInstructions reuses an existing workspace before creating one', () => {
  const text = standingInstructions(O)
  assert.ok(text.includes('Never create a workspace for work that already has one'))
  assert.ok(text.includes('orca orchestration worker-start --spec-file - --agent codex --worktree path:<key> --json'))
  assert.ok(text.includes('./bin/tell <session> <text>'))
  assert.ok(text.includes('orca worktree list --json'))
  assert.ok(text.includes('--on "<host>"'))
  const reuse = text.indexOf('## Use the workspace that already exists')
  const fresh = text.indexOf('## Starting a worker in a new workspace')
  assert.ok(reuse >= 0 && fresh > reuse)
  assert.ok(text.indexOf('--worktree new-top-level') > fresh)
})

test('boardMarkdown says whether an agent is in each session', () => {
  const md = boardMarkdown([{ ...ROW, name: 'with', agent: 'claude' }, { ...ROW, name: 'without', agent: null }], [], 0)
  const lines = md.split('\n')
  assert.ok(lines.find((l) => l.includes('with ·')).includes('agent claude'))
  assert.ok(lines.find((l) => l.includes('without')).includes('no agent'))
  assert.ok(!boardMarkdown([ROW], [], 0).includes('agent'))
})
