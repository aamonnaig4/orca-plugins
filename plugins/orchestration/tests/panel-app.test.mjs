import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (f) => readFileSync(new URL('../panel/' + f, import.meta.url), 'utf8')

const VM = {
  rev: 1, firstRun: false, orch: null, chat: [], queued: 0, rows: [], idle: [], needs: 0, asks: 0,
  gh: { ok: true }, watching: 1, intervalSec: 60, hooksOff: false, guard: { on: true, blocksToday: 0 }
}

function field(role, value = '', key) {
  const f = {
    dataset: { role, ...(key ? { key } : {}) },
    value,
    focused: false,
    focus() { f.focused = true },
    setSelectionRange() {},
    selectionStart: 0,
    selectionEnd: 0,
    parentElement: null
  }
  return f
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const VALUED = new Set(['input', 'textarea', 'select'])
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const decode = (v) => String(v).replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m])

function makeDom() {
  const writes = []
  const doc = { activeElement: null, body: null }
  let root = null
  const write = (node) => { if (root && root.contains(node)) writes.push(node) }
  const blur = (node) => { if (doc.activeElement && node.contains && node.contains(doc.activeElement)) doc.activeElement = doc.body }
  class Text {
    constructor(v) { this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = v; this.parentNode = null }
    get outerHTML() { return this.nodeValue }
    contains(n) { return n === this }
  }
  class El {
    constructor(tag, attrs = []) {
      this.nodeType = 1
      this.nodeName = tag.toUpperCase()
      this.tagName = this.nodeName
      this.attributes = attrs
      this.childNodes = []
      this.parentNode = null
      this.scrollTop = 0
      this.clientHeight = 0
      this.sh = null
      if (VALUED.has(tag)) {
        let v = null
        Object.defineProperty(this, 'value', {
          get: () => (v != null ? v : tag === 'textarea' ? decode(this.childNodes.map((c) => c.nodeValue || '').join('')) : this.getAttribute('value') || ''),
          set: (x) => { v = String(x) },
          enumerable: true
        })
        this.selectionStart = 0
        this.selectionEnd = 0
      }
    }
    get tag() { return this.nodeName.toLowerCase() }
    getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? (a.value == null ? '' : decode(a.value)) : null }
    get id() { return this.getAttribute('id') || '' }
    get dataset() {
      const d = {}
      for (const a of this.attributes) if (a.name.startsWith('data-')) d[a.name.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = a.value == null ? '' : decode(a.value)
      return d
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1) }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null }
    get content() { return this }
    get scrollHeight() { return this.sh != null ? this.sh : this.children.length * 100 }
    set scrollHeight(v) { this.sh = v }
    focus() { doc.activeElement = this }
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode } return false }
    insertBefore(n, ref) {
      if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1)
      const i = ref ? this.childNodes.indexOf(ref) : -1
      if (i < 0) this.childNodes.push(n)
      else this.childNodes.splice(i, 0, n)
      n.parentNode = this
      write(this)
      return n
    }
    appendChild(n) { return this.insertBefore(n, null) }
    removeChild(n) {
      const i = this.childNodes.indexOf(n)
      if (i < 0) throw new Error('not a child')
      write(this)
      blur(n)
      this.childNodes.splice(i, 1)
      n.parentNode = null
      return n
    }
    replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); return old }
    get innerHTML() { return this.childNodes.map((c) => c.outerHTML).join('') }
    set innerHTML(h) {
      write(this)
      for (const c of this.childNodes) { blur(c); c.parentNode = null }
      this.childNodes = []
      for (const c of parse(h)) { c.parentNode = this; this.childNodes.push(c) }
    }
    get outerHTML() {
      const attrs = this.attributes.map((a) => (a.value == null ? ' ' + a.name : ' ' + a.name + '="' + a.value + '"')).join('')
      return '<' + this.tag + attrs + '>' + (VOID.has(this.tag) ? '' : this.innerHTML + '</' + this.tag + '>')
    }
    matches(sel) {
      const m = /^([a-z0-9]+)?(?:#([\w-]+))?((?:\[[^\]]+\])*)$/.exec(sel)
      if (!m) throw new Error('selector ' + sel)
      if (m[1] && m[1] !== this.tag) return false
      if (m[2] && this.id !== m[2]) return false
      for (const a of m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const v = this.getAttribute(a[1])
        if (v == null) return false
        if (a[2] != null && v !== a[2]) return false
      }
      return true
    }
    querySelectorAll(sel) {
      const out = []
      const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c) } }
      walk(this)
      return out
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode } return null }
  }
  function parse(html) {
    const top = new El('template')
    const stack = [top]
    const re = /<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>\/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
    let m
    while ((m = re.exec(html))) {
      const cur = stack[stack.length - 1]
      if (m[1]) {
        const t = m[1].toLowerCase()
        const i = stack.map((n) => n.tag).lastIndexOf(t)
        if (i > 0) stack.length = i
      } else if (m[2]) {
        const tag = m[2].toLowerCase()
        const attrs = [...m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map((a) => ({ name: a[1], value: a[2] == null ? null : a[2] }))
        const node = new El(tag, attrs)
        node.parentNode = cur
        cur.childNodes.push(node)
        if (!VOID.has(tag) && !m[4]) stack.push(node)
      } else {
        const t = new Text(m[5])
        t.parentNode = cur
        cur.childNodes.push(t)
      }
    }
    const kids = top.childNodes
    for (const k of kids) k.parentNode = null
    return kids
  }
  root = new El('div', [{ name: 'id', value: 'app' }, { name: 'class', value: 'shell' }])
  doc.body = new El('body')
  doc.body.appendChild(root)
  doc.createElement = (tag) => new El(tag)
  return { root, doc, writes, parse, El }
}

function boot({ views = [], vmValue = VM, replies = {}, extraViews = null, scripts = ['patch.js'] } = {}) {
  const calls = []
  const listeners = {}
  const intervals = []
  const cleared = []
  const timeouts = []
  const opened = []
  const panelHandlers = {}
  const dom = makeDom()
  const root = dom.root
  const document = dom.doc
  Object.assign(document, {
    visibilityState: 'visible',
    documentElement: { classList: { contains: () => true, add() {} } },
    getElementById: () => root,
    addEventListener(type, fn) { listeners[type] = fn }
  })
  const orca = {
    plugin: {
      request(name, input) {
        calls.push([name, JSON.parse(JSON.stringify(input))])
        if (name in replies) return Promise.resolve(typeof replies[name] === 'function' ? replies[name](input) : replies[name])
        if (name === 'view.read') return Promise.resolve(vmValue)
        if (name === 'agents.list') return Promise.resolve([{ id: 'claude', label: 'Claude', cmd: 'claude', installed: true }])
        if (name === 'settings.save') return Promise.resolve({ guard: true })
        if (name === 'row.detail') return Promise.resolve({ lines: ['x'] })
        if (name === 'pr.url') return Promise.resolve({ url: 'https://github.com/o/r/pull/4' })
        return Promise.resolve({})
      },
      on(name, fn) { panelHandlers[name] = fn }
    },
    shell: { openExternal(url) { opened.push(url); return Promise.resolve({ opened: true }) } },
    host: { call: () => Promise.resolve({}) },
    on() {}
  }
  const window = { orca, document }
  const ctx = vm.createContext({
    window,
    setInterval: (fn, ms) => { intervals.push([fn, ms]); return intervals.length },
    clearInterval: (id) => { cleared.push(id) },
    setTimeout: (fn, ms) => { timeouts.push(ms); return 0 },
    clearTimeout: () => {}
  })
  for (const f of ['esc.js', 'chat.js']) vm.runInContext(read(f), ctx)
  const extra = typeof extraViews === 'function' ? extraViews(window.OrchViews) : extraViews
  for (const [name, fn] of Object.entries(extra || {})) window.OrchViews[name] = fn
  for (const f of views) vm.runInContext(read(f), ctx)
  for (const f of scripts) vm.runInContext(read(f), ctx)
  vm.runInContext(read('app.js'), ctx)
  return { calls, cleared, timeouts, listeners, intervals, opened, panelHandlers, root, window, document, dom }
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

function el(dataset, extra = {}) {
  const node = {
    dataset,
    parentElement: null,
    closest(sel) {
      if (sel === '[data-act]') return node
      if (sel === 'form[data-act="send"]') return dataset.act === 'send' ? node : null
      if (sel === 'form') return node
      return null
    },
    ...extra
  }
  return node
}

const names = (calls) => calls.map((c) => c[0])
const termTimers = (app) => app.intervals.filter(([, ms], i) => ms === 1000 && !app.cleared.includes(i + 1))
const click = (app, d) => app.listeners.click({ target: el(d) })

test('load asks view.read, subscribes to the view event and polls every 5 s', async () => {
  const app = boot()
  await settle()
  assert.deepEqual(names(app.calls), ['view.read', 'settings.save'])
  assert.deepEqual(app.calls[1], ['settings.save', {}])
  assert.equal(typeof app.panelHandlers.view, 'function')
  assert.ok(app.intervals.some(([, ms]) => ms === 5000))
  assert.ok(!app.intervals.some(([, ms]) => ms === 1000))
  app.panelHandlers.view()
  await settle()
  assert.equal(names(app.calls).filter((n) => n === 'view.read').length, 2)
  app.intervals.find(([, ms]) => ms === 5000)[0]()
  await settle()
  assert.equal(names(app.calls).filter((n) => n === 'view.read').length, 3)
})

test('polling stops while the panel is hidden', async () => {
  const app = boot()
  await settle()
  app.document.visibilityState = 'hidden'
  app.intervals.find(([, ms]) => ms === 5000)[0]()
  await settle()
  assert.equal(names(app.calls).filter((n) => n === 'view.read').length, 1)
})

test('a missing chat view renders View unavailable instead of throwing', async () => {
  const app = boot({ extraViews: (V) => { delete V.chat; return {} } })
  await settle()
  assert.ok(app.root.innerHTML.includes('View unavailable'))
})

test('a chat view that throws renders View unavailable', async () => {
  const app = boot({ extraViews: { chat() { throw new Error('boom') } } })
  await settle()
  assert.ok(app.root.innerHTML.includes('View unavailable'))
})

test('first run loads the installed agents and pick-agent saves the choice', async () => {
  const app = boot({ vmValue: { ...VM, firstRun: true } })
  await settle()
  assert.deepEqual(names(app.calls), ['view.read', 'settings.save', 'agents.list'])
  assert.ok(app.root.innerHTML.includes('data-act="pick-agent"'))
  app.listeners.click({ target: el({ act: 'pick-agent', agent: 'claude' }) })
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'firstrun.save'), ['firstrun.save', { agent: 'claude' }])
})

test('every data-act in the vocabulary reaches the expected request', async () => {
  const vocabulary = [
    'open-detail', 'back', 'send', 'starter', 'answer', 'pick-agent', 'card', 'idle-toggle', 'row', 'remove-ask', 'remove-cancel', 'idle-clear',
    'peek-key', 'pr-open', 'setting', 'agent-menu', 'strip-toggle', 'board-open', 'plan-toggle', 'copy', 'link', 'pin-step'
  ]
  const seen = new Set()
  const cases = [
    ['click', { act: 'open-detail', key: 'k1' }, null, [['row.detail', { key: 'k1', tab: 'terminal' }]]],
    ['click', { act: 'back' }, 'detail', []],
    ['click', { act: 'agent-menu' }, null, ['agents.list', 'settings.save']],
    ['click', { act: 'strip-toggle' }, null, []],
    ['click', { act: 'pin-step', step: '1' }, null, []],
    ['click', { act: 'card', id: 'approval:k', action: 'start' }, null, [['card.act', { id: 'approval:k', action: 'start' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'dismiss' }, null, [['card.act', { id: 'approval:k', action: 'dismiss' }]]],
    ['click', { act: 'board-open' }, null, [['board.url', {}]]],
    ['click', { act: 'plan-toggle', id: 'pl', open: 'false' }, null, []],
    ['click', { act: 'copy', id: 'missing' }, null, []],
    ['click', { act: 'link', url: 'https://github.com/o/r/pull/9' }, null, []],
    ['click', { act: 'link', url: 'javascript:alert(1)' }, null, []],
    ['submit', { act: 'send' }, 'form', [['chat.send', { text: 'hello there' }]]],
    ['click', { act: 'starter', text: 'Close out my open PRs' }, null, [['chat.send', { text: 'Close out my open PRs' }]]],
    ['click', { act: 'answer', id: 'q1', option: 'yimby' }, null, [['chat.answer', { id: 'q1', option: 'yimby' }]]],
    ['click', { act: 'pick-agent', agent: 'codex' }, null, [['firstrun.save', { agent: 'codex' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'allow' }, null, [['card.act', { id: 'approval:k', action: 'allow' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'deny' }, null, [['card.act', { id: 'approval:k', action: 'deny' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'retry' }, null, [['card.act', { id: 'approval:k', action: 'retry' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'details' }, null, [['card.act', { id: 'approval:k', action: 'details' }]]],
    ['click', { act: 'card', id: 'approval:k', action: 'peek' }, null, [['card.act', { id: 'approval:k', action: 'peek' }], ['row.detail', { key: 'sess', tab: 'terminal' }]]],
    ['click', { act: 'idle-toggle' }, null, []],
    ['click', { act: 'remove-ask', key: 'k1' }, null, []],
    ['click', { act: 'remove-cancel' }, null, []],
    ['click', { act: 'idle-clear' }, null, [['idle.clear', { confirmed: true }]]],
    ['click', { act: 'row', key: 'k1', action: 'open' }, null, [['row.act', { key: 'k1', action: 'open' }]]],
    ['click', { act: 'row', key: 'k1', action: 'retry' }, null, [['row.act', { key: 'k1', action: 'retry' }]]],
    ['click', { act: 'row', key: 'k1', action: 'stop' }, null, [['row.act', { key: 'k1', action: 'stop' }]]],
    ['click', { act: 'row', key: 'k1', action: 'remove', confirmed: 'true' }, null, [['row.act', { key: 'k1', action: 'remove', confirmed: true }]]],
    ['click', { act: 'row', key: 'k1', action: 'autofix-ci', on: 'false' }, null, [['row.act', { key: 'k1', action: 'autofix-ci', on: false }]]],
    ['click', { act: 'row', key: 'k1', action: 'autofix-review', on: 'true' }, null, [['row.act', { key: 'k1', action: 'autofix-review', on: true }]]],
    ['click', { act: 'peek-key', key: 'k1', name: 'esc' }, null, [['peek.key', { key: 'k1', name: 'esc' }]]],
    ['click', { act: 'pr-open', key: 'k1' }, null, [['pr.url', { key: 'k1' }]]],
    ['change', { act: 'setting', name: 'intervalSec' }, 'number', [['settings.save', { intervalSec: 120 }]]],
    ['change', { act: 'setting', name: 'guard' }, 'check', [['settings.save', { guard: false }]]],
    ['change', { act: 'setting', name: 'suffix' }, 'text', [['settings.save', { suffix: '-zz' }]]]
  ]
  for (const [type, dataset, mode, expected] of cases) {
    const app = boot({ replies: { 'card.act': (input) => (input.action === 'peek' ? { open: 'sess' } : {}), 'board.url': { url: 'http://127.0.0.1:4319/' } } })
    await settle()
    if (mode === 'detail') {
      app.listeners.click({ target: el({ act: 'open-detail', key: 'k1' }) })
      await settle()
    }
    const before = app.calls.length
    let target
    if (mode === 'form') {
      const box = field('chat-input', 'hello there')
      target = el(dataset, { querySelector: () => box })
    } else if (mode === 'number') target = el(dataset, { type: 'select-one', value: '120' })
    else if (mode === 'check') target = el(dataset, { type: 'checkbox', checked: false })
    else if (mode === 'text') target = el(dataset, { type: 'text', value: '-zz' })
    else target = el(dataset)
    app.listeners[type]({ target, preventDefault() {} })
    await settle()
    seen.add(dataset.act)
    const made = app.calls.slice(before).filter((c) => c[0] !== 'view.read')
    const want = expected.map((e) => (typeof e === 'string' ? e : e[0]))
    assert.deepEqual(made.map((c) => c[0]), want, JSON.stringify(dataset))
    expected.forEach((e, i) => { if (typeof e !== 'string') assert.deepEqual(made[i][1], e[1], JSON.stringify(dataset)) })
    if (dataset.act === 'pr-open') assert.deepEqual(app.opened, ['https://github.com/o/r/pull/4'])
    if (dataset.act === 'board-open') assert.deepEqual(app.opened, ['http://127.0.0.1:4319/'])
    if (dataset.act === 'link') assert.deepEqual(app.opened, /^https:/.test(dataset.url) ? [dataset.url] : [])
  }
  assert.deepEqual([...seen].sort(), vocabulary.slice().sort())
})

test('strip, idle, menu and remove clicks change the state the chat view receives', async () => {
  const seen = []
  const app = boot({ extraViews: { chat(vm, ui) { seen.push(JSON.stringify(ui)); return '<div>chat ' + seen.length + '</div>' } } })
  await settle()
  const last = () => JSON.parse(seen[seen.length - 1])
  click(app, { act: 'strip-toggle' })
  click(app, { act: 'idle-toggle' })
  click(app, { act: 'remove-ask', key: 'k1' })
  assert.deepEqual(last(), { idleOpen: true, stripOpen: true, menu: false, files: [], wide: false, pin: 0, confirmRemove: 'k1', plans: {}, copied: null })
  click(app, { act: 'remove-cancel' })
  click(app, { act: 'agent-menu' })
  assert.deepEqual(last(), { idleOpen: true, stripOpen: true, menu: 'chip', files: [], wide: false, pin: 0, confirmRemove: null, plans: {}, copied: null })
  click(app, { act: 'idle-toggle' })
  assert.equal(last().menu, false)
  click(app, { act: 'pin-step', step: '1' })
  click(app, { act: 'pin-step', step: '1' })
  click(app, { act: 'pin-step', step: '-1' })
  assert.equal(last().pin, 1)
  click(app, { act: 'open-detail', key: 'k1' })
  click(app, { act: 'strip-toggle' })
  assert.equal(last().stripOpen, false)
})

test('send ignores an empty box and clears the box when it sends', async () => {
  const app = boot()
  await settle()
  const empty = field('chat-input', '   ')
  app.listeners.submit({ target: el({ act: 'send' }, { querySelector: () => empty }), preventDefault() {} })
  await settle()
  assert.ok(!names(app.calls).includes('chat.send'))
  const box = field('chat-input', 'do it')
  app.listeners.submit({ target: el({ act: 'send' }, { querySelector: () => box }), preventDefault() {} })
  assert.equal(box.value, '')
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'chat.send'), ['chat.send', { text: 'do it' }])
})

test('Enter in the box sends and Shift+Enter does not', async () => {
  const app = boot()
  await settle()
  const box = field('chat-input', 'one')
  box.closest = () => ({ querySelector: () => box })
  app.listeners.keydown({ target: box, key: 'Enter', shiftKey: true, preventDefault() {} })
  await settle()
  assert.ok(!names(app.calls).includes('chat.send'))
  app.listeners.keydown({ target: box, key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'chat.send'), ['chat.send', { text: 'one' }])
})

test('text typed in the box survives a re-render that replaces the box', async () => {
  let rev = 1
  const app = boot({
    replies: { 'view.read': () => ({ ...VM, rev }) },
    extraViews: { chat: (v) => '<p class="m">m' + v.rev + '</p><form data-act="send"><textarea data-role="chat-input" data-rev="' + v.rev + '"></textarea></form>' }
  })
  await settle()
  const draft = app.root.querySelector('[data-role="chat-input"]')
  draft.value = 'half a thought'
  draft.focus()
  draft.setSelectionRange(2, 6)
  rev = 2
  app.panelHandlers.view()
  await settle()
  assert.ok(app.root.innerHTML.includes('m2'))
  const fresh = app.root.querySelector('[data-role="chat-input"]')
  assert.notEqual(fresh, draft)
  assert.equal(fresh.value, 'half a thought')
  assert.equal(app.document.activeElement, fresh)
  assert.deepEqual([fresh.selectionStart, fresh.selectionEnd], [2, 6])
})

test('an opened session reads its terminal once and then every second', async () => {
  const app = boot()
  await settle()
  assert.equal(termTimers(app).length, 0)
  click(app, { act: 'open-detail', key: 'k1' })
  await settle()
  assert.equal(termTimers(app).length, 1)
  assert.equal(names(app.calls).filter((n) => n === 'row.detail').length, 1)
  termTimers(app)[0][0]()
  await settle()
  assert.equal(names(app.calls).filter((n) => n === 'row.detail').length, 2)
})

test('the orchestrator detail opens on the Terminal tab', async () => {
  const app = boot()
  await settle()
  app.listeners.click({ target: el({ act: 'open-detail', key: 'orchestrator' }) })
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'row.detail'), ['row.detail', { key: 'orchestrator', tab: 'terminal' }])
})

test('a failed request shows a notice line and does not throw', async () => {
  const app = boot({ replies: { 'chat.answer': () => Promise.reject(new Error('<img src=x onerror=1>')) } })
  await settle()
  app.listeners.click({ target: el({ act: 'answer', id: 'q', option: 'a' }) })
  await settle()
  assert.ok(app.root.innerHTML.includes('class="notice"'))
  assert.ok(!app.root.innerHTML.includes('<img'))
})

test('the terminal timer runs only while a session is open in the strip', async () => {
  const app = boot()
  await settle()
  assert.equal(termTimers(app).length, 0)
  click(app, { act: 'open-detail', key: 'k1' })
  await settle()
  assert.equal(termTimers(app).length, 1)
  click(app, { act: 'back' })
  await settle()
  assert.equal(termTimers(app).length, 0)
  click(app, { act: 'open-detail', key: 'k1' })
  await settle()
  assert.equal(termTimers(app).length, 1)
  click(app, { act: 'open-detail', key: 'k1' })
  await settle()
  assert.equal(termTimers(app).length, 0)
  click(app, { act: 'open-detail', key: 'k2' })
  await settle()
  assert.equal(termTimers(app).length, 1)
  click(app, { act: 'strip-toggle' })
  await settle()
  assert.equal(termTimers(app).length, 0)
  assert.equal(app.intervals.filter(([, ms]) => ms === 1000).length, 3)
})

test('a row.detail failure on the Terminal timer raises the notice once per streak', async () => {
  let failing = true
  const app = boot({ replies: { 'row.detail': () => (failing ? Promise.reject(new Error('gone')) : { lines: ['x'] }) } })
  await settle()
  const notices = () => app.timeouts.filter((ms) => ms === 5000).length
  click(app, { act: 'open-detail', key: 'k1', tab: 'terminal' })
  await settle()
  assert.equal(notices(), 1)
  const tick = termTimers(app)[0][0]
  for (let i = 0; i < 3; i++) { tick(); await settle() }
  assert.equal(notices(), 1)
  failing = false
  tick()
  await settle()
  failing = true
  tick()
  await settle()
  assert.equal(notices(), 2)
  tick()
  await settle()
  assert.equal(notices(), 2)
})

test('a settings.save result without the expected keys keeps the previous settings', async () => {
  const full = { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa', intervalSec: 60, attempts: 3, guard: true, onCi: 'fix', onConflict: 'fix', onReview: 'fix', noAgent: 'start', scope: 'all', model: '', effort: '', fast: false, plan: false, permissionMode: '' }
  let next = full
  const seen = []
  const app = boot({
    replies: { 'settings.save': () => next },
    extraViews: { chat(vm, ui, x) { seen.push(x.settings); return '<div>chat ' + seen.length + '</div>' } }
  })
  await settle()
  click(app, { act: 'agent-menu' })
  await settle()
  assert.deepEqual(seen[seen.length - 1], full)
  for (const bad of [{}, null, [], { guard: false }]) {
    next = bad
    click(app, { act: 'agent-menu' })
    click(app, { act: 'agent-menu' })
    await settle()
    assert.deepEqual(seen[seen.length - 1], full)
  }
})

const descendants = (node) => {
  const out = []
  const walk = (n) => { for (const c of n.childNodes || []) { out.push(c); walk(c) } }
  walk(node)
  return out
}
const note = (i) => ({ id: 'c' + i, at: i, from: 'panel', kind: 'text', text: 'note ' + i })
const notes = (n) => Array.from({ length: n }, (_, i) => note(i))
const counting = (name, box) => (V) => {
  const real = V[name]
  return { [name]: (...args) => { box.n += 1; return real.apply(V, args) } }
}

test('the chat scroll position survives a re-render when scrolled up and sticks to the bottom otherwise', async () => {
  let queued = 0
  const app = boot({ replies: { 'view.read': () => ({ ...VM, chat: notes(10), queued }) } })
  await settle()
  const list = app.root.querySelector('[data-role="chat-list"]')
  list.clientHeight = 200
  list.scrollTop = 300
  app.listeners.scroll({ target: list })
  queued = 1
  app.panelHandlers.view()
  await settle()
  assert.ok(app.root.innerHTML.includes('1 queued'))
  assert.equal(app.root.querySelector('[data-role="chat-list"]').scrollTop, 300)
  const again = app.root.querySelector('[data-role="chat-list"]')
  again.scrollTop = 800
  app.listeners.scroll({ target: again })
  queued = 2
  app.panelHandlers.view()
  await settle()
  const end = app.root.querySelector('[data-role="chat-list"]')
  assert.equal(end.scrollTop, end.scrollHeight)
})

test('a second render with an identical view model writes nothing to the DOM', async () => {
  const app = boot({ replies: { 'view.read': () => ({ ...VM, chat: notes(3) }) } })
  await settle()
  const mark = app.dom.writes.length
  app.window.OrchApp.state.vm = { ...VM, chat: notes(3) }
  click(app, { act: 'remove-cancel' })
  await settle()
  assert.equal(app.dom.writes.length, mark)
})

const stripRow = (key, column, extra = {}) => ({ key, name: key, project: 'p', branch: 'b-' + key, pr: null, lane: column, column, tone: 'build', phrase: 'Working', label: 'Working', ...extra })

test('a strip-only change keeps every chat node', async () => {
  let retry = 47
  const app = boot({ views: ['time.js', 'strip.js'], replies: { 'view.read': () => ({ ...VM, gh: { ok: false, reason: 'rate-limited', retryInSec: retry }, chat: notes(3) }) } })
  await settle()
  assert.deepEqual(app.root.children.map((c) => c.tag), ['main'])
  const body = app.root.querySelector('#body')
  const list = app.root.querySelector('div[data-role="chat-list"]')
  const inside = descendants(list)
  retry = 46
  app.panelHandlers.view()
  await settle()
  assert.ok(app.root.innerHTML.includes('retrying in 46s'))
  assert.equal(app.root.querySelector('#body'), body)
  assert.equal(app.root.querySelector('div[data-role="chat-list"]'), list)
  const after = descendants(list)
  assert.equal(after.length, inside.length)
  inside.forEach((n, i) => assert.equal(after[i], n))
})

test('one session label change replaces that strip row and keeps its siblings', async () => {
  let label = 'Working'
  const app = boot({ views: ['time.js', 'strip.js'], replies: { 'view.read': () => ({ ...VM, rows: [stripRow('a', 'building'), stripRow('b', 'building', { label }), stripRow('c', 'ready')] }) } })
  await settle()
  click(app, { act: 'strip-toggle' })
  await settle()
  const q = (sel) => app.root.querySelector(sel)
  const keep = ['div[data-key="a"]', 'div[data-key="c"]']
  const before = keep.map(q)
  const b = q('div[data-key="b"]')
  assert.ok(before.every(Boolean) && b)
  label = 'Fixing CI failures'
  app.panelHandlers.view()
  await settle()
  assert.ok(app.root.innerHTML.includes('Fixing CI failures'))
  keep.forEach((sel, i) => assert.equal(q(sel), before[i], sel))
})

test('an appended chat item keeps the existing items and scrolls only when the list was at the bottom', async () => {
  let n = 10
  const app = boot({ replies: { 'view.read': () => ({ ...VM, chat: notes(n) }) } })
  await settle()
  const list = app.root.querySelector('[data-role="chat-list"]')
  list.clientHeight = 200
  let items = list.children.slice()
  list.scrollTop = 800
  app.listeners.scroll({ target: list })
  n = 11
  app.panelHandlers.view()
  await settle()
  assert.equal(app.root.querySelector('[data-role="chat-list"]'), list)
  assert.equal(list.children.length, 11)
  items.forEach((it, i) => assert.equal(list.children[i], it))
  assert.equal(list.scrollTop, 1100)
  list.scrollTop = 100
  app.listeners.scroll({ target: list })
  items = list.children.slice()
  n = 12
  app.panelHandlers.view()
  await settle()
  assert.equal(list.children.length, 12)
  items.forEach((it, i) => assert.equal(list.children[i], it))
  assert.equal(list.scrollTop, 100)
})

test('text, selection and focus in the chat box survive a body change elsewhere', async () => {
  let n = 1
  const app = boot({ replies: { 'view.read': () => ({ ...VM, chat: notes(n), queued: n > 1 ? 1 : 0 }) } })
  await settle()
  const box = app.root.querySelector('[data-role="chat-input"]')
  box.value = 'half a thought'
  box.focus()
  box.setSelectionRange(2, 6)
  n = 2
  app.panelHandlers.view()
  await settle()
  assert.ok(app.root.innerHTML.includes('note 1') && app.root.innerHTML.includes('1 queued'))
  assert.equal(app.root.querySelector('[data-role="chat-input"]'), box)
  assert.equal(box.value, 'half a thought')
  assert.equal(app.document.activeElement, box)
  assert.deepEqual([box.selectionStart, box.selectionEnd], [2, 6])
})

test('a refresh that returns a deep-equal view model does not render', async () => {
  const box = { n: 0 }
  let rev = 1
  const app = boot({ replies: { 'view.read': () => ({ ...VM, rev, chat: notes(2) }) }, extraViews: counting('chat', box) })
  await settle()
  const first = box.n
  app.panelHandlers.view()
  await settle()
  app.intervals.find(([, ms]) => ms === 5000)[0]()
  await settle()
  assert.equal(names(app.calls).filter((x) => x === 'view.read').length, 3)
  assert.equal(box.n, first)
  rev = 2
  app.panelHandlers.view()
  await settle()
  assert.equal(box.n, first + 1)
})

test('copy falls back to the selection copy when the clipboard call is refused, and says so only if both fail', async () => {
  const item = { id: 'o1', at: 1, from: 'orchestrator', kind: 'text', text: 'Here is where things stand.' }
  for (const [clipboard, legacy, copied] of [['refuse', true, true], ['throw', true, true], ['none', true, true], ['ok', false, true], ['refuse', false, false]]) {
    const app = boot({ vmValue: { ...VM, chat: [item] } })
    await settle()
    const wrote = []
    const selected = []
    if (clipboard !== 'none') {
      app.window.navigator = { clipboard: { writeText(text) {
        if (clipboard === 'throw') throw new Error('blocked')
        if (clipboard === 'refuse') return Promise.reject(new Error('NotAllowedError'))
        wrote.push(text)
        return Promise.resolve()
      } } }
    }
    app.document.body = { appendChild() {}, removeChild() {} }
    const make = app.document.createElement
    app.document.createElement = (tag) => {
      if (tag !== 'textarea') return make(tag)
      const box = { style: {}, setAttribute() {}, select() { selected.push(box.value) } }
      return box
    }
    app.document.execCommand = () => legacy
    click(app, { act: 'copy', id: 'o1' })
    await settle()
    const label = clipboard + '/' + legacy
    assert.equal(app.root.innerHTML.includes('aria-label="Copied"'), copied, label)
    assert.equal(app.root.innerHTML.includes('Could not copy the message'), !copied, label)
    if (clipboard === 'ok') assert.deepEqual(wrote, [item.text])
    else assert.deepEqual(selected, [item.text], label)
  }
})

test('the live timer runs only while the orchestrator is working and rewrites the elapsed text', async () => {
  let orch = { state: 'working', agentKind: 'claude', since: Date.now() - 5000, doing: 'Running ls' }
  const app = boot({ replies: { 'view.read': () => ({ ...VM, orch }) } })
  await settle()
  const lives = () => app.intervals.filter(([, ms], i) => ms === 1000 && !app.cleared.includes(i + 1))
  assert.equal(lives().length, 1)
  const stamp = app.root.querySelector('span[data-since]')
  assert.ok(stamp)
  stamp.textContent = 'old'
  lives()[0][0]()
  assert.match(stamp.textContent, /^\d+s$/)
  orch = { ...orch, state: 'waiting' }
  app.panelHandlers.view()
  await settle()
  assert.equal(lives().length, 0)
})

test('a pinned approval reads its prompt while it is pinned and again after a choice is sent', async () => {
  const approval = { id: 'approval:k', key: 'k', kind: 'approval', title: 't', detail: 'd', actions: ['allow', 'deny', 'peek'], at: 1, resolved: null }
  let rows = [stripRow('k', 'building', { lane: 'needs', card: approval })]
  const app = boot({ views: ['time.js', 'strip.js'], replies: { 'view.read': () => ({ ...VM, rows }), 'row.detail': { lines: ['Do you want to proceed?', '❯ 1. Yes', '  2. No'] } } })
  await settle()
  const reads = () => app.calls.filter((c) => c[0] === 'row.detail')
  const pins = () => app.intervals.filter(([, ms], i) => ms === 1500 && !app.cleared.includes(i + 1))
  assert.deepEqual(reads().map((c) => c[1]), [{ key: 'k', tab: 'terminal' }])
  assert.equal(pins().length, 1)
  assert.ok(app.root.innerHTML.includes('Do you want to proceed?'))
  pins()[0][0]()
  await settle()
  assert.equal(reads().length, 2)
  click(app, { act: 'peek-key', key: 'k', name: '1' })
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'peek.key'), ['peek.key', { key: 'k', name: '1' }])
  assert.equal(reads().length, 3)
  rows = []
  app.panelHandlers.view()
  await settle()
  assert.equal(pins().length, 0)
  assert.ok(!app.root.innerHTML.includes('Do you want to proceed?'))
})

test('a wide panel tells the views so, and a resize back to narrow does too', async () => {
  const seen = []
  const app = boot({ extraViews: { chat(vm, ui) { seen.push(ui.wide); return '<div>chat ' + seen.length + '</div>' } } })
  await settle()
  assert.equal(seen[seen.length - 1], false)
  app.root.clientWidth = 900
  app.window.OrchApp.measure()
  assert.equal(seen[seen.length - 1], true)
  const count = seen.length
  app.window.OrchApp.measure()
  assert.equal(seen.length, count)
  app.root.clientWidth = 400
  app.window.OrchApp.measure()
  assert.equal(seen[seen.length - 1], false)
})

test('clicking the idle count on a closed strip opens it with the idle sessions shown', async () => {
  const seen = []
  const app = boot({ extraViews: { chat(vm, ui) { seen.push([ui.stripOpen, ui.idleOpen]); return '<div>chat ' + seen.length + '</div>' } } })
  await settle()
  click(app, { act: 'idle-toggle' })
  assert.deepEqual(seen[seen.length - 1], [true, true])
  click(app, { act: 'idle-toggle' })
  assert.deepEqual(seen[seen.length - 1], [true, false])
  click(app, { act: 'idle-toggle' })
  click(app, { act: 'strip-toggle' })
  assert.deepEqual(seen[seen.length - 1], [false, true])
  click(app, { act: 'idle-toggle' })
  assert.deepEqual(seen[seen.length - 1], [true, true])
})

test('a chat image is read once through the worker and shows when its data arrives', async () => {
  const chat = [{ id: 'o1', at: 1, from: 'orchestrator', kind: 'result', text: '![After](/tmp/after.png)\n\n![Gone](/tmp/gone.png)' }]
  const app = boot({
    views: ['md.js'],
    vmValue: { ...VM, chat },
    replies: { 'image.read': (input) => (input.src === '/tmp/after.png' ? { data: 'data:image/png;base64,AAAA' } : Promise.reject(new Error('nope'))) }
  })
  await settle()
  const reads = app.calls.filter((c) => c[0] === 'image.read').map((c) => c[1].src).sort()
  assert.deepEqual(reads, ['/tmp/after.png', '/tmp/gone.png'])
  assert.ok(app.root.innerHTML.includes('<img class="md-img" src="data:image/png;base64,AAAA" alt="After">'), app.root.innerHTML)
  assert.ok(app.root.innerHTML.includes('<span class="md-img-miss">Gone</span>'), app.root.innerHTML)
  app.panelHandlers.view()
  await settle()
  assert.equal(app.calls.filter((c) => c[0] === 'image.read').length, 2)
})

test('clicking a workspace link in the chat opens that workspace', async () => {
  const app = boot({ views: ['md.js'], vmValue: { ...VM, idle: [{ key: '/w/yimby-86', name: 'yimby-86', branch: 'fix/x-oa' }], chat: [{ id: 'o1', at: 1, from: 'orchestrator', kind: 'text', text: 'cleaned up yimby-86' }] } })
  await settle()
  assert.ok(app.root.innerHTML.includes('data-act="row" data-action="open" data-key="/w/yimby-86"'), app.root.innerHTML)
  click(app, { act: 'row', action: 'open', key: '/w/yimby-86' })
  await settle()
  assert.deepEqual(app.calls.find((c) => c[0] === 'row.act')[1], { key: '/w/yimby-86', action: 'open' })
})

const FULL = { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa', intervalSec: 60, attempts: 3, guard: true, onCi: 'fix', onConflict: 'fix', onReview: 'fix', noAgent: 'start', scope: 'all', model: '', effort: '', fast: false, plan: false, permissionMode: '' }

function composerApp() {
  let current = { ...FULL }
  const seen = []
  const app = boot({
    replies: { 'settings.save': (patch) => { current = { ...current, ...patch }; return { ...current } }, 'chat.attach': (input) => ({ path: '/inbox/1-' + input.name, name: input.name }) },
    extraViews: { chat(vm, ui, x) { seen.push({ ui: JSON.parse(JSON.stringify(ui)), settings: x.settings }); return '<div>chat ' + seen.length + '</div>' } }
  })
  return { app, last: () => seen[seen.length - 1], saved: () => app.calls.filter((c) => c[0] === 'settings.save' && Object.keys(c[1]).length > 0).map((c) => c[1]) }
}

test('the +, chip and permission buttons each open their own menu, and a second press closes it', async () => {
  const { app, last } = composerApp()
  await settle()
  assert.deepEqual(last().settings, FULL)
  click(app, { act: 'menu-go', menu: 'plus' })
  assert.equal(last().ui.menu, 'plus')
  click(app, { act: 'menu-go', menu: 'perm' })
  assert.equal(last().ui.menu, 'perm')
  click(app, { act: 'menu-go', menu: 'perm' })
  assert.equal(last().ui.menu, false)
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'agent-menu' })
  assert.equal(last().ui.menu, 'chip')
  click(app, { act: 'menu-go', menu: 'chip:model' })
  assert.equal(last().ui.menu, 'chip:model')
  click(app, { act: 'menu-go', menu: 'chip' })
  assert.equal(last().ui.menu, 'chip')
  click(app, { act: 'agent-menu' })
  assert.equal(last().ui.menu, false)
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'strip-toggle' })
  assert.equal(last().ui.menu, false)
})

test('picking in a chip drill-down saves the value and goes back to the main chip menu', async () => {
  const { app, last, saved } = composerApp()
  await settle()
  click(app, { act: 'agent-menu' })
  click(app, { act: 'menu-go', menu: 'chip:model' })
  const inMenu = el({ act: 'set', name: 'model', value: 'opus' })
  const base = inMenu.closest
  inMenu.closest = (sel) => (sel === '[data-role="agent-menu"]' ? inMenu : base(sel))
  app.listeners.click({ target: inMenu })
  await settle()
  assert.deepEqual(saved(), [{ model: 'opus' }])
  assert.equal(last().ui.menu, 'chip')
  assert.equal(last().settings.model, 'opus')
})

test('Plan mode and Fast mode flip their setting and close the menu; a permission pick saves only the mode', async () => {
  const { app, last, saved } = composerApp()
  await settle()
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'toggle', name: 'plan' })
  await settle()
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'toggle', name: 'fast' })
  await settle()
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'toggle', name: 'fast' })
  await settle()
  click(app, { act: 'menu-go', menu: 'perm' })
  click(app, { act: 'perm', value: 'acceptEdits' })
  await settle()
  assert.deepEqual(saved(), [{ plan: true }, { fast: true }, { fast: false }, { permissionMode: 'acceptEdits' }])
  assert.equal(last().ui.menu, false)
})

test('New worker starts the message for the user and keeps what they typed', async () => {
  const { app, last } = composerApp()
  await settle()
  const box = field('chat-input', 'fix the login bug')
  let focused = false
  box.focus = () => { focused = true }
  app.document.querySelector = (sel) => (sel === '[data-role="chat-input"]' ? box : null)
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'new-worker' })
  assert.equal(box.value, 'Start a new worker to fix the login bug')
  assert.ok(focused)
  assert.equal(last().ui.menu, false)
  click(app, { act: 'new-worker' })
  assert.equal(box.value, 'Start a new worker to fix the login bug')
})

test('Files reads the picked files, drops ones over 4 MB or past four, and sends them with the message', async () => {
  const { app, last } = composerApp()
  await settle()
  app.window.FileReader = class { readAsDataURL(f) { this.result = 'data:text/plain;base64,' + Buffer.from(f.name).toString('base64'); this.onload() } }
  let clicked = false
  const input = { dataset: { role: 'attach-input' }, value: 'x', click() { clicked = true }, files: [] }
  app.document.querySelector = (sel) => (sel === '[data-role="attach-input"]' ? input : null)
  click(app, { act: 'menu-go', menu: 'plus' })
  click(app, { act: 'attach' })
  assert.ok(clicked)
  input.files = [{ name: 'a.txt', size: 3 }, { name: 'huge.bin', size: 5 * 1024 * 1024 }, { name: 'b.png', size: 9 }]
  app.listeners.change({ target: input })
  await settle()
  assert.equal(input.value, '')
  assert.deepEqual(last().ui.files.map((f) => f.name), ['a.txt', 'b.png'])
  input.files = [1, 2, 3].map((n) => ({ name: n + '.txt', size: 1 }))
  app.listeners.change({ target: input })
  await settle()
  assert.deepEqual(last().ui.files.map((f) => f.name), ['a.txt', 'b.png', '1.txt', '2.txt'])
  click(app, { act: 'unattach', i: '2' })
  assert.deepEqual(last().ui.files.map((f) => f.name), ['a.txt', 'b.png', '2.txt'])
  const box = field('chat-input', '  ')
  app.listeners.submit({ target: el({ act: 'send' }, { querySelector: () => box }), preventDefault() {} })
  assert.deepEqual(last().ui.files, [])
  await settle()
  const attach = app.calls.filter((c) => c[0] === 'chat.attach')
  assert.deepEqual(attach.map((c) => c[1].name), ['a.txt', 'b.png', '2.txt'])
  assert.ok(attach[0][1].data.startsWith('data:text/plain;base64,'))
  assert.deepEqual(app.calls.find((c) => c[0] === 'chat.send'), ['chat.send', { files: ['/inbox/1-a.txt', '/inbox/1-b.png', '/inbox/1-2.txt'] }])
})
