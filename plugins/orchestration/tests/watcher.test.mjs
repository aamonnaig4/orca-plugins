import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mockHost, mountWorker } from 'orca/testing'
import { createDelivery } from '../src/deliver.ts'
import { createOrchestrator } from '../src/orchestrator.ts'
import { createWatcher, appendChat, putPlan } from '../src/watcher.ts'

const USER_HOME = '/nonexistent/orch-watcher-test'
const REAL_HOME = '/Users/aamonnaig/.orca-orchestration/home'
const HOME = USER_HOME + '/.orca-orchestration/home'

async function fixture(name) {
  return JSON.parse((await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8')).split(REAL_HOME).join(HOME))
}

const WORKSPACES = await fixture('workspace-list.json')
const WORKTREES = (await fixture('worktree-list.json')).result
const WORKERS = (await fixture('worker-list.json')).result
const HOOKS = (await fixture('hooks-status.json')).result

const HOME_REPO = 'ed35e1a6-a877-4c36-9b9a-c9aa020a5305'
const WS = HOME_REPO + '::' + HOME
const SPIKE = '/Users/aamonnaig/Developer/orca-plugins/spike-oa'
const BUILD = '/Users/aamonnaig/Developer/orca-plugins/orchestration'
const FORBIDDEN = ['workspace.open', 'terminal.focus', 'editor.open', 'commands.run', 'terminal.sendText']
const T0 = 1794800000000

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function memoryFs() {
  const files = new Map()
  const writes = []
  return {
    files,
    writes,
    read: async (p) => (files.has(p) ? files.get(p) : null),
    write: async (p, text) => {
      writes.push(p)
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
  const sets = []
  return {
    data,
    sets,
    async get(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null
    },
    async set(key, value) {
      sets.push(key)
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

function agentInfo(state, terminalId, over = {}) {
  return { state, terminalId, sessionId: null, chatId: null, kind: 'claude', since: T0 - 60000, permissionMasked: false, ...over }
}

function orchRecord(over = {}) {
  return { marker: 'orch:abc', repoId: HOME_REPO, workspaceId: WS, home: HOME, agentKind: 'claude', agent: agentInfo('working', 'term_o1'), ...over }
}

function checkRun(name, conclusion, id, status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion, databaseId: id, startedAt: '2026-11-15T21:21:38Z', detailsUrl: 'https://ci/' + id }
}

function prNode({ number, branch, sha = 'sha1', checks = [], isDraft = false, mergeable = 'MERGEABLE', threads = [], reviews = [], comments = [], requests = 0 }) {
  return {
    number,
    url: 'https://github.com/o/r/pull/' + number,
    headRefName: branch,
    baseRefName: 'main',
    headRefOid: sha,
    baseRefOid: 'base1',
    isDraft,
    mergeable,
    reviewDecision: null,
    reviewRequests: { totalCount: requests },
    commits: { nodes: [{ commit: { statusCheckRollup: checks.length === 0 ? null : { state: 'X', contexts: { pageInfo: { hasNextPage: false }, nodes: checks } } } }] },
    reviewThreads: { nodes: threads },
    reviews: { nodes: reviews },
    comments: { nodes: comments }
  }
}

function graphql(prs) {
  return JSON.stringify({
    data: {
      rateLimit: { remaining: 4000, resetAt: '2026-11-15T21:57:04Z' },
      repository: { nameWithOwner: 'x', defaultBranchRef: { name: 'main' }, b0: { nodes: prs } }
    }
  })
}

function failing(number, branch, sha = 'sha1') {
  return prNode({ number, branch, sha, checks: [checkRun('lint', 'FAILURE', 101)] })
}

function green(number, branch) {
  return prNode({ number, branch, checks: [checkRun('lint', 'SUCCESS', 102), checkRun('test', 'SUCCESS', 103)] })
}

function spaceRow(path, name, state) {
  return { id: 'identity:wt2:local:' + name, kind: 'worktree', name, project: 'proj', projectId: 'r-' + name, path, branch: name, hostId: 'local', status: { state, unread: false, terminalCount: 1, lastActivityAt: null } }
}

function treeRow(path, name, repo, over = {}) {
  return {
    id: 'r-' + name + '::' + path,
    instanceId: 'inst-' + name,
    repoId: 'r-' + repo,
    projectId: 'github:' + repo,
    hostId: 'local',
    path,
    branch: 'refs/heads/' + name,
    isMainWorktree: false,
    comment: '',
    ...over
  }
}

function homeRow(state) {
  return { id: WS, kind: 'folder', name: 'home', project: 'home', projectId: HOME_REPO, path: HOME, branch: null, hostId: 'local', status: { state, unread: false, terminalCount: 1, lastActivityAt: null } }
}

function spyDelivery(real) {
  const sends = []
  return {
    sends,
    load: () => real.load(),
    send: (session, subject, body) => {
      sends.push({ key: session.key, name: session.name, subject, body })
      return real.send(session, subject, body)
    },
    flush: (session) => real.flush(session),
    prune: (keys) => real.prune(keys),
    queued: (key) => real.queued(key)
  }
}

async function setup(over = {}) {
  const env = {
    now: T0,
    spaces: [homeRow('active')],
    worktrees: [],
    workers: [],
    repos: {},
    ghFail: {},
    settings: { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa', intervalSec: 60, attempts: 3, guard: true, onCi: 'fix', onConflict: 'fix', onReview: 'fix', noAgent: 'ask', scope: 'all', ...over.settings },
    store: over.store ?? memoryStore(),
    fs: over.fs ?? memoryFs(),
    cliCalls: [],
    hostCalls: [],
    runCalls: [],
    cliFail: null,
    views: [],
    hostHang: null
  }
  if (over.record !== null && (await env.store.get('orch')) === null) await env.store.set('orch', over.record ?? orchRecord())
  const cli = {
    has: () => true,
    load: async () => {},
    json: async (args) => {
      env.cliCalls.push(args)
      if (env.cliFail && env.cliFail(args)) throw new Error('orca is down')
      const head = args.slice(0, 2).join(' ')
      if (head === 'worktree list') return { worktrees: clone(env.worktrees), truncated: false }
      if (head === 'orchestration worker-list') return { workers: clone(env.workers) }
      if (head === 'agent hooks') return clone(HOOKS)
      if (head === 'terminal send') return { sent: true }
      if (head === 'orchestration send') return { dispatchId: 'ctx_new' }
      return {}
    }
  }
  const host = over.host ?? {
    callsOf: (method) => env.hostCalls.filter((c) => c.method === method).map((c) => c.params),
    has: () => true,
    async call(method, params) {
      env.hostCalls.push({ method, params })
      if (method === 'workspace.list') {
        if (env.hostHang) await env.hostHang
        return { workspaces: clone(env.spaces), truncated: false }
      }
      if (method === 'notifications.show') return { delivered: true }
      throw new Error('unexpected host call ' + method)
    }
  }
  env.host = host
  const deps = {
    run: async (cmd, args) => {
      env.runCalls.push({ cmd, args })
      if (args[0] === 'api' && args[1] === 'graphql') {
        const owner = args.find((a) => a.startsWith('owner=')).slice(6)
        const name = args.find((a) => a.startsWith('name=')).slice(5)
        const repo = owner + '/' + name
        if (env.ghFail[repo]) return { missing: false, stdout: '', ...env.ghFail[repo] }
        return { code: 0, stdout: graphql(env.repos[repo] ?? []), stderr: '', missing: false }
      }
      if (args[0] === 'api' && args[1] === 'rate_limit' && env.budget) return { code: 0, stdout: JSON.stringify({ resources: { graphql: env.budget } }), stderr: '', missing: false }
      if (args[0] === 'run' && args[1] === 'view') return { code: 0, stdout: 'line a\nError: lint failed\n', stderr: '', missing: false }
      return { code: 1, stdout: '', stderr: 'unexpected', missing: false }
    },
    now: () => env.now,
    home: () => USER_HOME,
    env: () => undefined,
    fs: env.fs
  }
  let ids = 0
  const wire = (store) => {
    const real = createDelivery({ host, cli, store, now: () => env.now, id: () => 'q' + ++ids, fromHandle: () => null, track: () => {}, alive: async () => true })
    const delivery = spyDelivery(real)
    const orchestrator = createOrchestrator({ host, cli, deps, store, delivery, settings: () => env.settings, id: () => 'abc' })
    const watcher = createWatcher({
      deps,
      bins: { orca: '/bin/orca', gh: over.gh === undefined ? '/bin/gh' : over.gh },
      cli,
      host,
      store,
      orchestrator,
      delivery,
      settings: () => env.settings,
      onChange: (view) => env.views.push(view)
    })
    return { delivery, orchestrator, watcher }
  }
  Object.assign(env, { cli, deps, wire })
  env.rewire = async () => {
    Object.assign(env, wire(env.store))
    await env.orchestrator.load()
    await env.watcher.load()
  }
  await env.rewire()
  return env
}

function addSession(env, name, { repo = 'o/a', state = 'active', comment = '', agent } = {}) {
  const path = '/w/' + name
  env.spaces.push(spaceRow(path, name, state))
  env.worktrees.push(treeRow(path, name, repo, { comment }))
  if (agent) env.watcher.setAgent(path, agent)
  return path
}

function row(env, key) {
  const v = env.watcher.view()
  return [...v.rows, ...v.idle].find((r) => r.key === key) ?? null
}

function graphqlCalls(env) {
  return env.runCalls.filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql')
}

function notes(env) {
  return env.hostCalls.filter((c) => c.method === 'notifications.show')
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

test('watcher: a failed check with none pending is sent once and the row reads Fixing CI failures', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.delivery.sends[0].key, key)
  assert.equal(env.delivery.sends[0].subject, 'CI failed on #7')
  assert.ok(env.delivery.sends[0].body.includes('Error: lint failed'))
  assert.ok(env.runCalls.some((c) => c.args.join(' ') === 'run view --job 101 --log-failed -R o/a'))
  const r = row(env, key)
  assert.equal(r.lane, 'validating')
  assert.ok(r.phrase.startsWith('Fixing CI failures'), r.phrase)
  assert.equal(r.tone, 'warn')
  assert.equal(r.pr, 7)
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/7')
  assert.equal(r.stale, false)
  assert.equal(env.watcher.view().watching, 1)
  assert.deepEqual(env.watcher.pr(key).checks.map((c) => c.state), ['fail'])
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
})

test('watcher: Review Focus 1, gh rate-limited keeps the last PR data stale, sends nothing and waits out retryInSec', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  assert.equal(row(env, key).lane, 'ready')
  assert.equal(row(env, key).stale, false)
  env.repos['o/a'] = [failing(7, 'feat', 'sha2')]
  env.ghFail['o/a'] = { code: 1, stderr: 'API rate limit exceeded for user' }
  env.now += 60000
  await env.watcher.tick()
  const v = env.watcher.view()
  assert.equal(v.gh.ok, false)
  assert.equal(v.gh.reason, 'rate-limited')
  assert.equal(v.gh.retryInSec, 300)
  assert.equal(env.delivery.sends.length, 0)
  assert.equal(row(env, key).lane, 'ready')
  assert.equal(row(env, key).stale, true)
  const before = graphqlCalls(env).length
  env.now += 30000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, before)
  assert.equal(env.watcher.view().gh.reason, 'rate-limited')
  assert.equal(env.delivery.sends.length, 0)
  delete env.ghFail['o/a']
  env.now += 271000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, before + 1)
  assert.deepEqual(env.watcher.view().gh, { ok: true })
  assert.equal(row(env, key).stale, false)
  assert.equal(env.delivery.sends.length, 1)
})

test('watcher: Review Focus 1, gh missing marks rows stale, says so and runs nothing', async () => {
  const env = await setup({ gh: null })
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  assert.deepEqual(env.watcher.view().gh, { ok: false, reason: 'missing' })
  assert.equal(graphqlCalls(env).length, 0)
  assert.equal(row(env, key).stale, true)
  assert.equal(env.delivery.sends.length, 0)
})

test('watcher: Review Focus 3, a vanished worktree loses its queue, row and ledger', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'working', agent: agentInfo('working', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.delivery.queued(key).length, 1)
  assert.ok(env.store.peek('ledgers')['o/a#7'])
  env.worktrees = []
  env.spaces = env.spaces.filter((s) => s.path !== key)
  await env.watcher.tick()
  assert.deepEqual(env.delivery.queued(key), [])
  assert.deepEqual(env.store.peek('queue'), [])
  assert.equal(row(env, key), null)
  assert.equal(env.store.peek('ledgers')['o/a#7'], undefined)
  assert.equal(env.cliCalls.filter((a) => a[0] === 'terminal' && a[1] === 'send').length, 0)
})

test('watcher: Review Focus 3, a PR missing from the next read moves its session out and sends nothing', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const busy = addSession(env, 'busy', { state: 'working', agent: agentInfo('working', 't2') })
  env.repos['o/a'] = [green(7, 'feat'), green(8, 'busy')]
  await env.watcher.tick()
  assert.equal(row(env, key).lane, 'ready')
  env.repos['o/a'] = []
  env.now += 60000
  await env.watcher.tick()
  assert.equal(row(env, key).lane, 'idle')
  assert.equal(row(env, key).pr, null)
  assert.equal(row(env, busy).lane, 'building')
  assert.ok(env.watcher.view().idle.some((r) => r.key === key))
  assert.equal(env.delivery.sends.length, 0)
  assert.equal(env.watcher.view().watching, 0)
})

test('watcher: an all-green PR is ready with one notification across two ticks', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  await env.watcher.tick()
  const r = row(env, key)
  assert.equal(r.lane, 'ready')
  assert.equal(r.phrase, 'Mergeable')
  assert.equal(r.tone, 'ok')
  assert.equal(notes(env).length, 1)
  assert.equal(env.delivery.sends.length, 0)
})

test('watcher: waiting plus a permission row makes one approval card, chat item and notification, and masking closes it', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'permission', agent: agentInfo('waiting', 't1') })
  env.watcher.noteTool('t1', { tool: 'Bash', input: { command: 'pnpm install' }, at: T0 })
  await env.watcher.tick()
  await env.watcher.tick()
  let v = env.watcher.view()
  assert.equal(v.needs, 1)
  const cards = v.chat.filter((c) => c.kind === 'card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].from, 'panel')
  assert.equal(cards[0].card.kind, 'approval')
  assert.equal(cards[0].card.detail, 'wants to run: pnpm install')
  assert.deepEqual(cards[0].card.actions, ['allow', 'deny', 'peek'])
  assert.equal(notes(env).length, 1)
  const r = row(env, key)
  assert.equal(r.lane, 'needs')
  assert.equal(r.tone, 'bad')
  assert.equal(r.phrase, 'Blocked · wants to run: pnpm install')
  assert.equal(r.card.id, 'approval:' + key)
  await env.watcher.maskPermission(key)
  assert.equal(env.watcher.agents()[key].permissionMasked, true)
  await env.watcher.tick()
  v = env.watcher.view()
  assert.equal(v.needs, 0)
  assert.equal(v.chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
  assert.equal(row(env, key).lane, 'idle')
  assert.equal(notes(env).length, 1)
})

test('watcher: an active row gives no card, and leaving blocked closes an open card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'active', agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.length, 0)
  env.spaces.find((s) => s.path === key).status.state = 'permission'
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  env.spaces.find((s) => s.path === key).status.state = 'active'
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
})

test('watcher: masking a session with no stored agent creates one as waiting and closes its card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'permission' })
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  await env.watcher.maskPermission(key)
  assert.equal(env.watcher.agents()[key].state, 'waiting')
  assert.equal(env.watcher.agents()[key].permissionMasked, true)
  assert.equal(env.store.peek('agents')[key].permissionMasked, true)
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
})

test('watcher: the orchestrator gets an approval card from the home row in workspace-list.json', async () => {
  const env = await setup({ record: orchRecord({ agent: agentInfo('waiting', 'term_o1') }) })
  env.spaces = clone(WORKSPACES.workspaces)
  env.worktrees = clone(WORKTREES.worktrees)
  env.watcher.noteTool('term_o1', { tool: 'WebFetch', input: { url: 'https://example.com' }, at: T0 })
  await env.watcher.tick()
  const v = env.watcher.view()
  assert.equal(env.watcher.index().byKey(HOME), null)
  assert.equal(env.watcher.listState(HOME), 'permission')
  assert.deepEqual({ state: v.orch.state, agentKind: v.orch.agentKind, doing: v.orch.doing }, { state: 'blocked', agentKind: 'claude', doing: '' })
  assert.equal(typeof v.orch.since, 'number')
  const card = v.chat.find((c) => c.kind === 'card').card
  assert.equal(card.id, 'approval:orchestrator')
  assert.equal(card.key, 'orchestrator')
  assert.equal(card.detail, 'wants to use: WebFetch')
  assert.equal(v.needs, 1)
  await env.watcher.maskPermission('orchestrator')
  assert.equal(env.orchestrator.record().agent.permissionMasked, true)
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
})

test('watcher: agents set with setAgent survive re-creation and load', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.watcher.setAgent(key, agentInfo('waiting', 't9', { sessionId: 'u9' }))
  await new Promise((r) => setImmediate(r))
  assert.equal(env.store.peek('agents')[key].terminalId, 't9')
  await env.rewire()
  assert.equal(env.watcher.agents()[key].terminalId, 't9')
  await env.watcher.tick()
  const s = env.watcher.index().byKey(key)
  assert.equal(s.agent.terminalId, 't9')
  assert.equal(s.agent.sessionId, 'u9')
  assert.equal(env.watcher.index().byTerminal('t9').key, key)
})

test('watcher: noteTool keeps at most 200 terminals and drops the least recently noted', async () => {
  const env = await setup()
  const first = addSession(env, 'first', { state: 'permission', agent: agentInfo('waiting', 't0') })
  const last = addSession(env, 'last', { state: 'permission', agent: agentInfo('waiting', 't200') })
  for (let i = 0; i <= 200; i++) env.watcher.noteTool('t' + i, { tool: 'Bash', input: { command: 'cmd ' + i }, at: T0 })
  await env.watcher.tick()
  const cards = env.watcher.view().chat.filter((c) => c.kind === 'card').map((c) => c.card)
  assert.equal(cards.find((c) => c.key === first).detail, 'waiting on a prompt')
  assert.equal(cards.find((c) => c.key === last).detail, 'wants to run: cmd 200')
})

test('watcher: the fix limit adds an attempts card, and retry closes it and sends once', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  for (const sha of ['s1', 's2', 's3']) {
    env.repos['o/a'] = [failing(7, 'feat', sha)]
    env.now += 60000
    await env.watcher.tick()
  }
  assert.equal(env.delivery.sends.length, 3)
  env.repos['o/a'] = [failing(7, 'feat', 's4')]
  env.now += 60000
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 3)
  let v = env.watcher.view()
  const card = v.chat.find((c) => c.kind === 'card').card
  assert.equal(card.kind, 'attempts')
  assert.equal(card.detail, '3 fix attempts used')
  assert.deepEqual(card.actions, ['retry', 'details'])
  assert.equal(row(env, key).lane, 'needs')
  assert.equal(row(env, key).phrase, 'CI failing · 3 fix attempts used')
  await env.watcher.tick()
  assert.equal(env.watcher.view().chat.filter((c) => c.kind === 'card').length, 1)
  await env.watcher.retry(key)
  assert.equal(env.delivery.sends.length, 4)
  v = env.watcher.view()
  assert.equal(v.needs, 0)
  assert.equal(v.chat.find((c) => c.kind === 'card').card.resolved, 'retry')
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 4)
})

test('watcher: a hand-started session with the scope set to workers only shows CI failing until auto-fix CI is switched on', async () => {
  const env = await setup({ settings: { scope: 'workers' } })
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(row(env, key).phrase, 'CI failing')
  assert.deepEqual(row(env, key).autoFix, { ci: false, review: false })
  assert.equal(env.delivery.sends.length, 0)
  await env.watcher.setAutoFix(key, 'ci', true)
  assert.deepEqual(env.store.peek('autofix')[key], { ci: true })
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.deepEqual(row(env, key).autoFix, { ci: true, review: false })
})

test('watcher: outbox question, track, tell and an unknown tell target', async () => {
  const env = await setup()
  env.spaces = clone(WORKSPACES.workspaces).filter((s) => s.path !== HOME)
  env.worktrees = clone(WORKTREES.worktrees)
  env.workers = clone(WORKERS.workers)
  env.watcher.setAgent(SPIKE, agentInfo('waiting', 'term_spike'))
  env.fs.files.set(HOME + '/outbox/1-1.msg', 'question\nYes|No\nShip it?')
  env.fs.files.set(HOME + '/outbox/2-1.msg', 'track\nctx_92026b9d61c3\n')
  env.fs.files.set(HOME + '/outbox/3-1.msg', 'tell\nspike-oa\nPlease rebase')
  env.fs.files.set(HOME + '/outbox/4-1.msg', 'tell\nnobody\nhello')
  await env.watcher.tick()
  const v = env.watcher.view()
  const q = v.chat.find((c) => c.kind === 'question')
  assert.equal(q.from, 'orchestrator')
  assert.equal(q.text, 'Ship it?')
  assert.deepEqual(q.options, ['Yes', 'No'])
  assert.equal(v.asks, 1)
  const spike = env.watcher.index().byKey(SPIKE)
  assert.equal(spike.started, 'orchestrator')
  assert.equal(spike.dispatchId, 'ctx_6fc5b45b8c33')
  assert.equal(row(env, SPIKE).started, 'orchestrator')
  assert.deepEqual(env.store.peek('tracked'), ['ctx_92026b9d61c3'])
  assert.deepEqual(env.delivery.sends.map((s) => [s.key, s.subject, s.body]), [[SPIKE, 'From the orchestrator', 'Please rebase']])
  const miss = v.chat.find((c) => c.from === 'panel')
  assert.equal(miss.text, 'Could not find a session named "nobody".')
  const acts = v.chat.filter((c) => c.kind === 'action')
  assert.deepEqual(acts.map((c) => [c.verb, c.ref, c.text]), [['start', 'ctx_92026b9d61c3', 'New workspace'], ['tell', SPIKE, 'Wrote to ' + spike.name]])
  assert.equal(acts[0].live, null)
  assert.equal(acts[1].live.key, SPIKE)
  assert.equal(acts[1].live.name, spike.name)
  assert.equal(typeof acts[1].live.label, 'string')
  assert.deepEqual(await env.fs.list(HOME + '/outbox'), [])
})

test('watcher: guarded holds orchestrator-started ids and the home workspace id, never a hand-started session', async () => {
  const env = await setup({ record: orchRecord({ marker: 'orch:spike' }) })
  env.spaces = clone(WORKSPACES.workspaces)
  env.worktrees = clone(WORKTREES.worktrees)
  env.workers = clone(WORKERS.workers)
  await env.watcher.tick()
  const g = env.watcher.guarded()
  const spike = env.watcher.index().byKey(SPIKE)
  assert.equal(spike.ids.length, 3)
  for (const id of spike.ids) assert.ok(g.has(id), id)
  assert.ok(g.has(WS))
  for (const id of env.watcher.index().byKey(BUILD).ids) assert.equal(g.has(id), false, id)
})

test('watcher: board.md is written on the first tick and not rewritten when nothing changed', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  const boardWrites = () => env.fs.writes.filter((p) => p === HOME + '/board.md').length
  assert.equal(boardWrites(), 1)
  const text = env.fs.files.get(HOME + '/board.md')
  assert.ok(text.includes('## Ready'), text)
  assert.ok(text.includes('PR #7'), text)
  env.now += 1000
  await env.watcher.tick()
  assert.equal(boardWrites(), 1)
  env.repos['o/a'] = [failing(7, 'feat')]
  env.now += 60000
  await env.watcher.tick()
  assert.equal(boardWrites(), 2)
})

test('watcher: the 501st appendChat keeps 500 and drops the first', () => {
  let log = []
  for (let i = 0; i < 501; i++) log = appendChat(log, { id: 'c' + i, at: i, from: 'you', kind: 'text', text: 't' + i })
  assert.equal(log.length, 500)
  assert.equal(log[0].id, 'c1')
  assert.equal(log[499].id, 'c500')
})

test('watcher: a tick that changes nothing calls no onChange and writes no storage', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.views.length, 1)
  assert.equal(env.views[0].rev, env.watcher.view().rev)
  const sets = env.store.sets.length
  await env.watcher.tick()
  assert.equal(env.views.length, 1)
  assert.equal(env.store.sets.length, sets)
  env.repos['o/a'] = [failing(7, 'feat')]
  env.now += 60000
  await env.watcher.tick()
  assert.equal(env.views.length, 2)
  assert.ok(env.views[1].rev > env.views[0].rev)
})

test('watcher: a CLI that rejects keeps the last sessions and queue, and the rest of the tick runs', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'working', agent: agentInfo('working', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.delivery.queued(key).length, 1)
  env.cliFail = () => true
  env.fs.files.set(HOME + '/outbox/1-1.msg', 'text\n\nstill here')
  env.repos['o/a'] = [failing(7, 'feat', 'sha2')]
  await env.watcher.tick()
  const v = env.watcher.view()
  assert.equal(row(env, key).pr, 7)
  assert.equal(env.delivery.queued(key).length, 1)
  assert.equal(env.store.peek('queue').length, 1)
  assert.ok(env.store.peek('ledgers')['o/a#7'])
  assert.equal(env.delivery.sends.length, 1)
  assert.ok(v.chat.some((c) => c.kind === 'text' && c.text === 'still here'))
  assert.equal(v.hooksOff, false)
})

test('watcher: a tick on a fresh watcher whose CLI rejects does not throw and prunes nothing', async () => {
  const store = memoryStore()
  store.data.set('queue', JSON.stringify([{ id: 'x', key: '/w/feat', subject: 's', body: 'b', at: 1 }]))
  store.data.set('ledgers', JSON.stringify({ 'o/a#7': { sent: { 'ci:o/a#7:sha1': 1 }, ciSends: { 'o/a#7': 1 }, firstFail: {}, last: {} } }))
  const env = await setup({ store })
  env.cliFail = () => true
  await env.watcher.tick()
  assert.equal(env.delivery.queued('/w/feat').length, 1)
  assert.ok(env.store.peek('ledgers')['o/a#7'])
  assert.deepEqual(env.watcher.view().rows, [])
})

test('watcher: one of two repositories failing leaves the other read and sent', async () => {
  const env = await setup()
  const a = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const b = addSession(env, 'other', { repo: 'o/b', agent: agentInfo('waiting', 't2') })
  env.repos['o/a'] = [failing(7, 'feat')]
  env.ghFail['o/b'] = { code: 1, stderr: 'boom' }
  await env.watcher.tick()
  assert.deepEqual(env.watcher.view().gh, { ok: false, reason: 'error' })
  assert.deepEqual(env.delivery.sends.map((s) => s.key), [a])
  assert.equal(row(env, a).stale, false)
  assert.equal(row(env, b).stale, true)
  assert.equal(row(env, b).pr, null)
})

test('watcher: a repository whose read throws is caught like a failed one', async () => {
  const env = await setup()
  const a = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const b = addSession(env, 'other', { repo: 'o/b', agent: agentInfo('waiting', 't2') })
  env.repos['o/a'] = [failing(7, 'feat')]
  const run = env.deps.run
  env.deps.run = async (cmd, args) => {
    if (args.includes('owner=o') && args.includes('name=b')) throw new Error('spawn failed')
    return run(cmd, args)
  }
  await env.watcher.tick()
  assert.deepEqual(env.delivery.sends.map((s) => s.key), [a])
  assert.equal(row(env, b).stale, true)
})

test('watcher: a tick called while one runs returns the running one', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const gate = deferred()
  env.hostHang = gate.promise
  const first = env.watcher.tick()
  const second = env.watcher.tick()
  assert.equal(first, second)
  await new Promise((r) => setImmediate(r))
  env.hostHang = null
  gate.resolve()
  await first
  await settle()
  assert.equal(env.hostCalls.filter((c) => c.method === 'workspace.list').length, 2)
  const third = env.watcher.tick()
  assert.notEqual(third, first)
  await third
})

test('watcher: two ticks asked for during a running tick run exactly one more tick after it', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const gate = deferred()
  env.hostHang = gate.promise
  const first = env.watcher.tick()
  await settle()
  assert.equal(env.watcher.tick(), first)
  assert.equal(env.watcher.tick(), first)
  env.hostHang = null
  gate.resolve()
  await first
  await settle()
  await settle()
  assert.equal(env.hostCalls.filter((c) => c.method === 'workspace.list').length, 2)
  assert.equal(ticks(env), 2)
})

test('watcher: a card whose prompt changes between ticks takes the new detail without a new notification', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'permission', agent: agentInfo('waiting', 't1') })
  env.watcher.noteTool('t1', { tool: 'Bash', input: { command: 'rm -rf build' }, at: T0 })
  await env.watcher.tick()
  const first = env.watcher.view().chat.find((c) => c.kind === 'card')
  assert.equal(first.card.detail, 'wants to run: rm -rf build')
  assert.equal(notes(env).length, 1)
  env.now += 1000
  env.watcher.noteTool('t1', { tool: 'Bash', input: { command: 'git push origin main' }, at: env.now })
  await env.watcher.tick()
  const v = env.watcher.view()
  const items = v.chat.filter((c) => c.kind === 'card')
  assert.equal(items.length, 1)
  assert.equal(items[0].id, first.id)
  assert.equal(items[0].card.detail, 'wants to run: git push origin main')
  assert.equal(items[0].card.at, first.card.at)
  assert.equal(items[0].text, 'feat: wants to run: git push origin main')
  assert.equal(row(env, key).card.detail, 'wants to run: git push origin main')
  assert.equal(notes(env).length, 1)
  await settle()
  assert.equal(env.store.peek('cards')[0].detail, 'wants to run: git push origin main')
  assert.equal(env.store.peek('chat').find((c) => c.kind === 'card').card.detail, 'wants to run: git push origin main')
})

test('watcher: Pick an answer below stays on the card until its prompt changes', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'permission', agent: agentInfo('waiting', 't1') })
  env.watcher.noteTool('t1', { tool: 'Bash', input: { command: 'ls' }, at: T0 })
  await env.watcher.tick()
  await env.watcher.setCardDetail('approval:' + key, 'Pick an answer below')
  await env.watcher.tick()
  assert.equal(row(env, key).card.detail, 'Pick an answer below')
  env.watcher.noteTool('t1', { tool: 'Bash', input: { command: 'pwd' }, at: T0 })
  await env.watcher.tick()
  assert.equal(row(env, key).card.detail, 'wants to run: pwd')
  assert.equal(notes(env).length, 1)
})

function orchStarted(env, name) {
  return addSession(env, name, { comment: 'orch:abc', agent: agentInfo('working', 't-' + name) })
}

test('watcher: guarded ids persisted before a restart are back after load with no tick', async () => {
  const store = memoryStore()
  store.data.set('guarded', JSON.stringify(['ws-a', 'ws-b']))
  const env = await setup({ store })
  const g = env.watcher.guarded()
  assert.ok(g.has('ws-a'))
  assert.ok(g.has('ws-b'))
  assert.ok(g.has(WS))
  assert.equal(ticks(env), 0)
})

test('watcher: guarded ids are stored when they change and survive a restart whose sessions read fails', async () => {
  const env = await setup()
  const key = orchStarted(env, 'feat')
  await env.watcher.tick()
  const ids = env.watcher.index().byKey(key).ids
  assert.ok(ids.length > 0)
  await settle()
  for (const id of ids) assert.ok(env.store.peek('guarded').includes(id), id)
  await env.rewire()
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  env.cliFail = (a) => a[0] === 'worktree'
  await env.watcher.tick()
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  assert.ok(env.watcher.guarded().has(WS))
})

test('watcher: a new orchestrator worker is guarded once the sessions step is done, before GitHub answers', async () => {
  const env = await setup()
  addSession(env, 'old', { agent: agentInfo('waiting', 't0') })
  await env.watcher.tick()
  const key = orchStarted(env, 'feat')
  const gate = deferred()
  const run = env.deps.run
  env.deps.run = async (cmd, args) => {
    if (args[0] === 'api') await gate.promise
    return run(cmd, args)
  }
  const pending = env.watcher.tick()
  await settle()
  const session = env.watcher.index().byKey(key)
  assert.ok(session)
  for (const id of session.ids) assert.ok(env.watcher.guarded().has(id), id)
  gate.resolve()
  await pending
})

test('watcher: guardNow guards ids at once and keeps them until a session shows them', async () => {
  const env = await setup()
  env.watcher.guardNow(['ws-new'])
  assert.ok(env.watcher.guarded().has('ws-new'))
  await env.watcher.tick()
  assert.ok(env.watcher.guarded().has('ws-new'))
  await settle()
  assert.ok(env.store.peek('guarded').includes('ws-new'))
})

function setComment(env, path, comment) {
  env.worktrees.find((t) => t.path === path).comment = comment
}

async function tickAt(env, ms) {
  env.now = T0 + ms
  await env.watcher.tick()
}

test('watcher: a guarded orchestrator worker read once as hand-started and then orchestrator-started again never leaves guarded', async () => {
  const env = await setup()
  const key = orchStarted(env, 'feat')
  await tickAt(env, 0)
  const ids = env.watcher.index().byKey(key).ids
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  setComment(env, key, '')
  await tickAt(env, 60000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  await tickAt(env, 120000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  setComment(env, key, 'orch:abc')
  await tickAt(env, 180000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  setComment(env, key, '')
  await tickAt(env, 240000)
  await tickAt(env, 300000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  assert.ok(env.watcher.guarded().has(WS))
})

test('watcher: a guarded id read as hand-started in 3 consecutive reads over 2 minutes is removed and the change is stored', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const id = 'identity:wt2:local:feat'
  env.watcher.guardNow([id])
  await tickAt(env, 0)
  assert.ok(env.watcher.guarded().has(id))
  await tickAt(env, 60000)
  assert.ok(env.watcher.guarded().has(id))
  await tickAt(env, 120000)
  assert.equal(env.watcher.guarded().has(id), false)
  assert.ok(env.watcher.guarded().has(WS))
  await settle()
  assert.equal(env.store.peek('guarded').includes(id), false)
})

test('watcher: 3 hand-started reads within 30 seconds keep the id guarded', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const id = 'identity:wt2:local:feat'
  env.watcher.guardNow([id])
  await tickAt(env, 0)
  await tickAt(env, 15000)
  await tickAt(env, 30000)
  assert.ok(env.watcher.guarded().has(id))
})

test('watcher: a failed sessions read between hand-started reads keeps the id guarded and does not advance the count', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const id = 'identity:wt2:local:feat'
  env.watcher.guardNow([id])
  await tickAt(env, 0)
  env.cliFail = (a) => a[0] === 'worktree'
  await tickAt(env, 60000)
  assert.ok(env.watcher.guarded().has(id))
  env.cliFail = null
  await tickAt(env, 120000)
  assert.ok(env.watcher.guarded().has(id))
  await tickAt(env, 125000)
  assert.equal(env.watcher.guarded().has(id), false)
})

test('watcher: a guarded worktree absent for 9 minutes stays guarded and is removed after 10', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.watcher.guardNow(['ws-gone'])
  await tickAt(env, 0)
  assert.ok(env.watcher.guarded().has('ws-gone'))
  await tickAt(env, 9 * 60000)
  assert.ok(env.watcher.guarded().has('ws-gone'))
  await tickAt(env, 10 * 60000)
  assert.equal(env.watcher.guarded().has('ws-gone'), false)
  assert.ok(env.watcher.guarded().has(WS))
})

test('watcher: a guarded worker missing from a short list for a few reads stays guarded when it comes back', async () => {
  const env = await setup()
  const key = orchStarted(env, 'feat')
  await tickAt(env, 0)
  const ids = env.watcher.index().byKey(key).ids
  const trees = env.worktrees
  env.worktrees = []
  await tickAt(env, 60000)
  await tickAt(env, 5 * 60000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
  env.worktrees = trees
  await tickAt(env, 12 * 60000)
  for (const id of ids) assert.ok(env.watcher.guarded().has(id), id)
})

test('watcher: a truly hand-started workspace never pinned or guarded is never in guarded', async () => {
  const env = await setup()
  const key = addSession(env, 'mine', { agent: agentInfo('waiting', 't1') })
  for (let m = 0; m <= 15; m += 1) {
    await tickAt(env, m * 60000)
    for (const id of env.watcher.index().byKey(key).ids) assert.equal(env.watcher.guarded().has(id), false, id)
  }
})

test('watcher: a restart restores the guarded set and restarts the count, so it only delays a removal', async () => {
  const store = memoryStore()
  const id = 'identity:wt2:local:feat'
  store.data.set('guarded', JSON.stringify([id, 'ws-gone']))
  const env = await setup({ store })
  assert.ok(env.watcher.guarded().has(id))
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await tickAt(env, 0)
  await tickAt(env, 60000)
  assert.ok(env.watcher.guarded().has(id))
  await env.rewire()
  assert.ok(env.watcher.guarded().has(id))
  await tickAt(env, 120000)
  await tickAt(env, 180000)
  assert.ok(env.watcher.guarded().has(id))
  assert.ok(env.watcher.guarded().has('ws-gone'))
  await tickAt(env, 240000)
  assert.equal(env.watcher.guarded().has(id), false)
})

test('watcher: guardNow past the 200 pin cap returns promptly, evicts the oldest pin and keeps the newest', async () => {
  const env = await setup()
  const ids = Array.from({ length: 201 }, (_, i) => 'pin-' + i)
  const began = Date.now()
  for (const id of ids) env.watcher.guardNow([id])
  assert.ok(Date.now() - began < 2000)
  await env.watcher.tick()
  const g = env.watcher.guarded()
  assert.equal(g.has('pin-0'), false)
  assert.ok(g.has('pin-200'))
  assert.equal(ids.filter((id) => g.has(id)).length, 200)
  assert.ok(g.has(WS))
})

test('watcher: with no status event, a tick after the agent is seen working then idle in the list sends the queued message once', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  const session = env.watcher.index().byKey(key)
  assert.equal(await env.delivery.send(session, 'S1', 'one'), 'sent')
  assert.equal(await env.delivery.send(session, 'S2', 'two'), 'queued')
  const sends = () => env.cliCalls.filter((a) => a[0] === 'terminal' && a[1] === 'send').map((a) => a[4])
  await env.watcher.tick()
  assert.deepEqual(sends(), ['--text=S1\n\none'])
  const space = env.spaces.find((s) => s.path === key)
  space.status.state = 'working'
  await env.watcher.tick()
  assert.deepEqual(sends(), ['--text=S1\n\none'])
  space.status.state = 'active'
  await env.watcher.tick()
  assert.deepEqual(sends(), ['--text=S1\n\none', '--text=S2\n\ntwo'])
  await env.watcher.tick()
  assert.equal(sends().length, 2)
  assert.equal(env.delivery.queued(key).length, 0)
})

test('watcher: with no status event, a tick after the orchestrator is seen working then idle sends its queued message once', async () => {
  const env = await setup({ record: orchRecord({ agent: agentInfo('waiting', 'term_o1') }) })
  const orch = env.orchestrator.session()
  assert.equal(await env.delivery.send(orch, 'From Aamon', 'one'), 'sent')
  assert.equal(await env.delivery.send(env.orchestrator.session(), 'From Aamon', 'two'), 'queued')
  const sends = () => env.cliCalls.filter((a) => a[0] === 'terminal' && a[1] === 'send').map((a) => a[4])
  await env.watcher.tick()
  assert.equal(sends().length, 1)
  env.spaces = [homeRow('working')]
  await env.watcher.tick()
  assert.equal(sends().length, 1)
  env.spaces = [homeRow('active')]
  await env.watcher.tick()
  assert.deepEqual(sends(), ['--text=From Aamon\n\none', '--text=From Aamon\n\ntwo'])
  await env.watcher.tick()
  assert.equal(sends().length, 2)
})

test('watcher: noteGuard adds a merge-blocked card that stays until resolved and counts blocks today', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  env.watcher.noteGuard(key, { rule: 'merge', command: 'gh pr merge 1' }, true)
  env.watcher.noteGuard('orchestrator', { rule: 'force-push', command: 'git push -f' }, false)
  await new Promise((r) => setImmediate(r))
  await env.watcher.tick()
  await env.watcher.tick()
  const v = env.watcher.view()
  assert.equal(v.guard.on, true)
  assert.equal(v.guard.blocksToday, 1)
  assert.equal(v.needs, 2)
  assert.equal(row(env, key).lane, 'needs')
  assert.equal(row(env, key).phrase, 'Merge blocked')
  const orchCard = v.chat.find((c) => c.card && c.card.key === 'orchestrator').card
  assert.ok(orchCard.detail.includes('attempted'))
  assert.deepEqual(orchCard.actions, ['dismiss', 'details'])
  await env.watcher.resolveCard('merge-blocked:' + key, 'dismissed')
  assert.equal(env.watcher.view().needs, 1)
  assert.equal(env.watcher.view().chat.find((c) => c.card && c.card.key === key).card.resolved, 'dismissed')
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  assert.equal(row(env, key).lane, 'idle')
})

test('watcher: an unreachable send adds a Can\'t reach card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  const r = row(env, key)
  assert.equal(r.lane, 'needs')
  assert.equal(r.phrase, 'No agent to message')
  assert.equal(r.card.kind, 'unreachable')
  assert.deepEqual(r.card.actions, ['start', 'dismiss', 'details'])
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.watcher.view().chat.filter((c) => c.kind === 'card').length, 1)
})

test('watcher: stored chat, cards and tracked ids load once and addChat replaces an item with the same id', async () => {
  const env = await setup()
  await env.watcher.addChat({ id: 'q1', at: 1, from: 'orchestrator', kind: 'question', text: 'Go?', options: ['Yes'] })
  env.watcher.track('ctx_1')
  await new Promise((r) => setImmediate(r))
  await env.rewire()
  assert.equal(env.watcher.view().asks, 1)
  await env.watcher.addChat({ id: 'q1', at: 1, from: 'orchestrator', kind: 'question', text: 'Go?', options: ['Yes'], answered: 'Yes' })
  assert.equal(env.watcher.view().asks, 0)
  assert.equal(env.watcher.view().chat.length, 1)
  assert.deepEqual(env.store.peek('tracked'), ['ctx_1'])
})

function fakeTimers() {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const pending = new Map()
  let clock = 0
  let ids = 0
  globalThis.setTimeout = (fn, ms) => {
    ids += 1
    pending.set(ids, { fn, at: clock + (ms ?? 0), ms })
    return ids
  }
  globalThis.clearTimeout = (id) => {
    pending.delete(id)
  }
  return {
    pending,
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        clock = due[1].at
        due[1].fn()
        await settle()
      }
      clock = end
      await settle()
    },
    restore() {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  }
}

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

function ticks(env) {
  return env.cliCalls.filter((a) => a[0] === 'worktree').length
}

function logRounds(env) {
  return env.runCalls.filter((c) => c.args[0] === 'run' && c.args[1] === 'view').length
}

test('watcher: start ticks right away, honours intervalSec, and stop leaves no pending timer', async () => {
  const env = await setup({ settings: { intervalSec: 30 } })
  const clock = fakeTimers()
  try {
    env.watcher.start()
    await settle()
    assert.equal(ticks(env), 1)
    assert.equal(clock.pending.size, 1)
    assert.equal([...clock.pending.values()][0].ms, 30000)
    await clock.advance(29999)
    assert.equal(ticks(env), 1)
    await clock.advance(1)
    assert.equal(ticks(env), 2)
    assert.equal(clock.pending.size, 1)
    env.watcher.stop()
    assert.equal(clock.pending.size, 0)
    await clock.advance(300000)
    assert.equal(ticks(env), 2)
  } finally {
    env.watcher.stop()
    clock.restore()
  }
})

test('watcher: start twice runs one schedule chain', async () => {
  const env = await setup()
  const clock = fakeTimers()
  try {
    env.watcher.start()
    env.watcher.start()
    await settle()
    assert.equal(ticks(env), 1)
    assert.equal(clock.pending.size, 1)
    await clock.advance(60000)
    await clock.advance(60000)
    assert.equal(ticks(env), 3)
    assert.equal(clock.pending.size, 1)
  } finally {
    env.watcher.stop()
    clock.restore()
  }
})

test('watcher: stop then start during an in-flight tick runs one schedule chain', async () => {
  const env = await setup()
  const clock = fakeTimers()
  try {
    const gate = deferred()
    env.hostHang = gate.promise
    env.watcher.start()
    await settle()
    env.watcher.stop()
    env.watcher.start()
    env.hostHang = null
    gate.resolve()
    await settle()
    assert.equal(ticks(env), 1)
    assert.equal(clock.pending.size, 1)
    await clock.advance(60000)
    await clock.advance(60000)
    await clock.advance(60000)
    assert.equal(ticks(env), 4)
    assert.equal(clock.pending.size, 1)
  } finally {
    env.watcher.stop()
    clock.restore()
  }
})

test('watcher: a restart whose first sessions read fails keeps the persisted card and never notifies again', async () => {
  const env = await setup()
  addSession(env, 'feat', { state: 'permission', agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  assert.equal(notes(env).length, 1)
  const before = env.watcher.view().chat.find((c) => c.kind === 'card')
  await settle()
  await env.rewire()
  const base = notes(env).length
  const check = () => {
    const v = env.watcher.view()
    assert.equal(notes(env).length, base)
    assert.equal(v.needs, 1)
    const items = v.chat.filter((c) => c.kind === 'card')
    assert.equal(items.length, 1)
    assert.deepEqual(items[0], before)
  }
  check()
  env.cliFail = (a) => a[0] === 'worktree'
  await env.watcher.tick()
  check()
  env.cliFail = null
  await env.watcher.tick()
  check()
  await env.watcher.tick()
  check()
})

async function reachLimit(env) {
  for (const sha of ['s1', 's2', 's3', 's4']) {
    env.repos['o/a'] = [failing(7, 'feat', sha)]
    env.now += 60000
    await env.watcher.tick()
  }
}

test('watcher: a restart whose repository read fails keeps a persisted attempts card and never notifies again', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await reachLimit(env)
  const before = env.watcher.view().chat.find((c) => c.kind === 'card')
  assert.equal(before.card.kind, 'attempts')
  await settle()
  await env.rewire()
  const base = notes(env).length
  env.ghFail['o/a'] = { code: 1, stderr: 'boom' }
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  assert.deepEqual(env.watcher.view().chat.filter((c) => c.kind === 'card'), [before])
  delete env.ghFail['o/a']
  env.now += 60000
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  assert.deepEqual(env.watcher.view().chat.filter((c) => c.kind === 'card'), [before])
  assert.equal(notes(env).length, base)
})

test('watcher: a closed PR clears the fix limit and its attempts card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await reachLimit(env)
  assert.equal(env.watcher.view().needs, 1)
  env.repos['o/a'] = []
  env.now += 60000
  await env.watcher.tick()
  const v = env.watcher.view()
  assert.equal(v.needs, 0)
  assert.equal(v.chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
  assert.notEqual(row(env, key).lane, 'needs')
})

test('watcher: an unreachable tell shows a card that clears on the next tick', async () => {
  const env = await setup()
  addSession(env, 'feat')
  env.fs.files.set(HOME + '/outbox/1-1.msg', 'tell\nfeat\nhello')
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.watcher.view().needs, 1)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.kind, 'unreachable')
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
})

test('watcher: a PR that goes green clears the Can\'t reach card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(row(env, key).card.kind, 'unreachable')
  env.repos['o/a'] = [green(7, 'feat')]
  env.now += 60000
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(row(env, key).lane, 'ready')
})

test('watcher: an agent appearing clears the Can\'t reach card and sends once more', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.watcher.view().needs, 1)
  env.watcher.setAgent(key, agentInfo('waiting', 't1'))
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 2)
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
})

test('watcher: a session that is gone loses its Can\'t reach card and mark', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  const spaces = clone(env.spaces)
  const trees = clone(env.worktrees)
  env.worktrees = []
  env.spaces = env.spaces.filter((s) => s.path !== key)
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.resolved, 'cleared')
  env.spaces = spaces
  env.worktrees = trees
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 2)
})

test('watcher: an agent appearing while the repository read fails still clears the Can\'t reach card', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  env.ghFail['o/a'] = { code: 1, stderr: 'boom' }
  env.watcher.setAgent(key, agentInfo('working', 't1'))
  env.now += 60000
  await env.watcher.tick()
  assert.equal(row(env, key).stale, true)
  assert.equal(env.watcher.view().needs, 0)
})

test('watcher: a restart keeps a persisted Can\'t reach card through failed reads and does not resend', async () => {
  const env = await setup()
  addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  const before = env.watcher.view().chat.find((c) => c.kind === 'card')
  await settle()
  await env.rewire()
  const base = notes(env).length
  env.cliFail = (a) => a[0] === 'worktree'
  await env.watcher.tick()
  env.cliFail = null
  env.ghFail['o/a'] = { code: 1, stderr: 'boom' }
  await env.watcher.tick()
  delete env.ghFail['o/a']
  await env.watcher.tick()
  assert.equal(env.watcher.view().needs, 1)
  assert.deepEqual(env.watcher.view().chat.filter((c) => c.kind === 'card'), [before])
  assert.equal(notes(env).length, base)
  assert.equal(env.delivery.sends.length, 0)
})

test('watcher: an unreachable session is not re-sent until its agent info changes, and its log tails are fetched once', async () => {
  const env = await setup()
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  for (let i = 0; i < 3; i++) await env.watcher.tick()
  assert.equal(logRounds(env), 1)
  assert.equal(env.delivery.sends.length, 1)
  env.watcher.setAgent(key, agentInfo('working', null))
  await env.watcher.tick()
  assert.equal(logRounds(env), 1)
  assert.equal(env.delivery.sends.length, 2)
  await env.watcher.tick()
  assert.equal(logRounds(env), 1)
  assert.equal(env.delivery.sends.length, 2)
})

test('watcher: a send that throws does not stop the tick and is retried next tick', async () => {
  const env = await setup()
  const a = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const b = addSession(env, 'other', { agent: agentInfo('waiting', 't2') })
  env.repos['o/a'] = [failing(7, 'feat'), failing(8, 'other')]
  const send = env.delivery.send
  let boom = true
  env.delivery.send = (session, subject, body) => {
    if (boom && session.key === a) throw new Error('send blew up')
    return send(session, subject, body)
  }
  await env.watcher.tick()
  assert.deepEqual(env.delivery.sends.map((s) => s.key), [b])
  assert.equal(row(env, b).pr, 8)
  assert.equal(env.store.peek('ledgers')['o/a#7'].sent['ci:o/a#7:sha1'], undefined)
  boom = false
  await env.watcher.tick()
  assert.deepEqual(env.delivery.sends.map((s) => s.key), [b, a])
})

test('watcher: detail gives checks, unresolved threads, attempts and the last send', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const thread = (id, resolved) => ({ id, isResolved: resolved, comments: { nodes: [{ id: 'c' + id, author: { __typename: 'User', login: 'ann' }, body: 'fix ' + id, url: 'u', path: 'a.ts', line: 3 }] } })
  env.repos['o/a'] = [prNode({ number: 7, branch: 'feat', checks: [checkRun('lint', 'FAILURE', 101), checkRun('test', 'SUCCESS', 102)], threads: [thread('t1', false), thread('t2', true)] })]
  assert.equal(env.watcher.detail(key), null)
  await env.watcher.tick()
  const d = env.watcher.detail(key)
  assert.deepEqual(d.checks, [{ name: 'lint', state: 'fail', url: 'https://ci/101' }, { name: 'test', state: 'pass', url: 'https://ci/102' }])
  assert.deepEqual(d.threads, [{ resolved: false, comments: [{ author: 'ann', path: 'a.ts', line: 3, body: 'fix t1' }] }])
  assert.deepEqual(d.attempts, { used: 1, max: 3 })
  assert.equal(d.lastSent.sha, 'sha1')
  assert.equal(d.lastSent.at, T0)
  assert.ok(typeof d.lastSent.kind === 'string')
  assert.equal(env.watcher.detail('/w/none'), null)
})

test('watcher: setCardDetail updates the open card and its chat item, persists and publishes', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { state: 'permission', agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  const views = env.views.length
  await env.watcher.setCardDetail('approval:' + key, 'Pick an answer below')
  assert.equal(env.views.length, views + 1)
  assert.equal(row(env, key).card.detail, 'Pick an answer below')
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.detail, 'Pick an answer below')
  assert.equal(env.store.peek('cards')[0].detail, 'Pick an answer below')
  await env.watcher.tick()
  assert.equal(row(env, key).card.detail, 'Pick an answer below')
  await env.watcher.setCardDetail('approval:nobody', 'x')
  assert.equal(env.watcher.view().needs, 1)
})

test('watcher: addChat assigns an id when empty and answerQuestion answers once', async () => {
  const env = await setup()
  assert.equal(await env.watcher.addChat({ id: 'keep', at: 1, from: 'you', kind: 'text', text: 'hi' }), 'keep')
  const id = await env.watcher.addChat({ id: '', at: 2, from: 'orchestrator', kind: 'question', text: 'Go?', options: ['Yes', 'No'] })
  assert.ok(id !== '')
  assert.equal(env.watcher.view().chat.find((c) => c.id === id).text, 'Go?')
  assert.equal(env.watcher.view().asks, 1)
  const views = env.views.length
  assert.equal(await env.watcher.answerQuestion(id, 'Yes'), true)
  assert.equal(env.views.length, views + 1)
  assert.equal(env.watcher.view().asks, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.id === id).answered, 'Yes')
  assert.equal(env.store.peek('chat').find((c) => c.id === id).answered, 'Yes')
  assert.equal(await env.watcher.answerQuestion(id, 'No'), false)
  assert.equal(await env.watcher.answerQuestion('missing', 'Yes'), false)
  assert.equal(await env.watcher.answerQuestion('keep', 'Yes'), false)
})

test('watcher: works against mockHost with no refusals and no forbidden call', async () => {
  const spaces = { workspaces: [homeRow('active'), spaceRow('/w/feat', 'feat', 'permission')], truncated: false }
  const host = mockHost({ results: { 'workspace.list': spaces, 'notifications.show': { delivered: true } } })
  let orca
  const worker = await mountWorker({ default: (api) => { orca = api } }, { host })
  const env = await setup({ host: orca.host, store: orca.storage })
  env.worktrees.push(treeRow('/w/feat', 'feat', 'o/a'))
  env.repos['o/a'] = [failing(7, 'feat')]
  env.watcher.setAgent('/w/feat', agentInfo('waiting', 't1'))
  await env.watcher.tick()
  await env.watcher.tick()
  assert.equal(host.callsOf('notifications.show').length, 1)
  assert.equal(env.watcher.view().needs, 1)
  for (const name of FORBIDDEN) assert.deepEqual(host.callsOf(name), [], name)
  assert.deepEqual(host.refusals, [])
  assert.equal(env.cliCalls.filter((a) => a[0] === 'terminal' && a[1] === 'send').length, 0)
  await worker.deactivate()
})

function readsOf(env, repo) {
  const [owner, name] = repo.split('/')
  return graphqlCalls(env).filter((c) => c.args.includes('owner=' + owner) && c.args.includes('name=' + name)).length
}

function ghCalls(env) {
  return env.runCalls.filter((c) => c.cmd === '/bin/gh').length
}

test('watcher: 30 ticks inside one interval read GitHub once, and the next interval reads it once more', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  for (let i = 0; i < 30; i++) {
    await env.watcher.tick()
    env.now += 1000
  }
  assert.equal(graphqlCalls(env).length, 1)
  env.now = T0 + 60000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 2)
})

test('watcher: two repositories are each read once per interval', async () => {
  const env = await setup()
  addSession(env, 'feat', { repo: 'o/a', agent: agentInfo('waiting', 't1') })
  addSession(env, 'other', { repo: 'o/b', agent: agentInfo('waiting', 't2') })
  for (let i = 0; i < 10; i++) {
    await env.watcher.tick()
    env.now += 5000
  }
  assert.equal(readsOf(env, 'o/a'), 1)
  assert.equal(readsOf(env, 'o/b'), 1)
  env.now = T0 + 60000
  for (let i = 0; i < 5; i++) await env.watcher.tick()
  assert.equal(readsOf(env, 'o/a'), 2)
  assert.equal(readsOf(env, 'o/b'), 2)
})

test('watcher: a rate-limited answer stops every repository read for 300 seconds and rounds the countdown to 30 seconds', async () => {
  const env = await setup()
  addSession(env, 'feat', { repo: 'o/a', agent: agentInfo('waiting', 't1') })
  addSession(env, 'other', { repo: 'o/b', agent: agentInfo('waiting', 't2') })
  env.ghFail['o/a'] = { code: 1, stderr: 'API rate limit exceeded for user' }
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 1)
  assert.equal(readsOf(env, 'o/b'), 0)
  assert.equal(env.watcher.view().gh.retryInSec, 300)
  env.now = T0 + 10000
  await env.watcher.tick()
  assert.equal(env.watcher.view().gh.retryInSec, 300)
  env.now = T0 + 45000
  await env.watcher.tick()
  assert.equal(env.watcher.view().gh.retryInSec, 270)
  delete env.ghFail['o/a']
  for (let t = 60000; t < 300000; t += 60000) {
    env.now = T0 + t
    await env.watcher.tick()
  }
  env.now = T0 + 299999
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 1)
  env.now = T0 + 300000
  await env.watcher.tick()
  assert.equal(readsOf(env, 'o/a'), 2)
  assert.equal(readsOf(env, 'o/b'), 1)
  assert.deepEqual(env.watcher.view().gh, { ok: true })
})

test('watcher: retry forces one fresh read, and a second retry within 10 seconds does not', async () => {
  const env = await setup()
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 1)
  env.now += 20000
  await env.watcher.retry(key)
  assert.equal(graphqlCalls(env).length, 2)
  env.now += 5000
  await env.watcher.retry(key)
  assert.equal(graphqlCalls(env).length, 2)
})

test('watcher: changing intervalSec forces one fresh read, still no sooner than 10 seconds after the last', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  env.now += 5000
  env.settings.intervalSec = 120
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 1)
  env.now += 10000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 2)
  env.now += 10000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 2)
})

test('watcher: a quiet tick inside the window makes no gh call and calls no onChange', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [green(7, 'feat')]
  await env.watcher.tick()
  env.now += 5000
  await env.watcher.tick()
  const calls = ghCalls(env)
  const views = env.views.length
  env.now += 5000
  await env.watcher.tick()
  assert.equal(ghCalls(env), calls)
  assert.equal(env.views.length, views)
})

test('watcher: an unsent CI event fetches its log tails once across 5 ticks', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  env.delivery.send = async () => {
    throw new Error('send failed')
  }
  for (let i = 0; i < 5; i++) {
    await env.watcher.tick()
    env.now += 60000
  }
  assert.equal(graphqlCalls(env).length, 5)
  assert.equal(logRounds(env), 1)
})

test('putPlan updates the plan in place until you send another message, then starts a new one', () => {
  let n = 0
  const id = () => `o${++n}`
  const a = [{ text: 'one', status: 'active' }, { text: 'two', status: 'pending' }]
  const b = [{ text: 'one', status: 'done' }, { text: 'two', status: 'active' }]
  let log = putPlan([{ id: 'u1', at: 1, from: 'you', kind: 'text', text: 'go' }], a, id, 2)
  assert.equal(log.length, 2)
  assert.deepEqual(log[1], { id: 'o1', at: 2, from: 'orchestrator', kind: 'plan', text: 'Plan · 0 of 2 done', plan: a })
  log = [...log, { id: 'x', at: 3, from: 'orchestrator', kind: 'progress', text: 'working' }]
  log = putPlan(log, b, id, 4)
  assert.equal(log.length, 3)
  assert.deepEqual(log[1], { id: 'o1', at: 2, from: 'orchestrator', kind: 'plan', text: 'Plan · 1 of 2 done', plan: b })
  log = [...log, { id: 'u2', at: 5, from: 'you', kind: 'text', text: 'next' }]
  log = putPlan(log, a, id, 6)
  assert.equal(log.length, 5)
  assert.equal(log[4].id, 'o2')
  assert.deepEqual(log[1].plan, b)
})

function conflicting(number, branch) {
  return prNode({ number, branch, mergeable: 'CONFLICTING', checks: [checkRun('test', 'SUCCESS', 1)] })
}

test('watcher: Ask me holds a CI fix behind a card, and Fix it sends it once', async () => {
  const env = await setup({ settings: { onCi: 'ask' } })
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 0)
  const r = row(env, key)
  assert.equal(r.lane, 'needs')
  assert.equal(r.phrase, 'Waiting for your go · CI failed')
  assert.equal(r.card.kind, 'ask')
  assert.deepEqual(r.card.actions, ['fix', 'dismiss', 'details'])
  await env.watcher.tick()
  assert.equal(env.watcher.view().chat.filter((c) => c.kind === 'card').length, 1)
  await env.watcher.fixAsked(key)
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.delivery.sends[0].subject, 'CI failed on #7')
  assert.equal(env.watcher.view().needs, 0)
  assert.equal(env.watcher.view().chat.find((c) => c.kind === 'card').card.resolved, 'fix')
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.watcher.view().needs, 0)
})

test('watcher: dismissing an Ask me card sends nothing and does not ask again for the same commit', async () => {
  const env = await setup({ settings: { onCi: 'ask' } })
  const key = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  await env.watcher.resolveCard(row(env, key).card.id, 'dismissed')
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 0)
  assert.equal(env.watcher.view().needs, 0)
  env.repos['o/a'] = [failing(7, 'feat', 'sha2')]
  env.now += 60000
  await env.watcher.tick()
  assert.equal(row(env, key).card.kind, 'ask')
})

test('watcher: Ignore sends nothing and raises no card, and each kind has its own choice', async () => {
  const env = await setup({ settings: { onCi: 'ignore', onConflict: 'ask' } })
  const a = addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  const b = addSession(env, 'other', { agent: agentInfo('waiting', 't2') })
  env.repos['o/a'] = [failing(7, 'feat'), conflicting(8, 'other')]
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 0)
  assert.equal(row(env, a).card, null)
  assert.equal(row(env, a).phrase, 'CI failing')
  assert.equal(row(env, b).card.kind, 'ask')
  assert.equal(row(env, b).card.detail, 'Merge conflicts')
  env.settings.onConflict = 'fix'
  await env.watcher.tick()
  assert.equal(env.delivery.sends.length, 1)
  assert.equal(env.delivery.sends[0].subject, 'Merge conflict on #8')
  assert.equal(row(env, b).card, null)
})

test('watcher: with no agent running it starts one, waits two minutes, then falls back to the card', async () => {
  const env = await setup({ settings: { noAgent: 'start' } })
  const real = env.host.call
  env.host.call = async (method, params) => {
    if (method !== 'agent.launch') return real(method, params)
    env.hostCalls.push({ method, params })
    return {}
  }
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(env.host.callsOf('agent.launch').length, 1)
  assert.equal(env.host.callsOf('agent.launch')[0].agent, 'claude')
  assert.equal(row(env, key).card, null)
  assert.ok(env.watcher.view().chat.some((c) => c.from === 'panel' && c.text === 'Started an agent in feat to work on its pull request.'))
  env.now += 30000
  await env.watcher.tick()
  assert.equal(env.host.callsOf('agent.launch').length, 1)
  assert.equal(row(env, key).card, null)
  env.now += 150000
  await env.watcher.tick()
  assert.equal(env.host.callsOf('agent.launch').length, 1)
  assert.equal(row(env, key).card.kind, 'unreachable')
})

test('watcher: a failed agent start falls back to the no-agent card', async () => {
  const env = await setup({ settings: { noAgent: 'start' } })
  const key = addSession(env, 'feat')
  env.repos['o/a'] = [failing(7, 'feat')]
  await env.watcher.tick()
  assert.equal(row(env, key).card.kind, 'unreachable')
})

test('watcher: asks GitHub only for the branches it tracks and reads again when a new branch shows up', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  const branchArgs = (call) => call.args.filter((a) => /^b\d+=/.test(a))
  assert.equal(graphqlCalls(env).length, 1)
  assert.deepEqual(branchArgs(graphqlCalls(env)[0]), ['b0=feat'])
  env.now += 15000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 1)
  addSession(env, 'fix', { agent: agentInfo('waiting', 't2') })
  env.now += 15000
  await env.watcher.tick()
  assert.equal(graphqlCalls(env).length, 2)
  assert.deepEqual(branchArgs(graphqlCalls(env)[1]), ['b0=feat', 'b1=fix'])
})

test('watcher: a rate-limit refusal with budget left waits a minute, not five', async () => {
  const env = await setup()
  addSession(env, 'feat', { agent: agentInfo('waiting', 't1') })
  await env.watcher.tick()
  assert.deepEqual(env.watcher.view().gh, { ok: true })
  env.ghFail['o/a'] = { code: 1, stderr: 'API rate limit already exceeded for user ID 1.' }
  env.budget = { limit: 5000, remaining: 4400, reset: Math.floor(env.now / 1000) + 900 }
  env.now += 60000
  await env.watcher.tick()
  const gh = env.watcher.view().gh
  assert.equal(gh.reason, 'rate-limited')
  assert.equal(gh.retryInSec, 60)
  delete env.ghFail['o/a']
  env.now += 61000
  await env.watcher.tick()
  assert.deepEqual(env.watcher.view().gh, { ok: true })
})
