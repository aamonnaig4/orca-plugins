import test from 'node:test'
import assert from 'node:assert/strict'
import { hostError, mockHost, mountWorker } from 'orca/testing'
import * as main from '../src/worker.ts'
import { createSampler } from '../src/sampler.ts'

test('worker hides the status bar badge while calm and Orca refuses none of its calls', async () => {
  const worker = await mountWorker(main)
  const updates = worker.host.callsOf('statusBar.update')
  assert.ok(updates.length >= 1)
  assert.equal(updates[0].id, 'health')
  assert.equal(updates[0].visible, false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const WS = { id: 'ws1', kind: 'worktree', name: 'app', path: '/tmp/app', branch: 'main', hostId: null }

function cleanupHost(over = {}) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [WS], truncated: false },
      'agent.launch': { terminalId: 'term_1' },
      'terminal.sendText': { accepted: true },
      'terminal.read': { lines: ['Proposed: 2'], truncated: false },
      'agents.list': { agents: [] },
      ...over
    }
  })
}

const START = 'Thu Nov 5 09:02:44 2026'
const ORPHAN = { pid: 501, ppid: 1, name: 'node', cpu: 0, mem: 50 * 1024 ** 2, start: START }

function fakeSystem(procs) {
  const provider = {
    diskPath: '/',
    diskName: 'Root (/)',
    countIrq: true,
    procEvery: 0,
    protectedNames: /^(launchd)$/,
    info: async () => ({ performance: [], efficiency: [], model: '' }),
    note: async () => null,
    read: async () => ({ memory: { total: 100, used: 25, app: 25, wired: 0, compressed: 0, cached: 0 }, swap: null, pressure: null, net: null, disk: null, gpu: null }),
    procs: async () => [...procs],
    identify: async () => null,
    quit: async () => ({ ok: true }),
    detailsEvery: 0,
    details: async () => null,
    cwds: async () => new Map(),
    args: async (pids) => new Map(pids.map((pid) => [pid, 'node server.js']))
  }
  main.seams.sampler = () => createSampler({ provider, selfPids: [] })
}

function fakeCli(procs = [ORPHAN]) {
  fakeSystem(procs)
  const runs = []
  main.seams.run = async (command, args) => {
    runs.push([command, ...args])
    return ''
  }
  return runs
}

async function until(check) {
  for (let i = 0; i < 3000; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting')
}

const status = (state, terminalId = 'term_1') => ({ workspaceId: null, paneKey: 'pane', terminalId, state, receivedAt: Date.now() })

async function started(worker) {
  const pending = worker.request('cleanup.start')
  await until(() => worker.host.callsOf('agent.launch').length === 1)
  await worker.emit('agent.status.changed', status('waiting'))
  return pending
}

const HERE = { id: 'ws_here', kind: 'folder', name: 'here', path: process.cwd(), branch: null, hostId: null }
const REMOTE = { id: 'ws_ssh', kind: 'worktree', name: 'box', path: process.cwd(), branch: 'main', hostId: 'ssh:box' }

test('cleanup.start with no focused workspace starts the agent in a local one', async () => {
  fakeCli()
  const worker = await mountWorker(main, {
    host: cleanupHost({ 'workspace.readContext': null, 'workspace.list': { workspaces: [REMOTE, WS, HERE], truncated: false } })
  })
  assert.equal((await started(worker)).ok, true)
  assert.deepEqual(worker.host.callsOf('agent.launch'), [{ workspaceId: 'ws_here', agent: 'claude' }])
  await worker.deactivate()
})

test('cleanup.start falls back to a local workspace when the focused one is ambiguous', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: cleanupHost({ 'workspace.list': { workspaces: [WS, { ...WS, id: 'ws2' }, HERE], truncated: false } }) })
  assert.equal((await started(worker)).ok, true)
  assert.deepEqual(worker.host.callsOf('agent.launch'), [{ workspaceId: 'ws_here', agent: 'claude' }])
  await worker.deactivate()
})

test('cleanup.start refuses when Orca has no local workspace and launches nothing', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: cleanupHost({ 'workspace.readContext': null, 'workspace.list': { workspaces: [REMOTE], truncated: false } }) })
  assert.deepEqual(await worker.request('cleanup.start'), { ok: false, reason: 'Add a project to Orca first' })
  assert.equal(worker.host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('cleanup.start launches the agent without a prompt, then types the prompt once it is ready', async () => {
  const runs = fakeCli()
  const worker = await mountWorker(main, { host: cleanupHost() })
  const out = await started(worker)
  assert.equal(out.ok, true)
  assert.deepEqual(out.state, { kind: 'working' })
  assert.deepEqual(worker.host.callsOf('agent.launch'), [{ workspaceId: 'ws1', agent: 'claude' }])
  const sent = worker.host.callsOf('terminal.sendText')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].terminalId, 'term_1')
  assert.equal(sent[0].enter, true)
  assert.match(sent[0].text, /Proposed: N/)
  assert.deepEqual(runs, [['orca', 'terminal', 'switch', '--terminal', 'term_1']])
  const again = await worker.request('cleanup.start')
  assert.equal(again.ok, true)
  assert.equal(worker.host.callsOf('agent.launch').length, 1)
  assert.deepEqual(runs.at(-1), ['orca', 'terminal', 'switch', '--terminal', 'term_1'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a second press while the agent is still starting launches nothing new', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: cleanupHost() })
  const first = worker.request('cleanup.start')
  await until(() => worker.host.callsOf('agent.launch').length === 1)
  const second = worker.request('cleanup.start')
  await worker.emit('agent.status.changed', status('waiting'))
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(worker.host.callsOf('agent.launch').length, 1)
  await worker.deactivate()
})

test('cleanup.start falls back to the Orca CLI when the terminal does not take the prompt', async () => {
  const runs = fakeCli()
  const worker = await mountWorker(main, { host: cleanupHost({ 'terminal.sendText': { accepted: false } }) })
  const out = await started(worker)
  assert.equal(out.ok, true)
  const send = runs.find((r) => r[1] === 'terminal' && r[2] === 'send')
  assert.ok(send)
  assert.deepEqual(send.slice(0, 5), ['orca', 'terminal', 'send', '--terminal', 'term_1'])
  assert.equal(send[5], '--text')
  assert.match(send[6], /Proposed: N/)
  assert.equal(send[7], '--enter')
  await worker.deactivate()
})

test('cleanup.state follows the agent from working to review, and to rest when the terminal closes', async () => {
  fakeCli()
  let alive = true
  const worker = await mountWorker(main, {
    host: cleanupHost({
      'terminal.read': () => {
        if (!alive) throw hostError('invalid_params', 'no such terminal')
        return { lines: ['thinking', 'Proposed: 2'], truncated: false }
      }
    })
  })
  const out = await started(worker)
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'working' })
  await worker.emit('agent.status.changed', status('working'))
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'working' })
  await worker.emit('agent.status.changed', status('done'))
  const review = await worker.request('cleanup.state')
  assert.deepEqual(review.state, { kind: 'review', n: 2 })
  assert.equal(review.count, out.count)
  const reads = worker.host.callsOf('terminal.read')
  assert.equal(reads.at(-1).maxLines, 200)
  alive = false
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'rest' }, count: 0 })
  await worker.deactivate()
})

function liveCli(show) {
  fakeSystem([ORPHAN])
  const shows = []
  main.seams.run = async (command, args, options) => {
    if (args[1] !== 'show') return ''
    shows.push({ command, args: args.join(' '), anyExit: options?.anyExit === true })
    return show(command)
  }
  return shows
}

const shown = (terminal) => JSON.stringify({ id: 'x', ok: true, result: { terminal: { handle: 'term_1', ...terminal } } })

test('a closed cleanup terminal ends the session even though terminal.read still answers', async () => {
  let terminal = { connected: true, writable: true, orphaned: false }
  const shows = liveCli(() => shown(terminal))
  const worker = await mountWorker(main, { host: cleanupHost({ 'terminal.read': { lines: [], truncated: false } }) })
  await started(worker)
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'working' })
  assert.deepEqual(shows.at(-1), { command: 'orca', args: 'terminal show --terminal term_1 --json', anyExit: true })
  terminal = { connected: false, writable: false, orphaned: true }
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'rest' }, count: 0 })
  await worker.deactivate()
})

test('a stale terminal handle ends the session', async () => {
  let stale = false
  liveCli(() => (stale ? JSON.stringify({ id: 'x', ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } }) : shown({ connected: true, writable: true })))
  const worker = await mountWorker(main, { host: cleanupHost({ 'terminal.read': { lines: [], truncated: false } }) })
  await started(worker)
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'working' })
  stale = true
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'rest' }, count: 0 })
  await worker.deactivate()
})

test('when the Orca CLI cannot run, liveness falls back to terminal.read', async () => {
  let alive = true
  const shows = liveCli(() => null)
  const worker = await mountWorker(main, {
    host: cleanupHost({
      'terminal.read': () => {
        if (!alive) throw hostError('invalid_params', 'no such terminal')
        return { lines: ['Proposed: 2'], truncated: false }
      }
    })
  })
  await started(worker)
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'working' })
  assert.ok(shows.length >= 1)
  alive = false
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'rest' }, count: 0 })
  await worker.deactivate()
})

test('a suspect that disappears turns the pill to quit, and opening it returns to rest', async () => {
  const procs = [ORPHAN]
  const runs = fakeCli(procs)
  const worker = await mountWorker(main, { host: cleanupHost() })
  const out = await started(worker)
  assert.equal(out.count, 1)
  assert.match(worker.host.callsOf('terminal.sendText')[0].text, /PID 501/)
  await worker.emit('agent.status.changed', status('waiting'))
  assert.deepEqual((await worker.request('cleanup.state')).state, { kind: 'review', n: 2 })
  procs.length = 0
  await worker.emit('agent.status.changed', status('done'))
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'quit', n: 1 }, count: 1 })
  const opened = await worker.request('cleanup.open')
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.state, { kind: 'rest' })
  assert.deepEqual(runs.at(-1), ['orca', 'terminal', 'switch', '--terminal', 'term_1'])
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'rest' }, count: 0 })
  await worker.deactivate()
})

test('when no prompt send works the pill shows the idle agent, not Cleaning forever', async () => {
  const runs = fakeCli()
  main.seams.run = async (command, args) => {
    runs.push([command, ...args])
    return args[1] === 'send' ? null : ''
  }
  const worker = await mountWorker(main, { host: cleanupHost({ 'terminal.sendText': { accepted: false } }) })
  const out = await started(worker)
  assert.deepEqual(out, { ok: false, reason: 'Your agent did not take the cleanup prompt' })
  assert.deepEqual(await worker.request('cleanup.state'), { state: { kind: 'review', n: 2 }, count: 1 })
  await worker.request('cleanup.start')
  assert.equal(worker.host.callsOf('agent.launch').length, 1)
  await worker.deactivate()
})

test('an agent that never reports keeps its terminal as the session, so the next press focuses it', async () => {
  const runs = fakeCli()
  main.seams.startWaitMs = 20
  try {
    const worker = await mountWorker(main, { host: cleanupHost() })
    assert.deepEqual(await worker.request('cleanup.start'), { ok: false, reason: 'Your agent did not start' })
    assert.equal(worker.host.callsOf('terminal.sendText').length, 0)
    const again = await worker.request('cleanup.start')
    assert.equal(again.ok, true)
    assert.equal(worker.host.callsOf('agent.launch').length, 1)
    assert.deepEqual(runs.at(-1), ['orca', 'terminal', 'switch', '--terminal', 'term_1'])
    await worker.deactivate()
  } finally {
    main.seams.startWaitMs = 45000
  }
})

test('prefs.sync stores the prefs and the next launch uses the chosen agent without focusing', async () => {
  const runs = fakeCli()
  const host = cleanupHost()
  const worker = await mountWorker(main, { host })
  const synced = await worker.request('prefs.sync', { record: false, focus: false, agent: 'codex' })
  assert.equal(synced.ok, true)
  assert.deepEqual(host.data().storage.prefs, { record: false, focus: false, agent: 'codex' })
  await worker.request('prefs.sync', { record: false, focus: false, agent: 'auto' })
  assert.deepEqual(host.data().storage.prefs, { record: false, focus: false, agent: 'codex' })
  await started(worker)
  assert.equal(worker.host.callsOf('agent.launch')[0].agent, 'codex')
  assert.deepEqual(runs, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the worker loads stored prefs when it starts', async () => {
  fakeCli()
  const host = mockHost({
    storage: { prefs: { record: true, focus: false, agent: 'grok' } },
    results: {
      'workspace.readContext': { branch: '', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [{ ...WS, branch: null }], truncated: false },
      'agent.launch': { terminalId: 'term_1' },
      'terminal.sendText': { accepted: true }
    }
  })
  const worker = await mountWorker(main, { host })
  await started(worker)
  assert.equal(worker.host.callsOf('agent.launch')[0].agent, 'grok')
  await worker.deactivate()
})
