import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'

const dir = new URL('../panel/', import.meta.url)

function load() {
  const window = {}
  const ctx = { window }
  vm.createContext(ctx)
  if (existsSync(new URL('esc.js', dir))) {
    vm.runInContext(readFileSync(new URL('esc.js', dir), 'utf8'), ctx)
  }
  if (!window.OrchEsc) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    window.OrchEsc = { html: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => map[c]) }
  }
  vm.runInContext(readFileSync(new URL('time.js', dir), 'utf8'), ctx)
  vm.runInContext(readFileSync(new URL('board.js', dir), 'utf8'), ctx)
  return window.OrchViews.board
}

const board = load()

function row(over = {}) {
  return {
    key: 'k1',
    name: 'albums-grid',
    project: 'orca-plugins',
    branch: 'feat/albums',
    agentKind: 'claude',
    started: 'you',
    pr: 11,
    prUrl: 'https://github.com/o/r/pull/11',
    lane: 'building',
    phrase: 'Working · 14m',
    tone: 'build',
    card: null,
    autoFix: { ci: true, review: false },
    queued: 0,
    stale: false,
    ...over,
  }
}

function vm_(rows = [], idle = []) {
  return { rows, idle }
}

const ui = (over = {}) => ({ idleOpen: false, menuKey: null, confirmRemove: null, ...over })

const card = {
  id: 'approval:k2',
  key: 'k2',
  kind: 'approval',
  title: 'geo-index-oa',
  detail: 'wants to run: pnpm install',
  actions: ['allow', 'deny', 'peek'],
  at: 1,
  resolved: null,
}

test('the four lanes always render in order with a count each', () => {
  const html = board(
    vm_([
      row({ key: 'a', lane: 'ready', column: 'ready', name: 'r1', phrase: 'Mergeable', tone: 'ok' }),
      row({ key: 'c', lane: 'building', column: 'building', name: 'b1' }),
      row({ key: 'd', lane: 'building', column: 'building', name: 'b2' }),
      row({ key: 'e', lane: 'review', column: 'review', name: 'v1', phrase: 'Awaiting review', tone: 'info' }),
    ]),
    ui(),
  )
  const order = ['Building', 'Validating', 'In review', 'Ready'].map((t) => html.indexOf('<span>' + t + '</span>'))
  assert.ok(order.every((n) => n >= 0))
  assert.deepEqual([...order].sort((x, y) => x - y), order)
  assert.ok(!html.includes('Needs you'))
  assert.match(html, /<span>Building<\/span><b>2<\/b>/)
  assert.match(html, /lane-validating lane-empty[^>]*>[^]*?<span>Validating<\/span><b>0<\/b>/)
  assert.match(html, /<span>Ready<\/span><b>1<\/b>/)
})

test('a session that needs you stays in its own column and is marked for attention', () => {
  const html = board(
    vm_([
      row({ key: 'n', lane: 'needs', column: 'validating', name: 'n1', phrase: 'CI failing · 3 fix attempts used', label: 'CI failing', tone: 'bad' }),
      row({ key: 'b', lane: 'building', column: 'building', name: 'b1' }),
    ]),
    ui(),
  )
  const validating = html.slice(html.indexOf('lane-validating'), html.indexOf('lane-review'))
  assert.ok(validating.includes('data-key="n"'))
  assert.match(validating, /class="bcard board-row attn"[^>]*data-key="n"/)
  assert.ok(validating.includes('>CI failing</span>'))
  assert.ok(!validating.includes('3 fix attempts used'))
  assert.ok(!/class="bcard board-row attn"[^>]*data-key="b"/.test(html))
  const old = board(vm_([row({ key: 'o', lane: 'needs', column: undefined })]), ui())
  assert.ok(old.slice(old.indexOf('lane-building'), old.indexOf('lane-validating')).includes('data-key="o"'))
  const odd = board(vm_([row({ key: 'p', column: 'constructor' })]), ui())
  assert.ok(odd.slice(odd.indexOf('lane-building'), odd.indexOf('lane-validating')).includes('data-key="p"'))
})

test('a card shows the branch, the PR state, a short status and how long ago', () => {
  const now = 10 * 3_600_000
  const html = board(
    vm_([
      row({ key: 'a', branch: 'ao/pr-closeout-2/root', pr: 4356, draft: false, label: 'CI failing', at: now - 3 * 3_600_000 }),
      row({ key: 'b', branch: null, pr: 4550, draft: true, label: 'Working', working: true, at: now - 5 * 60_000 }),
      row({ key: 'c', pr: null, at: now - 20_000 }),
      row({ key: 'd', pr: null, at: null }),
    ]),
    ui({ now }),
  )
  const part = (k) => html.slice(html.indexOf('data-key="' + k + '"'), html.indexOf('bcard-foot', html.indexOf('data-key="' + k + '"')) + 400)
  assert.ok(part('a').includes('ao/pr-closeout-2/root') && part('a').includes('#i-branch'))
  assert.ok(part('a').includes('pr-ic pr-open') && part('a').includes('#4356'))
  assert.ok(part('a').includes('>3h ago<'))
  assert.ok(part('b').includes('pr-ic pr-draft') && part('b').includes('>5m ago<'))
  assert.ok(part('b').includes('class="spin"') && !part('a').includes('class="spin"'))
  assert.ok(!part('b').split('board-prline')[0].includes('#i-branch'))
  assert.ok(part('c').includes('pr-ic pr-none') && part('c').includes('>now<'))
  assert.ok(!part('d').split('</div></div>')[0].includes('board-time'))
})

test('a row shows name, PR number or no PR, project tag and phrase; stale adds a class', () => {
  const html = board(
    vm_([
      row({ key: 'a', name: 'albums-grid', pr: 11, phrase: 'Fixing CI failures · sent 1m ago', stale: true }),
      row({ key: 'b', name: 'orchestration', pr: null, project: 'yimby', phrase: 'Working · 3m' }),
    ]),
    ui(),
  )
  assert.ok(html.includes('albums-grid'))
  assert.ok(html.includes('#11'))
  assert.ok(html.includes('no PR'))
  assert.ok(html.includes('orca-plugins'))
  assert.ok(html.includes('yimby'))
  assert.ok(html.includes('Fixing CI failures · sent 1m ago'))
  assert.match(html, /class="[^"]*\bstale\b[^"]*"[^>]*data-key="a"|data-key="a"[^>]*class="[^"]*\bstale\b/)
  const second = html.slice(html.indexOf('orchestration'))
  assert.ok(!/\bstale\b/.test(second.split('data-key="b"')[0].slice(-200)))
})

test('the row main area opens details', () => {
  const html = board(vm_([row()]), ui())
  assert.match(html, /data-act="open-detail"[^>]*data-key="k1"|data-key="k1"[^>]*data-act="open-detail"/)
})

test('a Needs you row with an approval card renders the chat card buttons', () => {
  const html = board(
    vm_([row({ key: 'k2', lane: 'needs', name: 'geo-index-oa', phrase: 'Blocked · wants to run pnpm install', tone: 'bad', card })]),
    ui(),
  )
  for (const [action, label] of [['allow', 'Allow once'], ['deny', 'Deny'], ['peek', 'Peek']]) {
    const re = new RegExp(`data-act="card"[^>]*data-id="approval:k2"[^>]*data-action="${action}"[^>]*>[^]*?${label}`)
    assert.match(html, re)
  }
})

test('card buttons follow the card actions', () => {
  const peekOnly = { ...card, actions: ['peek'] }
  const html = board(vm_([row({ lane: 'needs', tone: 'bad', card: peekOnly })]), ui())
  assert.ok(!html.includes('Allow once'))
  assert.ok(!html.includes('>Deny<'))
  assert.ok(html.includes('Peek'))
  const att = { ...card, id: 'attempts:k1', kind: 'attempts', actions: ['retry', 'details'] }
  const h2 = board(vm_([row({ lane: 'needs', tone: 'bad', card: att })]), ui())
  assert.match(h2, /data-action="retry"[^>]*>[^]*?Retry fix/)
  assert.match(h2, /data-action="details"[^>]*>[^]*?Details/)
})

test('idle renders as one line with a count and expands to cards', () => {
  const idle = [1, 2, 3].map((n) =>
    row({ key: 'i' + n, name: 'idle' + n, lane: 'idle', column: 'idle', phrase: 'Idle · last active 2h ago', label: 'Idle', tone: 'info', pr: null }),
  )
  const closed = board(vm_([], idle), ui())
  assert.match(closed, /data-act="idle-toggle" aria-expanded="false">[^]*?<span>Idle<\/span><b>3<\/b>/)
  assert.ok(!closed.includes('idle1'))
  const open = board(vm_([], idle), ui({ idleOpen: true }))
  assert.ok(open.includes('idle1') && open.includes('idle2') && open.includes('idle3'))
  assert.ok(open.includes('aria-expanded="true"'))
  const lanes = open.slice(0, open.indexOf('board-foot'))
  assert.ok(!lanes.includes('idle1'))
  const none = board(vm_([row()], []), ui())
  assert.ok(!none.includes('idle-toggle'))
})

test('empty board shows one line', () => {
  const html = board(vm_([], []), ui())
  assert.ok(html.includes('No sessions yet. Agents you start in Orca show up here.'))
  assert.ok(!html.includes('Building'))
})

test('the menu lists the actions for a session with a PR', () => {
  const html = board(vm_([row()]), ui({ menuKey: 'k1' }))
  for (const t of ['Details', 'Message', 'Retry fix', 'Auto-fix CI', 'Auto-fix review comments', 'Stop agent', 'Remove worktree…']) {
    assert.ok(html.includes(t), t)
  }
  assert.match(html, /data-act="menu"[^>]*data-key="k1"|data-key="k1"[^>]*data-act="menu"/)
  assert.match(html, /data-act="row"[^>]*data-action="retry"|data-action="retry"[^>]*data-act="row"/)
  assert.match(html, /data-action="autofix-ci"[^>]*data-on="false"|data-on="false"[^>]*data-action="autofix-ci"/)
  assert.match(html, /data-action="autofix-review"[^>]*data-on="true"|data-on="true"[^>]*data-action="autofix-review"/)
  assert.match(html, /data-action="stop"/)
  assert.match(html, /data-act="remove-ask"/)
  assert.match(html, /data-tab="status"/)
})

test('the menu is closed unless menuKey matches', () => {
  const html = board(vm_([row()]), ui({ menuKey: 'other' }))
  assert.ok(!html.includes('Stop agent'))
})

test('no PR hides Retry fix and the auto-fix items', () => {
  const html = board(vm_([row({ pr: null })]), ui({ menuKey: 'k1' }))
  assert.ok(html.includes('Details') && html.includes('Message') && html.includes('Stop agent'))
  assert.ok(!html.includes('Retry fix'))
  assert.ok(!html.includes('Auto-fix'))
})

test('confirm remove shows the note, Remove and Cancel', () => {
  const html = board(vm_([row()]), ui({ confirmRemove: 'k1' }))
  assert.ok(html.includes('Its branch and PR stay on GitHub.'))
  assert.match(html, /data-act="row"[^>]*data-action="remove"[^>]*data-confirmed="true"/)
  assert.match(html, /data-act="remove-cancel"/)
  const other = board(vm_([row()]), ui({ confirmRemove: 'zzz' }))
  assert.ok(!other.includes('Its branch and PR stay on GitHub.'))
})

test('hostile text is escaped', () => {
  const evil = '<img src=x onerror=1>'
  const hostileCard = { ...card, key: 'k9', id: 'approval:k9', detail: evil, title: evil }
  const html = board(
    vm_(
      [row({ key: 'k9', name: evil, project: evil, branch: evil, phrase: evil, card: hostileCard, lane: 'needs' })],
      [row({ key: 'i9', name: evil, project: evil, branch: evil, phrase: evil, lane: 'idle' })],
    ),
    ui({ menuKey: 'k9', idleOpen: true, confirmRemove: 'k9' }),
  )
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
})

test('hostile key is escaped inside attributes', () => {
  const key = '"><img src=x onerror=1>'
  const html = board(vm_([row({ key })]), ui({ menuKey: key, confirmRemove: key }))
  assert.ok(!html.includes('<img'))
})

test('every data-act is one the shell handles', () => {
  const allowed = new Set(['open-detail', 'menu', 'row', 'remove-ask', 'remove-cancel', 'card', 'idle-toggle'])
  const html = board(
    vm_([row({ lane: 'needs', card }), row({ key: 'k5' })], [row({ key: 'i', lane: 'idle', pr: null })]),
    ui({ menuKey: 'k1', confirmRemove: 'k5', idleOpen: true }),
  )
  const acts = [...html.matchAll(/data-act="([^"]*)"/g)].map((m) => m[1])
  assert.ok(acts.length > 5)
  for (const a of acts) assert.ok(allowed.has(a), a)
})

test('an unknown row tone falls back to tone-info and cannot add classes or attributes', () => {
  const html = board(vm_([row({ tone: 'bad x" onclick="1' })]), ui())
  assert.ok(html.includes('tone-info-text'))
  assert.ok(!html.includes('onclick'))
  assert.ok(!html.includes('tone-bad'))
  for (const t of ['bad', 'build', 'warn', 'info', 'ok']) assert.ok(board(vm_([row({ tone: t })]), ui()).includes('board-sub tone-' + t + '-text"'))
})

test('board-only title and sub classes sit beside the shared ones', () => {
  const html = board(vm_([row()]), ui())
  assert.match(html, /class="row-title board-title"/)
  assert.match(html, /class="row-sub board-sub tone-build-text"/)
})

test('inherited property names as a row tone or a card action use the fallbacks', () => {
  for (const name of ['constructor', '__proto__', 'toString']) {
    const html = board(vm_([row({ lane: 'needs', tone: name, card: { ...card, actions: [name, 'deny'] } })]), ui())
    assert.ok(html.includes('tone-info'), name)
    assert.ok(!html.includes('data-action="' + name + '"'), name)
    assert.ok(html.includes('data-action="deny"'), name)
    assert.ok(!/function|\[object/.test(html), name)
  }
})

test('read-only mode drops the menu button and the action buttons but keeps the need text', () => {
  const html = board(vm_([row({ key: 'k2', lane: 'needs', column: 'building', card })]), { readonly: true })
  assert.ok(!html.includes('data-act="menu"'))
  assert.ok(!html.includes('data-act="card"'))
  assert.ok(html.includes('wants to run: pnpm install'))
  assert.ok(html.includes('bcard board-row attn'))
})
