import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function load() {
  const window = {}
  const ctx = vm.createContext({ window })
  for (const f of ['esc.js', 'md.js', 'chat.js', 'time.js', 'strip.js']) vm.runInContext(readFileSync(new URL('../panel/' + f, import.meta.url), 'utf8'), ctx)
  return window.OrchViews
}

const V = load()
const HOSTILE = '<img src=x onerror=1>'

function baseVm(over = {}) {
  return {
    rev: 1, firstRun: false, orch: null, chat: [], queued: 0, rows: [], idle: [], needs: 0, asks: 0,
    gh: { ok: true }, watching: 2, intervalSec: 60, hooksOff: false, guard: { on: true, blocksToday: 0 }, ...over
  }
}

function card(over = {}) {
  return { id: 'approval:k', key: 'k', kind: 'approval', title: 'geo-index-oa', detail: 'wants to run: pnpm install', actions: ['allow', 'deny', 'peek'], at: 1, resolved: null, ...over }
}

function srow(over = {}) {
  return {
    key: 'k1', name: 'albums-grid', project: 'orca-plugins', branch: 'feat/albums', agentKind: 'claude', started: 'you', pr: 11, prUrl: null,
    lane: 'building', column: 'building', phrase: 'Working · 14m', label: 'Working', tone: 'build', at: null, draft: false, working: true,
    card: null, autoFix: { ci: true, review: false }, queued: 0, stale: false, ...over
  }
}

test('hostile strings in every chat field render no img tag', () => {
  const hostileCard = card({ id: HOSTILE, key: HOSTILE, title: HOSTILE, detail: HOSTILE, resolved: null })
  const row = srow({ key: HOSTILE, name: HOSTILE, project: HOSTILE, branch: HOSTILE, agentKind: HOSTILE, phrase: HOSTILE, label: HOSTILE, tone: HOSTILE, column: HOSTILE, lane: 'needs', card: hostileCard })
  const out = V.chat(baseVm({
    gh: { ok: false, reason: HOSTILE },
    orch: { state: HOSTILE, agentKind: HOSTILE },
    rows: [row],
    idle: [srow({ key: 'i', name: HOSTILE, lane: 'idle', column: 'idle' })],
    chat: [
      { id: HOSTILE, at: 1, from: 'you', kind: 'text', text: HOSTILE },
      { id: 'a', at: 2, from: 'orchestrator', kind: 'question', text: HOSTILE, options: [HOSTILE, 'ok'] },
      { id: 'b', at: 3, from: 'orchestrator', kind: 'question', text: HOSTILE, options: [HOSTILE], answered: HOSTILE },
      { id: 'c', at: 4, from: 'orchestrator', kind: 'card', text: HOSTILE, card: hostileCard },
      { id: 'd', at: 5, from: 'panel', kind: 'progress', text: HOSTILE },
      { id: 'e', at: 6, from: 'orchestrator', kind: 'result', text: HOSTILE },
      { id: HOSTILE, at: 7, from: 'orchestrator', kind: 'action', verb: HOSTILE, ref: HOSTILE, text: HOSTILE, live: { key: HOSTILE, name: HOSTILE, label: HOSTILE, tone: HOSTILE, attention: false, queued: 0 } },
      { id: 'g', at: 8, from: 'orchestrator', kind: 'action', verb: 'tell', ref: HOSTILE, text: HOSTILE, live: null }
    ]
  }), { stripOpen: true, idleOpen: true, menu: true, confirmRemove: HOSTILE }, {
    detail: { key: HOSTILE, data: { lines: [HOSTILE] } },
    agents: [{ id: HOSTILE, label: HOSTILE, cmd: HOSTILE, installed: true }, { id: 'x', label: HOSTILE, cmd: HOSTILE, installed: false }],
    settings: { orchestratorAgent: HOSTILE, workerAgent: HOSTILE, suffix: HOSTILE, intervalSec: HOSTILE, attempts: HOSTILE, guard: true, onCi: HOSTILE, onConflict: HOSTILE, onReview: HOSTILE, noAgent: HOSTILE, scope: HOSTILE }
  })
  assert.ok(!out.includes('<img'), out)
  assert.ok(out.includes('srow-term') && out.includes('agent-menu') && out.includes('class="pin"'))
  const first = V.chat(baseVm({ firstRun: true }), {}, { agents: [{ id: HOSTILE, label: HOSTILE, cmd: HOSTILE, installed: true }, { id: 'x', label: HOSTILE, cmd: HOSTILE, installed: false }] })
  assert.ok(!first.includes('<img'))
})

test('an open question renders one answer button per option and an answered one renders none', () => {
  const open = V.chat(baseVm({ chat: [{ id: 'q1', at: 1, from: 'orchestrator', kind: 'question', text: 'Which repo?', options: ['yimby', 'orca-plugins'] }] }))
  assert.equal(open.match(/data-act="answer"/g).length, 2)
  assert.ok(open.includes('data-id="q1"') && open.includes('data-option="yimby"') && open.includes('data-option="orca-plugins"'))
  const done = V.chat(baseVm({ chat: [{ id: 'q1', at: 1, from: 'orchestrator', kind: 'question', text: 'Which repo?', options: ['yimby', 'orca-plugins'], answered: 'yimby' }] }))
  assert.ok(!done.includes('data-act="answer"'))
  assert.ok(done.includes('yimby'))
})

test('an approval pins above the box with its buttons, and a chat card item renders nothing', () => {
  const c = card()
  const html = V.chat(baseVm({ rows: [srow({ key: 'k', lane: 'needs', card: c })], chat: [{ id: 'c', at: 1, from: 'panel', kind: 'card', text: c.title + ': ' + c.detail, card: c }] }))
  assert.equal(html.match(/data-act="card"/g).length, 3)
  assert.equal(html.split(c.detail).length - 1, 1)
  assert.ok(html.indexOf('class="pin"') > html.indexOf('chat-list'))
  assert.ok(html.indexOf('class="pin"') < html.indexOf('class="strip'))
  assert.ok(html.indexOf('class="strip') < html.indexOf('<form class="composer"'))
  assert.match(html, /data-act="card" data-id="approval:k" data-action="allow">Allow once</)
  assert.ok(html.includes('>Deny<') && /Peek<\/button>/.test(html))
  assert.ok(!html.includes('pin-n'))
})

test('the pin shows the first of several and nothing once every card is resolved', () => {
  const rows = [
    srow({ key: 'a', lane: 'needs', card: card({ id: 'approval:a', title: 'first' }) }),
    srow({ key: 'b', lane: 'needs', card: card({ id: 'attempts:b', kind: 'attempts', title: 'second', actions: ['retry', 'details'] }) })
  ]
  const html = V.pin(baseVm({ rows }))
  assert.ok(html.includes('<b>first</b>') && html.includes('<span class="pin-n">1 of 2</span>'))
  assert.ok(!html.includes('second'))
  const next = V.pin(baseVm({ rows: [srow({ key: 'a', card: card({ resolved: 'allowed' }) }), rows[1]] }))
  assert.ok(next.includes('<b>second</b>') && !next.includes('pin-n'))
  assert.match(next, /data-action="retry">Retry fix</)
  assert.equal(V.pin(baseVm({ rows: [srow()] })), '')
  for (const name of ['constructor', '__proto__', 'toString']) {
    const odd = V.pin(baseVm({ rows: [srow({ card: card({ actions: [name, 'deny'] }) })] }))
    assert.ok(!odd.includes('data-action="' + name + '"'), name)
    assert.ok(odd.includes('>Deny<') && !/function|\[object/.test(odd), name)
  }
})

test('queued messages show the queue line', () => {
  assert.ok(V.chat(baseVm({ queued: 2 })).includes('2 queued · sends when the orchestrator finishes its turn'))
  assert.ok(!V.chat(baseVm({ queued: 0 })).includes('queued'))
})

test('an empty chat shows the prompt and both starters', () => {
  const html = V.chat(baseVm())
  assert.ok(html.includes('What should I take on?'))
  assert.equal(html.match(/data-act="starter"/g).length, 2)
  assert.ok(html.includes('data-text="Close out my open PRs"') && html.includes('>What needs me right now?<'))
})

test('the orca mark sits above the empty-chat prompt', () => {
  const mark = '<svg class="orca-mark" aria-hidden="true"><use href="#i-orca"></use></svg>'
  assert.ok(V.chat(baseVm()).includes('<div class="empty">' + mark + '<div>What should I take on?</div>'))
  assert.ok(!V.chat(baseVm({ chat: [{ id: 'c', at: 1, from: 'you', kind: 'text', text: 'hi' }] })).includes('orca-mark'))
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  assert.ok(html.includes('<symbol id="i-orca" viewBox="0 0 24 24">'))
})

test('the chat has a message box wired to send', () => {
  const html = V.chat(baseVm())
  assert.ok(html.includes('<form class="composer" data-act="send">'))
  assert.ok(html.includes('data-role="chat-input"') && html.includes('Tell the orchestrator what to do'))
})

test('the page has no header, footer, view toggle or settings page', () => {
  assert.equal(V.chrome(baseVm(), 'chat'), '<main class="body" id="body"></main>')
  const html = V.chat(baseVm({ rows: [srow()], needs: 2, asks: 1 }), { stripOpen: true })
  for (const gone of ['data-act="view"', 'data-act="tab"', 'data-act="new-task"', 'data-act="menu"', '<header', '<footer']) assert.ok(!html.includes(gone), gone)
})

test('the strip stays visible with no sessions and shows a problem line only while something is wrong', () => {
  const empty = V.strip(baseVm())
  assert.ok(empty.includes('data-act="strip-toggle"') && !empty.includes('strip-rows') && !empty.includes('strip-warn'))
  assert.ok(V.strip(baseVm(), { stripOpen: true }).includes('data-act="board-open"'))
  const warn = (over) => V.strip(baseVm(over))
  assert.ok(warn({ gh: { ok: false, reason: 'missing' }, hooksOff: true }).includes('gh is not installed'))
  assert.ok(warn({ gh: { ok: false, reason: 'signed-out' } }).includes('gh is not signed in'))
  assert.ok(warn({ gh: { ok: false, reason: 'rate-limited', retryInSec: 42 } }).includes('GitHub rate limited · retrying in 42s'))
  assert.ok(warn({ hooksOff: true }).includes('Status hooks are off'))
  assert.ok(warn({ guard: { on: false, blocksToday: 0 } }).includes('Merge guard is off'))
  assert.ok(!V.strip(baseVm({ rows: [srow()] })).includes('strip-warn'))
})

test('the closed strip counts sessions by lane and says how many need you', () => {
  const rows = [
    srow({ key: 'a', column: 'building' }), srow({ key: 'b', column: 'building', lane: 'needs' }),
    srow({ key: 'c', column: 'validating', lane: 'validating' }), srow({ key: 'd', column: 'ready', lane: 'ready' })
  ]
  const html = V.strip(baseVm({ rows, idle: [srow({ key: 'i', lane: 'idle', column: 'idle' })] }), {})
  const n = (col) => new RegExp('strip-n col-' + col + '" title="[^"]*"><i class="lane-dot"></i>(\\d+)<').exec(html)[1]
  assert.deepEqual([n('working'), n('validating'), n('review'), n('ready')], ['2', '1', '0', '1'])
  assert.ok(html.includes('1 idle') && html.includes('1 needs you'))
  assert.ok(html.includes('aria-expanded="false"') && !html.includes('strip-rows'))
  assert.ok(V.strip(baseVm({ rows: [rows[1], srow({ key: 'z', lane: 'needs' })] }), {}).includes('2 need you'))
})

test('the open strip lists every session and opens one in place with its terminal and actions', () => {
  const now = 10 * 3_600_000
  const rows = [srow({ key: 'a', name: 'alpha', at: now - 5 * 60_000 }), srow({ key: 'b', name: 'beta', pr: null, working: false, label: 'Idle' })]
  const closed = V.strip(baseVm({ rows }), { stripOpen: true, now }, { key: null, data: null })
  assert.ok(closed.includes('alpha') && closed.includes('beta') && closed.includes('>5m ago<'))
  assert.ok(!closed.includes('srow-x'))
  assert.match(closed, /data-act="open-detail" data-key="a" aria-expanded="false"/)
  assert.ok(closed.includes('data-act="board-open"'))
  const loading = V.strip(baseVm({ rows }), { stripOpen: true, now }, { key: 'a', data: null })
  assert.ok(loading.includes('Reading the terminal…'))
  const lines = Array.from({ length: 30 }, (_, i) => 'line ' + i).concat(['', ''])
  const open = V.strip(baseVm({ rows }), { stripOpen: true, now }, { key: 'a', data: { lines } })
  assert.ok(open.includes('feat/albums · #11 · orca-plugins · claude'))
  assert.ok(open.includes('line 29') && open.includes('line 20') && !open.includes('line 19\n'))
  for (const action of ['open', 'retry', 'stop', 'autofix-ci', 'autofix-review']) assert.ok(open.includes('data-action="' + action + '"'), action)
  assert.match(open, /data-action="autofix-ci" data-on="false" aria-pressed="true">Auto-fix CI on</)
  assert.match(open, /data-action="autofix-review" data-on="true" aria-pressed="false">Auto-fix reviews off</)
  assert.ok(open.includes('data-act="pr-open"') && open.includes('data-act="remove-ask"') && open.includes('data-act="peek-key"'))
  assert.ok(!open.includes('data-role="message-text"'))
  const noPr = V.strip(baseVm({ rows }), { stripOpen: true, now }, { key: 'b', data: { lines: ['x'] } })
  assert.ok(!noPr.includes('pr-open') && !noPr.includes('autofix') && noPr.includes('no PR'))
  const confirm = V.strip(baseVm({ rows }), { stripOpen: true, now, confirmRemove: 'a' }, { key: 'a', data: { lines: ['x'] } })
  assert.match(confirm, /data-action="remove" data-confirmed="true">Remove worktree</)
  assert.ok(confirm.includes('Its branch and PR stay on GitHub.') && confirm.includes('data-act="remove-cancel"'))
})

test('idle sessions fold under one line and the orchestrator terminal opens as its own row', () => {
  const idle = [srow({ key: 'i1', name: 'idle-one', lane: 'idle', column: 'idle' })]
  const folded = V.strip(baseVm({ idle }), { stripOpen: true })
  assert.ok(folded.includes('data-act="idle-toggle"') && !folded.includes('idle-one') && folded.includes('Nothing is running.'))
  assert.ok(V.strip(baseVm({ idle }), { stripOpen: true, idleOpen: true }).includes('idle-one'))
  const orch = V.strip(baseVm(), {}, { key: 'orchestrator', data: { lines: ['$ claude'] } })
  assert.ok(orch.includes('class="strip open"') && orch.includes('Orchestrator') && orch.includes('$ claude'))
  assert.ok(orch.includes('data-key="orchestrator" data-name="enter"'))
})

test('an action row shows the live status of its session and opens it', () => {
  const live = { key: 'k9', name: 'geo-index-oa', label: 'Working', tone: 'build', attention: false, queued: 0 }
  const items = (over) => V.chat(baseVm({ chat: [{ id: 'a1', at: 1, from: 'orchestrator', kind: 'action', verb: 'start', ref: 'ctx_1', text: 'New workspace', ...over }] }))
  const start = items({ live })
  assert.match(start, /<div class="msg" data-key="a1"><button type="button" class="act" data-act="open-detail" data-key="k9">/)
  assert.ok(start.includes('New workspace · geo-index-oa') && start.includes('<span class="act-s tone-build-text">Working</span>'))
  assert.ok(items({ live: { ...live, label: 'Blocked', attention: true } }).includes('<span class="act-s attn-text">Blocked</span>'))
  const pending = items({ live: null })
  assert.ok(pending.includes('Starting…') && !pending.includes('data-act="open-detail"'))
  const tell = items({ verb: 'tell', text: 'Wrote to geo-index-oa', live })
  assert.ok(tell.includes('#i-pen') && tell.includes('Wrote to geo-index-oa') && tell.includes('>Delivered<'))
  assert.ok(items({ verb: 'tell', text: 'Wrote to geo-index-oa', live: { ...live, queued: 1 } }).includes('>Queued<'))
  assert.ok(items({ verb: 'tell', text: 'Wrote to x', live: null }).includes('>Gone<'))
})

test('chrome leaves a body slot for the active view', () => {
  assert.ok(V.chrome(baseVm(), 'board').includes('<main class="body" id="body"></main>'))
})

test('first run opens the agent menu with installed agents to pick and disables the box', () => {
  const html = V.chat(baseVm({ firstRun: true }), {}, { agents: [
    { id: 'claude', label: 'Claude', cmd: 'claude', installed: true },
    { id: 'codex', label: 'Codex', cmd: 'codex', installed: true },
    { id: 'grok', label: 'Grok', cmd: 'grok', installed: false }
  ] })
  assert.ok(html.includes('Pick your orchestrator') && html.includes('<b>Pick an agent</b>'))
  assert.equal(html.match(/data-act="pick-agent"/g).length, 2)
  assert.ok(html.includes('data-agent="claude"') && html.includes('data-agent="codex"') && !html.includes('data-agent="grok"'))
  assert.ok(html.indexOf('Grok') > html.indexOf('Codex') && html.includes('not installed'))
  assert.ok(html.includes('data-role="chat-input"') && / disabled><\/textarea>/.test(html))
  assert.ok(V.chat(baseVm({ firstRun: true }), {}, {}).includes('Looking for agents'))
  assert.ok(V.chat(baseVm({ firstRun: true }), {}, { agents: [] }).includes('No supported agent is installed yet.'))
})

const SETTINGS = { orchestratorAgent: 'claude', workerAgent: '', suffix: '-oa', intervalSec: 120, attempts: 3, guard: true, onCi: 'fix', onConflict: 'ask', onReview: 'ignore', noAgent: 'start', scope: 'workers', model: 'opus', effort: 'medium', fast: false, plan: false, permissionMode: 'auto' }
const AGENTS = [{ id: 'claude', label: 'Claude', cmd: 'claude', installed: true }, { id: 'codex', label: 'Codex', cmd: 'codex', installed: true }, { id: 'grok', label: 'Grok', cmd: 'grok', installed: false }]
const menuOf = (html) => {
  const at = html.indexOf('<div class="agent-menu')
  return at < 0 ? '' : html.slice(at, html.indexOf('<textarea', at))
}

test('the chip menu lists agent, model, effort, workers, fast mode, auto-fix and GitHub, and no board item', () => {
  assert.equal(menuOf(V.chat(baseVm(), {}, { agents: AGENTS, settings: SETTINGS })), '')
  const html = V.chat(baseVm({ guard: { on: true, blocksToday: 2 } }), { menu: 'chip' }, { agents: AGENTS, settings: SETTINGS })
  const menu = menuOf(html)
  assert.ok(menu.includes('class="agent-menu pop-chip"'))
  for (const [page, label, value] of [['chip:agent', 'Agent', 'Claude'], ['chip:model', 'Model', 'Opus'], ['chip:effort', 'Effort', 'Medium'], ['chip:workers', 'Workers', 'Same'], ['chip:autofix', 'Auto-fix', 'CI'], ['chip:github', 'GitHub', '2m · guard on']]) {
    assert.ok(menu.includes('data-menu="' + page + '"><span>' + label + '</span><span class="menu-val">' + value), page)
  }
  assert.ok(menu.includes('data-act="setting" data-name="fast"') && !menu.includes('data-name="fast" checked'))
  assert.ok(!menu.includes('next starts'))
  assert.ok(!menu.includes('board-open') && !menu.includes('Open its terminal'))
  assert.ok(html.includes('class="composer-agent state-none on" data-act="agent-menu" aria-haspopup="true" aria-expanded="true"'))
  assert.deepEqual(menuOf(V.chat(baseVm(), { menu: true }, { agents: AGENTS, settings: SETTINGS })), menu.replace('2 blocks today', ''))
  assert.ok(menuOf(V.chat(baseVm(), { menu: 'chip' }, {})).includes('Loading…'))
})

test('each chip drill-down shows its own choices with a way back', () => {
  const page = (name, s = SETTINGS) => menuOf(V.chat(baseVm({ guard: { on: true, blocksToday: 2 } }), { menu: name }, { agents: AGENTS, settings: s }))
  const agent = page('chip:agent')
  assert.ok(agent.includes('data-act="menu-go" data-menu="chip"') && agent.includes('<b>Agent</b>'))
  assert.ok(agent.includes('data-act="set" data-name="orchestratorAgent" data-value="claude" role="menuitemradio" aria-checked="true"'))
  assert.ok(agent.includes('data-value="codex" role="menuitemradio" aria-checked="false"') && agent.includes('<span>Grok</span><span class="muted">not installed</span>'))
  const model = page('chip:model')
  for (const id of ['', 'fable', 'opus', 'sonnet', 'haiku']) assert.ok(model.includes('data-name="model" data-value="' + id + '"'), id)
  assert.ok(model.includes('data-value="opus" role="menuitemradio" aria-checked="true"'))
  const effort = page('chip:effort')
  assert.ok(effort.includes('data-value="xhigh" role="menuitemradio" aria-checked="false"><span>Extra high</span>') && !effort.includes('data-value="max"'))
  const workers = page('chip:workers')
  assert.ok(workers.includes('data-name="workerAgent" data-value="" role="menuitemradio" aria-checked="true"><span>Same as the orchestrator</span>'))
  assert.ok(workers.includes('data-act="setting" data-name="suffix"'))
  const fix = page('chip:autofix')
  for (const name of ['onCi', 'onConflict', 'onReview', 'noAgent', 'scope', 'attempts']) assert.ok(fix.includes('data-act="setting" data-name="' + name + '"'), name)
  assert.ok(fix.includes('<option value="ask" selected>Ask me</option>') && fix.includes('<option value="workers" selected>Workers only</option>'))
  assert.ok(fix.includes('<div class="menu-row" role="group" aria-label="Tries before asking">'))
  assert.ok(page('chip:autofix', { ...SETTINGS, onCi: 'ask' }).includes('<div class="menu-row dim" role="group" aria-label="Tries before asking">'))
  const gh = page('chip:github')
  assert.ok(gh.includes('data-name="intervalSec" value="120" checked><span>2m</span>') && gh.includes('2 blocks today') && /data-name="guard" checked>/.test(gh))
})

test('a non-Claude orchestrator keeps Plan mode but gets no model, effort, fast mode or permission button', () => {
  const codex = { ...SETTINGS, orchestratorAgent: 'codex' }
  const vmCodex = baseVm({ orch: { state: 'waiting', agentKind: 'codex' } })
  const main = menuOf(V.chat(vmCodex, { menu: 'chip' }, { agents: AGENTS, settings: codex }))
  assert.ok(main.includes('data-menu="chip:agent"') && !main.includes('data-menu="chip:model"') && !main.includes('data-menu="chip:effort"') && !main.includes('data-name="fast"'))
  const html = V.chat(vmCodex, { menu: 'plus' }, { agents: AGENTS, settings: codex })
  assert.ok(menuOf(html).includes('data-act="attach"') && menuOf(html).includes('data-act="new-worker"') && menuOf(html).includes('data-name="plan"') && !menuOf(html).includes('data-name="fast"'))
  assert.ok(!menuOf(html).includes('next starts'))
  assert.ok(!html.includes('composer-perm') && !html.includes('chip-model'))
  assert.equal(menuOf(V.chat(vmCodex, { menu: 'perm' }, { agents: AGENTS, settings: codex })), '')
})

test('the + menu holds Files, Plan mode and New worker, and leaves Fast mode to the agent menu', () => {
  const html = V.chat(baseVm(), { menu: 'plus' }, { agents: AGENTS, settings: SETTINGS })
  const menu = menuOf(html)
  assert.ok(menu.includes('class="agent-menu pop-plus"') && menu.includes('<div class="menu-h">Add</div>'))
  assert.ok(menu.indexOf('data-act="attach"') < menu.indexOf('data-name="plan"') && menu.indexOf('data-name="plan"') < menu.indexOf('menu-sep') && menu.indexOf('menu-sep') < menu.indexOf('data-act="new-worker"'))
  assert.ok(menu.includes('Turn plan mode on') && !menu.includes('data-name="fast"') && !menu.includes('next starts'))
  assert.ok(!html.includes('composer-tag'))
  assert.ok(menuOf(V.chat(baseVm(), { menu: 'plus' }, { agents: AGENTS, settings: { ...SETTINGS, plan: true, fast: true } })).includes('Turn plan mode off'))
  assert.ok(html.includes('class="composer-plus on" data-act="menu-go" data-menu="plus" aria-label="Add" aria-haspopup="true" aria-expanded="true"'))
  assert.ok(html.includes('<input type="file" multiple hidden data-role="attach-input"'))
  assert.ok(V.chat(baseVm({ firstRun: true }), {}, { agents: AGENTS }).includes('data-menu="plus" aria-label="Add" aria-haspopup="true" aria-expanded="false" disabled'))
})

test('the permission menu lists the five modes, marks the current one, and says when it applies and that workers are not covered', () => {
  const html = V.chat(baseVm(), { menu: 'perm' }, { agents: AGENTS, settings: SETTINGS })
  const menu = menuOf(html)
  for (const [id, label] of [['auto', 'Auto'], ['manual', 'Manual'], ['acceptEdits', 'Accept Edits'], ['dontAsk', 'Don&#39;t Ask'], ['bypassPermissions', 'Bypass Permissions']]) {
    assert.ok(menu.includes('data-act="perm" data-value="' + id + '"'), id)
    assert.ok(menu.includes('<span>' + label + '</span>') || menu.includes('<span>' + label.replace('&#39;', "'") + '</span>'), label)
  }
  assert.ok(menu.includes('perm-item sel" data-act="perm" data-value="auto" role="menuitemradio" aria-checked="true"'))
  assert.ok(menu.includes('perm-item warn" data-act="perm" data-value="bypassPermissions"'))
  assert.ok(menu.includes('when it next starts') && menu.includes('Workers use Orca'))
  assert.ok(html.includes('class="composer-perm on" data-act="menu-go" data-menu="perm"') && html.includes('<span>Auto</span>'))
  const plan = V.chat(baseVm(), {}, { agents: AGENTS, settings: { ...SETTINGS, plan: true } })
  assert.ok(plan.includes('class="composer-tag" data-act="toggle" data-name="plan"') && plan.includes('class="composer-perm"') && plan.includes('<span>Auto</span>'))
  assert.ok(menuOf(V.chat(baseVm(), { menu: 'perm' }, { agents: AGENTS, settings: { ...SETTINGS, plan: true } })).includes('data-value="auto" role="menuitemradio" aria-checked="true"'))
  const bypass = V.chat(baseVm(), {}, { agents: AGENTS, settings: { ...SETTINGS, permissionMode: 'bypassPermissions' } })
  assert.ok(bypass.includes('class="composer-perm warn"') && bypass.includes('<span>Bypass</span>'))
  assert.ok(V.chat(baseVm(), {}, { agents: AGENTS, settings: { ...SETTINGS, permissionMode: '' } }).includes('<span>Default</span>'))
})

test('the chip shows the picked model and effort, and nothing extra when both are default', () => {
  const vmClaude = baseVm({ orch: { state: 'waiting', agentKind: 'claude' } })
  const html = V.chat(vmClaude, {}, { agents: AGENTS, settings: SETTINGS })
  assert.ok(html.includes('<b>Claude</b><span class="chip-model">Opus<span class="chip-effort"> · Medium</span></span></button>'))
  assert.ok(V.chat(vmClaude, {}, { agents: AGENTS, settings: { ...SETTINGS, model: '' } }).includes('<span class="chip-model"><span class="chip-effort">Medium</span></span>'))
  assert.ok(!V.chat(vmClaude, {}, { agents: AGENTS, settings: { ...SETTINGS, model: '', effort: '' } }).includes('chip-model'))
})

test('attached files show as chips with a remove button above the message box', () => {
  const html = V.chat(baseVm(), { files: [{ name: 'shot.png', data: 'x' }, { name: HOSTILE, data: 'y' }] }, { agents: AGENTS, settings: SETTINGS })
  assert.ok(html.includes('<div class="composer-files"><span class="file-chip">') && html.includes('<span>shot.png</span>'))
  assert.ok(html.includes('data-act="unattach" data-i="1"') && !html.includes('<img'))
  assert.ok(html.indexOf('composer-files') < html.indexOf('<textarea'))
  assert.ok(!V.chat(baseVm(), { files: [] }, {}).includes('composer-files'))
})

const MD = (() => {
  const window = {}
  const ctx = vm.createContext({ window })
  for (const f of ['esc.js', 'md.js']) vm.runInContext(readFileSync(new URL('../panel/' + f, import.meta.url), 'utf8'), ctx)
  return window.OrchMd
})()

test('markdown renders bold, code, lists, a table and a fenced block', () => {
  const html = MD.html(['**The Android check did not run.**', '', '- The `pill android` workspace is gone', '- Until then it is *iOS only*', '', '1. first', '2. second', '', '| PR | State |', '| --- | --- |', '| #4555 | ready |', '| #4560 | waiting |', '', '```', 'git fetch <origin>', '```'].join('\n'))
  assert.ok(html.includes('<p><strong>The Android check did not run.</strong></p>'))
  assert.ok(html.includes('<ul><li>The <code>pill android</code> workspace is gone</li><li>Until then it is <em>iOS only</em></li></ul>'))
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'))
  assert.ok(html.includes('<th>PR</th><th>State</th>'))
  assert.ok(html.includes('<tr><td>#4555</td><td>ready</td></tr><tr><td>#4560</td><td>waiting</td></tr>'))
  assert.ok(html.includes('<pre class="md-pre"><code>git fetch &lt;origin&gt;</code></pre>'))
})

test('markdown keeps plain lines together and leaves stray symbols alone', () => {
  assert.equal(MD.html('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(MD.html('2 * 3 * 4 and a_b_c'), '<p>2 * 3 * 4 and a_b_c</p>')
  assert.equal(MD.html('a | b'), '<p>a | b</p>')
  assert.equal(MD.html(''), '')
  assert.equal(MD.html(null), '')
})

test('markdown links open through the shell and only for http and https', () => {
  const ok = MD.html('see [the PR](https://github.com/o/r/pull/1?a=1&b=2)')
  assert.ok(ok.includes('<a href="#" data-act="link" data-url="https://github.com/o/r/pull/1?a=1&amp;b=2">the PR</a>'))
  const bad = MD.html('[x](javascript:alert(1)) [y](data:text/html,1)')
  assert.ok(!bad.includes('<a '))
})

test('markdown never lets markup through', () => {
  const evil = ['<img src=x onerror=1>', '**<img src=x>**', '`<img src=x>`', '- <img src=x>', '| <img src=x> | b |', '| --- | --- |', '| <img src=x> | c |', '# <img src=x>', '```', '<img src=x>', '```', '[<img src=x>](https://a.b/"onmouseover="1)', '[a](https://a.b/x"y)'].join('\n')
  const html = MD.html(evil)
  assert.ok(!html.includes('<img'), html)
  assert.ok(!/data-url="[^"]*"[^>]*on\w+=/.test(html), html)
})

test('an orchestrator message renders as markdown with a copy button and a time, and yours stays a bubble', () => {
  const at = new Date(2026, 10, 15, 17, 51).getTime()
  const html = V.chat(baseVm({ chat: [
    { id: 'u1', at, from: 'you', kind: 'text', text: '**not bold**' },
    { id: 'o1', at, from: 'orchestrator', kind: 'result', text: '**Done.**\n\n- PR #12' }
  ] }))
  assert.ok(html.includes('<div class="msg me" data-key="u1"><div class="bubble me">**not bold**</div></div>'))
  assert.ok(html.includes('<div class="msg or result" data-key="o1"><div class="md"><p><strong>Done.</strong></p><ul><li>PR #12</li></ul></div>'))
  assert.match(html, /data-act="copy" data-id="o1" aria-label="Copy message"/)
  assert.ok(html.includes('<span class="msg-time">17:51</span>'))
  assert.equal(html.match(/data-act="copy"/g).length, 1)
  const copied = V.chat(baseVm({ chat: [{ id: 'o1', at, from: 'orchestrator', kind: 'text', text: 'x' }] }), { copied: 'o1' })
  assert.ok(copied.includes('aria-label="Copied"') && copied.includes('#i-check'))
})

test('a progress message is one quiet line with no copy button', () => {
  const html = V.chat(baseVm({ chat: [{ id: 'p', at: 1, from: 'orchestrator', kind: 'progress', text: 'Started `albums-oa`' }] }))
  assert.ok(html.includes('<div class="msg step" data-key="p"><i class="step-dot"></i><span>Started <code>albums-oa</code></span></div>'))
  assert.ok(!html.includes('data-act="copy"'))
})

function planItem(steps, id = 'pl') {
  return { id, at: 1, from: 'orchestrator', kind: 'plan', text: 'Plan', plan: steps }
}

test('a plan renders as a checklist with a count and folds when every step is done', () => {
  const steps = [{ text: 'cal #4545', status: 'done' }, { text: 'tablet chat #4555', status: 'active' }, { text: 'pill easing #4560', status: 'pending' }]
  const open = V.chat(baseVm({ chat: [planItem(steps)] }))
  assert.ok(open.includes('<span class="plan-n">1/3</span>'))
  assert.ok(open.includes('aria-expanded="true"'))
  assert.ok(open.includes('<li class="plan-step done"><svg class="icon"><use href="#i-check-circle"></use></svg><span>cal #4545</span></li>'))
  assert.ok(open.includes('<li class="plan-step active">') && open.includes('<li class="plan-step pending">'))
  assert.match(open, /data-act="plan-toggle" data-id="pl" data-open="false"/)
  const folded = V.chat(baseVm({ chat: [planItem(steps)] }), { plans: { pl: false } })
  assert.ok(!folded.includes('plan-steps'))
  assert.ok(folded.includes('<span class="plan-cur">tablet chat #4555</span>'))
  assert.match(folded, /data-open="true"/)
  const done = V.chat(baseVm({ chat: [planItem(steps.map((s) => ({ ...s, status: 'done' })))] }))
  assert.ok(done.includes('class="plan all-done"') && done.includes('<span class="plan-n">3/3</span>'))
  assert.ok(!done.includes('plan-steps'))
  const reopened = V.chat(baseVm({ chat: [planItem(steps.map((s) => ({ ...s, status: 'done' })))] }), { plans: { pl: true } })
  assert.ok(reopened.includes('plan-steps'))
})

test('a plan with no steps renders nothing and hostile steps are escaped', () => {
  assert.ok(!V.chat(baseVm({ chat: [planItem([])] })).includes('class="plan'))
  const html = V.chat(baseVm({ chat: [planItem([{ text: HOSTILE, status: 'constructor' }], HOSTILE)] }), { plans: { constructor: true } })
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('<li class="plan-step pending">'))
})

test('the agent chip shows a still dot and the name, with no spinner and no status text', () => {
  const working = V.chat(baseVm({ orch: { state: 'working', agentKind: 'claude', since: 1, doing: '' } }))
  assert.match(working, /class="composer-agent state-working" data-act="agent-menu" aria-haspopup="true" aria-expanded="false"><i class="state-dot"[^>]*><\/i><b>Claude<\/b><\/button>/)
  const bar = (html) => html.slice(html.indexOf('composer-bar'))
  for (const state of ['working', 'blocked', 'waiting', 'none']) {
    const html = bar(V.chat(baseVm({ orch: { state, agentKind: 'codex', since: 1, doing: '' } })))
    assert.ok(html.includes('<b>Codex</b>') && html.includes('state-' + state), state)
    assert.ok(!html.includes('class="spin"') && html.includes('state-dot'), state)
    for (const gone of ['Working', 'Ready', 'Waiting on approval', 'Not running', 'composer-state']) assert.ok(!html.includes(gone), state + ' ' + gone)
  }
  const odd = V.chat(baseVm({ orch: { state: 'toString', agentKind: HOSTILE } }))
  assert.ok(odd.includes('state-none') && !odd.includes('<img'))
  assert.ok(bar(V.chat(baseVm({ orch: null }))).includes('<b>Orchestrator</b>'))
  assert.ok(working.includes('<button type="submit" class="send" aria-label="Send">'))
})

test('the pin steps through every need and offers to start an agent or dismiss when no agent is there', () => {
  const lost = card({ id: 'unreachable:b', key: 'b', kind: 'unreachable', title: 'chore/review-contract', detail: 'No agent to message in this session', actions: ['start', 'dismiss', 'details'] })
  const rows = [srow({ key: 'a', lane: 'needs', card: card({ id: 'approval:a', title: 'first' }) }), srow({ key: 'b', lane: 'needs', card: lost })]
  const first = V.pin(baseVm({ rows }), { pin: 0 })
  assert.ok(first.includes('<b>first</b>') && first.includes('>1 of 2<'))
  assert.equal(first.match(/data-act="pin-step"/g).length, 2)
  assert.ok(first.includes('data-step="-1"') && first.includes('data-step="1"'))
  const second = V.pin(baseVm({ rows }), { pin: 1 })
  assert.ok(second.includes('<b>chore/review-contract</b>') && second.includes('>2 of 2<'))
  assert.match(second, /class="btn pri" data-act="card" data-id="unreachable:b" data-action="start">Start an agent</)
  assert.match(second, /data-action="dismiss">Dismiss</)
  assert.match(second, /data-action="details">Show session</)
  assert.ok(V.pin(baseVm({ rows }), { pin: 2 }).includes('<b>first</b>'))
  assert.ok(V.pin(baseVm({ rows }), { pin: -1 }).includes('<b>chore/review-contract</b>'))
  assert.ok(!V.pin(baseVm({ rows: [rows[1]] }), { pin: 5 }).includes('pin-step'))
})

test('a working orchestrator adds a live row with what it is doing and for how long', () => {
  const now = 1_000_000
  const html = V.chat(baseVm({ chat: [{ id: 'u', at: 1, from: 'you', kind: 'text', text: 'clear the 11 idle' }], orch: { state: 'working', agentKind: 'claude', since: now - 75_000, doing: 'Running orca worktree list' } }), { now })
  assert.match(html, /<div class="msg live" data-key="live" role="status"><i class="spin"[^>]*><\/i><span class="live-text">Running orca worktree list<\/span><span class="live-time" data-since="925000">1m 15s<\/span><\/div><\/div>/)
  assert.ok(html.indexOf('msg live') > html.indexOf('clear the 11 idle'))
  const bare = V.chat(baseVm({ orch: { state: 'working', agentKind: 'claude', since: now - 9000, doing: '' } }), { now })
  assert.ok(bare.includes('<span class="live-text">Working</span>') && bare.includes('>9s</span>') && !bare.includes('class="empty"'))
  assert.ok(!V.chat(baseVm({ orch: { state: 'waiting', agentKind: 'claude', since: now, doing: 'x' } }), { now }).includes('msg live'))
  assert.ok(!V.chat(baseVm({ orch: { state: 'working', agentKind: 'claude', since: now, doing: HOSTILE } }), { now }).includes('<img'))
  assert.equal(V.elapsed(0, now), '')
  assert.equal(V.elapsed(10_000_000 - 3_725_000, 10_000_000), '62m 5s')
})

test('opening the strip adds the sessions above its summary row, which stays last and unchanged', () => {
  const vmv = baseVm({ gh: { ok: false, reason: 'rate-limited', retryInSec: 300 }, rows: [srow({ key: 'a' }), srow({ key: 'b', column: 'validating', lane: 'validating' })], idle: [srow({ key: 'i', lane: 'idle', column: 'idle' })] })
  const closed = V.strip(vmv, {})
  const open = V.strip(vmv, { stripOpen: true })
  const tail = (html) => html.slice(html.indexOf('<div class="strip-warn">')).replace('aria-expanded="true"', 'aria-expanded="false"').replace('chev up', 'chev').replace('Hide sessions', 'Show sessions')
  assert.equal(tail(open), tail(closed))
  assert.ok(open.indexOf('strip-rows') < open.indexOf('strip-warn'))
  assert.ok(open.indexOf('strip-warn') < open.indexOf('strip-sum'))
  assert.ok(open.endsWith('</button></div></section>') && closed.endsWith('</button></div></section>'))
  assert.equal(closed.match(/data-act="board-open"/g).length, 1)
  assert.match(open, /class="ib strip-full" data-act="board-open" title="Full board in the browser"/)
  assert.ok(open.indexOf('strip-full') > open.indexOf('strip-sum') && open.indexOf('strip-full') < open.indexOf('strip-chev'))
  assert.equal(open.match(/data-act="board-open"/g).length, 1)
  assert.equal(open.match(/data-act="strip-toggle"/g).length, 3)
})

test('a pinned approval shows the prompt\'s own choices as buttons and never the terminal', () => {
  const c = card({ detail: 'Pick an answer below' })
  const rows = [srow({ key: 'k', lane: 'needs', card: c })]
  const loading = V.pin(baseVm({ rows }), {}, { key: null, data: null })
  assert.ok(loading.includes('data-action="allow"') && loading.includes('data-action="deny"') && !loading.includes('srow-term'))
  const lines = ['│ old 1. stale', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again for rm commands', '  3. No', 'Esc to cancel · Tab to amend', '']
  const html = V.pin(baseVm({ rows }), {}, { key: 'k', data: { lines } })
  assert.ok(html.includes('<div class="pin-q">Do you want to proceed?</div>'))
  assert.ok(html.includes('class="btn pin-opt pri" data-act="peek-key" data-key="k" data-name="1">Yes</button>'))
  assert.ok(html.includes('data-name="2">Yes, and don&#39;t ask again for rm commands</button>') || html.includes('data-name="2">Yes, and don\'t ask again for rm commands</button>'))
  assert.ok(html.includes('class="btn pin-opt" data-act="peek-key" data-key="k" data-name="3">No</button>'))
  for (const gone of ['srow-term', 'Send a key', 'pin-term', 'data-action="allow"', 'data-action="peek"', 'stale']) assert.ok(!html.includes(gone), gone)
  const unread = V.pin(baseVm({ rows }), {}, { key: 'k', data: { lines: ['building…', 'still going'] } })
  assert.ok(unread.includes('data-action="allow"') && !unread.includes('pin-opt') && !unread.includes('srow-term'))
  assert.ok(!V.pin(baseVm({ rows }), {}, { key: 'other', data: { lines } }).includes('Do you want to proceed?'))
  const lost = card({ id: 'unreachable:b', key: 'b', kind: 'unreachable', actions: ['start', 'dismiss', 'details'] })
  assert.ok(!V.pin(baseVm({ rows: [srow({ key: 'b', lane: 'needs', card: lost })] }), {}, { key: 'b', data: { lines } }).includes('pin-term'))
  assert.equal(V.pinned(baseVm({ rows }), {}).id, c.id)
  assert.equal(V.pinned(baseVm(), {}), null)
  assert.ok(!V.pin(baseVm({ rows }), {}, { key: 'k', data: { lines: [HOSTILE] } }).includes('<img'))
})

test('the idle list offers Remove idle for worktrees only, counts them, and keeps main checkouts out of it', () => {
  const idle = [
    srow({ key: 'm', name: 'main', lane: 'idle', column: 'idle', removable: false }),
    srow({ key: 'a', name: 'fix-a', lane: 'idle', column: 'idle', removable: true }),
    srow({ key: 'b', name: 'fix-b', lane: 'idle', column: 'idle', removable: true })
  ]
  const closed = V.strip(baseVm({ idle }), { stripOpen: true })
  assert.ok(!closed.includes('Remove idle'))
  const open = V.strip(baseVm({ idle }), { stripOpen: true, idleOpen: true })
  assert.ok(open.includes('data-act="remove-ask" data-key="*idle">Remove idle…</button>') && !open.includes('data-act="idle-clear"'))
  const asked = V.strip(baseVm({ idle }), { stripOpen: true, idleOpen: true, confirmRemove: '*idle' })
  assert.ok(asked.includes('Removes 2 idle worktrees. Main checkouts are kept. Branches and PRs stay on GitHub.'))
  assert.ok(asked.includes('data-act="idle-clear">Remove 2</button>') && asked.includes('data-act="remove-cancel"'))
  const onlyMain = V.strip(baseVm({ idle: [idle[0]] }), { stripOpen: true, idleOpen: true, confirmRemove: '*idle' })
  assert.ok(!onlyMain.includes('Remove idle') && !onlyMain.includes('idle-clear'))
})

test('an opened session that cannot be removed shows no Remove button', () => {
  const kept = srow({ key: 'm', name: 'main', lane: 'idle', column: 'idle', removable: false })
  const html = V.strip(baseVm({ idle: [kept] }), { stripOpen: true, idleOpen: true }, { key: 'm', data: { lines: [] } })
  assert.ok(html.includes('data-action="stop"') && !html.includes('remove-ask'))
  const free = V.strip(baseVm({ idle: [{ ...kept, removable: true }] }), { stripOpen: true, idleOpen: true }, { key: 'm', data: { lines: [] } })
  assert.ok(free.includes('data-act="remove-ask" data-key="m"'))
})

test('a wide panel opens the strip as four lanes of cards with the opened session below them', () => {
  const now = 10 * 3_600_000
  const rows = [
    srow({ key: 'a', name: 'alpha', column: 'building', at: now - 9 * 60_000 }),
    srow({ key: 'b', name: 'beta', column: 'validating', lane: 'needs', label: 'CI failing', working: false, card: card({ id: 'attempts:b', key: 'b', kind: 'attempts', actions: ['retry', 'details'] }) }),
    srow({ key: 'c', name: 'gamma', column: 'ready', lane: 'ready', label: 'Mergeable', tone: 'ok', working: false })
  ]
  const html = V.strip(baseVm({ rows, idle: [srow({ key: 'i', name: 'idle-one', lane: 'idle', column: 'idle' })] }), { stripOpen: true, wide: true, now }, { key: null, data: null })
  const order = ['Building', 'Validating', 'In review', 'Ready'].map((t) => html.indexOf('<span>' + t + '</span>'))
  assert.ok(order.every((n) => n >= 0))
  assert.deepEqual([...order].sort((x, y) => x - y), order)
  const lane = (id, next) => html.slice(html.indexOf('data-key="klane:' + id + '"'), next ? html.indexOf('data-key="klane:' + next + '"') : html.indexOf('</div>', html.indexOf('data-key="klane:' + id + '"')))
  assert.ok(lane('building', 'validating').includes('alpha') && lane('building', 'validating').includes('<b>1</b>') && lane('building', 'validating').includes('>9m ago<'))
  assert.ok(lane('validating', 'review').includes('beta') && lane('validating', 'review').includes('kcard attn'))
  assert.ok(lane('review', 'ready').includes('<b>0</b>') && !lane('review', 'ready').includes('kcard'))
  assert.ok(lane('ready').includes('gamma'))
  assert.equal(html.match(/class="kcard[ "]/g).length, 3)
  assert.ok(!html.includes('kcard-meta') && !html.includes('feat/albums'))
  assert.ok(!html.includes('class="srow col-working') && !html.includes('kdetail'))
  assert.ok(html.includes('data-act="idle-toggle"') && html.indexOf('klanes') < html.indexOf('idle-toggle'))
  assert.ok(html.indexOf('strip-rows') < html.indexOf('strip-sum'))
  const open = V.strip(baseVm({ rows }), { stripOpen: true, wide: true, now }, { key: 'b', data: { lines: ['✖ 3 problems'] } })
  assert.match(open, /<div class="kcard attn on" data-key="b">/)
  assert.match(open, /class="kcard-foot" data-act="open-detail" data-key="b" aria-expanded="true"/)
  assert.match(html, /<button type="button" class="kcard-name" data-act="open-detail" data-key="a" aria-expanded="false">alpha<\/button>/)
  assert.match(html, /class="kcard-foot" data-act="open-detail" data-key="a" aria-expanded="false"/)
  const detail = open.slice(open.indexOf('class="kdetail'))
  assert.ok(detail.includes('<b>beta</b>') && detail.includes('✖ 3 problems') && detail.includes('data-action="retry"') && detail.includes('data-act="back"'))
  assert.ok(open.indexOf('klanes') < open.indexOf('class="kdetail'))
  const narrow = V.strip(baseVm({ rows }), { stripOpen: true, wide: false, now }, { key: null, data: null })
  assert.ok(!narrow.includes('klanes') && narrow.includes('class="srow col-working'))
  assert.ok(!V.strip(baseVm({ rows: [srow({ key: HOSTILE, name: HOSTILE, branch: HOSTILE, label: HOSTILE })] }), { stripOpen: true, wide: true }, { key: HOSTILE, data: null }).includes('<img'))
})

test('each idle worktree has its own red trash button that asks before removing, and a main checkout has none', () => {
  const idle = [
    srow({ key: 'm', name: 'main', lane: 'idle', column: 'idle', removable: false }),
    srow({ key: 'a', name: 'fix-a', lane: 'idle', column: 'idle', removable: true })
  ]
  const open = V.strip(baseVm({ idle }), { stripOpen: true, idleOpen: true })
  assert.equal(open.split('class="ib sm srow-trash"').length - 1, 1)
  assert.ok(open.includes('class="ib sm srow-trash" data-act="remove-ask" data-key="a" title="Remove worktree" aria-label="Remove fix-a">'))
  assert.ok(!open.includes('data-action="remove"'))
  const asked = V.strip(baseVm({ idle }), { stripOpen: true, idleOpen: true, confirmRemove: 'a' })
  assert.ok(asked.includes('Removes this worktree. Its branch and PR stay on GitHub.'))
  assert.ok(asked.includes('data-act="row" data-key="a" data-action="remove" data-confirmed="true">Remove</button>'))
  const working = V.strip(baseVm({ rows: [srow({ key: 'w', removable: true })] }), { stripOpen: true })
  assert.ok(!working.includes('srow-trash'))
})

test('each count in the strip says what it counts when hovered', () => {
  const rows = [srow({ key: 'a' }), srow({ key: 'b', column: 'validating', lane: 'needs' }), srow({ key: 'c', column: 'validating', lane: 'validating' })]
  const html = V.strip(baseVm({ rows, idle: [srow({ key: 'i', lane: 'idle', column: 'idle' })] }), {})
  for (const hint of ['title="1 building"', 'title="2 validating"', 'title="0 in review"', 'title="0 ready"', 'title="1 idle, with no agent working and no PR. Click to show them"', 'title="Waiting on an answer or a decision from you"']) {
    assert.ok(html.includes(hint), hint)
  }
})

test('the idle count in the summary row is the only idle control and shows or hides the idle sessions', () => {
  const idle = [srow({ key: 'i1', name: 'idle-one', lane: 'idle', column: 'idle', removable: true })]
  const vmv = baseVm({ rows: [srow()], idle })
  const closed = V.strip(vmv, {})
  assert.match(closed, /<button type="button" class="strip-idle" data-act="idle-toggle" aria-expanded="false"[^>]*>1 idle<\/button>/)
  const open = V.strip(vmv, { stripOpen: true })
  assert.equal(open.match(/data-act="idle-toggle"/g).length, 1)
  assert.ok(!open.includes('idle-one') && !open.includes('<span>Idle</span>') && !open.includes('#i-archive'))
  const shown = V.strip(vmv, { stripOpen: true, idleOpen: true })
  assert.match(shown, /class="strip-idle on" data-act="idle-toggle" aria-expanded="true"/)
  assert.ok(shown.includes('idle-one') && shown.includes('Remove idle…') && shown.includes('Click to hide them'))
  assert.equal(shown.match(/data-act="idle-toggle"/g).length, 1)
  assert.ok(!V.strip(vmv, { idleOpen: true }).includes('strip-idle on'))
  assert.ok(!V.strip(baseVm({ rows: [srow()] }), {}).includes('idle-toggle'))
})

test('the chip menu ends with Instructions, which shows each file the orchestrator reads, escaped and full width', () => {
  const main = menuOf(V.chat(baseVm(), { menu: 'chip' }, { agents: AGENTS, settings: SETTINGS }))
  assert.ok(main.includes('data-menu="chip:instructions"><span>Instructions</span>'))
  assert.ok(main.lastIndexOf('menu-sep') < main.indexOf('chip:instructions'))
  const page = (ins) => V.chat(baseVm(), { menu: 'chip:instructions' }, { agents: AGENTS, settings: SETTINGS, instructions: ins })
  assert.ok(menuOf(page(null)).includes('Loading…'))
  assert.ok(menuOf(page({ started: false, files: [] })).includes('has not started yet'))
  const html = page({ started: true, files: [{ name: 'AGENTS.md', text: '# You are the orchestrator\n' + HOSTILE }, { name: '.claude/settings.json', text: '{"model":"opus"}' }] })
  const menu = menuOf(html)
  assert.ok(menu.includes('class="agent-menu pop-chip pop-wide"'))
  assert.ok(menu.includes('data-act="menu-go" data-menu="chip"') && menu.includes('<b>Instructions</b>'))
  assert.ok(menu.includes('<div class="ins-h">AGENTS.md</div><pre class="ins-text"># You are the orchestrator'))
  assert.ok(menu.includes('<div class="ins-h">.claude/settings.json</div><pre class="ins-text">{&quot;model&quot;:&quot;opus&quot;}</pre>'))
  assert.ok(!menu.includes(HOSTILE))
  assert.ok(!menuOf(V.chat(baseVm(), { menu: 'chip' }, { agents: AGENTS, settings: SETTINGS })).includes('pop-wide'))
})
