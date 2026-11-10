import test from 'node:test'
import assert from 'node:assert/strict'
import { appName, causeOf, createHealth, culpritOf, isOrca, rawLevel, stepOf, swapRate, topSuspects, QUIET, STEPS } from '../src/health.ts'

const GB = 1024 ** 3
const TOTAL = 16 * GB
const mac = /^(launchd|kernel_task|WindowServer|loginwindow)$/
const guard = { selfPids: [111, 222], protectedNames: mac }

function reading(at, memPct, swapGb, pressure = 'normal') {
  return { at, total: 20, memory: { total: TOTAL, used: (TOTAL * memPct) / 100 }, swap: swapGb === null ? null : swapGb * GB, swapTotal: 10 * GB, pressure }
}

function proc(pid, name, memGb, start = 'Thu Nov  6 09:00:00 2026') {
  return { pid, name, mem: memGb * GB, cpu: 1, start }
}

test('calm machine reads ok with headroom', () => {
  const r = reading(0, 52, 1)
  assert.equal(rawLevel(r, 0), 'ok')
  assert.equal(causeOf(r, 0), 'plenty of headroom')
})

test('memory pressure warning alone is strained', () => {
  assert.equal(rawLevel(reading(0, 70, 1, 'warning'), 0), 'warn')
})

test('pressure or swap trouble below the critical percent stays strained', () => {
  assert.equal(rawLevel(reading(0, 92, 4, 'warning'), 0.4 * GB), 'warn')
  assert.equal(rawLevel(reading(0, 80, 2, 'critical'), 0), 'warn')
  assert.equal(causeOf(reading(0, 80, 2, 'critical'), 0), 'memory pressure high')
})

test('critical starts at the memory percent, 95 by default', () => {
  assert.equal(rawLevel(reading(0, 94, 2, 'critical'), 1.2 * GB), 'warn')
  assert.equal(rawLevel(reading(0, 95, 2, 'normal'), 0), 'risk')
  assert.equal(rawLevel(reading(0, 96, 2, 'critical'), 0, 99), 'warn')
  assert.equal(rawLevel(reading(0, 99, 2, 'normal'), 0, 99), 'risk')
})

test('full memory with fast swap growth is critical and says why', () => {
  const r = reading(0, 97, 9)
  assert.equal(rawLevel(r, 1.2 * GB), 'crit')
  assert.equal(causeOf(r, 1.2 * GB), 'memory 97%, swap +1.2 GB/min')
})

test('busy CPU alone never raises the level', () => {
  const r = { ...reading(0, 40, 0), total: 100 }
  assert.equal(rawLevel(r, 0), 'ok')
})

test('windows without swap or pressure falls back to memory percent', () => {
  const r = { ...reading(0, 96, null), pressure: null }
  assert.equal(rawLevel(r, null), 'risk')
  assert.equal(rawLevel({ ...r, memory: { total: TOTAL, used: TOTAL * 0.985 } }, null), 'crit')
})

test('swap rate needs at least 20 seconds of data', () => {
  assert.equal(swapRate([reading(0, 50, 1), reading(10_000, 50, 2)]), null)
  const rate = swapRate([reading(0, 50, 1), reading(30_000, 50, 1.5)])
  assert.ok(Math.abs(rate - 1 * GB) < 1)
})

test('helpers group under their app', () => {
  assert.equal(appName('Google Chrome Helper (Renderer)'), 'Google Chrome')
  assert.equal(appName('Google Chrome Helper (GPU)'), 'Google Chrome')
  assert.equal(appName('Orca Helper (Renderer)'), 'Orca')
  assert.equal(appName('chrome.exe'), 'chrome')
  assert.ok(isOrca('Orca Helper'))
  assert.ok(isOrca('orca-terminal-host'))
})

test('culprit sums an app and targets its main process', () => {
  const list = [proc(10, 'Google Chrome', 1), proc(11, 'Google Chrome Helper (Renderer)', 8), proc(12, 'Google Chrome Helper (GPU)', 5), proc(20, 'Docker', 4)]
  const c = culpritOf(list, guard)
  assert.equal(c.app, 'Google Chrome')
  assert.equal(c.pid, 10)
  assert.equal(c.quittable, true)
  assert.ok(Math.abs(c.mem - 14 * GB) < 1)
})

test('never offers to quit Orca, even when it uses the most memory', () => {
  const list = [proc(30, 'Orca', 2), proc(31, 'Orca Helper (Renderer)', 9), proc(32, 'Orca Helper', 3), proc(10, 'Google Chrome', 4)]
  const c = culpritOf(list, guard)
  assert.equal(c.app, 'Orca')
  assert.equal(c.quittable, false)
})

test('never offers to quit its own worker or Orca host pids', () => {
  const c = culpritOf([proc(111, 'node', 12), proc(10, 'Safari', 1)], guard)
  assert.equal(c.pid, 111)
  assert.equal(c.quittable, false)
})

test('no Quit when the app has no main process to quit', () => {
  const c = culpritOf([proc(11, 'Google Chrome Helper (Renderer)', 9), proc(10, 'Safari', 1)], guard)
  assert.equal(c.app, 'Google Chrome')
  assert.equal(c.quittable, false)
})

test('protected system processes are never quittable', () => {
  const c = culpritOf([proc(400, 'WindowServer', 9)], guard)
  assert.equal(c.quittable, false)
})

test('ladder escalates after 5 seconds and settles after 15', () => {
  let now = 0
  const h = createHealth(() => now)
  const step = (memPct, swapGb, pressure) => {
    now += 3000
    return h.push(reading(now, memPct, swapGb, pressure))
  }
  assert.equal(step(70, 1, 'warning').level, 'ok')
  assert.equal(step(70, 1, 'warning').level, 'ok')
  const up = step(70, 1, 'warning')
  assert.equal(up.level, 'warn')
  assert.equal(up.escalated, true)
  for (let i = 0; i < 5; i++) assert.equal(step(50, 1, 'normal').level, 'warn')
  assert.equal(step(50, 1, 'normal').level, 'ok')
})

test('risk shows a toast, critical adds one notification, then quiet for 10 minutes', () => {
  let now = 0
  const h = createHealth(() => now)
  const MEM = { warning: 96, critical: 99, normal: 50 }
  const go = (pressure) => {
    now += 3000
    const r = h.push({ ...reading(now, MEM[pressure], null), pressure: null })
    if (r.level === 'risk' || r.level === 'crit') h.setCulprit({ pid: 10, name: 'Google Chrome', start: null, app: 'Google Chrome', mem: 14.2 * GB, quittable: true })
    return r.escalated ? h.alerts() : []
  }
  go('warning')
  go('warning')
  const risk = go('warning')
  assert.deepEqual(risk.map((a) => a.kind), ['toast'])
  go('critical')
  go('critical')
  const crit = go('critical')
  assert.deepEqual(crit.map((a) => a.kind), ['notify'])
  for (let i = 0; i < 30; i++) go('normal')
  now += QUIET
  go('critical')
  go('critical')
  const again = go('critical')
  assert.deepEqual(again.map((a) => a.kind).sort(), ['notify', 'toast'])
  assert.match(again[0].body, /Google Chrome is using 14\.2 GB/)
})

test('first jump straight to critical fires both toast and notification', () => {
  let now = 0
  const h = createHealth(() => now)
  now += 3000
  h.push(reading(now, 96, 2, 'critical'))
  now += 3000
  h.push(reading(now, 96, 2, 'critical'))
  now += 3000
  const r = h.push(reading(now, 96, 2, 'critical'))
  assert.equal(r.level, 'crit')
  assert.deepEqual(h.alerts().map((a) => a.kind), ['toast', 'notify'])
  now += 3000
  assert.deepEqual(h.alerts().map((a) => a.kind), [])
})

test('alerts never name Orca as the app to blame', () => {
  let now = 0
  const h = createHealth(() => now)
  for (let i = 0; i < 3; i++) {
    now += 3000
    h.push(reading(now, 96, 2, 'critical'))
  }
  h.setCulprit({ pid: 30, name: 'Orca', start: null, app: 'Orca', mem: 12 * GB, quittable: false })
  for (const a of h.alerts()) assert.doesNotMatch(a.body, /Orca/)
})

test('a sub-second spike at a 100ms refresh never escalates', () => {
  let now = 0
  const h = createHealth(() => now)
  for (let i = 0; i < 30; i++) {
    now += 100
    const r = h.push(reading(now, 80, 2, 'critical'))
    assert.equal(r.level, 'ok')
  }
  now += 100
  assert.equal(h.push(reading(now, 50, 2, 'normal')).level, 'ok')
})

test('many unrelated processes with one name get no Quit button', () => {
  const list = [proc(1001, 'node', 3), proc(1002, 'node', 3), proc(1003, 'node', 3), proc(1004, 'node', 3), proc(10, 'Safari', 2)]
  const c = culpritOf(list, guard)
  assert.equal(c.app, 'node')
  assert.equal(c.quittable, false)
})

test('several chrome.exe on Windows are treated as many processes, not one app to quit', () => {
  const list = [proc(1, 'chrome.exe', 2), proc(2, 'chrome.exe', 6), proc(3, 'chrome.exe', 4)]
  const c = culpritOf(list, guard)
  assert.equal(c.app, 'chrome')
  assert.equal(c.quittable, false)
})

test('a single main process with exe suffix is quittable', () => {
  const c = culpritOf([proc(7, 'Code.exe', 9), proc(8, 'Code Helper (Renderer).exe', 2)], guard)
  assert.equal(c.app, 'Code')
  assert.equal(c.pid, 7)
  assert.equal(c.quittable, true)
})

test('raising the critical percent keeps 96% memory on Strained', () => {
  let now = 0
  const h = createHealth(() => now)
  h.setCritAt(99)
  for (let i = 0; i < 3; i++) {
    now += 3000
    h.push(reading(now, 96, 2, 'critical'))
  }
  assert.equal(h.snapshot().word, 'Strained')
  h.setCritAt(95)
  for (let i = 0; i < 3; i++) {
    now += 3000
    h.push(reading(now, 96, 2, 'critical'))
  }
  assert.equal(h.snapshot().word, 'Critical')
  assert.equal(h.snapshot().level, 'crit')
})

test('five words: Idle, Healthy, Busy, Strained, Critical', () => {
  assert.deepEqual([...STEPS], ['Idle', 'Healthy', 'Busy', 'Strained', 'Critical'])
  assert.equal(stepOf('ok', 4, 40), 0)
  assert.equal(stepOf('ok', 4, 75), 1)
  assert.equal(stepOf('ok', 30, 40), 1)
  assert.equal(stepOf('ok', 85, 40), 2)
  assert.equal(stepOf('warn', 5, 40), 3)
  assert.equal(stepOf('risk', 5, 40), 4)
  assert.equal(stepOf('crit', 99, 99), 4)
})

test('Busy uses CPU averaged over 10 seconds, so one spike stays Healthy', () => {
  let now = 0
  const h = createHealth(() => now)
  for (let i = 0; i < 4; i++) {
    now += 3000
    h.push({ ...reading(now, 70, 1), total: 30 })
  }
  now += 3000
  h.push({ ...reading(now, 70, 1), total: 100 })
  assert.equal(h.snapshot().word, 'Healthy')
  for (let i = 0; i < 4; i++) {
    now += 3000
    h.push({ ...reading(now, 70, 1), total: 95 })
  }
  assert.equal(h.snapshot().word, 'Busy')
  assert.match(h.snapshot().cause, /^CPU \d+% for 10s$/)
  assert.equal(h.snapshot().level, 'ok')
})

test('the desktop notification is titled Critical', () => {
  let now = 0
  const h = createHealth(() => now)
  for (let i = 0; i < 3; i++) {
    now += 3000
    h.push(reading(now, 96, 2, 'critical'))
  }
  const notify = h.alerts().find((a) => a.kind === 'notify')
  assert.equal(notify.title, 'Critical')
  assert.equal(h.snapshot().word, 'Critical')
})

test('top suspects: five, by memory, apps grouped with helpers', () => {
  const list = [
    proc(10, 'Google Chrome', 1), proc(11, 'Google Chrome Helper (Renderer)', 8), proc(12, 'Google Chrome Helper (GPU)', 5),
    proc(20, 'Docker', 4), proc(30, 'Orca', 2), proc(31, 'Orca Helper (Renderer)', 4),
    proc(40, 'Slack', 1.5), proc(50, 'Finder', 0.2), proc(60, 'Spotify', 1)
  ]
  const top = topSuspects(list, guard, 'mem')
  assert.equal(top.length, 5)
  assert.deepEqual(top.map((t) => t.app), ['Google Chrome', 'Orca', 'Docker', 'Slack', 'Spotify'])
  assert.equal(top[0].count, 3)
  assert.equal(top[0].pid, 10)
  assert.equal(top[0].quittable, true)
  assert.equal(top[1].quittable, false)
})

test('top suspects split same-named processes so each Quit hits one pid', () => {
  const list = [proc(1001, 'node', 3), proc(1002, 'node', 1), proc(111, 'node', 5), proc(10, 'Safari', 2)]
  const top = topSuspects(list, guard, 'mem')
  assert.deepEqual(top.map((t) => t.pid), [111, 1001, 10, 1002])
  assert.equal(top[0].quittable, false)
  assert.equal(top[1].quittable, true)
  assert.equal(top[1].count, 1)
})

test('top suspects rank by CPU when busy and never offer Orca or system processes', () => {
  const list = [
    { ...proc(301, 'WindowServer', 0.1), cpu: 90 }, { ...proc(302, 'orca-terminal-host', 0.1), cpu: 80 },
    { ...proc(303, 'ffmpeg', 0.3), cpu: 300 }, { ...proc(304, 'Safari', 1), cpu: 5 }
  ]
  const top = topSuspects(list, guard, 'cpu')
  assert.deepEqual(top.map((t) => t.name), ['ffmpeg', 'WindowServer', 'orca-terminal-host', 'Safari'])
  assert.deepEqual(top.map((t) => t.quittable), [true, false, false, true])
})

test('while the word holds during recovery the cause says easing off, not plenty of headroom', () => {
  let now = 0
  const h = createHealth(() => now)
  for (let i = 0; i < 3; i++) {
    now += 3000
    h.push(reading(now, 70, 1, 'warning'))
  }
  assert.equal(h.snapshot().word, 'Strained')
  now += 3000
  h.push(reading(now, 50, 1, 'normal'))
  assert.equal(h.snapshot().word, 'Strained')
  assert.equal(h.snapshot().cause, 'easing off')
})
