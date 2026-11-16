import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentFromStatus, buildSessions, createIndex, effectiveState, listStateOf } from '../src/sessions.ts'

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))

const workspaces = fixture('workspace-list.json')
const worktrees = fixture('worktree-list.json').result
const workers = fixture('worker-list.json').result
const homePath = '/Users/aamonnaig/.orca-orchestration/home'
const base = { workspaces, worktrees, workers, agents: {}, tracked: [], marker: 'orch:x', homePath }
const spike = '/Users/aamonnaig/Developer/orca-plugins/spike-oa'

const agent = (over = {}) => ({
  state: 'working',
  terminalId: null,
  sessionId: null,
  chatId: null,
  kind: null,
  since: 0,
  permissionMasked: false,
  ...over
})

test('fixtures give one session per local worktree outside the home', () => {
  const sessions = buildSessions(base)
  assert.deepEqual(
    sessions.map((s) => s.key).sort(),
    [
      '/Users/aamonnaig/Developer/orca-plugins',
      '/Users/aamonnaig/Developer/orca-plugins/orchestration',
      spike
    ].sort()
  )
  for (const s of sessions) assert.equal(s.repo, 'aamonnaig4/orca-plugins')
  assert.equal(sessions.find((s) => s.key === spike).branch, 'aamonnaig4/spike-oa')
  assert.deepEqual(sessions.find((s) => s.key === spike).ids, [
    'identity:wt2:local:e4c5b3f5-797b-4987-9199-d48dd1796aec',
    '5e954941-0215-463e-97e1-feb38c4e64ff::' + spike,
    'e4c5b3f5-797b-4987-9199-d48dd1796aec'
  ])
})

test('branch and isMain come from the worktree list', () => {
  const sessions = buildSessions(base)
  const main = sessions.find((s) => s.key === '/Users/aamonnaig/Developer/orca-plugins')
  assert.equal(main.branch, 'main')
  assert.equal(main.isMain, true)
  assert.equal(sessions.find((s) => s.key === spike).isMain, false)
})

test('a folder row has no repo and no branch', () => {
  const ws = { workspaces: [{ ...workspaces.workspaces[3], path: '/x/home2', id: 'r::/x/home2' }] }
  const tree = { worktrees: [{ ...worktrees.worktrees[3], path: '/x/home2', id: 'r::/x/home2' }] }
  const [s] = buildSessions({ ...base, workspaces: ws, worktrees: tree })
  assert.equal(s.repo, null)
  assert.equal(s.branch, null)
})

const orchDir = '/Users/aamonnaig/Developer/orca-plugins/orchestration'
const withComment = (comment) => ({
  worktrees: worktrees.worktrees.map((w) => (w.path === orchDir ? { ...w, comment } : w))
})
const startedOf = (comment, marker) =>
  buildSessions({ ...base, worktrees: withComment(comment), marker }).find((x) => x.key === orchDir).started

test('a comment with the marker means orchestrator-started', () => {
  assert.equal(startedOf('', 'orch:abc'), 'you')
  assert.equal(startedOf('orch:abc', 'orch:abc'), 'orchestrator')
  assert.equal(startedOf('orchestra', 'orch:abc'), 'you')
  assert.equal(startedOf('orch:abc', ''), 'you')
  assert.equal(startedOf('', ''), 'you')
})

test('a tracked dispatch id means orchestrator-started and takes the first worker row', () => {
  const tracked = buildSessions({ ...base, tracked: ['ctx_92026b9d61c3'] }).find((x) => x.key === spike)
  assert.equal(tracked.started, 'orchestrator')
  assert.equal(tracked.dispatchId, 'ctx_6fc5b45b8c33')
  const untracked = buildSessions({ ...base, tracked: [] }).find((x) => x.key === spike)
  assert.equal(untracked.started, 'you')
  assert.equal(untracked.dispatchId, null)
})

test('remote rows and the home row are dropped', () => {
  const ws = { workspaces: workspaces.workspaces.map((w) => (w.path === spike ? { ...w, hostId: 'ssh:x' } : w)) }
  const tree = { worktrees: worktrees.worktrees.map((w) => (w.path === spike ? { ...w, hostId: 'ssh:x' } : w)) }
  const keys = buildSessions({ ...base, workspaces: ws, worktrees: tree }).map((s) => s.key)
  assert.ok(!keys.includes(spike))
  assert.ok(!keys.includes(homePath))
  assert.ok(!buildSessions(base).some((s) => s.key === homePath))
})

test('a row in only one list is dropped', () => {
  const tree = { worktrees: worktrees.worktrees.filter((w) => w.path !== spike) }
  assert.ok(!buildSessions({ ...base, worktrees: tree }).some((s) => s.key === spike))
  const ws = { workspaces: workspaces.workspaces.filter((w) => w.path !== spike) }
  assert.ok(!buildSessions({ ...base, workspaces: ws }).some((s) => s.key === spike))
  const orphanTree = { worktrees: [...worktrees.worktrees, { ...worktrees.worktrees[2], path: '/x/orphan-tree', id: 'r::/x/orphan-tree' }] }
  assert.ok(!buildSessions({ ...base, worktrees: orphanTree }).some((s) => s.key === '/x/orphan-tree'))
  const orphanWs = { workspaces: [...workspaces.workspaces, { ...workspaces.workspaces[2], path: '/x/orphan-ws', id: 'r::/x/orphan-ws' }] }
  assert.ok(!buildSessions({ ...base, workspaces: orphanWs }).some((s) => s.key === '/x/orphan-ws'))
})

test('malformed input never throws', () => {
  const bad = [null, undefined, 5, 'x', [null, 1, 'x'], { worktrees: null }, { worktrees: [null, 3] }, { result: null }]
  for (const w of bad) {
    for (const t of bad) {
      assert.ok(Array.isArray(buildSessions({ ...base, workspaces: w, worktrees: t })))
    }
  }
  for (const k of bad) assert.ok(Array.isArray(buildSessions({ ...base, workers: k })))
  const rows = buildSessions({ ...base, workers: { workers: [null, 1, 'x'] } })
  assert.equal(rows.length, 3)
  for (const agents of [undefined, null, 5, 'x', []]) {
    assert.equal(buildSessions({ ...base, agents }).length, 3)
  }
  const { agents: _a, ...noAgents } = base
  assert.equal(buildSessions(noAgents).length, 3)
  const { tracked: _t, ...noTracked } = base
  assert.equal(buildSessions(noTracked).length, 3)
  for (const tracked of [null, 5, {}, true]) assert.equal(buildSessions({ ...base, tracked }).length, 3)
})

test('a non-object or stateless agents entry falls back to the list state and the last activity time', () => {
  const lastActivityAt = workspaces.workspaces.find((w) => w.path === spike).status.lastActivityAt
  for (const bad of [5, 'x', null, [], {}, { state: 'bogus', since: 3 }]) {
    const s = buildSessions({ ...base, agents: { [spike]: bad } }).find((x) => x.key === spike)
    assert.equal(s.agent.state, 'waiting')
    assert.equal(s.agent.since, typeof lastActivityAt === 'number' ? lastActivityAt : 0)
    assert.ok(Number.isFinite(s.agent.since))
  }
  const odd = buildSessions({ ...base, agents: { [spike]: { state: 'working', since: 'x' } } }).find((x) => x.key === spike)
  assert.equal(odd.agent.since, 0)
})

test('the index finds a session by each id and by terminal', () => {
  const sessions = buildSessions({ ...base, agents: { [spike]: agent({ state: 'waiting', terminalId: 't1' }) } })
  const index = createIndex(sessions)
  const s = sessions.find((x) => x.key === spike)
  for (const id of s.ids) assert.equal(index.byAnyId(id), s)
  assert.equal(index.byTerminal('t1'), s)
  assert.equal(index.byKey(spike), s)
  for (const v of [undefined, null]) {
    assert.equal(index.byAnyId(v), null)
    assert.equal(index.byTerminal(v), null)
  }
})

test('listStateOf reads the status object by path', () => {
  assert.equal(listStateOf(workspaces, spike), 'active')
  assert.equal(listStateOf(workspaces, '/nope'), null)
})

test('effectiveState', () => {
  assert.equal(effectiveState(undefined, 'permission'), 'blocked')
  assert.equal(effectiveState(undefined, 'working'), 'working')
  assert.equal(effectiveState(undefined, 'done'), 'done')
  assert.equal(effectiveState(undefined, 'active'), 'waiting')
  assert.equal(effectiveState(undefined, 'inactive'), 'none')
  assert.equal(effectiveState(undefined, null), 'none')
  assert.equal(effectiveState(agent({ state: 'waiting' }), 'permission'), 'blocked')
  assert.equal(effectiveState(agent({ state: 'waiting', permissionMasked: true }), 'permission'), 'waiting')
  assert.equal(effectiveState(agent({ state: 'waiting' }), 'active'), 'waiting')
  assert.equal(effectiveState(agent({ state: 'blocked' }), null), 'blocked')
})

test('a home-fixture row copied to another path with no agent entry is blocked', () => {
  const ws = { workspaces: [{ ...workspaces.workspaces[3], path: '/x/copy', id: 'r::/x/copy' }] }
  const tree = { worktrees: [{ ...worktrees.worktrees[3], path: '/x/copy', id: 'r::/x/copy' }] }
  const [s] = buildSessions({ ...base, workspaces: ws, worktrees: tree })
  assert.equal(s.agent.state, 'blocked')
  assert.equal(s.agent.terminalId, null)
})

test('agentFromStatus keeps ids, stamps since on change, clears the mask', () => {
  const prev = agent({ state: 'working', terminalId: 'T', sessionId: 'S', since: 5, permissionMasked: true })
  const same = agentFromStatus(prev, { state: 'working', receivedAt: 9 }, 'claude')
  assert.equal(same.terminalId, 'T')
  assert.equal(same.sessionId, 'S')
  assert.equal(same.since, 5)
  assert.equal(same.permissionMasked, false)
  const changed = agentFromStatus(prev, { state: 'done', receivedAt: 9 }, 'claude')
  assert.equal(changed.since, 9)
  assert.equal(changed.kind, 'claude')
})

test('a chat pane key sets chatId and leaves terminalId null', () => {
  const out = agentFromStatus(undefined, { state: 'working', paneKey: 'structured-agent-session-claude_780deaf0_x:uuid', receivedAt: 1 }, null)
  assert.equal(out.chatId, 'claude_780deaf0_x')
  assert.equal(out.terminalId, null)
})
