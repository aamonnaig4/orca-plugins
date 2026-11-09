import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

async function harness() {
  let now = 0
  let nextFrame = 0
  let resize
  let theme
  let canvas
  let steps = 0
  let sinkNext = false
  const frames = new Map()
  const draws = []
  const saves = []
  const listeners = new Map()
  const stage = { clientWidth: 300, clientHeight: 440 }
  const labels = { '.strokes': {}, '.score': {} }
  function makeCanvas() {
    const events = new Map()
    const field = {
      style: {},
      getContext: () => ({ canvas: field }),
      addEventListener: (name, callback) => events.set(name, callback),
      setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 440 }),
      fire(name, x = 150, y = 300) { events.get(name)?.({ pointerId: 1, clientX: x, clientY: y }) }
    }
    return field
  }
  const app = {
    set innerHTML(html) {
      this.html = html
      canvas = html.includes('canvas class="field"') ? makeCanvas() : null
    },
    querySelectorAll: () => [],
    querySelector: (selector) => selector === 'canvas.field' ? canvas : selector === '.stage' ? stage : labels[selector],
    addEventListener: (name, callback) => listeners.set(name, callback)
  }
  const context = vm.createContext({
    console,
    performance: { now: () => now },
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id) => frames.delete(id),
    document: { getElementById: () => app, createElement: makeCanvas },
    ResizeObserver: class { constructor(callback) { resize = callback } observe() {} },
    setTimeout: (callback) => callback(),
    orca: {
      host: { call: async (name, value) => { if (name === 'storage.set') saves.push(value); return {} } },
      on: (_name, callback) => { theme = callback }
    },
    MiniGolfRender: {
      CELL: 2,
      readPalette: () => ({}),
      paintHole() {},
      paintThumbnail() {},
      drawFrame: (_context, _background, view) => draws.push({ ...view })
    }
  })
  for (const file of ['engine.js', 'course.js', 'save.js']) {
    vm.runInContext(readFileSync(new URL('../panel/' + file, import.meta.url), 'utf8'), context)
  }
  const originalStep = context.MiniGolfEngine.stepBall
  context.MiniGolfEngine.stepBall = (ball, hole) => {
    steps++
    if (sinkNext) {
      sinkNext = false
      ball.moving = false
      ball.sunk = true
    } else originalStep(ball, hole)
  }
  vm.runInContext(readFileSync(new URL('../panel/app.js', import.meta.url), 'utf8'), context)
  await new Promise((resolve) => setImmediate(resolve))
  return {
    app, draws, saves,
    get canvas() { return canvas },
    get pending() { return frames.size },
    get steps() { return steps },
    click(action, course = 0, holeIndex = 0) {
      listeners.get('click')({ target: { closest: () => ({ dataset: { action, course, holeIndex } }) } })
    },
    frame(ms = 1000 / 60) {
      now += ms
      const batch = [...frames.values()]
      frames.clear()
      for (const callback of batch) callback(now)
    },
    elapse(ms) { now += ms },
    shot() {
      canvas.fire('pointerdown')
      canvas.fire('pointermove', 150, 400)
      canvas.fire('pointerup')
    },
    sink() { sinkNext = true },
    resize() { stage.clientHeight = 500; resize() },
    theme() { theme() }
  }
}

test('library and a stationary hole leave no animation callback or physics work', async () => {
  const h = await harness()
  assert.equal(h.pending, 0)
  h.click('play')
  assert.equal(h.draws.length, 1)
  assert.equal(h.pending, 0)
  for (let i = 0; i < 120; i++) h.frame()
  assert.equal(h.draws.length, 1)
  assert.equal(h.steps, 0)
})

test('aim input coalesces into one frame and cancel clears the aim', async () => {
  const h = await harness()
  h.click('play')
  h.canvas.fire('pointerdown')
  for (let y = 320; y < 400; y++) h.canvas.fire('pointermove', 150, y)
  assert.equal(h.pending, 1)
  h.frame()
  assert.ok(h.draws.at(-1).shot)
  assert.equal(h.pending, 0)
  assert.equal(h.steps, 0)
  h.canvas.fire('pointercancel')
  h.frame()
  assert.equal(h.draws.at(-1).shot, null)
  assert.equal(h.pending, 0)
  // A release below the minimum power also clears the previous preview.
  h.canvas.fire('pointerdown')
  h.canvas.fire('pointermove', 150, 400)
  h.frame()
  h.canvas.fire('pointermove', 150, 301)
  h.canvas.fire('pointerup')
  h.frame()
  assert.equal(h.draws.at(-1).shot, null)
  assert.equal(h.draws.at(-1).ball.moving, false)
  assert.equal(h.pending, 0)
})

test('a shot after a long idle starts with a fresh clock and stops scheduling at rest', async () => {
  const h = await harness()
  h.click('play')
  h.elapse(60_000)
  h.shot()
  h.frame()
  assert.ok(h.steps > 0 && h.steps <= 5, 'the idle minute must not advance the new shot')
  assert.equal(h.pending, 1)
  let frames = 0
  while (h.pending && frames++ < 1000) h.frame()
  assert.ok(frames < 1000, 'the shot should come to rest')
  assert.equal(h.pending, 0)
  const draws = h.draws.length
  h.frame()
  assert.equal(h.draws.length, draws)
  // Resuming from rest starts another frame chain.
  h.shot()
  assert.equal(h.pending, 1)
})

test('sinking still scores once, holds the animation and advances to the next hole', async () => {
  const h = await harness()
  h.click('play')
  const firstCanvas = h.canvas
  const initialSaves = h.saves.length
  h.sink()
  h.shot()
  h.frame()
  assert.equal(h.saves.length, initialSaves + 1)
  assert.equal(h.pending, 1)
  for (let i = 0; i < 60; i++) h.frame()
  assert.equal(h.canvas, firstCanvas, 'the result stays visible during the hold')
  assert.equal(h.saves.length, initialSaves + 1)
  for (let i = 0; i < 35; i++) h.frame()
  assert.notEqual(h.canvas, firstCanvas)
  assert.match(h.app.html, /2\. /)
  assert.equal(h.saves.length, initialSaves + 2, 'one score and one next-hole start')
  assert.equal(h.pending, 0)
})

test('navigation cancels pending play frames, and resize/theme repaint a resting hole', async () => {
  const h = await harness()
  h.click('play')
  h.resize()
  h.theme()
  assert.equal(h.draws.length, 3)
  assert.equal(h.pending, 0)
  h.shot()
  assert.equal(h.pending, 1)
  h.click('library')
  assert.equal(h.pending, 0)
  const draws = h.draws.length
  h.frame()
  assert.equal(h.draws.length, draws)
  h.click('play')
  assert.equal(h.pending, 0)
  h.shot()
  assert.equal(h.pending, 1)
})
