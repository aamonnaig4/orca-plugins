import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mockHost, mountWorker } from 'orca/testing'
import { CliError } from '../src/orcacli.ts'
import { createDelivery } from '../src/deliver.ts'

function session(over = {}) {
  const { agent, ...rest } = over
  const path = rest.path ?? '/w/a'
  return {
    key: path,
    ids: ['identity:wt2:local:' + path, 'r::' + path, 'inst' + path],
    path,
    name: 'a',
    project: 'orca-plugins',
    repoId: 'r',
    repo: 'o/n',
    branch: 'feature',
    isMain: false,
    agent: { state: 'waiting', terminalId: 'term_a', sessionId: null, chatId: null, kind: null, since: 0, permissionMasked: false, ...agent },
    dispatchId: null,
    started: 'you',
    ...rest
  }
}

function listOf(rows) {
  return {
    workspaces: Object.entries(rows).map(([path, state]) => ({
      id: 'identity:wt2:local:' + path,
      kind: 'worktree',
      name: 'n',
      path,
      branch: 'feature',
      hostId: 'local',
      status: { state, unread: false, terminalCount: 1, lastActivityAt: null }
    })),
    truncated: false
  }
}

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    data,
    async get(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null
    },
    async set(key, value) {
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

function fakeCli(handler = () => ({})) {
  const calls = []
  return {
    calls,
    has: () => true,
    load: async () => {},
    json: async (args) => {
      calls.push(args)
      return handler(args)
    }
  }
}

function makeHost({ rows = { '/w/a': 'active' }, results = {} } = {}) {
  const calls = []
  const answers = { 'workspace.list': listOf(rows), 'agent.resume': { terminalId: 'term_new', started: true }, ...results }
  return {
    calls,
    answers,
    callsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.params),
    async call(method, params) {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer === undefined) throw new Error('unexpected host call ' + method)
      return typeof answer === 'function' ? answer(params) : answer
    },
    has: () => true
  }
}

function build({ host = makeHost(), cli = fakeCli(), from = 'term_orch', store = memoryStore(), onDrop, alive = async () => true, realAlive = false } = {}) {
  const tracked = []
  const checked = []
  let n = 0
  const state = { from, now: 1000 }
  const delivery = createDelivery({
    host,
    cli,
    store,
    now: () => state.now,
    id: () => 'm' + ++n,
    fromHandle: () => state.from,
    track: (id) => tracked.push(id),
    ...(onDrop ? { onDrop } : {}),
    ...(realAlive
      ? {}
      : {
          alive: (terminalId) => {
            checked.push(terminalId)
            return alive(terminalId)
          }
        })
  })
  return { host, cli, store, tracked, delivery, state, checked }
}

function combined(items) {
  if (items.length === 1) return items[0][0] + '\n\n' + items[0][1]
  return items.length + ' messages\n\n' + items.map(([s, b]) => s + '\n\n' + b).join('\n\n----------\n\n')
}

function onlyListCalls(host) {
  assert.deepEqual(
    host.calls.filter((c) => c.method !== 'workspace.list').map((c) => c.method),
    []
  )
  for (const c of host.callsOf('workspace.list')) assert.deepEqual(c, { includeStatus: true })
}

function noSendText(host) {
  assert.equal(host.calls.filter((c) => c.method === 'terminal.sendText').length, 0)
}

function terminalSends(cli) {
  return cli.calls.filter((args) => args[0] === 'terminal' && args[1] === 'send')
}

function textOf(args) {
  assert.ok(args[4].startsWith('--text='))
  return args[4].slice('--text='.length)
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

const MSG = ['terminal', 'send', '--terminal', 'term_a', '--text=' + 'Fix CI\n\nThe lint job failed.', '--enter']

test('route 1: an orchestrator session with a dispatch id gets dispatch mail with --from and the receipt id is tracked', async () => {
  const cli = fakeCli(() => ({ delivery: 'follow_up', followUpOf: 'ctx_1', dispatchId: 'ctx_2' }))
  const { host, delivery, tracked } = build({ cli })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'sent')
  assert.deepEqual(cli.calls, [
    ['orchestration', 'send', '--from', 'term_orch', '--to', 'dispatch:ctx_1', '--subject=' + 'Fix CI', '--body=' + 'The lint job failed.']
  ])
  assert.deepEqual(tracked, ['ctx_2'])
  onlyListCalls(host)
  noSendText(host)
  assert.deepEqual(delivery.queued(s.key), [])
})

test('route 1 is skipped when fromHandle() is null and route 2 types into the idle terminal', async () => {
  const cli = fakeCli()
  const { host, delivery, tracked } = build({ cli, from: null })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'sent')
  assert.equal(cli.calls.filter((a) => a[0] === 'orchestration').length, 0)
  assert.deepEqual(cli.calls, [MSG])
  assert.deepEqual(tracked, [])
  onlyListCalls(host)
})

test('route 1 falls through to route 2 on a CliError', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration') throw new CliError('terminal_handle_stale', 'closed')
    return { ok: true }
  })
  const { host, delivery, tracked } = build({ cli })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'sent')
  assert.equal(cli.calls.length, 2)
  assert.deepEqual(cli.calls[1], MSG)
  assert.deepEqual(tracked, [])
  onlyListCalls(host)
})

test('route 1 falls through to the queue when the fallback terminal is busy', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration') throw new CliError('terminal_handle_stale', 'closed')
    return {}
  })
  const { delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1', agent: { state: 'working' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'queued')
  assert.equal(terminalSends(cli).length, 0)
})

test('route 2: an idle terminal gets one terminal send with subject, blank line, body and --enter', async () => {
  for (const [agentState, listState] of [['waiting', 'active'], ['done', 'done']]) {
    const cli = fakeCli()
    const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': listState } }) })
    assert.equal(await delivery.send(session({ agent: { state: agentState } }), 'Fix CI', 'The lint job failed.'), 'sent')
    assert.deepEqual(cli.calls, [MSG])
    assert.equal(host.callsOf('workspace.list').length >= 1, true)
    onlyListCalls(host)
    noSendText(host)
  }
})

test('route 2: a CliError from terminal send queues the item and send returns queued', async () => {
  const cli = fakeCli(() => {
    throw new CliError('timeout', 'slow', true)
  })
  const { host, delivery } = build({ cli })
  const s = session()
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'queued')
  assert.deepEqual(cli.calls, [MSG])
  assert.deepEqual(delivery.queued(s.key), [{ id: 'm1', key: '/w/a', subject: 'Fix CI', body: 'The lint job failed.', at: 1000 }])
  onlyListCalls(host)
})

test('route 3: a working or blocked terminal agent is queued and nothing is sent', async () => {
  for (const [agentState, listState] of [['working', 'working'], ['blocked', 'permission']]) {
    const cli = fakeCli()
    const { host, delivery, store } = build({ cli, host: makeHost({ rows: { '/w/a': listState } }) })
    const s = session({ agent: { state: agentState } })
    assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'queued')
    assert.deepEqual(cli.calls, [])
    assert.equal(delivery.queued(s.key).length, 1)
    assert.equal(store.peek('queue').length, 1)
    onlyListCalls(host)
  }
})

test('route 4: an idle chat agent gets chat mail by session id and never agent.resume', async () => {
  const cli = fakeCli(() => ({ messageId: 'msg_1' }))
  const { host, delivery } = build({ cli })
  const s = session({ agent: { state: 'waiting', terminalId: null, chatId: 'claude_780deaf0_x', sessionId: 'uuid-1', kind: 'claude' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'sent')
  assert.deepEqual(cli.calls, [
    ['orchestration', 'send', '--from', 'term_orch', '--to', 'orca_session_id:claude_780deaf0_x', '--subject=' + 'Fix CI', '--body=' + 'The lint job failed.']
  ])
  assert.equal(host.callsOf('agent.resume').length, 0)
  onlyListCalls(host)
})

test('route 4: a busy chat is queued, a chat with no sender is unreachable, a failed chat send is unreachable', async () => {
  const chat = { terminalId: null, chatId: 'chat1', sessionId: 'uuid-1', kind: 'claude' }

  const busy = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  assert.equal(await busy.delivery.send(session({ agent: { ...chat, state: 'working' } }), 's', 'b'), 'queued')
  assert.deepEqual(busy.cli.calls, [])
  onlyListCalls(busy.host)

  const noFrom = build({ from: null })
  assert.equal(await noFrom.delivery.send(session({ agent: { ...chat, state: 'waiting' } }), 's', 'b'), 'unreachable')
  assert.deepEqual(noFrom.cli.calls, [])
  assert.deepEqual(noFrom.delivery.queued('/w/a'), [])
  onlyListCalls(noFrom.host)

  const failing = build({
    cli: fakeCli(() => {
      throw new CliError('not_found', 'gone')
    })
  })
  assert.equal(await failing.delivery.send(session({ agent: { ...chat, state: 'waiting' } }), 's', 'b'), 'unreachable')
  assert.equal(failing.cli.calls.length, 1)
  assert.deepEqual(failing.delivery.queued('/w/a'), [])
})

test('route 5: a closed agent with a session id and kind is resumed and the message is queued', async () => {
  const { host, cli, delivery } = build()
  const s = session({ agent: { state: 'none', terminalId: null, chatId: null, sessionId: 'uuid-1', kind: 'claude' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'queued')
  assert.deepEqual(host.callsOf('agent.resume'), [{ workspaceId: 'identity:wt2:local:/w/a', agent: 'claude', sessionId: 'uuid-1' }])
  assert.deepEqual(cli.calls, [])
  assert.equal(delivery.queued(s.key).length, 1)
  assert.deepEqual(
    host.calls.filter((c) => c.method !== 'workspace.list' && c.method !== 'agent.resume'),
    []
  )
})

test('route 6: nothing to reach is unreachable and nothing is called or queued', async () => {
  const { host, cli, delivery } = build()
  const s = session({ agent: { state: 'none', terminalId: null, chatId: null, sessionId: null, kind: null } })
  assert.equal(await delivery.send(s, 's', 'b'), 'unreachable')
  assert.deepEqual(cli.calls, [])
  assert.deepEqual(delivery.queued(s.key), [])
  onlyListCalls(host)
})

test('a waiting agent whose fresh workspace.list row says permission is never typed into by send or flush', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
  const s = session({ agent: { state: 'waiting' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(terminalSends(cli), [])
  assert.equal(delivery.queued(s.key).length, 1)
  assert.ok(host.callsOf('workspace.list').length >= 2)
  noSendText(host)
})

test('a blocked agent is never sent a message by send or flush', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
  const s = session({ agent: { state: 'blocked' } })
  assert.equal(await delivery.send(s, 'a', 'b'), 'queued')
  assert.equal(await delivery.send(s, 'c', 'd'), 'queued')
  assert.equal(await delivery.flush(s), 0)
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(cli.calls, [])
  assert.equal(delivery.queued(s.key).length, 2)
})

test('two queued items flush oldest first in one combined send when the agent turns idle, and a second flush sends nothing', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  const busy = session({ agent: { state: 'working' } })
  assert.equal(await delivery.send(busy, 'First', 'one'), 'queued')
  assert.equal(await delivery.send(busy, 'Second', 'two'), 'queued')
  assert.equal(await delivery.flush(busy), 0)
  assert.deepEqual(cli.calls, [])
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  const idle = session({ agent: { state: 'waiting' } })
  assert.equal(await delivery.flush(idle), 2)
  assert.deepEqual(cli.calls, [
    ['terminal', 'send', '--terminal', 'term_a', '--text=' + '2 messages\n\nFirst\n\none\n\n----------\n\nSecond\n\ntwo', '--enter']
  ])
  assert.equal(await delivery.flush(idle), 0)
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(delivery.queued(idle.key), [])
  noSendText(host)
})

test('flush sends nothing when the fresh list says the agent turned busy', async () => {
  const host = makeHost({ rows: { '/w/a': 'working' } })
  const { cli, delivery } = build({ host })
  const busy = session({ agent: { state: 'working' } })
  await delivery.send(busy, 'First', 'one')
  await delivery.send(busy, 'Second', 'two')
  assert.equal(await delivery.flush(session({ agent: { state: 'waiting' } })), 0)
  assert.equal(terminalSends(cli).length, 0)
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['First', 'Second'])
})

test('the queue survives createDelivery re-creation followed by load()', async () => {
  const store = memoryStore()
  const first = build({ store, host: makeHost({ rows: { '/w/a': 'working' } }) })
  await first.delivery.send(session({ agent: { state: 'working' } }), 'Kept', 'body')
  const second = build({ store })
  assert.deepEqual(second.delivery.queued('/w/a'), [])
  await second.delivery.load()
  assert.deepEqual(second.delivery.queued('/w/a'), [{ id: 'm1', key: '/w/a', subject: 'Kept', body: 'body', at: 1000 }])
  assert.equal(await second.delivery.flush(session()), 1)
  assert.deepEqual(second.cli.calls, [['terminal', 'send', '--terminal', 'term_a', '--text=' + 'Kept\n\nbody', '--enter']])
  assert.deepEqual(store.peek('queue'), [])
})

test('load() ignores a corrupt stored queue', async () => {
  const store = memoryStore({ queue: [{ id: 1 }, 'x', null, { id: 'ok', key: '/w/a', subject: 's', body: 'b', at: 5 }] })
  const { delivery } = build({ store })
  await delivery.load()
  assert.deepEqual(delivery.queued('/w/a'), [{ id: 'ok', key: '/w/a', subject: 's', body: 'b', at: 5 }])
  const empty = build({ store: memoryStore({ queue: 'nope' }) })
  await empty.delivery.load()
  assert.deepEqual(empty.delivery.queued('/w/a'), [])
})

test('Review Focus 3: prune drops the queue of a vanished session and a later flush for it sends nothing', async () => {
  const { host, cli, delivery, store } = build({ host: makeHost({ rows: { a: 'working', b: 'working' } }) })
  const a = session({ path: 'a', agent: { state: 'working' } })
  const b = session({ path: 'b', agent: { state: 'working', terminalId: 'term_b' } })
  await delivery.send(a, 'for a', 'x')
  await delivery.send(b, 'for b', 'y')
  assert.equal(await delivery.prune(['a']), 1)
  assert.deepEqual(delivery.queued('b'), [])
  assert.equal(delivery.queued('a').length, 1)
  assert.deepEqual(store.peek('queue').map((i) => i.key), ['a'])
  host.answers['workspace.list'] = listOf({ a: 'working', b: 'active' })
  assert.equal(await delivery.flush(session({ path: 'b', agent: { state: 'waiting', terminalId: 'term_b' } })), 0)
  assert.deepEqual(cli.calls, [])
})

test('an item pruned while flush is re-reading the live state is not sent', async () => {
  const host = makeHost({ rows: { '/w/b': 'working' } })
  const { cli, delivery } = build({ host })
  await delivery.send(session({ path: '/w/b', agent: { state: 'working', terminalId: 'term_b' } }), 'for b', 'y')
  const gate = deferred()
  host.answers['workspace.list'] = async () => {
    await gate.promise
    return listOf({ '/w/b': 'active' })
  }
  const flushing = delivery.flush(session({ path: '/w/b', agent: { state: 'waiting', terminalId: 'term_b' } }))
  await new Promise((r) => setImmediate(r))
  assert.equal(await delivery.prune([]), 1)
  gate.resolve()
  assert.equal(await flushing, 0)
  assert.deepEqual(cli.calls, [])
})

test('a session missing from the fresh workspace.list is never typed into', async () => {
  const { cli, delivery } = build({ host: makeHost({ rows: { '/w/other': 'active' } }) })
  const s = session({ agent: { state: 'waiting' } })
  assert.equal(await delivery.send(s, 's', 'b'), 'queued')
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(cli.calls, [])
})

test('a failed workspace.list re-read queues instead of sending', async () => {
  const host = makeHost()
  host.answers['workspace.list'] = () => {
    throw new Error('unavailable')
  }
  const { cli, delivery } = build({ host })
  const s = session({ agent: { state: 'waiting' } })
  assert.equal(await delivery.send(s, 's', 'b'), 'queued')
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(cli.calls, [])
  assert.equal(delivery.queued(s.key).length, 1)
})

test('flush leaves the item at the head of the queue on a CliError and stops', async () => {
  let fail = true
  const cli = fakeCli((args) => {
    if (fail && args[0] === 'terminal') throw new CliError('exit_1', 'refused')
    return {}
  })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  const busy = session({ agent: { state: 'working' } })
  await delivery.send(busy, 'First', 'one')
  await delivery.send(busy, 'Second', 'two')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 0)
  assert.equal(terminalSends(cli).length, 1)
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['First', 'Second'])
  fail = false
  assert.equal(await delivery.flush(session()), 2)
  assert.deepEqual(terminalSends(cli).slice(1).map(textOf), [combined([['First', 'one'], ['Second', 'two']])])
})

test('two concurrent flush calls for one session send each item exactly once', async () => {
  const gate = deferred()
  const cli = fakeCli(async (args) => {
    if (args[0] === 'terminal') await gate.promise
    return {}
  })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  const busy = session({ agent: { state: 'working' } })
  await delivery.send(busy, 'First', 'one')
  await delivery.send(busy, 'Second', 'two')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  const idle = session()
  const one = delivery.flush(idle)
  const two = delivery.flush(idle)
  await new Promise((r) => setImmediate(r))
  gate.resolve()
  const counts = await Promise.all([one, two])
  assert.equal(counts[0] + counts[1], 2)
  assert.deepEqual(terminalSends(cli).map(textOf), [combined([['First', 'one'], ['Second', 'two']])])
  assert.deepEqual(delivery.queued('/w/a'), [])
})

test('a send racing a flush for the same session keeps the order, sends each item once and waits for the next turn', async () => {
  const gate = deferred()
  const cli = fakeCli(async (args) => {
    if (args[0] === 'terminal') await gate.promise
    return {}
  })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { state: 'working' } }), 'Old', 'one')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  const flushing = delivery.flush(session())
  const sending = delivery.send(session(), 'New', 'two')
  await new Promise((r) => setImmediate(r))
  gate.resolve()
  await flushing
  assert.equal(await sending, 'queued')
  assert.deepEqual(terminalSends(cli).map(textOf), ['Old\n\none'])
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['New'])
  assert.equal(await delivery.flush(session({ agent: { state: 'working' } })), 0)
  assert.equal(await delivery.flush(session()), 1)
  assert.deepEqual(terminalSends(cli).map(textOf), ['Old\n\none', 'New\n\ntwo'])
  assert.deepEqual(delivery.queued('/w/a'), [])
})

test('send to an idle session with older queued items sends the older items first in the same message', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { state: 'working' } }), 'Old', 'one')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.send(session(), 'New', 'two'), 'sent')
  assert.deepEqual(terminalSends(cli).map(textOf), [combined([['Old', 'one'], ['New', 'two']])])
  assert.deepEqual(delivery.queued('/w/a'), [])
})

test('flush sends queued chat items by chat mail when the chat is idle', async () => {
  const chat = { terminalId: null, chatId: 'chat1', sessionId: null, kind: null }
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { ...chat, state: 'working' } }), 's', 'b')
  host.answers['workspace.list'] = listOf({ '/w/a': 'done' })
  assert.equal(await delivery.flush(session({ agent: { ...chat, state: 'done' } })), 1)
  assert.deepEqual(cli.calls, [['orchestration', 'send', '--from', 'term_orch', '--to', 'orca_session_id:chat1', '--subject=' + 's', '--body=' + 'b']])
})

test('works against the orca/testing mockHost and storage and never calls terminal.sendText', async () => {
  const host = mockHost({
    results: { 'workspace.list': listOf({ '/w/a': 'active', '/w/b': 'working' }), 'agent.resume': { terminalId: 'term_new', started: true } }
  })
  let orca
  const worker = await mountWorker({ default: (api) => { orca = api } }, { host })
  const cli = fakeCli(() => ({ dispatchId: 'ctx_9' }))
  const tracked = []
  let n = 0
  const delivery = createDelivery({
    host: orca.host,
    cli,
    store: orca.storage,
    now: () => 7,
    id: () => 'k' + ++n,
    fromHandle: () => 'term_orch',
    track: (id) => tracked.push(id),
    alive: async (terminalId) => terminalId === 'term_a'
  })
  assert.equal(await delivery.send(session(), 'a', 'b'), 'sent')
  assert.equal(await delivery.send(session({ started: 'orchestrator', dispatchId: 'ctx_1' }), 'a', 'b'), 'sent')
  assert.equal(await delivery.send(session({ path: '/w/b', agent: { state: 'working', terminalId: 'term_b' } }), 'q', 'r'), 'queued')
  assert.equal(await delivery.send(session({ path: '/w/c', agent: { state: 'none', terminalId: null, sessionId: 'u', kind: 'claude' } }), 'a', 'b'), 'queued')
  assert.equal(await delivery.flush(session({ path: '/w/b', agent: { state: 'working', terminalId: 'term_b' } })), 0)
  assert.deepEqual(tracked, ['ctx_9'])
  assert.deepEqual(host.data().storage.queue.map((i) => i.key), ['/w/b', '/w/c'])
  assert.deepEqual(host.callsOf('workspace.list')[0], { includeStatus: true })
  assert.deepEqual(host.callsOf('agent.resume'), [{ workspaceId: 'identity:wt2:local:/w/c', agent: 'claude', sessionId: 'u' }])
  assert.deepEqual(host.callsOf('terminal.sendText'), [])
  assert.deepEqual(host.refusals, [])
  await worker.deactivate()
})

test('a second send to the same closed session does not resume it again', async () => {
  const { host, delivery } = build()
  const s = session({ agent: { state: 'none', terminalId: null, chatId: null, sessionId: 'uuid-1', kind: 'claude' } })
  assert.equal(await delivery.send(s, 'a', 'b'), 'queued')
  assert.equal(await delivery.send(s, 'c', 'd'), 'queued')
  assert.equal(host.callsOf('agent.resume').length, 1)
  assert.equal(delivery.queued(s.key).length, 2)
})

test('send re-reads the live state after queueing, so a prompt that appears meanwhile stops the send', async () => {
  const host = makeHost()
  const states = ['active', 'permission']
  host.answers['workspace.list'] = () => listOf({ '/w/a': states.shift() ?? 'permission' })
  const { cli, delivery } = build({ host })
  assert.equal(await delivery.send(session(), 's', 'b'), 'queued')
  assert.deepEqual(cli.calls, [])
  assert.equal(delivery.queued('/w/a').length, 1)
})

test('a failed resume is unreachable and queues nothing', async () => {
  const host = makeHost()
  host.answers['agent.resume'] = () => {
    throw new Error('not_permitted')
  }
  const { delivery } = build({ host })
  const s = session({ agent: { state: 'none', terminalId: null, chatId: null, sessionId: 'uuid-1', kind: 'claude' } })
  assert.equal(await delivery.send(s, 'a', 'b'), 'unreachable')
  assert.deepEqual(delivery.queued(s.key), [])
})

function flakyStore(failOn) {
  const store = memoryStore()
  const set = store.set
  let n = 0
  store.set = async (key, value) => {
    n += 1
    if (failOn.includes(n)) throw new Error('disk full')
    return set(key, value)
  }
  return store
}

test('a done agent whose fresh row says permission is queued and not typed into unless the prompt is masked', async () => {
  const blocked = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
  const s = session({ agent: { state: 'done' } })
  assert.equal(await blocked.delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.equal(await blocked.delivery.flush(s), 0)
  assert.deepEqual(blocked.cli.calls, [])
  assert.equal(blocked.delivery.queued(s.key).length, 1)

  const masked = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
  assert.equal(await masked.delivery.send(session({ agent: { state: 'done', permissionMasked: true } }), 'Fix CI', 'body'), 'sent')
  assert.equal(terminalSends(masked.cli).length, 1)
})

test('a chat agent whose fresh row says permission is queued, not mailed', async () => {
  const { cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
  const s = session({ agent: { state: 'done', terminalId: null, chatId: 'chat1' } })
  assert.equal(await delivery.send(s, 's', 'b'), 'queued')
  assert.deepEqual(cli.calls, [])
})

test('route 1 is ungated by design: dispatch mail is sent while the worker is working, because Orca delivers it when the turn ends', async () => {
  const cli = fakeCli(() => ({ dispatchId: 'ctx_2' }))
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1', agent: { state: 'working' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'sent')
  assert.equal(cli.calls.length, 1)
  assert.equal(cli.calls[0][0], 'orchestration')
  assert.equal(terminalSends(cli).length, 0)
  assert.equal(host.callsOf('workspace.list').length, 0)
})

test('route 1 failing falls through to the busy check: a done agent on a permission prompt is queued, nothing typed', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration') throw new CliError('terminal_handle_stale', 'closed')
    return {}
  })
  const { delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'permission' } }) })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1', agent: { state: 'done' } })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.equal(terminalSends(cli).length, 0)
  assert.equal(delivery.queued(s.key).length, 1)
})

test('flush sends one combined message, re-reads the live state once and sends nothing more while that send is open', async () => {
  const gate = deferred()
  const cli = fakeCli(async (args) => {
    if (args[0] === 'terminal') await gate.promise
    return {}
  })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { state: 'working' } }), 'First', 'one')
  await delivery.send(session({ agent: { state: 'working' } }), 'Second', 'two')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  const listsBefore = host.callsOf('workspace.list').length
  const flushing = delivery.flush(session())
  const again = delivery.flush(session())
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(terminalSends(cli).map(textOf), [combined([['First', 'one'], ['Second', 'two']])])
  gate.resolve()
  assert.equal(await flushing, 2)
  assert.equal(await again, 0)
  assert.equal(terminalSends(cli).length, 1)
  assert.equal(host.callsOf('workspace.list').length - listsBefore, 1)
})

test('flush stops at a failure, sends nothing after it and keeps every item in order', async () => {
  const cli = fakeCli((args) => {
    if (textOf(args).includes('Second')) throw new CliError('exit_1', 'refused')
    return {}
  })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  for (const subject of ['First', 'Second', 'Third']) await delivery.send(session({ agent: { state: 'working' } }), subject, 'x')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(terminalSends(cli).map(textOf), [combined([['First', 'x'], ['Second', 'x'], ['Third', 'x']])])
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['First', 'Second', 'Third'])
})

test('a timed-out send is retried once more and then dropped; a plain failure is never dropped', async () => {
  const cli = fakeCli((args) => {
    if (textOf(args).startsWith('A')) throw new CliError('timeout', 'orca timed out', true)
    return {}
  })
  const { host, delivery, store } = build({ cli, host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { state: 'working' } }), 'A', 'x')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['A'])
  assert.deepEqual(store.peek('queue').map((i) => i.subject), ['A'])
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(delivery.queued('/w/a'), [])
  assert.deepEqual(store.peek('queue'), [])
  assert.equal(await delivery.send(session(), 'B', 'y'), 'sent')
  assert.deepEqual(terminalSends(cli).map(textOf), ['A\n\nx', 'A\n\nx', 'B\n\ny'])

  const stuck = build({
    cli: fakeCli(() => {
      throw new CliError('exit_1', 'refused')
    })
  })
  assert.equal(await stuck.delivery.send(session(), 'C', 'z'), 'queued')
  for (let i = 0; i < 3; i++) assert.equal(await stuck.delivery.flush(session()), 0)
  assert.equal(stuck.delivery.queued('/w/a').length, 1)
  assert.equal(terminalSends(stuck.cli).length, 4)
})

test('a failed enqueue write rolls the queue back and send rejects', async () => {
  const store = flakyStore([1])
  const { cli, delivery } = build({ store, host: makeHost({ rows: { '/w/a': 'working' } }) })
  await assert.rejects(delivery.send(session({ agent: { state: 'working' } }), 's', 'b'), /disk full/)
  assert.deepEqual(delivery.queued('/w/a'), [])
  assert.equal(store.peek('queue'), null)
  assert.deepEqual(cli.calls, [])
  assert.equal(await delivery.send(session({ agent: { state: 'working' } }), 't', 'c'), 'queued')
  assert.deepEqual(store.peek('queue').map((i) => i.subject), ['t'])
})

test('a sent item leaves storage before it is sent, so a failed write never sends and a reload never resends', async () => {
  const store = flakyStore([2])
  const { cli, delivery } = build({ store })
  assert.equal(await delivery.send(session(), 's', 'b'), 'queued')
  assert.deepEqual(cli.calls, [])
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['s'])
  assert.deepEqual(store.peek('queue').map((i) => i.subject), ['s'])
  assert.equal(await delivery.flush(session()), 1)
  assert.deepEqual(store.peek('queue'), [])
  const again = build({ store })
  await again.delivery.load()
  assert.equal(await again.delivery.flush(session()), 0)
  assert.deepEqual(again.cli.calls, [])
})

test('a failed prune write keeps memory and storage in step and rejects', async () => {
  const store = flakyStore([3])
  const { delivery } = build({ store, host: makeHost({ rows: { a: 'working', b: 'working' } }) })
  await delivery.send(session({ path: 'a', agent: { state: 'working' } }), 'for a', 'x')
  await delivery.send(session({ path: 'b', agent: { state: 'working', terminalId: 'term_b' } }), 'for b', 'y')
  await assert.rejects(delivery.prune(['a']), /disk full/)
  assert.equal(delivery.queued('b').length, 1)
  assert.deepEqual(store.peek('queue').map((i) => i.key), ['a', 'b'])
  assert.equal(await delivery.prune(['a']), 1)
  assert.deepEqual(store.peek('queue').map((i) => i.key), ['a'])
})

test('text that looks like a flag reaches the CLI in the --flag=value form', async () => {
  const term = build()
  assert.equal(await term.delivery.send(session(), '--json', '-rf'), 'sent')
  assert.deepEqual(term.cli.calls, [['terminal', 'send', '--terminal', 'term_a', '--text=--json\n\n-rf', '--enter']])

  const chat = build()
  assert.equal(await chat.delivery.send(session({ agent: { terminalId: null, chatId: 'chat1' } }), '-s', '--json'), 'sent')
  assert.deepEqual(chat.cli.calls, [['orchestration', 'send', '--from', 'term_orch', '--to', 'orca_session_id:chat1', '--subject=-s', '--body=--json']])

  const mail = build()
  assert.equal(await mail.delivery.send(session({ started: 'orchestrator', dispatchId: 'ctx_1' }), '-x', '--json'), 'sent')
  assert.deepEqual(mail.cli.calls, [['orchestration', 'send', '--from', 'term_orch', '--to', 'dispatch:ctx_1', '--subject=-x', '--body=--json']])
})

test('a failed put-back write after a failed send is retried by the next operation, so a restart keeps the item', async () => {
  const store = flakyStore([3])
  const cli = fakeCli((args) => {
    if (args[0] === 'terminal') throw new CliError('exit_1', 'refused')
    return {}
  })
  const host = makeHost({ rows: { '/w/a': 'working' } })
  const { delivery } = build({ cli, store, host })
  assert.equal(await delivery.send(session({ agent: { state: 'working' } }), 'Kept', 'body'), 'queued')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['Kept'])
  assert.deepEqual(store.peek('queue'), [])
  host.answers['workspace.list'] = listOf({ '/w/a': 'working' })
  assert.equal(await delivery.flush(session({ agent: { state: 'working' } })), 0)
  assert.deepEqual(store.peek('queue').map((i) => i.subject), ['Kept'])
  const again = build({ store })
  await again.delivery.load()
  assert.deepEqual(again.delivery.queued('/w/a').map((i) => i.subject), ['Kept'])
})

test('prune with nothing to remove still rewrites a queue left out of step by a failed write', async () => {
  const store = flakyStore([3])
  const cli = fakeCli(() => {
    throw new CliError('exit_1', 'refused')
  })
  const host = makeHost({ rows: { '/w/a': 'working' } })
  const { delivery } = build({ cli, store, host })
  await delivery.send(session({ agent: { state: 'working' } }), 'Kept', 'body')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(store.peek('queue'), [])
  assert.equal(await delivery.prune(['/w/a']), 0)
  assert.deepEqual(store.peek('queue').map((i) => i.subject), ['Kept'])
})

test('an item dropped after a second timeout is reported through onDrop, and a throwing onDrop changes nothing', async () => {
  for (const throwing of [false, true]) {
    const dropped = []
    const cli = fakeCli((args) => {
      if (textOf(args).startsWith('A')) throw new CliError('timeout', 'orca timed out', true)
      return {}
    })
    const onDrop = (item, reason) => {
      dropped.push([item, reason])
      if (throwing) throw new Error('listener broke')
    }
    const { host, delivery, store } = build({ cli, onDrop, host: makeHost({ rows: { '/w/a': 'working' } }) })
    await delivery.send(session({ agent: { state: 'working' } }), 'A', 'x')
    host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
    assert.equal(await delivery.flush(session()), 0)
    assert.deepEqual(dropped, [])
    assert.equal(await delivery.flush(session()), 0)
    assert.deepEqual(dropped, [[{ id: 'm1', key: '/w/a', subject: 'A', body: 'x', at: 1000 }, 'timeout']])
    assert.deepEqual(delivery.queued('/w/a'), [])
    assert.deepEqual(store.peek('queue'), [])
    assert.equal(await delivery.send(session(), 'B', 'y'), 'sent')
    assert.equal(dropped.length, 1)
  }
})

test('a dispatch-mail timeout queues the item instead of typing it, retries it once by dispatch mail, then drops it', async () => {
  const dropped = []
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration') throw new CliError('timeout', 'orca timed out', true)
    return {}
  })
  const { host, delivery, tracked } = build({ cli, onDrop: (item, reason) => dropped.push([item.id, reason]) })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.equal(terminalSends(cli).length, 0)
  assert.deepEqual(delivery.queued(s.key).map((i) => i.id), ['m1'])
  assert.deepEqual(dropped, [])
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(dropped, [['m1', 'timeout']])
  assert.equal(await delivery.flush(s), 0)
  assert.equal(terminalSends(cli).length, 0)
  assert.deepEqual(cli.calls.map((a) => a[5]), ['dispatch:ctx_1', 'dispatch:ctx_1'])
  assert.deepEqual(delivery.queued(s.key), [])
  assert.deepEqual(tracked, [])
  noSendText(host)
})

test('a dispatch-mail retry that succeeds tracks the new receipt and types nothing', async () => {
  let fail = true
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration' && fail) throw new CliError('timeout', 'orca timed out', true)
    return { dispatchId: 'ctx_2' }
  })
  const { delivery, tracked } = build({ cli })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  fail = false
  assert.equal(await delivery.flush(s), 1)
  assert.equal(terminalSends(cli).length, 0)
  assert.deepEqual(tracked, ['ctx_2'])
  assert.deepEqual(delivery.queued(s.key), [])
})

test('a dispatch-mail retry waits while the agent is working or on a permission prompt', async () => {
  for (const listState of ['working', 'permission']) {
    const cli = fakeCli((args) => {
      throw new CliError('timeout', 'orca timed out', true)
    })
    const { delivery } = build({ cli, host: makeHost({ rows: { '/w/a': listState } }) })
    const s = session({ started: 'orchestrator', dispatchId: 'ctx_1', agent: { state: 'waiting' } })
    assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
    assert.equal(cli.calls.length, 1)
    assert.equal(await delivery.flush(s), 0)
    assert.equal(cli.calls.length, 1)
    assert.equal(delivery.queued(s.key).length, 1)
  }
})

test('a dispatch-mail error other than a timeout still falls through to the idle terminal', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'orchestration') throw new CliError('exit_1', 'refused')
    return {}
  })
  const { delivery } = build({ cli })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Fix CI', 'The lint job failed.'), 'sent')
  assert.deepEqual(terminalSends(cli), [MSG])
  assert.deepEqual(delivery.queued(s.key), [])
})

test('flush never mails a queued chat item while the fresh row says permission', async () => {
  const chat = { terminalId: null, chatId: 'chat1', sessionId: null, kind: null }
  const host = makeHost({ rows: { '/w/a': 'working' } })
  const { cli, delivery } = build({ host })
  await delivery.send(session({ agent: { ...chat, state: 'working' } }), 's', 'b')
  host.answers['workspace.list'] = listOf({ '/w/a': 'permission' })
  assert.equal(await delivery.flush(session({ agent: { ...chat, state: 'done' } })), 0)
  assert.deepEqual(cli.calls, [])
  assert.equal(delivery.queued('/w/a').length, 1)
})

const LIVENESS = JSON.parse(readFileSync(new URL('./fixtures/agent-liveness.json', import.meta.url), 'utf8'))
const LIVE_TERM = 'term_bb58dc1e-f21b-4ee1-ae9e-a7b92eeef75d'
const SHELL_TERM = 'term_188c6f3c-27b5-45c4-9741-390665dfc036'
const FLOATING_TERM = 'term_76dffcf2-d223-49df-a7e1-dcd204fcf164'
const LIVE_PATH = '/Users/aamonnaig/Developer/orca-plugins/orchestration'

function livenessCli({ terminals = LIVENESS.terminalList, worktrees = LIVENESS.worktreePs } = {}) {
  return fakeCli((args) => {
    if (args[0] === 'terminal' && args[1] === 'list') {
      if (terminals instanceof Error) throw terminals
      return terminals
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      if (worktrees instanceof Error) throw worktrees
      return worktrees
    }
    return {}
  })
}

function liveSession(terminalId, agent = {}) {
  return session({ path: LIVE_PATH, agent: { terminalId, ...agent } })
}

function liveHost(state = 'active') {
  return makeHost({ rows: { [LIVE_PATH]: state } })
}

test('liveness: the CLI check sends when the agent row in worktree ps owns exactly this terminal', async () => {
  const cli = livenessCli()
  const { delivery } = build({ cli, host: liveHost(), realAlive: true })
  assert.equal(await delivery.send(liveSession(LIVE_TERM), 'Fix CI', 'body'), 'sent')
  const kinds = cli.calls.map((a) => a.slice(0, 2).join(' '))
  assert.ok(kinds.includes('terminal list'))
  assert.ok(kinds.includes('worktree ps'))
  assert.equal(kinds[kinds.length - 1], 'terminal send')
  assert.ok(kinds.lastIndexOf('worktree ps') < kinds.indexOf('terminal send'))
  assert.deepEqual(terminalSends(cli).map((a) => a[3]), [LIVE_TERM])
})

test('liveness: a terminal with no agent row is never typed into and is unreachable without a session id', async () => {
  for (const terminalId of [SHELL_TERM, 'term_unknown']) {
    const cli = livenessCli()
    const { host, delivery } = build({ cli, host: liveHost(), realAlive: true })
    const s = liveSession(terminalId)
    assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'unreachable')
    assert.deepEqual(terminalSends(cli), [])
    assert.deepEqual(delivery.queued(s.key), [])
    assert.equal(host.callsOf('agent.resume').length, 0)
  }
})

test('liveness: a terminal with no agent row takes the resume route when a session id and kind are known', async () => {
  const cli = livenessCli()
  const { host, delivery } = build({ cli, host: liveHost(), realAlive: true })
  const s = liveSession(SHELL_TERM, { sessionId: 'uuid-1', kind: 'claude' })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.deepEqual(terminalSends(cli), [])
  assert.deepEqual(host.callsOf('agent.resume'), [{ workspaceId: 'identity:wt2:local:' + LIVE_PATH, agent: 'claude', sessionId: 'uuid-1' }])
  assert.deepEqual(delivery.queued(s.key).map((i) => i.subject), ['Fix CI'])
  assert.equal(await delivery.flush(s), 0)
  assert.deepEqual(terminalSends(cli), [])
  assert.equal(host.callsOf('agent.resume').length, 1)
})

test('liveness: a live agent in a different terminal of the same worktree does not count', async () => {
  const sibling = {
    ...LIVENESS.terminalList.terminals.find((t) => t.handle === LIVE_TERM),
    handle: 'term_sibling',
    tabId: 'aaaaaaaa-0000-0000-0000-000000000000',
    leafId: 'bbbbbbbb-0000-0000-0000-000000000000',
    agentIdentity: 'claude'
  }
  const terminals = { ...LIVENESS.terminalList, terminals: [...LIVENESS.terminalList.terminals, sibling] }
  const cli = livenessCli({ terminals })
  const { delivery } = build({ cli, host: liveHost(), realAlive: true })
  assert.equal(await delivery.send(liveSession('term_sibling'), 'Fix CI', 'body'), 'unreachable')
  assert.deepEqual(terminalSends(cli), [])
})

const UNKNOWN_ANSWERS = [
  { terminals: new CliError('timeout', 'orca timed out', true) },
  { worktrees: new CliError('runtime_unavailable', 'down', true) },
  { terminals: new Error('spawn E2BIG') },
  { terminals: {} },
  { worktrees: { rows: [] } },
  { terminals: null },
  { terminals: { ...LIVENESS.terminalList, truncated: true } },
  { worktrees: { ...LIVENESS.worktreePs, truncated: true } },
  { worktrees: { worktrees: LIVENESS.worktreePs.worktrees.map((w) => ({ ...w, agents: w.agents.map(({ hasLivePty, ...a }) => a) })) } },
  { worktrees: { worktrees: LIVENESS.worktreePs.worktrees.map((w) => ({ ...w, agents: undefined })) } },
  { worktrees: { worktrees: [] } },
  { terminals: { terminals: LIVENESS.terminalList.terminals.map((t) => ({ ...t, connected: undefined })) } },
  { terminals: { terminals: [...LIVENESS.terminalList.terminals, ...LIVENESS.terminalList.terminals] } }
]

test('liveness: a failed, timed-out or unknown-shaped answer is unknown: queued, never typed, never resumed', async () => {
  for (const answer of UNKNOWN_ANSWERS) {
    const cli = livenessCli(answer)
    const { host, delivery } = build({ cli, host: liveHost(), realAlive: true })
    const s = liveSession(LIVE_TERM, { sessionId: 'uuid-1', kind: 'claude' })
    assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
    assert.deepEqual(terminalSends(cli), [])
    assert.equal(host.callsOf('agent.resume').length, 0)
    assert.deepEqual(delivery.queued(s.key).map((i) => i.subject), ['Fix CI'])
  }
})

test('liveness: a terminal whose worktree has no ps row is unknown, not gone', async () => {
  const cli = livenessCli()
  const { host, delivery } = build({ cli, host: liveHost(), realAlive: true })
  const s = liveSession(FLOATING_TERM, { sessionId: 'uuid-1', kind: 'claude' })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.deepEqual(terminalSends(cli), [])
  assert.equal(host.callsOf('agent.resume').length, 0)
})

test('liveness: one orca timeout makes zero agent.resume calls, and the next flush with a clean read sends the item', async () => {
  const answer = { terminals: new CliError('timeout', 'orca timed out', true) }
  const cli = fakeCli((args) => {
    if (args[0] === 'terminal' && args[1] === 'list') {
      if (answer.terminals instanceof Error) throw answer.terminals
      return answer.terminals
    }
    if (args[0] === 'worktree' && args[1] === 'ps') return LIVENESS.worktreePs
    return {}
  })
  const { host, delivery } = build({ cli, host: liveHost(), realAlive: true })
  const s = liveSession(LIVE_TERM, { sessionId: 'uuid-1', kind: 'claude' })
  assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
  assert.equal(await delivery.flush(s), 0)
  assert.equal(host.callsOf('agent.resume').length, 0)
  assert.deepEqual(terminalSends(cli), [])
  answer.terminals = LIVENESS.terminalList
  assert.equal(await delivery.flush(s), 1)
  assert.deepEqual(terminalSends(cli).map((a) => [a[3], textOf(a)]), [[LIVE_TERM, 'Fix CI\n\nbody']])
  assert.equal(host.callsOf('agent.resume').length, 0)
})

test('liveness: three outcomes from an injected check: true sends, false resumes, a throw or non-boolean queues without resuming', async () => {
  const agent = { sessionId: 'uuid-1', kind: 'claude' }
  const live = build({ alive: async () => true })
  assert.equal(await live.delivery.send(session({ agent }), 's', 'b'), 'sent')
  assert.equal(live.host.callsOf('agent.resume').length, 0)

  const gone = build({ alive: async () => false })
  assert.equal(await gone.delivery.send(session({ agent }), 's', 'b'), 'queued')
  assert.equal(gone.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(terminalSends(gone.cli), [])

  for (const alive of [async () => { throw new CliError('timeout', 'orca timed out', true) }, async () => undefined, async () => 'yes']) {
    const unknown = build({ alive })
    assert.equal(await unknown.delivery.send(session({ agent }), 's', 'b'), 'queued')
    assert.equal(unknown.host.callsOf('agent.resume').length, 0)
    assert.deepEqual(terminalSends(unknown.cli), [])
    assert.equal(unknown.delivery.queued('/w/a').length, 1)
  }
})

test('liveness: an injected check that says no, or rejects, stops the send; one that says yes is asked for this exact terminal', async () => {
  for (const [alive, expected] of [[async () => false, 'unreachable'], [async () => { throw new Error('boom') }, 'queued']]) {
    const { cli, delivery } = build({ alive })
    assert.equal(await delivery.send(session(), 'Fix CI', 'body'), expected)
    assert.deepEqual(terminalSends(cli), [])
  }
  const yes = build()
  assert.equal(await yes.delivery.send(session({ agent: { terminalId: 'term_z' } }), 'Fix CI', 'body'), 'sent')
  assert.ok(yes.checked.length >= 1)
  assert.ok(yes.checked.every((id) => id === 'term_z'))
})

test('liveness: flush re-checks before typing and leaves the queue alone without proof', async () => {
  let live = true
  const { host, cli, delivery, checked } = build({ host: makeHost({ rows: { '/w/a': 'working' } }), alive: async () => live })
  await delivery.send(session({ agent: { state: 'working' } }), 'Kept', 'body')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  live = false
  assert.equal(await delivery.flush(session()), 0)
  assert.deepEqual(terminalSends(cli), [])
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['Kept'])
  assert.deepEqual(checked, ['term_a'])
  live = true
  assert.equal(await delivery.flush(session()), 1)
  assert.equal(terminalSends(cli).length, 1)
})

function listWithStatus(path, status) {
  const row = { id: 'identity:wt2:local:' + path, kind: 'worktree', name: 'n', path, branch: 'feature', hostId: 'local' }
  if (status !== undefined) row.status = status
  return { workspaces: [row], truncated: false, statusTruncated: status === undefined }
}

test('live state: a stored waiting or done is sent only when the fresh row says active or done', async () => {
  const statuses = [
    ['missing', undefined],
    ['null', null],
    ['no state', { unread: false, terminalCount: 1 }],
    ['inactive', { state: 'inactive', unread: false, terminalCount: 0 }]
  ]
  for (const agentState of ['waiting', 'done']) {
    for (const [, status] of statuses) {
      const host = makeHost()
      host.answers['workspace.list'] = listWithStatus('/w/a', status)
      const { cli, delivery } = build({ host })
      const s = session({ agent: { state: agentState } })
      assert.equal(await delivery.send(s, 'Fix CI', 'body'), 'queued')
      assert.equal(await delivery.flush(s), 0)
      assert.deepEqual(terminalSends(cli), [])
      assert.equal(delivery.queued(s.key).length, 1)
    }
    for (const listState of ['active', 'done']) {
      const { cli, delivery } = build({ host: makeHost({ rows: { '/w/a': listState } }) })
      assert.equal(await delivery.send(session({ agent: { state: agentState } }), 'Fix CI', 'body'), 'sent')
      assert.equal(terminalSends(cli).length, 1)
    }
  }
})

test('live state: a chat agent with no list status is queued, not mailed', async () => {
  const host = makeHost()
  host.answers['workspace.list'] = listWithStatus('/w/a', { state: 'inactive' })
  const { cli, delivery } = build({ host })
  assert.equal(await delivery.send(session({ agent: { state: 'done', terminalId: null, chatId: 'chat1' } }), 's', 'b'), 'queued')
  assert.deepEqual(cli.calls, [])
})

test('live state: permission means blocked for a stored waiting or done unless the prompt is masked', async () => {
  for (const agentState of ['waiting', 'done']) {
    const blocked = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
    assert.equal(await blocked.delivery.send(session({ agent: { state: agentState } }), 's', 'b'), 'queued')
    assert.equal(await blocked.delivery.flush(session({ agent: { state: agentState } })), 0)
    assert.deepEqual(terminalSends(blocked.cli), [])
    const masked = build({ host: makeHost({ rows: { '/w/a': 'permission' } }) })
    assert.equal(await masked.delivery.send(session({ agent: { state: agentState, permissionMasked: true } }), 's', 'b'), 'sent')
    assert.equal(terminalSends(masked.cli).length, 1)
  }
})

test('turns: five queued items go out as one combined message in queue order', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  const parts = [['One', 'a'], ['Two', 'b'], ['Three', 'c'], ['Four', 'd'], ['Five', 'e']]
  for (const [s, b] of parts) assert.equal(await delivery.send(session({ agent: { state: 'working' } }), s, b), 'queued')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 5)
  const sends = terminalSends(cli)
  assert.equal(sends.length, 1)
  const text = textOf(sends[0])
  assert.equal(text, '5 messages\n\nOne\n\na\n\n----------\n\nTwo\n\nb\n\n----------\n\nThree\n\nc\n\n----------\n\nFour\n\nd\n\n----------\n\nFive\n\ne')
  assert.deepEqual(delivery.queued('/w/a'), [])
})

test('turns: after a send nothing more goes to that session until it has been seen working and idle again', async () => {
  const { cli, delivery } = build()
  assert.equal(await delivery.send(session(), 'First', 'one'), 'sent')
  assert.equal(await delivery.send(session(), 'Second', 'two'), 'queued')
  assert.equal(await delivery.flush(session()), 0)
  assert.equal(await delivery.send(session(), 'Third', 'three'), 'queued')
  assert.equal(await delivery.flush(session({ agent: { state: 'done' } })), 0)
  assert.deepEqual(terminalSends(cli).map(textOf), ['First\n\none'])
  assert.equal(await delivery.flush(session({ agent: { state: 'working' } })), 0)
  assert.equal(terminalSends(cli).length, 1)
  assert.equal(await delivery.flush(session()), 2)
  assert.deepEqual(terminalSends(cli).map(textOf), ['First\n\none', combined([['Second', 'two'], ['Third', 'three']])])
  assert.equal(await delivery.flush(session()), 0)
  assert.equal(terminalSends(cli).length, 2)
})

test('turns: the mark is per session, and it lapses after ten minutes by the injected clock', async () => {
  const host = makeHost({ rows: { '/w/a': 'active', '/w/b': 'active' } })
  const { cli, delivery, state } = build({ host })
  assert.equal(await delivery.send(session(), 'A1', 'x'), 'sent')
  assert.equal(await delivery.send(session({ path: '/w/b', agent: { terminalId: 'term_b' } }), 'B1', 'y'), 'sent')
  assert.equal(await delivery.send(session(), 'A2', 'x'), 'queued')
  state.now += 10 * 60 * 1000 - 1
  assert.equal(await delivery.flush(session()), 0)
  state.now += 1
  assert.equal(await delivery.flush(session()), 1)
  assert.deepEqual(terminalSends(cli).map(textOf), ['A1\n\nx', 'B1\n\ny', 'A2\n\nx'])
})

test('turns: chat mail is held to one message per turn too', async () => {
  const chat = { terminalId: null, chatId: 'chat1' }
  const { cli, delivery } = build()
  assert.equal(await delivery.send(session({ agent: chat }), 's1', 'b1'), 'sent')
  assert.equal(await delivery.send(session({ agent: chat }), 's2', 'b2'), 'queued')
  assert.equal(cli.calls.length, 1)
  assert.equal(await delivery.flush(session({ agent: { ...chat, state: 'working' } })), 0)
  assert.equal(await delivery.flush(session({ agent: chat })), 1)
  assert.equal(cli.calls.length, 2)
  assert.equal(cli.calls[1][5], 'orca_session_id:chat1')
})

test('turns: dispatch mail is exempt from the one-message-per-turn mark', async () => {
  const cli = fakeCli(() => ({ dispatchId: 'ctx_2' }))
  const { delivery, state, tracked } = build({ cli, from: null })
  const s = session({ started: 'orchestrator', dispatchId: 'ctx_1' })
  assert.equal(await delivery.send(s, 'Typed', 'one'), 'sent')
  assert.equal(terminalSends(cli).length, 1)
  state.from = 'term_orch'
  assert.equal(await delivery.send(s, 'Mailed', 'two'), 'sent')
  assert.equal(await delivery.send(s, 'Mailed again', 'three'), 'sent')
  assert.deepEqual(cli.calls.slice(1).map((a) => a[5]), ['dispatch:ctx_1', 'dispatch:ctx_1'])
  assert.deepEqual(tracked, ['ctx_2', 'ctx_2'])
})

const ORCH = LIVENESS.orchestrator
const ORCH_TERM = 'term_1f13679f-7807-4508-9488-54f96eb242ff'
const ORCH_PATH = '/Users/aamonnaig/.orca-orchestration/home'

function orchSession(agent = {}) {
  return session({ path: ORCH_PATH, agent: { terminalId: ORCH_TERM, sessionId: 'uuid-o', kind: 'claude', ...agent } })
}

test('liveness: the live orchestrator in the hidden home folder is proven by its real terminal list and worktree ps rows', async () => {
  const cli = livenessCli({ terminals: ORCH.terminalList, worktrees: ORCH.worktreePs })
  const { host, delivery } = build({ cli, host: makeHost({ rows: { [ORCH_PATH]: 'active' } }), realAlive: true })
  assert.equal(await delivery.send(orchSession(), 'From Aamon', 'hello'), 'sent')
  assert.deepEqual(terminalSends(cli).map((a) => a[3]), [ORCH_TERM])
  assert.equal(host.callsOf('agent.resume').length, 0)
})

test('liveness: the orchestrator terminal without its agent row is gone, and a non-orphaned row with a synthetic pty pane is unknown', async () => {
  const pane = ORCH.terminalList.terminals[0].recordedPaneKey
  const noAgent = {
    ...ORCH.worktreePs,
    worktrees: ORCH.worktreePs.worktrees.map((w) => ({ ...w, agents: w.agents.filter((a) => a.paneKey !== pane) }))
  }
  const gone = livenessCli({ terminals: ORCH.terminalList, worktrees: noAgent })
  const g = build({ cli: gone, host: makeHost({ rows: { [ORCH_PATH]: 'active' } }), realAlive: true })
  assert.equal(await g.delivery.send(orchSession({ sessionId: null, kind: null }), 's', 'b'), 'unreachable')
  assert.deepEqual(terminalSends(gone), [])

  const synthetic = { ...ORCH.terminalList, terminals: ORCH.terminalList.terminals.map((t) => ({ ...t, orphaned: false })) }
  const odd = livenessCli({ terminals: synthetic, worktrees: ORCH.worktreePs })
  const u = build({ cli: odd, host: makeHost({ rows: { [ORCH_PATH]: 'active' } }), realAlive: true })
  assert.equal(await u.delivery.send(orchSession(), 's', 'b'), 'queued')
  assert.deepEqual(terminalSends(odd), [])
  assert.equal(u.host.callsOf('agent.resume').length, 0)
})

const CAP = 64 * 1024
const TAIL = '\n[message truncated]'

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

test('cap: queued items are combined only up to 64 KB, and the rest wait for the next turn', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  const big = 'x'.repeat(30000)
  for (const subject of ['One', 'Two', 'Three']) await delivery.send(session({ agent: { state: 'working' } }), subject, big)
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 2)
  const first = textOf(terminalSends(cli)[0])
  assert.ok(byteLength(first) <= CAP)
  assert.equal(first, combined([['One', big], ['Two', big]]))
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['Three'])
  assert.equal(await delivery.flush(session({ agent: { state: 'working' } })), 0)
  assert.equal(await delivery.flush(session()), 1)
  assert.equal(textOf(terminalSends(cli)[1]), 'Three\n\n' + big)
  assert.deepEqual(delivery.queued('/w/a'), [])
})

test('cap: a single item over 64 KB is cut to the cap with a final truncation line, on every route', async () => {
  const body = '\u20ac'.repeat(200000)
  const term = build()
  assert.equal(await term.delivery.send(session(), 'Huge', body), 'sent')
  const typed = textOf(terminalSends(term.cli)[0])
  assert.ok(byteLength(typed) <= CAP)
  assert.ok(byteLength(typed) > CAP - 8)
  assert.ok(typed.startsWith('Huge\n\n\u20ac'))
  assert.ok(typed.endsWith('\u20ac' + TAIL))
  assert.ok(!typed.includes('\uFFFD'))

  const chat = build()
  assert.equal(await chat.delivery.send(session({ agent: { terminalId: null, chatId: 'chat1' } }), 'Huge', body), 'sent')
  const mail = chat.cli.calls[0]
  const sent = mail[6].slice('--subject='.length) + '\n\n' + mail[7].slice('--body='.length)
  assert.ok(byteLength(sent) <= CAP)
  assert.ok(sent.endsWith(TAIL))

  const dispatch = build({ cli: fakeCli(() => ({ dispatchId: 'ctx_2' })) })
  assert.equal(await dispatch.delivery.send(session({ started: 'orchestrator', dispatchId: 'ctx_1' }), 'Huge', body), 'sent')
  const d = dispatch.cli.calls[0]
  assert.ok(byteLength(d[6].slice('--subject='.length) + '\n\n' + d[7].slice('--body='.length)) <= CAP)
  assert.ok(d[7].endsWith(TAIL))
})

test('cap: an oversized item at the head goes alone and truncated, and the small one behind it waits', async () => {
  const { host, cli, delivery } = build({ host: makeHost({ rows: { '/w/a': 'working' } }) })
  await delivery.send(session({ agent: { state: 'working' } }), 'Huge', 'y'.repeat(2 * 1024 * 1024))
  await delivery.send(session({ agent: { state: 'working' } }), 'Small', 'z')
  host.answers['workspace.list'] = listOf({ '/w/a': 'active' })
  assert.equal(await delivery.flush(session()), 1)
  const text = textOf(terminalSends(cli)[0])
  assert.ok(byteLength(text) <= CAP)
  assert.ok(text.startsWith('Huge\n\nyyy'))
  assert.ok(text.endsWith(TAIL))
  assert.deepEqual(delivery.queued('/w/a').map((i) => i.subject), ['Small'])
})
