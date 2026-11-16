import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hostError, mockHost, mountWorker } from 'orca/testing'
import * as main from '../src/worker.ts'

const REAL_HOME = '/Users/aamonnaig/.orca-orchestration/home'
const USER = '/nonexistent/orch-worker-test'
const HOME = USER + '/.orca-orchestration/home'
const HOME_REPO = 'ed35e1a6-a877-4c36-9b9a-c9aa020a5305'
const WS = HOME_REPO + '::' + HOME
const REPO = '5e954941-0215-463e-97e1-feb38c4e64ff'
const ROOT = '/Users/aamonnaig/Developer/orca-plugins'
const SPIKE = ROOT + '/spike-oa'
const BUILD = ROOT + '/orchestration'
const SPIKE_WT = REPO + '::' + SPIKE
const BUILD_WT = REPO + '::' + BUILD
const SPIKE_LIST = 'identity:wt2:local:e4c5b3f5-797b-4987-9199-d48dd1796aec'
const ROOT_LIST = 'identity:wt2:local:9a0b0e52-9b28-4a23-a626-1db954b18502'
const SPIKE_DISPATCH = 'ctx_6fc5b45b8c33'
const FORBIDDEN = ['workspace.open', 'terminal.focus', 'editor.open', 'commands.run', 'terminal.sendText']
const T0 = 1794800000000

async function raw(name) {
  return (await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8')).split(REAL_HOME).join(HOME)
}

const CONTEXT = await raw('agent-context.json')
const WORKSPACES = JSON.parse(await raw('workspace-list.json'))
const WORKTREES = JSON.parse(await raw('worktree-list.json')).result
const WORKERS = JSON.parse(await raw('worker-list.json')).result
const HOOKS = JSON.parse(await raw('hooks-status.json')).result
const REPOS = JSON.parse(await raw('repo-list.json')).result
const PROMPT = JSON.parse(await raw('terminal-read-prompt.json')).result
const DENIED = JSON.parse(await raw('terminal-read-denied.json')).result
const GH = JSON.parse(await raw('gh-prs.json'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function workspaces(states = {}) {
  const ws = clone(WORKSPACES)
  for (const row of ws.workspaces) {
    if (row.path === HOME) row.status.state = 'active'
    if (Object.prototype.hasOwnProperty.call(states, row.path)) row.status.state = states[row.path]
  }
  return ws
}

function agent(state, terminalId, over = {}) {
  return { state, terminalId, sessionId: null, chatId: null, kind: 'claude', since: T0 - 60000, permissionMasked: false, ...over }
}

function orchRecord() {
  return { marker: 'orch:spike', repoId: HOME_REPO, workspaceId: WS, home: HOME, agentKind: 'claude', agent: agent('waiting', 'term_orch', { sessionId: 'sess_orch' }) }
}

function memoryFs() {
  const files = new Map()
  return {
    files,
    read: async (p) => (files.has(p) ? files.get(p) : null),
    write: async (p, text) => {
      files.set(p, text)
    },
    list: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : dir + '/'
      return [...files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length))
    },
    remove: async (p) => {
      files.delete(p)
    },
    mkdir: async () => {}
  }
}

function envelope(result) {
  return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', missing: false }
}

function ghResponse(prs) {
  const data = clone(GH)
  data.data.repository.b0.nodes = prs
  return { code: 0, stdout: JSON.stringify(data), stderr: '', missing: false }
}

function spikePr() {
  const node = clone(GH.data.repository.b0.nodes[0])
  node.headRefName = 'aamonnaig4/spike-oa'
  node.url = 'https://github.com/aamonnaig4/orca-plugins/pull/7'
  node.number = 7
  return node
}

function world(o = {}) {
  const fs = memoryFs()
  const runs = []
  const screens = [...(o.screens ?? [])]
  const w = {
    t: T0,
    fs,
    runs,
    screens,
    prs: o.prs ?? [],
    throwNow: false,
    onWait: null,
    orcaRuns(prefix) {
      return runs.filter((r) => r[0] === '/x/orca' && prefix.every((p, i) => r[1 + i] === p))
    }
  }
  const run = async (cmd, args) => {
    runs.push([cmd, ...args])
    if (o.run) {
      const custom = await o.run(cmd, args)
      if (custom) return custom
    }
    if (cmd === '/bin/zsh') {
      if (String(args[1]).includes('orca=')) return { code: 0, stdout: 'orca=/x/orca\ngh=/x/gh\n', stderr: '', missing: false }
      return { code: 0, stdout: 'ok claude\n', stderr: '', missing: false }
    }
    if (cmd === '/x/gh') {
      if (args[0] === 'api') return ghResponse(w.prs)
      if (args[0] === 'pr' && args[1] === 'diff') return { code: 0, stdout: 'diff --git a/x b/x\n', stderr: '', missing: false }
      return { code: 1, stdout: '', stderr: 'nope', missing: false }
    }
    const a = args.filter((x) => x !== '--json')
    const head = a.slice(0, 2).join(' ')
    if (a[0] === 'agent-context') return { code: 0, stdout: CONTEXT, stderr: '', missing: false }
    if (head === 'worktree list') return envelope(WORKTREES)
    if (head === 'orchestration worker-list') return envelope(WORKERS)
    if (head === 'agent hooks') return envelope(HOOKS)
    if (head === 'repo list') return envelope(REPOS)
    if (head === 'terminal list') return envelope({ terminals: [{ handle: 'term_orch' }], truncated: false })
    if (head === 'terminal read') return envelope(w.screens.length > 0 ? w.screens.shift() : PROMPT)
    if (head === 'terminal send') return envelope({ accepted: true })
    if (head === 'orchestration send') return envelope({ dispatchId: 'ctx_new' })
    if (head === 'orchestration worker-stop') return envelope({ stopped: true })
    if (head === 'orchestration worker-read') return envelope({ output: 'line one\nline two\n' })
    if (head === 'worktree rm') return envelope({ removed: true })
    if (head === 'terminal switch') return envelope({ switched: true })
    if (head === 'worktree activate') return envelope({ activated: true })
    return { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'unknown', message: 'unknown command' } }), stderr: '', missing: false }
  }
  w.deps = {
    run,
    now: () => {
      if (w.throwNow) throw new Error('clock broke')
      return w.t
    },
    home: () => USER,
    env: () => undefined,
    fs
  }
  return w
}

async function mount(o = {}) {
  const w = world(o)
  main.setTestDeps({
    deps: w.deps,
    id: (() => {
      let n = 0
      return () => 'id' + ++n
    })(),
    wait: async () => {
      if (w.onWait) await w.onWait()
    },
    readyMs: o.readyMs,
    alive: async () => true,
    ...(o.seam ?? {})
  })
  const storage = {}
  if (o.orch !== false && o.settings?.orchestratorAgent) storage.orch = orchRecord()
  Object.assign(storage, o.storage ?? {})
  const host = mockHost({
    results: {
      'workspace.list': o.workspaces ?? workspaces(),
      'agent.launch': { terminalId: 'term_orch' },
      'agent.resume': { terminalId: 'term_orch', started: true },
      ...(o.results ?? {})
    },
    storage,
    settings: o.settings ?? {}
  })
  const worker = await mountWorker(main, { host })
  return { worker, w, host }
}

async function until(fn, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition never held')
}

async function macrotask() {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

async function ticked(worker) {
  return until(async () => {
    const vm = await worker.request('view.read')
    return [...vm.rows, ...vm.idle].some((r) => r.key === SPIKE) ? vm : null
  })
}

async function done(worker) {
  try {
    for (const name of FORBIDDEN) assert.equal(worker.host.callsOf(name).length, 0, name + ' was called')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    main.setTestDeps(null)
  }
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, err.message)
    return true
  })
}

function openCards(vm, key) {
  return vm.chat.filter((c) => c.kind === 'card' && c.card && c.card.key === key && c.card.resolved === null).map((c) => c.card)
}

function guardedSettings(over = {}) {
  return {
    settings: { orchestratorAgent: 'claude' },
    storage: {
      agents: {
        [SPIKE]: agent('waiting', 'term_spike', { sessionId: 's1' }),
        [BUILD]: agent('working', 'term_build')
      }
    },
    ...over
  }
}

test('worker mounts, Orca refuses none of its calls, and view.read answers firstRun', async () => {
  const { worker, w } = await mount()
  try {
    assert.deepEqual(worker.refusals, [])
    const vm = await worker.request('view.read')
    assert.equal(vm.firstRun, true)
    const bars = worker.host.callsOf('statusBar.update')
    assert.ok(bars.length >= 1)
    assert.equal(bars[0].id, 'needs')
    assert.equal(bars[0].visible, false)
    assert.equal(worker.host.callsOf('agent.launch').length, 0)
    assert.equal(w.orcaRuns(['worktree', 'list']).length, 0)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await done(worker)
  }
})

test('agent.tool.before denies a merge from a guarded session without any run or host call', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const runs = w.runs.length
    const calls = worker.host.calls.length
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.reason, main.DENY_TEXT)
    assert.equal(decision.reason, "Merging, force-pushing and pushing to main are Aamon's alone. Leave the PR open and report that it is ready.")
    assert.equal(w.runs.length, runs)
    assert.equal(worker.host.calls.length, calls)
    await macrotask()
    const vm = await worker.request('view.read')
    const cards = openCards(vm, SPIKE).filter((c) => c.kind === 'merge-blocked')
    assert.equal(cards.length, 1)
    assert.match(cards[0].detail, /gh pr merge 1/)
    assert.equal(vm.guard.blocksToday, 1)

    const orch = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: WS, terminalId: 'term_orch', tool: 'Bash', input: { command: 'git push origin main' } })
    assert.equal(orch.kind, 'deny')

    const mine = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: BUILD_WT, terminalId: 'term_build', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(mine.kind, 'continue')

    const harmless = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'git push origin feat/x' } })
    assert.equal(harmless.kind, 'continue')
  } finally {
    await done(worker)
  }
})

test('agent.tool.before passes a guarded merge when the guard setting is off', async () => {
  const { worker } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const saved = await worker.request('settings.save', { guard: false })
    assert.equal(saved.guard, false)
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(decision.kind, 'continue')
    const vm = await worker.request('view.read')
    assert.equal(vm.guard.on, false)
  } finally {
    await done(worker)
  }
})

test('a hook never throws: a broken clock still denies the merge and nothing is logged by the harness', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const logs = worker.logs.length
    w.throwNow = true
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    const after = await worker.hooks.fire('agent.tool.after', { agent: 'codex', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'git push -f' } })
    await macrotask()
    w.throwNow = false
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.reason, main.DENY_TEXT)
    assert.equal(after.kind, 'continue')
    assert.equal(worker.logs.length, logs)
  } finally {
    w.throwNow = false
    await done(worker)
  }
})

test('agent.tool.after from a guarded codex session reports a force-push as attempted', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const before = await worker.hooks.fire('agent.tool.before', { agent: 'codex', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'git push -f' } })
    assert.equal(before.kind, 'continue')
    const runs = w.runs.length
    const calls = worker.host.calls.length
    await worker.hooks.fire('agent.tool.after', { agent: 'codex', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'git push -f' } })
    assert.equal(w.runs.length, runs)
    assert.equal(worker.host.calls.length, calls)
    await macrotask()
    const vm = await worker.request('view.read')
    const cards = openCards(vm, SPIKE).filter((c) => c.kind === 'merge-blocked')
    assert.equal(cards.length, 1)
    assert.match(cards[0].detail, /attempted/)
    assert.equal(vm.guard.blocksToday, 0)
  } finally {
    await done(worker)
  }
})

test('agent.tool.before keeps working past the kind cap and the newest terminal keeps its kind', async () => {
  const { worker } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const started = Date.now()
    for (let n = 0; n < 450; n++) {
      const out = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: BUILD_WT, terminalId: 'term_flood_' + n, tool: 'Bash', input: { command: 'ls' } })
      assert.equal(out.kind, 'continue')
    }
    await worker.hooks.fire('agent.tool.before', { agent: 'codex', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'ls' } })
    assert.ok(Date.now() - started < 20_000)
    await worker.emit('agent.status.changed', { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, paneKey: 'a:b', terminalId: 'term_spike', state: 'working', receivedAt: T0 + 9 })
    const stored = await until(() => {
      const agents = worker.host.data().storage.agents
      return agents && agents[SPIKE] && agents[SPIKE].state === 'working' ? agents : null
    })
    assert.equal(stored[SPIKE].kind, 'codex')
  } finally {
    await done(worker)
  }
})

test('agent.status.changed waiting flushes a queued message once by terminal send with enter', async () => {
  const queue = [{ id: 'q1', key: SPIKE, subject: 'S', body: 'B', at: T0 }]
  const { worker, w } = await mount(guardedSettings({ storage: { queue, agents: { [SPIKE]: agent('working', 'term_spike', { sessionId: 's1' }) } } }))
  try {
    await ticked(worker)
    const ev = { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, paneKey: 'a:b', terminalId: 'term_spike', state: 'waiting', receivedAt: T0, sessionId: 's1' }
    await worker.emit('agent.status.changed', ev)
    await worker.emit('agent.status.changed', { ...ev, receivedAt: T0 + 1 })
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.equal(sends.length, 1)
    assert.deepEqual(sends[0].slice(1), ['terminal', 'send', '--terminal', 'term_spike', '--text=S\n\nB', '--enter', '--json'])
  } finally {
    await done(worker)
  }
})

test('agent.status.changed waiting sends nothing while the session row says permission', async () => {
  const queue = [{ id: 'q1', key: SPIKE, subject: 'S', body: 'B', at: T0 }]
  const { worker, w, host } = await mount(guardedSettings({ storage: { queue, agents: { [SPIKE]: agent('working', 'term_spike') } } }))
  try {
    await ticked(worker)
    host.respond('workspace.list', workspaces({ [SPIKE]: 'permission' }))
    await worker.emit('agent.status.changed', { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, paneKey: 'a:b', terminalId: 'term_spike', state: 'waiting', receivedAt: T0 })
    assert.equal(w.orcaRuns(['terminal', 'send']).length, 0)
  } finally {
    await done(worker)
  }
})

test('agent.status.changed finds a session by workspaceListId, keeps its terminal, and records a chat id', async () => {
  const { worker } = await mount(guardedSettings())
  try {
    await ticked(worker)
    await worker.emit('agent.status.changed', { workspaceId: null, workspaceListId: SPIKE_LIST, paneKey: 'a:b', state: 'working', receivedAt: T0 + 5 })
    const stored = await until(() => {
      const agents = worker.host.data().storage.agents
      return agents && agents[SPIKE] && agents[SPIKE].state === 'working' ? agents : null
    })
    assert.equal(stored[SPIKE].terminalId, 'term_spike')
    await worker.emit('agent.status.changed', { workspaceId: null, workspaceListId: ROOT_LIST, paneKey: 'structured-agent-session-claude_x:uuid-1', state: 'working', receivedAt: T0 + 6 })
    const chat = await until(() => {
      const agents = worker.host.data().storage.agents
      return agents && agents[ROOT] ? agents[ROOT] : null
    })
    assert.equal(chat.chatId, 'claude_x')
    assert.equal(chat.terminalId, null)
    assert.equal(chat.kind, 'claude')
  } finally {
    await done(worker)
  }
})

test('row.detail terminal returns the screen tail, a worker-read for a dispatch, and the chat line otherwise', async () => {
  const { worker } = await mount(guardedSettings({
    storage: {
      agents: {
        [SPIKE]: agent('waiting', 'term_spike'),
        [ROOT]: agent('waiting', null, { chatId: 'claude_x' })
      }
    }
  }))
  try {
    await ticked(worker)
    const screen = await worker.request('row.detail', { key: SPIKE, tab: 'terminal' })
    assert.deepEqual(screen, { lines: PROMPT.terminal.tail })
    const chat = await worker.request('row.detail', { key: ROOT, tab: 'terminal' })
    assert.deepEqual(chat, { lines: ['This session is a chat. It has no terminal to show.'] })
    const orch = await worker.request('row.detail', { key: 'orchestrator', tab: 'terminal' })
    assert.ok(Array.isArray(orch.lines))
    await rejectsWith(worker.request('row.detail', { key: '/no/such', tab: 'terminal' }), 'invalid_params')
    await rejectsWith(worker.request('row.detail', { key: SPIKE, tab: 'nope' }), 'invalid_params')
  } finally {
    await done(worker)
  }
})

test('row.detail terminal reads a dispatched worker with no terminal through worker-read', async () => {
  const { worker, w } = await mount(guardedSettings({ storage: { agents: { [SPIKE]: agent('waiting', null) } } }))
  try {
    await ticked(worker)
    const res = await worker.request('row.detail', { key: SPIKE, tab: 'terminal' })
    assert.deepEqual(res, { lines: ['line one', 'line two'] })
    const reads = w.orcaRuns(['orchestration', 'worker-read'])
    assert.deepEqual(reads[0].slice(1), ['orchestration', 'worker-read', '--dispatch', SPIKE_DISPATCH, '--source', 'auto', '--json'])
  } finally {
    await done(worker)
  }
})

test('the status bar stays hidden while nothing needs Aamon', async () => {
  const { worker } = await mount(guardedSettings())
  try {
    const vm = await ticked(worker)
    assert.equal(vm.needs + vm.asks, 0)
    const bars = worker.host.callsOf('statusBar.update')
    assert.ok(bars.length >= 1)
    assert.equal(bars.every((b) => b.visible === false), true)
  } finally {
    await done(worker)
  }
})

test('one approval card and one unanswered question show 2 need you on the status bar', async () => {
  const setup = guardedSettings({ storage: { agents: { [SPIKE]: agent('blocked', 'term_spike') } } })
  const w = world()
  w.fs.files.set(HOME + '/outbox/1-1.msg', 'question\nYes|No\nShip it?')
  const { worker } = await mountWith(w, setup)
  try {
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return v.needs === 1 && v.asks === 1 ? v : null
    })
    assert.equal(vm.needs + vm.asks, 2)
    const bars = worker.host.callsOf('statusBar.update')
    assert.equal(bars[0].visible, false)
    const last = bars[bars.length - 1]
    assert.equal(last.visible, true)
    assert.equal(last.text, '2 need you')
    assert.ok(worker.posts.some((p) => p.event === 'view' && typeof p.payload.rev === 'number' && p.payload.rev > 0))
  } finally {
    await done(worker)
  }
})

function bashScreen(command) {
  return {
    terminal: {
      handle: 'term_spike',
      source: 'screen',
      tail: ['', '╭──────────────────────────────╮', '│ Bash command                 │', '│                              │', '│   ' + command, '│   Run it                     │', '│                              │', '│ Do you want to proceed?      │', '│ ❯ 1. Yes                     │', '│   2. No (esc)                │', '╰──────────────────────────────╯', '']
    }
  }
}

async function commandCard(worker, w, host, command) {
  await ticked(worker)
  await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command } })
  host.respond('workspace.list', workspaces({ [SPIKE]: 'permission' }))
  await worker.request('row.act', { key: SPIKE, action: 'retry' })
  const vm = await until(async () => {
    const v = await worker.request('view.read')
    return openCards(v, SPIKE).some((c) => c.kind === 'approval') ? v : null
  })
  return openCards(vm, SPIKE).find((c) => c.kind === 'approval')
}

async function mountWith(w, o) {
  main.setTestDeps({ deps: w.deps, id: () => 'id' + Math.random().toString(36).slice(2), wait: async () => { if (w.onWait) await w.onWait() }, alive: async () => true })
  const storage = { orch: orchRecord(), ...(o.storage ?? {}) }
  const host = mockHost({
    results: { 'workspace.list': o.workspaces ?? workspaces(), 'agent.launch': { terminalId: 'term_orch' }, ...(o.results ?? {}) },
    storage,
    settings: o.settings ?? {}
  })
  const worker = await mountWorker(main, { host })
  return { worker, w, host }
}

test('row.act remove needs confirmed: true, a known key, and never removes a main worktree or the home', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'remove' }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'remove', confirmed: 'yes' }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: ROOT, action: 'remove', confirmed: true }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: 'orchestrator', action: 'remove', confirmed: true }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: HOME, action: 'remove', confirmed: true }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: '/no/such', action: 'remove', confirmed: true }), 'invalid_params')
    assert.equal(w.orcaRuns(['worktree', 'rm']).length, 0)
    await worker.request('row.act', { key: SPIKE, action: 'remove', confirmed: true })
    const rm = w.orcaRuns(['worktree', 'rm'])
    assert.equal(rm.length, 1)
    assert.deepEqual(rm[0].slice(1), ['worktree', 'rm', '--worktree', 'id:' + SPIKE_WT, '--json'])
  } finally {
    await done(worker)
  }
})

test('idle.clear needs confirmed: true and removes only idle worktrees that are not a main checkout or the home', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    await rejectsWith(worker.request('idle.clear', {}), 'invalid_params')
    assert.equal(w.orcaRuns(['worktree', 'rm']).length, 0)
    const view = await worker.request('view.read', {})
    const spare = view.idle.filter((r) => r.removable)
    const keptRows = [...view.idle, ...view.rows].filter((r) => r.key === ROOT || r.key === HOME)
    assert.ok(spare.length > 0)
    assert.ok(keptRows.every((r) => r.removable === false))
    const res = await worker.request('idle.clear', { confirmed: true })
    assert.equal(res.removed, spare.length)
    const ids = w.orcaRuns(['worktree', 'rm']).map((run) => run[4])
    assert.equal(ids.length, spare.length)
    assert.ok(ids.includes('id:' + SPIKE_WT))
  } finally {
    await done(worker)
  }
})

test('row.act validates its input, stops a dispatched worker and refuses to stop a hand-started one', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    await rejectsWith(worker.request('row.act', [SPIKE]), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'merge' }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'message' }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'message', text: 'x'.repeat(16385) }), 'invalid_params')
    await rejectsWith(worker.request('row.act', { key: SPIKE, action: 'autofix-ci', on: 'no' }), 'invalid_params')
    await worker.request('row.act', { key: SPIKE, action: 'stop' })
    const stops = w.orcaRuns(['orchestration', 'worker-stop'])
    assert.deepEqual(stops[0].slice(1), ['orchestration', 'worker-stop', '--dispatch', SPIKE_DISPATCH, '--json'])
    await rejectsWith(worker.request('row.act', { key: BUILD, action: 'stop' }), 'conflict')
    await worker.request('row.act', { key: SPIKE, action: 'autofix-ci', on: false })
    const vm = await worker.request('view.read')
    const row = [...vm.rows, ...vm.idle].find((r) => r.key === SPIKE)
    assert.equal(row.autoFix.ci, false)
  } finally {
    await done(worker)
  }
})

test('row.act message sends through delivery to an idle session', async () => {
  const { worker, w } = await mount(guardedSettings({ workspaces: workspaces({ [BUILD]: 'active' }), storage: { agents: { [BUILD]: agent('waiting', 'term_build') } } }))
  try {
    await ticked(worker)
    const res = await worker.request('row.act', { key: BUILD, action: 'message', text: 'hello' })
    assert.deepEqual(res, { result: 'sent' })
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.deepEqual(sends[0].slice(1), ['terminal', 'send', '--terminal', 'term_build', '--text=From Aamon\n\nhello', '--enter', '--json'])
  } finally {
    await done(worker)
  }
})

test('a second message queued after a send goes out once after a working then a waiting status event', async () => {
  const { worker, w } = await mount(guardedSettings({ workspaces: workspaces({ [BUILD]: 'active' }), storage: { agents: { [BUILD]: agent('waiting', 'term_build') } } }))
  try {
    await ticked(worker)
    assert.deepEqual(await worker.request('row.act', { key: BUILD, action: 'message', text: 'one' }), { result: 'sent' })
    assert.deepEqual(await worker.request('row.act', { key: BUILD, action: 'message', text: 'two' }), { result: 'queued' })
    const bodies = () => w.orcaRuns(['terminal', 'send']).map((r) => r[5])
    assert.deepEqual(bodies(), ['--text=From Aamon\n\none'])
    const ev = { workspaceId: BUILD_WT, paneKey: 'a:b', terminalId: 'term_build', state: 'working', receivedAt: T0 + 1 }
    await worker.emit('agent.status.changed', ev)
    assert.deepEqual(bodies(), ['--text=From Aamon\n\none'])
    await worker.emit('agent.status.changed', { ...ev, state: 'waiting', receivedAt: T0 + 2 })
    assert.deepEqual(bodies(), ['--text=From Aamon\n\none', '--text=From Aamon\n\ntwo'])
    await worker.emit('agent.status.changed', { ...ev, state: 'waiting', receivedAt: T0 + 3 })
    assert.equal(bodies().length, 2)
  } finally {
    await done(worker)
  }
})

test('right after a restart, a restored guarded id is denied a merge before the session index is built', async () => {
  const restored = 'repo-restored::/restored/worktree'
  let release = null
  const { worker } = await mount({
    settings: { orchestratorAgent: 'claude' },
    storage: { guarded: [restored] },
    run: async (cmd, args) => {
      if (cmd === '/x/orca' && args[0] === 'worktree' && args[1] === 'list') {
        return new Promise((resolve) => {
          release = () => resolve(envelope(WORKTREES))
        })
      }
      return null
    }
  })
  try {
    await worker.request('view.read')
    const denied = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: restored, tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.reason, main.DENY_TEXT)
    const unknown = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: 'repo-x::/unknown', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(unknown.kind, 'continue')
  } finally {
    if (release) release()
    await done(worker)
  }
})

test('card.act allow resolves the card when the agent leaves blocked, else says Pick an answer below', async () => {
  const { worker, w, host } = await mount(guardedSettings({ storage: { agents: { [SPIKE]: agent('waiting', 'term_spike') } } }))
  try {
    const card = await commandCard(worker, w, host, 'gh pr list')
    assert.deepEqual(card.actions, ['allow', 'deny', 'peek'])
    assert.equal(card.detail, 'wants to run: gh pr list')
    for (let i = 0; i < 4; i += 1) w.screens.push(bashScreen('gh pr list'))
    let emitted = false
    w.onWait = async () => {
      if (emitted) return
      emitted = true
      await worker.emit('agent.status.changed', { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, paneKey: 'a:b', terminalId: 'term_spike', state: 'working', receivedAt: T0 + 10 })
    }
    const res = await worker.request('card.act', { id: card.id, action: 'allow' })
    assert.deepEqual(res, { result: 'answered' })
    const keys = w.orcaRuns(['terminal', 'send'])
    assert.equal(keys.length, 1)
    assert.deepEqual(keys[0].slice(1), ['terminal', 'send', '--terminal', 'term_spike', '--text=1', '--json'])
    const after = await worker.request('view.read')
    assert.equal(openCards(after, SPIKE).filter((c) => c.kind === 'approval').length, 0)
    void host
  } finally {
    await done(worker)
  }
})

test('card.act allow on an agent that stays blocked sets the card detail to Pick an answer below', async () => {
  const { worker, w, host } = await mount(guardedSettings({ storage: { agents: { [SPIKE]: agent('waiting', 'term_spike') } } }))
  try {
    const card = await commandCard(worker, w, host, 'gh pr list')
    for (let i = 0; i < 4; i += 1) w.screens.push(bashScreen('gh pr list'))
    const res = await worker.request('card.act', { id: card.id, action: 'allow' })
    assert.deepEqual(res, { result: 'use-peek' })
    const keys = w.orcaRuns(['terminal', 'send'])
    assert.equal(keys.length, 1)
    assert.deepEqual(keys[0].slice(1), ['terminal', 'send', '--terminal', 'term_spike', '--text=1', '--json'])
    const after = await worker.request('view.read')
    const still = openCards(after, SPIKE).find((c) => c.kind === 'approval')
    assert.equal(still.detail, 'Pick an answer below')
  } finally {
    await done(worker)
  }
})

test('card.act deny on a waiting session at permission resolves the card and the next tick adds none', async () => {
  const perm = workspaces({ [SPIKE]: 'permission' })
  const { worker, w } = await mount(guardedSettings({ workspaces: perm, storage: { agents: { [SPIKE]: agent('waiting', 'term_spike') } }, screens: [] }))
  try {
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return openCards(v, SPIKE).some((c) => c.kind === 'approval') ? v : null
    })
    const card = openCards(vm, SPIKE).find((c) => c.kind === 'approval')
    w.screens.push(PROMPT, DENIED)
    const res = await worker.request('card.act', { id: card.id, action: 'deny' })
    assert.deepEqual(res, { result: 'answered' })
    const keys = w.orcaRuns(['terminal', 'send'])
    assert.deepEqual(keys[0].slice(1), ['terminal', 'send', '--terminal', 'term_spike', '--text=\u001b', '--json'])
    const resolved = (await worker.request('view.read')).chat.filter((c) => c.card && c.card.id === card.id)
    assert.ok(resolved.every((c) => c.card.resolved !== null))
    w.t += 5000
    await worker.request('row.act', { key: SPIKE, action: 'retry' })
    const next = await worker.request('view.read')
    assert.equal(openCards(next, SPIKE).filter((c) => c.kind === 'approval').length, 0)
    assert.equal(worker.host.data().storage.agents[SPIKE].permissionMasked, true)
  } finally {
    await done(worker)
  }
})

test('card.act validates the card and action, and peek or details opens the session', async () => {
  const perm = workspaces({ [SPIKE]: 'permission' })
  const { worker } = await mount(guardedSettings({ workspaces: perm, storage: { agents: { [SPIKE]: agent('waiting', 'term_spike') } } }))
  try {
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return openCards(v, SPIKE).some((c) => c.kind === 'approval') ? v : null
    })
    const card = openCards(vm, SPIKE).find((c) => c.kind === 'approval')
    assert.deepEqual(await worker.request('card.act', { id: card.id, action: 'peek' }), { open: SPIKE })
    await rejectsWith(worker.request('card.act', { id: 'approval:/no/such', action: 'peek' }), 'invalid_params')
    await rejectsWith(worker.request('card.act', { id: card.id, action: 'retry' }), 'invalid_params')
    await rejectsWith(worker.request('card.act', { id: card.id, action: 'toString' }), 'invalid_params')
    await rejectsWith(worker.request('card.act', { id: card.id }), 'invalid_params')
  } finally {
    await done(worker)
  }
})

test('peek.key sends only named keys, without enter, and rejects other names', async () => {
  const { worker, w } = await mount(guardedSettings({ storage: { agents: { [SPIKE]: agent('waiting', 'term_spike'), [ROOT]: agent('waiting', null, { chatId: 'c' }) } } }))
  try {
    await ticked(worker)
    await rejectsWith(worker.request('peek.key', { key: SPIKE, name: 'nope' }), 'invalid_params')
    await rejectsWith(worker.request('peek.key', { key: SPIKE, name: 'constructor' }), 'invalid_params')
    await rejectsWith(worker.request('peek.key', { key: '/no/such', name: 'esc' }), 'invalid_params')
    assert.equal(w.orcaRuns(['terminal', 'send']).length, 0)
    await worker.request('peek.key', { key: SPIKE, name: 'esc' })
    await worker.request('peek.key', { key: 'orchestrator', name: 'enter' })
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.deepEqual(sends[0].slice(1), ['terminal', 'send', '--terminal', 'term_spike', '--text=\u001b', '--json'])
    assert.deepEqual(sends[1].slice(1), ['terminal', 'send', '--terminal', 'term_orch', '--text=\r', '--json'])
    assert.ok(sends.every((r) => !r.includes('--enter')))
    await rejectsWith(worker.request('peek.key', { key: ROOT, name: 'esc' }), 'conflict')
  } finally {
    await done(worker)
  }
})

test('settings.save reads with {}, validates every key and value, and rewrites the home on a suffix change', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const all = await worker.request('settings.save', {})
    assert.deepEqual(all, { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa', intervalSec: 60, attempts: 3, escalations: 2, guard: true, onCi: 'fix', onConflict: 'fix', onReview: 'fix', noAgent: 'start', scope: 'all', model: '', effort: '', fast: false, plan: false, permissionMode: '' })
    for (const bad of [{ intervalSec: 7 }, { attempts: 4 }, { escalations: 4 }, { escalations: '2' }, { guard: 'yes' }, { onCi: 'maybe' }, { onConflict: true }, { onReview: '' }, { noAgent: 'ignore' }, { scope: 'mine' }, { autoFixYours: true }, { workerAgent: 'nope' }, { model: 'gpt' }, { effort: 'max' }, { permissionMode: 'plan' }, { fast: 'on' }, { plan: 1 }, { suffix: 'a b' }, { suffix: 'x'.repeat(40) }, { orchestratorAgent: 3 }]) {
      await rejectsWith(worker.request('settings.save', bad), 'invalid_params')
    }
    await rejectsWith(worker.request('settings.save', [1]), 'invalid_params')
    await rejectsWith(worker.request('settings.save', { bogus: 1 }), 'invalid_params')
    await rejectsWith(worker.request('settings.save', { intervalSec: 120, workerAgent: 'codex', suffix: '-zz', unknown: 1 }), 'invalid_params')
    assert.deepEqual(await worker.request('settings.save', {}), all)
    assert.equal('intervalSec' in worker.host.data().settings, false)
    const next = await worker.request('settings.save', { intervalSec: 120, workerAgent: 'codex', suffix: '-zz' })
    assert.deepEqual(next, { orchestratorAgent: 'claude', workerAgent: 'codex', suffix: '-zz', intervalSec: 120, attempts: 3, escalations: 2, guard: true, onCi: 'fix', onConflict: 'fix', onReview: 'fix', noAgent: 'start', scope: 'all', model: '', effort: '', fast: false, plan: false, permissionMode: '' })
    const modes = await worker.request('settings.save', { onCi: 'ask', onConflict: 'ignore', onReview: 'ask', noAgent: 'ask', scope: 'workers' })
    assert.deepEqual({ onCi: modes.onCi, onConflict: modes.onConflict, onReview: modes.onReview, noAgent: modes.noAgent, scope: modes.scope }, { onCi: 'ask', onConflict: 'ignore', onReview: 'ask', noAgent: 'ask', scope: 'workers' })
    assert.equal(worker.host.data().settings.onConflict, 'ignore')
    const stored = worker.host.data().settings
    assert.equal(stored.intervalSec, 120)
    assert.equal(stored.suffix, '-zz')
    assert.equal('unknown' in stored, false)
    const agents = w.fs.files.get(HOME + '/AGENTS.md')
    assert.ok(agents.includes('-zz'))
    assert.ok(agents.includes('--agent codex'))
    await worker.request('settings.save', { model: 'opus', effort: 'high', permissionMode: 'auto', fast: true })
    const claude = JSON.parse(w.fs.files.get(HOME + '/.claude/settings.json'))
    assert.deepEqual([claude.model, claude.effortLevel, claude.permissions.defaultMode, claude.fastMode], ['opus', 'high', 'auto', true])
    assert.ok(!w.fs.files.get(HOME + '/AGENTS.md').includes('--model'))
    await worker.request('settings.save', { plan: true, workerAgent: '' })
    assert.equal(JSON.parse(w.fs.files.get(HOME + '/.claude/settings.json')).permissions.defaultMode, 'auto')
    assert.ok(w.fs.files.get(HOME + '/AGENTS.md').includes('## Plan mode is on'))
    assert.ok(w.fs.files.get(HOME + '/AGENTS.md').includes('--agent claude --model opus --effort high'))
    const vm = await worker.request('view.read')
    assert.equal(vm.intervalSec, 120)
  } finally {
    await done(worker)
  }
})

test('row.detail status, the diff and pr.url read the session PR', async () => {
  const { worker } = await mount(guardedSettings({ prs: [spikePr()] }))
  try {
    await until(async () => {
      const vm = await worker.request('view.read')
      return [...vm.rows, ...vm.idle].some((r) => r.key === SPIKE && r.pr === 7)
    })
    const res = await worker.request('row.detail', { key: SPIKE, tab: 'status' })
    assert.ok(Array.isArray(res.status.checks) && res.status.checks.length > 0)
    assert.ok(Array.isArray(res.status.threads))
    assert.equal(res.status.attempts.max, 3)
    assert.equal(res.status.maxAttempts, 3)
    assert.equal(typeof res.status.attempts.used, 'number')
    const none = await worker.request('row.detail', { key: BUILD, tab: 'status' })
    assert.deepEqual(none, { status: { checks: [], threads: [], attempts: { used: 0, max: 3 }, maxAttempts: 3, lastSent: null } })
    assert.deepEqual(await worker.request('row.detail', { key: SPIKE, tab: 'diff' }), { diff: 'diff --git a/x b/x\n' })
    assert.deepEqual(await worker.request('row.detail', { key: BUILD, tab: 'diff' }), { diff: '' })
    assert.deepEqual(await worker.request('pr.url', { key: SPIKE }), { url: 'https://github.com/aamonnaig4/orca-plugins/pull/7' })
    await rejectsWith(worker.request('pr.url', { key: '/no/such' }), 'invalid_params')
  } finally {
    await done(worker)
  }
})

test('chat.send adds the message and says it; an oversized one is rejected', async () => {
  const { worker, w } = await mount(guardedSettings())
  try {
    await ticked(worker)
    await rejectsWith(worker.request('chat.send', { text: 'x'.repeat(16385) }), 'invalid_params')
    await rejectsWith(worker.request('chat.send', { text: 5 }), 'invalid_params')
    const res = await worker.request('chat.send', { text: 'Close out my open PRs' })
    assert.equal(res, 'sent')
    const vm = await worker.request('view.read')
    assert.ok(vm.chat.some((c) => c.from === 'you' && c.text === 'Close out my open PRs'))
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.deepEqual(sends[0].slice(1), ['terminal', 'send', '--terminal', 'term_orch', '--text=From Aamon\n\nClose out my open PRs', '--enter', '--json'])
  } finally {
    await done(worker)
  }
})

test('chat.attach saves a file to the inbox and chat.send passes its path to the orchestrator', async () => {
  const files = new Map()
  const attach = { dir: () => '/inbox', async save(p, b) { files.set(p, b) }, async exists(p) { return files.has(p) } }
  const { worker, w } = await mount(guardedSettings({ seam: { attach } }))
  try {
    await ticked(worker)
    const saved = await worker.request('chat.attach', { name: '../shot.png', data: Buffer.from('png').toString('base64') })
    assert.equal(saved.name, 'shot.png')
    assert.match(saved.path, /^\/inbox\/\d+-[a-z0-9]+-shot\.png$/)
    assert.equal(Buffer.from(files.get(saved.path)).toString(), 'png')
    await rejectsWith(worker.request('chat.attach', { name: 'x', data: '***' }), 'invalid_params')
    await rejectsWith(worker.request('chat.attach', { name: 'x', data: 4 }), 'invalid_params')
    await rejectsWith(worker.request('chat.send', { text: 'hi', files: ['/etc/passwd'] }), 'invalid_params')
    await rejectsWith(worker.request('chat.send', { text: 'hi', files: ['/inbox/missing'] }), 'invalid_params')
    assert.equal(await worker.request('chat.send', { files: [saved.path] }), 'sent')
    const vm = await worker.request('view.read')
    assert.ok(vm.chat.some((c) => c.from === 'you' && c.text === 'Attached: shot.png'))
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.equal(sends[sends.length - 1][5], '--text=From Aamon\n\nAttached files:\n- ' + saved.path)
  } finally {
    await done(worker)
  }
})

test('chat.send rejects with a readable message when the orchestrator cannot be started', async () => {
  const { worker } = await mount({
    settings: { orchestratorAgent: 'claude' },
    orch: false,
    results: { 'agent.launch': () => { throw hostError('action_failed', 'agent not installed') } }
  })
  try {
    await assert.rejects(worker.request('chat.send', { text: 'hi' }), (err) => {
      assert.match(err.message, /could not be started/)
      return true
    })
  } finally {
    await done(worker)
  }
})

test('chat.answer marks the question answered and sends the option to the orchestrator', async () => {
  const w = world()
  w.fs.files.set(HOME + '/outbox/1-1.msg', 'question\nYes|No\nShip it?')
  const { worker } = await mountWith(w, guardedSettings())
  try {
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return v.asks === 1 ? v : null
    })
    const q = vm.chat.find((c) => c.kind === 'question')
    await rejectsWith(worker.request('chat.answer', { id: q.id, option: 'Maybe' }), 'invalid_params')
    await rejectsWith(worker.request('chat.answer', { id: 'nope', option: 'Yes' }), 'invalid_params')
    await worker.request('chat.answer', { id: q.id, option: 'Yes' })
    const after = await worker.request('view.read')
    assert.equal(after.chat.find((c) => c.id === q.id).answered, 'Yes')
    assert.equal(after.asks, 0)
    const sends = w.orcaRuns(['terminal', 'send'])
    assert.deepEqual(sends[sends.length - 1].slice(1), ['terminal', 'send', '--terminal', 'term_orch', '--text=From Aamon\n\nYes', '--enter', '--json'])
    await rejectsWith(worker.request('chat.answer', { id: q.id, option: 'No' }), 'conflict')
  } finally {
    await done(worker)
  }
})

test('firstrun.save validates the agent, saves it, starts the orchestrator and the watcher', async () => {
  const { worker, w } = await mount()
  try {
    await rejectsWith(worker.request('firstrun.save', { agent: 'nope' }), 'invalid_params')
    await rejectsWith(worker.request('firstrun.save', {}), 'invalid_params')
    await worker.request('firstrun.save', { agent: 'claude' })
    assert.equal(worker.host.data().settings.orchestratorAgent, 'claude')
    assert.equal(worker.host.callsOf('agent.launch').length, 1)
    const first = await worker.request('view.read')
    assert.equal(first.firstRun, false)
    assert.equal(first.chat.some((c) => /takes effect the next time/.test(c.text)), false)
    await until(() => w.orcaRuns(['worktree', 'list']).length > 0)
    const list = await worker.request('agents.list')
    assert.equal(list[0].id, 'claude')
    assert.equal(list[0].installed, true)
  } finally {
    await done(worker)
  }
})

test('dev.seed makes view.read return the given view model and rejects other shapes', async () => {
  const { worker } = await mount()
  try {
    const seed = { rev: 9, firstRun: false, orch: null, chat: [{ id: 'x', at: 1, from: 'orchestrator', kind: 'text', text: 'hi' }], queued: 0, rows: [], idle: [], needs: 0, asks: 0, gh: { ok: true }, watching: 0, intervalSec: 60, hooksOff: false, guard: { on: true, blocksToday: 0 } }
    await worker.request('view.read')
    const calls = worker.host.calls.length
    await worker.request('dev.seed', seed)
    assert.equal(worker.host.calls.length, calls)
    assert.deepEqual(await worker.request('view.read'), seed)
    await rejectsWith(worker.request('dev.seed', { rows: 'x' }), 'invalid_params')
  } finally {
    await done(worker)
  }
})

test('activation survives a failing bin lookup, CLI load and storage, and view.read still answers', async () => {
  const { worker } = await mount({
    settings: { orchestratorAgent: 'claude' },
    orch: false,
    run: async (cmd, args) => {
      if (cmd === '/bin/zsh') throw new Error('no shell')
      if (args[0] === 'agent-context') return { code: 1, stdout: '', stderr: 'broken', missing: false }
      return null
    },
    results: { 'storage.get': () => { throw hostError('unavailable', 'storage down') } }
  })
  try {
    const vm = await worker.request('view.read')
    assert.equal(vm.firstRun, false)
    assert.deepEqual(vm.gh, { ok: false, reason: 'missing' })
    assert.equal(vm.hooksOff, true)
    assert.ok(worker.logs.some((l) => /orca and gh/.test(l)))
    assert.ok(worker.logs.some((l) => /agent-context/.test(l)))
    const settings = await worker.request('settings.save', {})
    assert.equal(settings.orchestratorAgent, 'claude')
  } finally {
    await done(worker)
  }
})

test('activation does not wait on a hung shell: mount resolves and view.read answers', async () => {
  const { worker } = await mount({
    readyMs: 20,
    run: async (cmd) => (cmd === '/bin/zsh' ? new Promise(() => {}) : null)
  })
  try {
    const vm = await worker.request('view.read')
    assert.equal(vm.firstRun, true)
  } finally {
    await done(worker)
  }
})

test('deactivate stops the watcher timer', async () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set()
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSet(fn, ms, ...rest)
    if (ms >= 30000) live.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    live.delete(handle)
    return realClear(handle)
  }
  let worker
  try {
    const mounted = await mount(guardedSettings())
    worker = mounted.worker
    await ticked(worker)
    await until(() => live.size > 0)
    await worker.deactivate()
    worker = null
    assert.equal(live.size, 0)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    if (worker) await worker.deactivate()
    main.setTestDeps(null)
  }
})

test('agent.tool.before still denies a guarded merge when noteTool throws', async () => {
  const { worker } = await mount(guardedSettings({
    seam: { watcher: (real) => ({ ...real, noteTool() { throw new Error('noteTool broke') } }) }
  }))
  try {
    await ticked(worker)
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.reason, main.DENY_TEXT)
  } finally {
    await done(worker)
  }
})

test('the orchestrator workspace is guarded right after firstrun.save, before any tick finishes', async () => {
  let release = null
  const { worker, w } = await mount({
    run: async (cmd, args) => {
      if (cmd === '/x/orca' && args[0] === 'worktree' && args[1] === 'list') {
        return new Promise((resolve) => {
          release = () => resolve(envelope(WORKTREES))
        })
      }
      return null
    }
  })
  try {
    await worker.request('firstrun.save', { agent: 'claude' })
    const record = worker.host.data().storage.orch
    assert.ok(record && record.workspaceId)
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: record.workspaceId, tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(decision.kind, 'deny')
    assert.equal(w.orcaRuns(['worktree', 'list']).length, 1)
  } finally {
    if (release) release()
    await done(worker)
  }
})

test('an orchestrator-started session the index knows is guarded at once, and a tick is requested', async () => {
  const guardCalls = []
  const { worker, w } = await mount(guardedSettings({
    seam: {
      watcher: (real) => ({
        ...real,
        guarded: () => new Set(),
        guardNow: (ids) => {
          guardCalls.push(ids)
        }
      })
    }
  }))
  try {
    await ticked(worker)
    await macrotask()
    const lists = w.orcaRuns(['worktree', 'list']).length
    const decision = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: SPIKE_WT, terminalId: 'term_spike', tool: 'Bash', input: { command: 'gh pr merge 1' } })
    assert.equal(decision.kind, 'deny')
    assert.equal(guardCalls.length, 1)
    assert.ok(guardCalls[0].includes(SPIKE_WT))
    await until(() => w.orcaRuns(['worktree', 'list']).length > lists)
    const plain = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: BUILD_WT, terminalId: 'term_build', tool: 'Bash', input: { command: 'ls' } })
    assert.equal(plain.kind, 'continue')
    assert.ok(guardCalls.every((ids) => !ids.includes(BUILD_WT)))
    const count = guardCalls.length
    await worker.emit('workspace.created', { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, kind: 'worktree', path: SPIKE, branch: 'aamonnaig4/spike-oa' })
    assert.equal(guardCalls.length, count + 1)
    assert.ok(guardCalls[count].includes(SPIKE_LIST))
    await worker.emit('workspace.created', { workspaceId: BUILD_WT, kind: 'worktree', path: BUILD, branch: 'aamonnaig4/orchestration-build' })
    assert.equal(guardCalls.length, count + 1)
  } finally {
    await done(worker)
  }
})

test('card.act passes the card command as expect, and nothing for a prompt card', async () => {
  const seen = []
  const { worker, w, host } = await mount(guardedSettings({
    storage: { agents: { [SPIKE]: agent('waiting', 'term_spike') } },
    seam: {
      answer: async (opts) => {
        seen.push({ has: Object.prototype.hasOwnProperty.call(opts, 'expect'), expect: opts.expect, choice: opts.choice })
        return opts.expect === undefined ? 'use-peek' : 'answered'
      }
    }
  }))
  try {
    const card = await commandCard(worker, w, host, 'gh pr list --state open')
    const res = await worker.request('card.act', { id: card.id, action: 'deny' })
    assert.deepEqual(res, { result: 'answered' })
    assert.deepEqual(seen[0], { has: true, expect: 'gh pr list --state open', choice: 'deny' })
    w.t += 200000
    await worker.request('row.act', { key: SPIKE, action: 'retry' })
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return openCards(v, SPIKE).some((c) => c.kind === 'approval' && c.detail === 'waiting on a prompt') ? v : null
    })
    const prompt = openCards(vm, SPIKE).find((c) => c.kind === 'approval')
    const peek = await worker.request('card.act', { id: prompt.id, action: 'allow' })
    assert.deepEqual(peek, { result: 'use-peek' })
    assert.deepEqual(seen[1], { has: false, expect: undefined, choice: 'allow' })
    const after = await worker.request('view.read')
    assert.equal(openCards(after, SPIKE).find((c) => c.kind === 'approval').detail, 'Pick an answer below')
  } finally {
    await done(worker)
  }
})

test('a message delivery drops after a second timeout and the chat says so', async () => {
  const queue = [{ id: 'q1', key: SPIKE, subject: 'S', body: 'B', at: T0 }]
  const { worker } = await mount(guardedSettings({
    storage: { queue, agents: { [SPIKE]: agent('working', 'term_spike', { sessionId: 's1' }) } },
    run: async (cmd, args) => (cmd === '/x/orca' && args[0] === 'terminal' && args[1] === 'send' ? { code: 124, stdout: '', stderr: 'timed out', missing: false } : null)
  }))
  try {
    const vm = await ticked(worker)
    const name = [...vm.rows, ...vm.idle].find((r) => r.key === SPIKE).name
    const ev = { workspaceId: SPIKE_WT, workspaceListId: SPIKE_LIST, paneKey: 'a:b', terminalId: 'term_spike', state: 'waiting', receivedAt: T0, sessionId: 's1' }
    await worker.emit('agent.status.changed', ev)
    await worker.emit('agent.status.changed', { ...ev, receivedAt: T0 + 1 })
    const line = `A message for ${name} could not be delivered and was dropped.`
    const found = await until(async () => {
      const v = await worker.request('view.read')
      return v.chat.find((c) => c.from === 'panel' && c.text === line) ?? null
    })
    assert.equal(found.kind, 'text')
  } finally {
    await done(worker)
  }
})

test('a panel request rejects with unavailable when initialisation never finishes', async () => {
  const { worker } = await mount({
    readyMs: 20,
    seam: { initMs: 30 },
    run: async (cmd) => (cmd === '/bin/zsh' ? new Promise(() => {}) : null)
  })
  try {
    let timer
    const cap = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the request never settled')), 2000)
    })
    cap.catch(() => undefined)
    try {
      await rejectsWith(Promise.race([worker.request('agents.list'), cap]), 'unavailable')
      await assert.rejects(Promise.race([worker.request('settings.save', {}), cap]), (err) => {
        assert.equal(err.code, 'unavailable')
        assert.match(err.message, /starting/)
        return true
      })
    } finally {
      clearTimeout(timer)
    }
    const vm = await worker.request('view.read')
    assert.equal(vm.firstRun, true)
  } finally {
    await done(worker)
  }
})

test('changing the orchestrator agent after first run says when it takes effect and relaunches nothing', async () => {
  const { worker } = await mount(guardedSettings())
  try {
    await ticked(worker)
    const launches = worker.host.callsOf('agent.launch').length + worker.host.callsOf('agent.resume').length
    const line = 'The new orchestrator agent takes effect the next time the orchestrator starts.'
    const saved = await worker.request('settings.save', { orchestratorAgent: 'codex' })
    assert.equal(saved.orchestratorAgent, 'codex')
    const vm = await worker.request('view.read')
    const items = vm.chat.filter((c) => c.text === line)
    assert.equal(items.length, 1)
    assert.equal(items[0].from, 'panel')
    await worker.request('settings.save', { intervalSec: 120 })
    assert.equal((await worker.request('view.read')).chat.filter((c) => c.text === line).length, 1)
    assert.equal(worker.host.callsOf('agent.launch').length + worker.host.callsOf('agent.resume').length, launches)
  } finally {
    await done(worker)
  }
})

test('card.act start launches the worker agent in that workspace and dismiss closes the card', async () => {
  const held = { id: 'merge-blocked:' + SPIKE, key: SPIKE, kind: 'merge-blocked', title: 'spike', detail: 'Stopped: gh pr merge', actions: ['start', 'dismiss', 'details'], at: 1, resolved: null }
  const { worker } = await mount(guardedSettings({ storage: { cards: [held] } }))
  const rowCards = (v) => [...v.rows, ...v.idle].map((r) => r.card).filter((c) => c && c.resolved === null)
  try {
    const vm = await until(async () => {
      const v = await worker.request('view.read')
      return rowCards(v).some((c) => c.id === held.id) ? v : null
    })
    const card = rowCards(vm).find((c) => c.id === held.id)
    const before = worker.host.callsOf('agent.launch').length
    assert.deepEqual(await worker.request('card.act', { id: card.id, action: 'start' }), { ok: true, open: SPIKE })
    const calls = worker.host.callsOf('agent.launch')
    assert.equal(calls.length, before + 1)
    const sent = JSON.stringify(calls[calls.length - 1])
    assert.ok(sent.includes('"agent":"claude"') && sent.includes('"workspaceId"'), sent)
    assert.deepEqual(await worker.request('card.act', { id: card.id, action: 'dismiss' }), { ok: true })
    const after = await worker.request('view.read')
    assert.equal(rowCards(after).filter((c) => c.id === held.id).length, 0)
    await rejectsWith(worker.request('card.act', { id: card.id, action: 'dismiss' }), 'invalid_params')
  } finally {
    await done(worker)
  }
})

test('row.act open switches to the agent terminal, or opens the worktree when there is no terminal', async () => {
  const { worker, w } = await mount(guardedSettings({ workspaces: workspaces({ [BUILD]: 'active' }), storage: { agents: { [BUILD]: agent('waiting', 'term_build') } } }))
  try {
    await ticked(worker)
    await worker.request('row.act', { key: BUILD, action: 'open' })
    assert.deepEqual(w.orcaRuns(['terminal', 'switch'])[0].slice(1), ['terminal', 'switch', '--terminal', 'term_build', '--json'])
    await worker.request('row.act', { key: ROOT, action: 'open' })
    assert.deepEqual(w.orcaRuns(['worktree', 'activate'])[0].slice(1), ['worktree', 'activate', '--worktree', 'path:' + ROOT, '--json'])
  } finally {
    await done(worker)
  }
})

test('image.read returns a data URL for a real image and refuses anything else', async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const asked = []
  const images = {
    home: () => '/Users/me',
    bytes: async (path) => { asked.push(path); return path.endsWith('shot.png') ? PNG : new TextEncoder().encode('secret') },
    fetch: async () => null
  }
  const { worker } = await mount(guardedSettings({ seam: { images } }))
  try {
    const res = await worker.request('image.read', { src: '~/Desktop/shot.png' })
    assert.equal(res.data, 'data:image/png;base64,' + Buffer.from(PNG).toString('base64'))
    assert.deepEqual(asked, ['/Users/me/Desktop/shot.png'])
    await rejectsWith(worker.request('image.read', { src: '/Users/me/fake.png' }), 'conflict')
    await rejectsWith(worker.request('image.read', { src: '/Users/me/.ssh/id_rsa' }), 'conflict')
    await rejectsWith(worker.request('image.read', { src: 'http://insecure/x.png' }), 'conflict')
    assert.deepEqual(asked, ['/Users/me/Desktop/shot.png', '/Users/me/fake.png'])
  } finally {
    await done(worker)
  }
})
