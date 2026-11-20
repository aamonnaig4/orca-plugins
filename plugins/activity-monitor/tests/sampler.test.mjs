import test from 'node:test'
import assert from 'node:assert/strict'
import { createSampler } from '../src/sampler.ts'

const GB = 1024 ** 3
const START = 'Thu Nov 5 09:02:44 2026'

function stubProvider(over = {}) {
  return {
    diskPath: '/',
    diskName: 'Root (/)',
    countIrq: true,
    procEvery: 0,
    protectedNames: /^(launchd|loginwindow)$/,
    info: async () => ({ performance: [], efficiency: [], model: '' }),
    note: async () => null,
    read: async () => ({ memory: { total: 100, used: 25, app: 25, wired: 0, compressed: 0, cached: 0 }, swap: null, pressure: null, net: null, disk: null, gpu: null }),
    procs: async () => null,
    identify: async () => null,
    quit: async () => ({ ok: true }),
    detailsEvery: 0,
    details: async () => null,
    cwds: async () => new Map(),
    args: async () => new Map(),
    ...over
  }
}

function quitter(identity) {
  const quits = []
  const provider = stubProvider({
    identify: async (pid) => (pid === 999 ? identity : null),
    quit: async (pid, force) => { quits.push([pid, force]); return { ok: true } }
  })
  return { quits, sampler: createSampler({ provider }) }
}

const changed = { ok: false, reason: 'That process changed; try again' }

test('quit refuses a request with no start time when the live process has one', async () => {
  const { quits, sampler } = quitter({ name: 'node', start: START })
  assert.deepEqual(await sampler.quit(999, 'node', null), changed)
  assert.deepEqual(await sampler.quit(999, 'node', null, true), changed)
  assert.deepEqual(await sampler.quit(999, 'node', ''), changed)
  assert.deepEqual(quits, [])
})

test('quit refuses a request with a start time when the live process has none', async () => {
  const { quits, sampler } = quitter({ name: 'node', start: null })
  assert.deepEqual(await sampler.quit(999, 'node', START), changed)
  assert.deepEqual(await sampler.quit(999, 'node', START, true), changed)
  assert.deepEqual(quits, [])
})

test('quit refuses a different start time on normal and force quit', async () => {
  const { quits, sampler } = quitter({ name: 'node', start: START })
  assert.deepEqual(await sampler.quit(999, 'node', 'Wed Nov 4 08:00:00 2026'), changed)
  assert.deepEqual(await sampler.quit(999, 'node', 'Wed Nov 4 08:00:00 2026', true), changed)
  assert.deepEqual(quits, [])
})

test('quit proceeds when the start time matches, or when neither side has one', async () => {
  const matched = quitter({ name: 'node', start: START })
  assert.deepEqual(await matched.sampler.quit(999, 'node', START), { ok: true })
  assert.deepEqual(await matched.sampler.quit(999, 'node', START, true), { ok: true })
  assert.deepEqual(matched.quits, [[999, false], [999, true]])
  const bare = quitter({ name: 'node', start: null })
  assert.deepEqual(await bare.sampler.quit(999, 'node', null), { ok: true })
  assert.deepEqual(bare.quits, [[999, false]])
})

test('quit keeps refusing Orca, its own pids, and protected names before identifying', async () => {
  const { quits, sampler } = quitter({ name: 'node', start: START })
  assert.deepEqual(await sampler.quit(1, 'launchd', null), { ok: false, reason: 'Not allowed' })
  assert.deepEqual(await sampler.quit(process.pid, 'node', START), { ok: false, reason: 'Not allowed' })
  assert.deepEqual(await sampler.quit(999, 'Orca Helper', START), { ok: false, reason: 'Quit Orca from its own menu' })
  assert.deepEqual(await sampler.quit(999, 'loginwindow', START, true), { ok: false, reason: 'Protected system process' })
  assert.deepEqual(quits, [])
})

test('a slow process list at lock-up risk does not hold up reads, and the culprit lands later', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let now = 0
  const provider = stubProvider({
    read: async () => ({ memory: { total: 16 * GB, used: 15.8 * GB, app: 0, wired: 0, compressed: 0, cached: 0 }, swap: 9 * GB, swapTotal: 10 * GB, pressure: 'critical', net: null, disk: null, gpu: null }),
    procs: async () => { await gate; return [{ pid: 4242, name: 'Hog', cpu: 1, mem: 6 * GB, start: START }] }
  })
  const alerts = []
  const sampler = createSampler({ provider, cpus: () => [], space: async () => null, settle: 0, clock: () => now, selfPids: [1, 2] })
  sampler.onAlert((alert) => alerts.push(alert))
  for (let i = 0; i < 40; i += 1) {
    now += 1000
    const started = Date.now()
    const out = await Promise.race([
      sampler.read({ interval: 100 }),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))
    ])
    assert.notEqual(out, 'blocked', 'read waited on the process list')
    assert.ok(Date.now() - started < 500)
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (sampler.health().level === 'crit' || sampler.health().level === 'risk') break
  }
  assert.ok(['risk', 'crit'].includes(sampler.health().level), 'reached risk, got ' + sampler.health().level)
  assert.equal(sampler.health().culprit, null)
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sampler.health().culprit?.mem, 6 * GB)
  assert.ok(alerts.length > 0)
  assert.match(alerts[0].body, /is using/)
})

function quiet() {
  return createSampler({ provider: stubProvider(), cpus: () => [{ user: 1, nice: 0, sys: 1, idle: 8, irq: 0 }], space: async () => null, settle: 0, selfPids: [] })
}

test('pulse with background recording off and no recent read leaves history empty', async () => {
  const sampler = quiet()
  sampler.setRecording(false)
  await sampler.pulse()
  const out = await sampler.read({ interval: 10000 })
  assert.equal(out.sample.seq, 1)
  assert.deepEqual(out.history, [])
  assert.equal(out.windowed, false)
})

test('pulse with background recording on adds to history', async () => {
  const sampler = quiet()
  await sampler.pulse()
  const out = await sampler.read({ interval: 10000 })
  assert.deepEqual(out.history.map((p) => p.seq), [1])
})

test('pulse within 10s of a read still records while background recording is off', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const sampler = createSampler({ provider: stubProvider(), cpus: () => [{ user: 1, nice: 0, sys: 1, idle: 8, irq: 0 }], space: async () => null, settle: 0, selfPids: [], clock: () => Date.now() })
  sampler.setRecording(false)
  const first = await sampler.read({ interval: 1000 })
  t.mock.timers.tick(5000)
  await sampler.pulse()
  t.mock.timers.tick(20000)
  await sampler.pulse()
  const out = await sampler.read({ interval: 10000, boot: first.boot, since: 0 })
  assert.deepEqual(out.history.map((p) => p.seq), [1, 2])
})

test('read returns a windowed history only when the span outgrows the raw point count', async () => {
  const sampler = quiet()
  const short = await sampler.read({ interval: 1000, span: 900 })
  assert.equal(short.windowed, false)
  const long = await sampler.read({ interval: 1000, span: 3600 })
  assert.equal(long.windowed, true)
  assert.ok(long.history.length <= 600)
  const fast = await sampler.read({ interval: 100, span: 300 })
  assert.equal(fast.windowed, true)
  const slow = await sampler.read({ interval: 5000, span: 3600 })
  assert.equal(slow.windowed, true)
})

test('listProcs, inspect and guard reach the provider data for the cleanup', async () => {
  const list = [{ pid: 7, ppid: 1, name: 'node', cpu: 1, mem: 10, start: START }]
  const asked = []
  const provider = stubProvider({
    procs: async () => list,
    cwds: async (pids) => { asked.push(['cwds', pids]); return new Map([[7, '/tmp']]) },
    args: async (pids) => { asked.push(['args', pids]); return new Map([[7, 'node server.js']]) }
  })
  const sampler = createSampler({ provider, selfPids: [42] })
  assert.deepEqual(await sampler.listProcs(), list)
  const seen = await sampler.inspect([7, 8], (args) => [...args.keys()])
  assert.equal(seen.cwds.get(7), '/tmp')
  assert.equal(seen.args.get(7), 'node server.js')
  assert.deepEqual(asked, [['args', [7, 8]], ['cwds', [7]]])
  const guard = sampler.guard()
  assert.deepEqual(guard.selfPids, [42])
  assert.equal(guard.protectedNames, provider.protectedNames)
})

test('an async cpus source feeds the core loads', async () => {
  let n = 0
  const sampler = createSampler({
    provider: stubProvider(),
    settle: 5,
    cpus: async () => {
      n += 1
      return [{ user: n * 10, nice: 0, sys: 0, idle: n * 10, irq: 0 }, { user: 0, nice: 0, sys: 0, idle: n * 10, irq: 0 }]
    }
  })
  const out = await sampler.read({})
  assert.equal(out.sample.cores.length, 2)
  assert.ok(out.sample.loads[0] > 40 && out.sample.loads[0] < 60)
  assert.equal(out.sample.loads[1], 0)
})

test('quit guards only the configured self pids', async () => {
  const quits = []
  const provider = stubProvider({ identify: async () => ({ name: 'x', start: null }), quit: async (pid) => { quits.push(pid); return { ok: true } } })
  const guarded = createSampler({ provider, selfPids: [321] })
  assert.deepEqual(await guarded.quit(321, 'x', null), { ok: false, reason: 'Not allowed' })
  assert.deepEqual(await guarded.quit(process.pid, 'x', null), { ok: true })
  assert.deepEqual(quits, [process.pid])
})
