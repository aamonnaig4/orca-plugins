import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mockHost, mountWorker } from 'orca/testing'
import { createDelivery } from '../src/deliver.ts'
import { createOrchestrator } from '../src/orchestrator.ts'

const USER = '/nonexistent/orch-orchestrator-test'
const REAL_HOME = '/Users/aamonnaig/.orca-orchestration/home'
const HOME = USER + '/.orca-orchestration/home'
const REPO_LIST = JSON.parse((await readFile(new URL('./fixtures/repo-list.json', import.meta.url), 'utf8')).split(REAL_HOME).join(HOME)).result
const HOME_REPO = 'ed35e1a6-a877-4c36-9b9a-c9aa020a5305'
const WS = HOME_REPO + '::' + HOME
const FORBIDDEN = ['workspace.open', 'terminal.focus', 'editor.open', 'commands.run', 'terminal.sendText']

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

function memoryStore(data = new Map()) {
  return {
    data,
    async get(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null
    },
    failKeys: new Set(),
    async set(key, value) {
      if (this.failKeys.has(key)) throw new Error('disk full')
      data.set(key, JSON.stringify(value))
    },
    async delete(key) {
      data.delete(key)
    },
    async keys() {
      return [...data.keys()]
    },
    onDidChange() {
      return { dispose() {} }
    },
    peek(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null
    }
  }
}

function homeList(state) {
  return {
    workspaces: [{ id: WS, kind: 'folder', name: 'home', path: HOME, branch: null, hostId: 'local', status: { state, unread: false, terminalCount: 1, lastActivityAt: null } }],
    truncated: false
  }
}

function setup(over = {}) {
  const order = []
  const env = {
    order,
    listState: 'working',
    now: 100,
    truncated: false,
    launchFail: false,
    onResume: null,
    logs: [],
    repos: REPO_LIST,
    terminals: [],
    store: over.store ?? memoryStore(),
    fs: over.fs ?? memoryFs(),
    settings: { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa' },
    ids: 0,
    cliCalls: [],
    hostCalls: []
  }
  const cli = {
    has: () => true,
    load: async () => {},
    json: async (args) => {
      env.cliCalls.push(args)
      order.push(args.slice(0, 2).join(' '))
      if (args[0] === 'repo' && args[1] === 'list') return env.repos
      if (args[0] === 'repo' && args[1] === 'add') {
        env.repos = { repos: [...env.repos.repos, { id: 'new-repo', path: HOME }] }
        return { repo: { id: 'new-repo', path: HOME } }
      }
      if (args[0] === 'repo' && args[1] === 'hide') {
        env.repos = { repos: env.repos.repos.map((r) => (r.id === args[3].slice(3) ? { ...r, hiddenAt: 1 } : r)) }
        return {}
      }
      if (args[0] === 'terminal' && args[1] === 'list') return { terminals: env.terminals, totalCount: env.terminals.length, truncated: env.truncated }
      return {}
    }
  }
  const answers = {
    'workspace.list': () => homeList(env.listState),
    'agent.launch': () => {
      if (env.launchFail) throw new Error('launch refused')
      return { terminalId: 'term_o1' }
    },
    'agent.resume': async () => {
      if (env.onResume) await env.onResume()
      return { terminalId: 'term_o2', started: true }
    }
  }
  const host = {
    calls: env.hostCalls,
    callsOf: (method) => env.hostCalls.filter((c) => c.method === method).map((c) => c.params),
    has: () => true,
    async call(method, params) {
      env.hostCalls.push({ method, params })
      order.push(method)
      const answer = answers[method]
      if (answer === undefined) throw new Error('unexpected host call ' + method)
      return typeof answer === 'function' ? answer(params) : answer
    }
  }
  const deps = { run: async () => ({ code: 0, stdout: '', stderr: '', missing: true }), now: () => env.now, home: () => USER, env: () => undefined, fs: env.fs }
  const wire = (store) => {
    const delivery = createDelivery({ host, cli, store, now: () => 100, id: () => 'm' + ++env.ids, fromHandle: () => null, track: () => {}, alive: async () => true })
    const orch = createOrchestrator({ host, cli, deps, store, delivery, settings: () => env.settings, id: () => 'abc', log: (m) => env.logs.push(m) })
    return { delivery, orch }
  }
  Object.assign(env, { host, cli, deps, wire }, wire(env.store))
  return env
}

function noForbidden(env) {
  for (const name of FORBIDDEN) assert.equal(env.host.callsOf(name).length, 0, name)
}

function terminalSends(env) {
  return env.cliCalls.filter((a) => a[0] === 'terminal' && a[1] === 'send')
}

const EVENT = { workspaceId: WS, paneKey: 'p:q', state: 'waiting', receivedAt: 500 }

test('first ensure reuses the hidden home folder from repo list and launches without a prompt', async () => {
  const env = setup()
  const rec = await env.orch.ensure()
  assert.deepEqual(env.cliCalls, [['repo', 'list']])
  assert.equal(rec.workspaceId, WS)
  assert.equal(rec.repoId, HOME_REPO)
  assert.equal(rec.home, HOME)
  assert.equal(rec.marker, 'orch:abc')
  assert.equal(rec.agentKind, 'claude')
  assert.equal(rec.agent.terminalId, 'term_o1')
  assert.deepEqual(env.host.callsOf('agent.launch'), [{ workspaceId: WS, agent: 'claude' }])
  assert.deepEqual(env.store.peek('orch'), rec)
  assert.deepEqual(env.orch.record(), rec)
  assert.ok(env.fs.files.get(HOME + '/AGENTS.md').includes('--comment "orch:abc"'))
  noForbidden(env)
})

test('a found home folder that is not hidden is hidden once and not added again', async () => {
  const env = setup()
  env.repos = { repos: REPO_LIST.repos.map((r) => (r.id === HOME_REPO ? { ...r, hiddenAt: undefined } : r)) }
  await env.orch.ensure()
  assert.deepEqual(env.cliCalls, [['repo', 'list'], ['repo', 'hide', '--repo', 'id:' + HOME_REPO]])
})

test('first ensure with no matching repo adds the folder, hides it, then launches, in that order', async () => {
  const env = setup()
  env.repos = { repos: REPO_LIST.repos.filter((r) => r.id !== HOME_REPO) }
  const rec = await env.orch.ensure()
  assert.deepEqual(env.order, ['repo list', 'repo add', 'repo hide', 'agent.launch'])
  assert.deepEqual(env.cliCalls[1], ['repo', 'add', '--path', HOME, '--kind', 'folder'])
  assert.deepEqual(env.cliCalls[2], ['repo', 'hide', '--repo', 'id:new-repo'])
  assert.equal(rec.workspaceId, 'new-repo::' + HOME)
  assert.deepEqual(env.host.callsOf('agent.launch'), [{ workspaceId: 'new-repo::' + HOME, agent: 'claude' }])
})

test('a worker agent setting reaches the standing instructions', async () => {
  const env = setup()
  env.settings = { orchestratorAgent: 'claude', workerAgent: 'codex', suffix: '-zz' }
  await env.orch.ensure()
  const text = env.fs.files.get(HOME + '/AGENTS.md')
  assert.ok(text.includes('--agent codex'))
  assert.ok(text.includes('-zz'))
})

test('two concurrent first ensures launch one agent', async () => {
  const env = setup()
  const [a, b] = await Promise.all([env.orch.ensure(), env.orch.ensure()])
  assert.equal(env.host.callsOf('agent.launch').length, 1)
  assert.deepEqual(a, b)
})

test('say while the agent is working queues and types nothing; the next waiting status without a terminal id sends it once', async () => {
  const env = setup()
  assert.equal(await env.orch.say('hello'), 'queued')
  assert.deepEqual(terminalSends(env), [])
  env.listState = 'active'
  const matched = await env.orch.onStatus({ ...EVENT })
  assert.equal(matched, true)
  assert.equal(env.orch.record().agent.terminalId, 'term_o1')
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o1', '--text=From Aamon\n\nhello', '--enter']])
  await env.orch.onStatus({ ...EVENT, receivedAt: 600 })
  assert.equal(terminalSends(env).length, 1)
  noForbidden(env)
})

test('say to a waiting orchestrator sends at once through the terminal', async () => {
  const env = setup()
  await env.orch.ensure()
  env.terminals = [{ handle: 'term_o1' }]
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT })
  assert.equal(await env.orch.say('now'), 'sent')
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o1', '--text=From Aamon\n\nnow', '--enter']])
})

test('a second say queued after a send goes out once after a working then a waiting status event', async () => {
  const env = setup()
  await env.orch.ensure()
  env.terminals = [{ handle: 'term_o1' }]
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT })
  assert.equal(await env.orch.say('one'), 'sent')
  assert.equal(await env.orch.say('two'), 'queued')
  await env.orch.onStatus({ ...EVENT, state: 'working', receivedAt: 600 })
  assert.equal(terminalSends(env).length, 1)
  await env.orch.onStatus({ ...EVENT, state: 'waiting', receivedAt: 700 })
  assert.deepEqual(terminalSends(env).map((a) => a[4]), ['--text=From Aamon\n\none', '--text=From Aamon\n\ntwo'])
  await env.orch.onStatus({ ...EVENT, state: 'waiting', receivedAt: 800 })
  assert.equal(terminalSends(env).length, 2)
  assert.equal(env.delivery.queued('orchestrator').length, 0)
})

test('a waiting event over a permission row sends nothing and reads blocked until the mask is set', async () => {
  const env = setup()
  await env.orch.say('hello')
  env.listState = 'permission'
  env.orch.setListState('permission')
  await env.orch.onStatus({ ...EVENT })
  assert.deepEqual(terminalSends(env), [])
  assert.equal(env.orch.session().agent.state, 'blocked')
  await env.orch.maskPermission()
  assert.equal(env.orch.session().agent.state, 'waiting')
  assert.equal(env.store.peek('orch').agent.permissionMasked, true)
})

test('the session is the orchestrator keyed for delivery', async () => {
  const env = setup()
  assert.equal(env.orch.session(), null)
  await env.orch.ensure()
  env.orch.setListState('active')
  const s = env.orch.session()
  assert.equal(s.key, 'orchestrator')
  assert.equal(s.path, HOME)
  assert.deepEqual(s.ids, [WS])
  assert.equal(s.started, 'you')
  assert.equal(s.dispatchId, null)
  assert.equal(s.agent.terminalId, 'term_o1')
})

test('Review Focus 2: a terminal missing from terminal list is resumed by session id, the text is queued and sent on the next waiting', async () => {
  const store = memoryStore()
  const first = setup({ store })
  await first.orch.ensure()
  await first.orch.onStatus({ ...EVENT, sessionId: 'sess-1' })
  const env = setup({ store, fs: first.fs })
  await env.orch.load()
  env.terminals = [{ handle: 'term_other' }]
  assert.equal(await env.orch.say('wake up'), 'queued')
  assert.deepEqual(env.cliCalls[0], ['terminal', 'list', '--worktree', 'id:' + WS])
  assert.deepEqual(env.host.callsOf('agent.resume'), [{ workspaceId: WS, agent: 'claude', sessionId: 'sess-1' }])
  assert.deepEqual(env.host.callsOf('agent.launch'), [])
  assert.equal(env.orch.record().agent.terminalId, 'term_o2')
  assert.equal(env.store.peek('orch').agent.terminalId, 'term_o2')
  assert.deepEqual(terminalSends(env), [])
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT, sessionId: 'sess-1' })
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o2', '--text=From Aamon\n\nwake up', '--enter']])
  noForbidden(env)
})

test('a lost terminal with no stored session id is launched again', async () => {
  const env = setup()
  await env.orch.ensure()
  env.terminals = []
  assert.equal(await env.orch.say('again'), 'queued')
  assert.equal(env.host.callsOf('agent.launch').length, 2)
  assert.deepEqual(env.host.callsOf('agent.resume'), [])
  assert.equal(env.orch.record().agent.terminalId, 'term_o1')
})

test('a live terminal is neither resumed nor launched, and the home files are rewritten for new settings', async () => {
  const env = setup()
  await env.orch.ensure()
  env.terminals = [{ handle: 'term_o1' }]
  env.settings = { ...env.settings, suffix: '-qq' }
  await env.orch.ensure()
  assert.equal(env.host.callsOf('agent.launch').length, 1)
  assert.deepEqual(env.host.callsOf('agent.resume'), [])
  assert.deepEqual(env.cliCalls.at(-1), ['terminal', 'list', '--worktree', 'id:' + WS])
  assert.ok(env.fs.files.get(HOME + '/AGENTS.md').includes('-qq'))
})

test('the record and the queue survive re-creation followed by load', async () => {
  const store = memoryStore()
  const first = setup({ store })
  await first.orch.say('keep me')
  const saved = first.orch.record()
  const env = setup({ store, fs: first.fs })
  assert.equal(env.orch.record(), null)
  await env.orch.load()
  assert.deepEqual(env.orch.record(), saved)
  assert.equal(env.delivery.queued('orchestrator').length, 1)
  env.terminals = [{ handle: 'term_o1' }]
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT })
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o1', '--text=From Aamon\n\nkeep me', '--enter']])
})

test('onStatus for another workspace and session returns false and changes nothing', async () => {
  const env = setup()
  const before = await env.orch.ensure()
  const writes = [...env.store.data.entries()]
  assert.equal(await env.orch.onStatus({ ...EVENT, workspaceId: 'other::/x', sessionId: 'nope', terminalId: 'term_o1' }), false)
  assert.equal(await env.orch.onStatus({ ...EVENT, workspaceId: null }), false)
  assert.deepEqual(env.orch.record(), before)
  assert.deepEqual([...env.store.data.entries()], writes)
})

test('onStatus matches a stored session id and never the terminal id or workspace list id', async () => {
  const env = setup()
  await env.orch.ensure()
  await env.orch.onStatus({ ...EVENT, state: 'working' })
  await env.orch.onStatus({ ...EVENT, state: 'working', sessionId: 'sess-9' })
  assert.equal(await env.orch.onStatus({ workspaceId: 'x::/y', paneKey: 'k', state: 'working', sessionId: 'sess-9', receivedAt: 700 }), true)
  assert.equal(await env.orch.onStatus({ workspaceId: 'x::/y', workspaceListId: WS, terminalId: 'term_o1', paneKey: 'k', state: 'working', receivedAt: 800 }), false)
})

test('onStatus before any record returns false', async () => {
  const env = setup()
  assert.equal(await env.orch.onStatus({ ...EVENT }), false)
})

test('works against the orca/testing mockHost and never calls a forbidden host method', async () => {
  const host = mockHost({
    results: { 'workspace.list': homeList('working'), 'agent.launch': { terminalId: 'term_m' }, 'agent.resume': { terminalId: 'term_m2', started: true } }
  })
  let orca
  const worker = await mountWorker({ default: (api) => { orca = api } }, { host })
  const env = setup()
  const delivery = createDelivery({ host: orca.host, cli: env.cli, store: orca.storage, now: () => 1, id: () => 'k', fromHandle: () => null, track: () => {}, alive: async () => true })
  const orch = createOrchestrator({ host: orca.host, cli: env.cli, deps: env.deps, store: orca.storage, delivery, settings: () => env.settings, id: () => 'zz' })
  assert.equal(await orch.say('hi'), 'queued')
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WS, agent: 'claude' }])
  for (const name of FORBIDDEN) assert.deepEqual(host.callsOf(name), [], name)
  assert.deepEqual(host.refusals, [])
  await worker.deactivate()
})

const settleTicks = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

async function resumable() {
  const store = memoryStore()
  const first = setup({ store })
  await first.orch.ensure()
  await first.orch.onStatus({ ...EVENT, sessionId: 'sess-1' })
  const env = setup({ store, fs: first.fs })
  await env.orch.load()
  return env
}

test('item 1: an agent that never sends a status event is read as idle after two idle list states 5 seconds apart, and the queue is sent once', async () => {
  const env = setup()
  assert.equal(await env.orch.say('hello'), 'queued')
  env.listState = 'active'
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [])
  env.now = 4999 + 100
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [])
  env.now = 5100
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o1', '--text=From Aamon\n\nhello', '--enter']])
  assert.equal(env.orch.record().agent.state, 'waiting')
  assert.equal(env.store.peek('orch').agent.state, 'waiting')
  env.now = 20000
  env.orch.setListState('active')
  env.orch.setListState('active')
  await settleTicks()
  assert.equal(terminalSends(env).length, 1)
  noForbidden(env)
})

test('item 1: a done list state also settles a seeded agent', async () => {
  const env = setup()
  await env.orch.say('hi')
  env.listState = 'done'
  env.orch.setListState('done')
  env.now = 9000
  env.orch.setListState('done')
  await settleTicks()
  assert.equal(terminalSends(env).length, 1)
})

test('item 1: working and permission list states never settle the agent, and a working state resets the clock', async () => {
  const env = setup()
  await env.orch.say('hello')
  for (const state of ['working', 'permission']) {
    env.listState = state
    env.now = 100
    env.orch.setListState(state)
    env.now = 60000
    env.orch.setListState(state)
    await settleTicks()
    assert.deepEqual(terminalSends(env), [])
    assert.equal(env.orch.record().agent.state, 'working')
  }
  env.listState = 'active'
  env.now = 70000
  env.orch.setListState('active')
  env.orch.setListState('working')
  env.now = 80000
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [])
})

test('item 1: a real status event before the second idle list state wins', async () => {
  const env = setup()
  await env.orch.say('hello')
  env.listState = 'active'
  env.orch.setListState('active')
  await env.orch.onStatus({ ...EVENT, state: 'working' })
  env.now = 9000
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [])
  assert.equal(env.orch.record().agent.state, 'working')
  assert.equal(env.orch.session().agent.state, 'working')
})

test('item 2: ensure, say and onStatus wait for load, so a stored record is never launched over', async () => {
  const store = memoryStore()
  const first = setup({ store })
  await first.orch.ensure()
  const a = setup({ store, fs: first.fs })
  a.terminals = [{ handle: 'term_o1' }]
  const rec = await a.orch.ensure()
  assert.equal(rec.agent.terminalId, 'term_o1')
  assert.deepEqual(a.host.callsOf('agent.launch'), [])
  const b = setup({ store, fs: first.fs })
  b.terminals = [{ handle: 'term_o1' }]
  assert.equal(await b.orch.say('x'), 'queued')
  assert.deepEqual(b.host.callsOf('agent.launch'), [])
  const c = setup({ store, fs: first.fs })
  assert.equal(await c.orch.onStatus({ ...EVENT }), true)
  const d = setup({ store, fs: first.fs })
  d.terminals = [{ handle: 'term_o1' }]
  await Promise.all([d.orch.load(), d.orch.ensure(), d.orch.load()])
  assert.deepEqual(d.host.callsOf('agent.launch'), [])
})

test('item 3: a failed write keeps the record, logs the error, and is retried on the next ensure without launching again', async () => {
  const env = setup()
  env.store.failKeys.add('orch')
  const rec = await env.orch.ensure()
  assert.equal(rec.agent.terminalId, 'term_o1')
  assert.deepEqual(env.orch.record(), rec)
  assert.equal(env.store.peek('orch'), null)
  assert.equal(env.logs.length, 1)
  assert.ok(env.logs[0].includes('disk full'))
  env.store.failKeys.clear()
  env.terminals = [{ handle: 'term_o1' }]
  await env.orch.ensure()
  assert.deepEqual(env.store.peek('orch'), rec)
  assert.equal(env.host.callsOf('agent.launch').length, 1)
})

test('item 4: a status update that lands during the resume is kept; only the terminal id is merged in', async () => {
  const env = await resumable()
  env.terminals = []
  env.onResume = async () => {
    await env.orch.onStatus({ ...EVENT, state: 'waiting', sessionId: 'sess-1', receivedAt: 900 })
  }
  await env.orch.ensure()
  assert.equal(env.orch.record().agent.terminalId, 'term_o2')
  assert.equal(env.orch.record().agent.state, 'waiting')
  assert.equal(env.store.peek('orch').agent.state, 'waiting')
})

test('item 5: a truncated terminal list that does not show the terminal is read as alive', async () => {
  const env = await resumable()
  env.terminals = [{ handle: 'term_other' }]
  env.truncated = true
  await env.orch.ensure()
  assert.deepEqual(env.host.callsOf('agent.resume'), [])
  assert.deepEqual(env.host.callsOf('agent.launch'), [])
  assert.equal(env.orch.record().agent.terminalId, 'term_o1')
  env.truncated = false
  await env.orch.ensure()
  assert.equal(env.host.callsOf('agent.resume').length, 1)
})

test('item 6: when ensure throws, say keeps the text queued under the orchestrator key and rejects with a clear error', async () => {
  const env = setup()
  env.launchFail = true
  await assert.rejects(env.orch.say('keep me'), /orchestrator could not be started.*launch refused.*queued/)
  assert.equal(env.delivery.queued('orchestrator').length, 1)
  assert.deepEqual(terminalSends(env), [])
  env.launchFail = false
  await env.orch.ensure()
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT })
  assert.deepEqual(terminalSends(env), [['terminal', 'send', '--terminal', 'term_o1', '--text=From Aamon\n\nkeep me', '--enter']])
  assert.equal(env.delivery.queued('orchestrator').length, 0)
})

test('item 7: two concurrent ensures with the home folder absent add the repo once and launch once', async () => {
  const env = setup()
  env.repos = { repos: REPO_LIST.repos.filter((r) => r.id !== HOME_REPO) }
  await Promise.all([env.orch.ensure(), env.orch.ensure()])
  assert.equal(env.cliCalls.filter((a) => a[0] === 'repo' && a[1] === 'add').length, 1)
  assert.equal(env.host.callsOf('agent.launch').length, 1)
})

test('item 7: two concurrent says with a dead terminal resume once and deliver both texts in order', async () => {
  const env = await resumable()
  env.terminals = [{ handle: 'term_other' }]
  const [a, b] = await Promise.all([env.orch.say('first'), env.orch.say('second')])
  assert.deepEqual([a, b], ['queued', 'queued'])
  assert.equal(env.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(env.host.callsOf('agent.launch'), [])
  env.listState = 'active'
  await env.orch.onStatus({ ...EVENT, sessionId: 'sess-1' })
  assert.deepEqual(
    terminalSends(env).map((a) => a[4]),
    ['--text=2 messages\n\nFrom Aamon\n\nfirst\n\n----------\n\nFrom Aamon\n\nsecond']
  )
})

test('item 7: when repo add succeeds and agent.launch fails, the next ensure does not add again and launches once', async () => {
  const env = setup()
  env.repos = { repos: REPO_LIST.repos.filter((r) => r.id !== HOME_REPO) }
  env.launchFail = true
  await assert.rejects(env.orch.ensure(), /launch refused/)
  assert.equal(env.cliCalls.filter((a) => a[0] === 'repo' && a[1] === 'add').length, 1)
  const attempts = env.host.callsOf('agent.launch').length
  env.launchFail = false
  const rec = await env.orch.ensure()
  assert.equal(env.cliCalls.filter((a) => a[0] === 'repo' && a[1] === 'add').length, 1)
  assert.equal(env.host.callsOf('agent.launch').length, attempts + 1)
  assert.equal(rec.repoId, 'new-repo')
})

for (const [label, row] of [
  ['handle', { handle: 'term_o1' }],
  ['terminalId', { terminalId: 'term_o1' }],
  ['id', { id: 'term_o1' }],
  ['handle without the prefix', { handle: 'o1' }],
  ['terminalId without the prefix', { terminalId: 'o1' }],
  ['id without the prefix', { id: 'o1' }]
]) {
  test('item 8: a terminal row carrying ' + label + ' counts as alive', async () => {
    const env = setup()
    await env.orch.ensure()
    env.terminals = [{ tabId: 'pty:x', title: 'claude' }, row]
    await env.orch.ensure()
    assert.equal(env.host.callsOf('agent.launch').length, 1)
    assert.deepEqual(env.host.callsOf('agent.resume'), [])
  })
}

test('item 8: a stored id without the prefix matches a prefixed row, and a different id does not match', async () => {
  const env = setup()
  await env.orch.ensure()
  env.terminals = [{ handle: 'term_zzz' }, { tabId: 'term_o1' }]
  await env.orch.ensure()
  assert.equal(env.host.callsOf('agent.launch').length, 2)
})

test('a real working status event keeps the orchestrator working through two idle list states 5 seconds apart', async () => {
  const env = setup()
  await env.orch.say('hello')
  await env.orch.onStatus({ ...EVENT, state: 'working' })
  env.listState = 'active'
  env.now = 1000
  env.orch.setListState('active')
  env.now = 6000
  env.orch.setListState('active')
  env.now = 12000
  env.orch.setListState('active')
  await settleTicks()
  assert.deepEqual(terminalSends(env), [])
  assert.equal(env.orch.record().agent.state, 'working')
  assert.equal(env.orch.session().agent.state, 'working')
})
