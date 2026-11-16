(function (g) {
  var V = (g.OrchViews = g.OrchViews || {})

  function e(s) { return g.OrchEsc.html(s) }
  function icon(id) { return '<svg class="icon"><use href="#i-' + id + '"></use></svg>' }
  var ORCA = '<svg class="orca-mark" aria-hidden="true"><use href="#i-orca"></use></svg>'

  var STARTERS = ['Close out my open PRs', 'What needs me right now?']

  V.chrome = function () {
    return '<main class="body" id="body"></main>'
  }

  function bubble(cls, text, key) { return '<div class="bubble ' + cls + '"' + (key || '') + '>' + e(text) + '</div>' }

  function keyOf(it) { return it.id == null || it.id === '' ? '' : ' data-key="' + e(it.id) + '"' }

  var mdOpts = null
  function md(text) { return g.OrchMd ? g.OrchMd.html(text, mdOpts) : '<p>' + e(text) + '</p>' }
  function mdInline(text) { return g.OrchMd ? g.OrchMd.inline(text, mdOpts) : e(text) }

  function two(n) { return (n < 10 ? '0' : '') + n }

  function clock(at) {
    if (typeof at !== 'number' || !(at > 0)) return ''
    var d = new Date(at)
    return two(d.getHours()) + ':' + two(d.getMinutes())
  }

  function meta(it, ui) {
    var copied = ui.copied === it.id
    var time = clock(it.at)
    return '<div class="msg-meta">' +
      '<button type="button" class="ib sm" data-act="copy" data-id="' + e(it.id) + '" aria-label="' + (copied ? 'Copied' : 'Copy message') + '">' + icon(copied ? 'check' : 'copy') + '</button>' +
      (time ? '<span class="msg-time">' + time + '</span>' : '') + '</div>'
  }

  var MARKS = { done: 'check-circle', active: 'dot-circle', pending: 'circle' }

  function plan(it, ui) {
    var steps = it.plan || []
    if (!steps.length) return ''
    var done = 0
    var current = ''
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].status === 'done') done++
      else if (!current && steps[i].status === 'active') current = steps[i].text
    }
    if (!current) for (var j = 0; j < steps.length; j++) if (steps[j].status !== 'done') { current = steps[j].text; break }
    var allDone = done === steps.length
    var plans = ui.plans || {}
    var open = Object.prototype.hasOwnProperty.call(plans, it.id) ? !!plans[it.id] : !allDone
    var list = ''
    if (open) {
      list = '<ol class="plan-steps">'
      for (var k = 0; k < steps.length; k++) {
        var st = Object.prototype.hasOwnProperty.call(MARKS, steps[k].status) ? steps[k].status : 'pending'
        list += '<li class="plan-step ' + st + '">' + icon(MARKS[st]) + '<span>' + e(steps[k].text) + '</span></li>'
      }
      list += '</ol>'
    }
    return '<section class="plan' + (allDone ? ' all-done' : '') + '"' + keyOf(it) + ' aria-label="Orchestrator plan">' +
      '<button type="button" class="plan-h" data-act="plan-toggle" data-id="' + e(it.id) + '" data-open="' + String(!open) + '" aria-expanded="' + String(open) + '">' +
      icon(allDone ? 'check-circle' : 'list') + '<b>Plan</b>' +
      '<span class="plan-cur">' + (open || allDone ? '' : e(current)) + '</span>' +
      '<span class="plan-n">' + done + '/' + steps.length + '</span>' +
      '<svg class="icon chev' + (open ? ' up' : '') + '"><use href="#i-chev"></use></svg></button>' + list + '</section>'
  }

  var VERBS = { start: 'plus', tell: 'pen' }

  function action(it) {
    var live = it.live || null
    var verb = Object.prototype.hasOwnProperty.call(VERBS, it.verb) ? it.verb : 'start'
    var name = live ? live.name : ''
    var title = verb === 'tell' ? it.text : 'New workspace' + (name ? ' · ' + name : '')
    var tone = live && Object.prototype.hasOwnProperty.call(TONES, live.tone) ? live.tone : 'info'
    var status
    if (!live) status = verb === 'tell' ? '<span class="act-s muted">Gone</span>' : '<span class="act-s muted">Starting…</span>'
    else if (verb === 'tell') status = live.queued > 0 ? '<span class="act-s muted">Queued</span>' : '<span class="act-s tone-ok-text">Delivered</span>'
    else status = '<span class="act-s ' + (live.attention ? 'attn-text' : 'tone-' + tone + '-text') + '">' + e(live.label) + '</span>'
    var inner = icon(VERBS[verb]) + '<span class="act-n">' + e(title) + '</span>' + status
    var wrap = '<div class="msg" data-key="' + e(it.id) + '">'
    if (!live) return wrap + '<div class="act">' + inner + '</div></div>'
    return wrap + '<button type="button" class="act" data-act="open-detail" data-key="' + e(live.key) + '">' + inner + '</button></div>'
  }

  var TONES = { bad: true, build: true, warn: true, info: true, ok: true }

  function item(it, ui) {
    if (it.kind === 'card') return ''
    if (it.kind === 'action') return action(it)
    if (it.kind === 'plan') return plan(it, ui)
    if (it.from === 'you') return '<div class="msg me" data-key="' + e(it.id) + '">' + bubble('me', it.text) + '</div>'
    if (it.from === 'panel') return bubble('note' + (it.kind === 'progress' ? ' progress' : ''), it.text, ' data-key="' + e(it.id) + '"')
    if (it.kind === 'progress') return '<div class="msg step" data-key="' + e(it.id) + '"><i class="step-dot"></i><span>' + mdInline(it.text) + '</span></div>'
    var html = '<div class="msg or' + (it.kind === 'result' ? ' result' : '') + '" data-key="' + e(it.id) + '"><div class="md">' + md(it.text) + '</div>'
    if (it.kind === 'question') {
      if (it.answered != null && it.answered !== '') {
        html += '<div class="answered muted">Answered: ' + e(it.answered) + '</div>'
      } else {
        var opts = it.options || []
        var btns = ''
        for (var i = 0; i < opts.length; i++) {
          btns += '<button type="button" class="btn" data-act="answer" data-id="' + e(it.id) + '" data-option="' + e(opts[i]) + '">' + e(opts[i]) + '</button>'
        }
        html += '<div class="btns options">' + btns + '</div>'
      }
    }
    return html + meta(it, ui) + '</div>'
  }

  function empty() {
    var btns = ''
    for (var i = 0; i < STARTERS.length; i++) {
      btns += '<button type="button" class="btn" data-act="starter" data-text="' + e(STARTERS[i]) + '">' + e(STARTERS[i]) + '</button>'
    }
    return '<div class="empty">' + ORCA + '<div>What should I take on?</div>' + btns + '</div>'
  }


  function option(value, label, selected) {
    return '<option value="' + e(value) + '"' + (selected ? ' selected' : '') + '>' + e(label) + '</option>'
  }

  function line(label, control) {
    return '<label class="menu-row"><span>' + label + '</span>' + control + '</label>'
  }

  function select(name, inner) {
    return '<select class="menu-input" data-act="setting" data-name="' + name + '">' + inner + '</select>'
  }

  var MODES = [['fix', 'Fix it'], ['ask', 'Ask me'], ['ignore', 'Ignore']]
  var NO_AGENT = [['start', 'Start one'], ['ask', 'Ask me']]
  var SCOPES = [['all', 'All sessions'], ['workers', 'Workers only']]
  var TRIES = [[1, '1'], [2, '2'], [3, '3'], [5, '5']]
  var EVERY = [[30, '30s'], [60, '1m'], [120, '2m'], [300, '5m']]

  function head(label) {
    return '<div class="menu-h">' + label + '</div>'
  }

  function choices(list, value) {
    var out = ''
    for (var i = 0; i < list.length; i++) out += option(list[i][0], list[i][1], list[i][0] === value)
    return out
  }

  function group(label, control, dim) {
    return '<div class="menu-row' + (dim ? ' dim' : '') + '" role="group" aria-label="' + label + '"><span>' + label + '</span>' + control + '</div>'
  }

  function seg(name, list, value) {
    var out = '<span class="menu-seg">'
    for (var i = 0; i < list.length; i++) {
      out += '<label><input type="radio" name="set-' + name + '" data-act="setting" data-name="' + name + '" value="' + list[i][0] + '"' +
        (list[i][0] === value ? ' checked' : '') + '><span>' + list[i][1] + '</span></label>'
    }
    return out + '</span>'
  }

  function check(name, on) {
    return '<input type="checkbox" class="menu-check" data-act="setting" data-name="' + name + '"' + (on ? ' checked' : '') + '>'
  }

  function pickMenu(agents) {
    var html = '<div class="menu-title">Pick your orchestrator</div><div class="menu-note muted">One agent that takes tasks from this chat and starts workers for them.</div>'
    if (!agents) return html + '<div class="menu-note muted">Looking for agents…</div>'
    var on = ''
    var off = ''
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].installed) on += '<button type="button" class="menu-item" data-act="pick-agent" data-agent="' + e(agents[i].id) + '"><b>' + e(agents[i].label) + '</b><span class="muted">' + e(agents[i].cmd) + '</span></button>'
      else off += '<div class="menu-item off"><b>' + e(agents[i].label) + '</b><span class="muted">not installed</span></div>'
    }
    return html + (on || '<div class="menu-note muted">No supported agent is installed yet.</div>') + off
  }

  var MODELS = [['', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
  var EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']]
  var PERMS = [
    ['auto', 'Auto', 'A classifier approves or denies permission prompts', 'shield'],
    ['manual', 'Manual', 'Prompts for dangerous operations', 'hand'],
    ['acceptEdits', 'Accept Edits', 'Auto-accepts file edits', 'pen'],
    ['dontAsk', "Don't Ask", 'Denies anything not pre-approved', 'hand-x'],
    ['bypassPermissions', 'Bypass Permissions', 'Bypasses all permission checks', 'shield-alert']
  ]

  function labelOf(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === value) return list[i][1]
    return ''
  }

  function agentLabel(agents, id) {
    for (var i = 0; i < (agents || []).length; i++) if (agents[i].id === id) return agents[i].label
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : ''
  }

  function isClaude(s) { return !!s && s.orchestratorAgent === 'claude' }

  function sep() { return '<div class="menu-sep"></div>' }

  function go(label, value, menu) {
    return '<button type="button" class="menu-item" data-act="menu-go" data-menu="' + menu + '"><span>' + label + '</span>' +
      '<span class="menu-val">' + e(value) + icon('chev-r') + '</span></button>'
  }

  function pick(name, value, label, on, extra) {
    return '<button type="button" class="menu-item' + (on ? ' sel' : '') + '" data-act="set" data-name="' + name + '" data-value="' + e(value) + '" role="menuitemradio" aria-checked="' + String(!!on) + '">' +
      '<span>' + e(label) + (extra || '') + '</span>' + (on ? icon('check') : '') + '</button>'
  }

  function toggle(name, label, on) {
    return '<label class="menu-item menu-toggle"><span>' + label + '</span><input type="checkbox" class="switch" data-act="setting" data-name="' + name + '"' + (on ? ' checked' : '') + '></label>'
  }

  function back(label) {
    return '<button type="button" class="menu-item menu-back" data-act="menu-go" data-menu="chip">' + icon('back') + '<b>' + label + '</b></button>' + sep()
  }

  function fixSummary(s) {
    var on = []
    if (s.onCi === 'fix') on.push('CI')
    if (s.onConflict === 'fix') on.push('conflicts')
    if (s.onReview === 'fix') on.push('reviews')
    return on.length ? on.join(', ') : 'Off'
  }

  function everyLabel(sec) { return labelOf(EVERY, sec) || sec + 's' }

  function chipMain(vm, agents, s) {
    var claude = isClaude(s)
    var html = go('Agent', agentLabel(agents, s.orchestratorAgent), 'chip:agent')
    if (claude) html += go('Model', labelOf(MODELS, s.model), 'chip:model') + go('Effort', labelOf(EFFORTS, s.effort), 'chip:effort')
    html += go('Workers', s.workerAgent ? agentLabel(agents, s.workerAgent) : 'Same', 'chip:workers')
    if (claude) html += sep() + toggle('fast', 'Fast mode', s.fast)
    html += sep() + go('Auto-fix', fixSummary(s), 'chip:autofix') + go('GitHub', everyLabel(s.intervalSec) + ' · guard ' + (s.guard ? 'on' : 'off'), 'chip:github')
    html += sep() + go('Instructions', '', 'chip:instructions')
    return html
  }

  function agentPicks(agents, name, current, blank) {
    var out = blank ? pick(name, '', blank, current === '') : ''
    var off = ''
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].installed) out += pick(name, agents[i].id, agents[i].label, agents[i].id === current)
      else off += '<div class="menu-item off"><span>' + e(agents[i].label) + '</span><span class="muted">not installed</span></div>'
    }
    return out + off
  }

  function listPicks(name, list, current) {
    var out = ''
    for (var i = 0; i < list.length; i++) out += pick(name, list[i][0], list[i][1], list[i][0] === current)
    return out
  }

  function instructionsPage(ins) {
    if (!ins) return '<div class="menu-note muted">Loading…</div>'
    if (!ins.started) return '<div class="menu-note muted">The orchestrator has not started yet. Its instructions are written when it first starts.</div>'
    var html = '<div class="menu-note muted">What the orchestrator reads when it starts, as written in its folder. It also loads Orca’s guide with <code>orca skills get orchestration</code>.</div>'
    for (var i = 0; i < ins.files.length; i++) {
      html += '<div class="ins-h">' + e(ins.files[i].name) + '</div><pre class="ins-text">' + e(ins.files[i].text) + '</pre>'
    }
    return html
  }

  function settingsMenu(vm, agents, s, page, ins) {
    if (!s || !agents) return '<div class="menu-note muted">Loading…</div>'
    var guard = vm.guard || { on: true, blocksToday: 0 }
    var blocks = guard.blocksToday || 0
    var idle = s.onCi !== 'fix' && s.onConflict !== 'fix' && s.onReview !== 'fix'
    if (page === 'chip:agent') return back('Agent') + agentPicks(agents, 'orchestratorAgent', s.orchestratorAgent || '', '')
    if (page === 'chip:model' && isClaude(s)) return back('Model') + listPicks('model', MODELS, s.model)
    if (page === 'chip:effort' && isClaude(s)) return back('Effort') + listPicks('effort', EFFORTS, s.effort)
    if (page === 'chip:workers') {
      return back('Workers') + agentPicks(agents, 'workerAgent', s.workerAgent || '', 'Same as the orchestrator') + sep() +
        line('Worker names end in', '<input type="text" class="menu-input" data-act="setting" data-name="suffix" data-role="setting-suffix" value="' + e(s.suffix) + '" spellcheck="false">')
    }
    if (page === 'chip:autofix') {
      return back('Auto-fix') +
        line('When CI fails', select('onCi', choices(MODES, s.onCi))) +
        line('When a PR has conflicts', select('onConflict', choices(MODES, s.onConflict))) +
        line('When a review comes in', select('onReview', choices(MODES, s.onReview))) +
        line('When no agent is running', select('noAgent', choices(NO_AGENT, s.noAgent))) +
        line('Apply to', select('scope', choices(SCOPES, s.scope))) +
        group('Tries before asking', seg('attempts', TRIES, s.attempts), idle)
    }
    if (page === 'chip:instructions') return back('Instructions') + instructionsPage(ins)
    if (page === 'chip:github') {
      return back('GitHub') +
        group('Check GitHub every', seg('intervalSec', EVERY, s.intervalSec), false) +
        line('Merge guard' + (blocks > 0 ? ' <span class="muted">· ' + blocks + (blocks === 1 ? ' block today' : ' blocks today') + '</span>' : ''), check('guard', s.guard))
    }
    return chipMain(vm, agents, s)
  }

  function plusMenu(s) {
    var html = '<div class="menu-h">Add</div>' +
      '<button type="button" class="menu-item menu-add" data-act="attach">' + icon('clip') + '<span>Files</span><span class="muted">Attach files to this message</span></button>' +
      '<button type="button" class="menu-item menu-add" data-act="toggle" data-name="plan">' + icon('list') + '<span>Plan mode</span><span class="muted">Turn plan mode ' + (s && s.plan ? 'off' : 'on') + '</span></button>'
    return html + sep() + '<button type="button" class="menu-item menu-add" data-act="new-worker">' + icon('branch') + '<span>New worker</span><span class="muted">Start a worker on a task</span></button>'
  }

  function permMenu(s) {
    var mode = (s && s.permissionMode) || ''
    var html = ''
    for (var i = 0; i < PERMS.length; i++) {
      var p = PERMS[i]
      var on = p[0] === mode
      html += '<button type="button" class="menu-item perm-item' + (on ? ' sel' : '') + (p[0] === 'bypassPermissions' ? ' warn' : '') + '" data-act="perm" data-value="' + p[0] + '" role="menuitemradio" aria-checked="' + String(on) + '">' +
        icon(p[3]) + '<span class="perm-two"><span>' + e(p[1]) + '</span><span class="perm-d">' + e(p[2]) + '</span></span>' + (on ? icon('check') : '') + '</button>'
    }
    return html + sep() + '<div class="menu-note muted">Applies to the orchestrator when it next starts. Workers use Orca’s own permission setting.</div>'
  }

  function permLabel(s) {
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i][0] === s.permissionMode) return [PERMS[i][3], PERMS[i][0] === 'bypassPermissions' ? 'Bypass' : PERMS[i][1]]
    return ['shield', 'Default']
  }

  function permButton(s, open) {
    if (!isClaude(s)) return ''
    var l = permLabel(s)
    return '<button type="button" class="composer-perm' + (open ? ' on' : '') + (s.permissionMode === 'bypassPermissions' ? ' warn' : '') + '" data-act="menu-go" data-menu="perm" aria-haspopup="true" aria-expanded="' + String(open) + '">' +
      icon(l[0]) + '<span>' + e(l[1]) + '</span><svg class="icon chev' + (open ? ' up' : '') + '"><use href="#i-chev"></use></svg></button>'
  }

  var STATES = { working: true, blocked: true, waiting: true, done: true, none: true }

  function agentChip(vm, open, s) {
    var orch = vm.orch
    var state = orch && Object.prototype.hasOwnProperty.call(STATES, orch.state) ? orch.state : 'none'
    var kind = orch ? String(orch.agentKind || 'Agent') : ''
    var name = vm.firstRun ? 'Pick an agent' : kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Orchestrator'
    var extra = ''
    if (!vm.firstRun && isClaude(s) && (s.model || s.effort)) {
      var model = s.model ? e(labelOf(MODELS, s.model)) : ''
      var effort = s.effort ? '<span class="chip-effort">' + (model ? ' · ' : '') + e(labelOf(EFFORTS, s.effort)) + '</span>' : ''
      extra = '<span class="chip-model">' + model + effort + '</span>'
    }
    return '<button type="button" class="composer-agent state-' + state + (open ? ' on' : '') + '" data-act="agent-menu" aria-haspopup="true" aria-expanded="' + String(open) + '">' +
      '<i class="state-dot" aria-hidden="true"></i>' +
      '<b>' + e(name) + '</b>' + extra + '</button>'
  }

  function filesRow(files) {
    if (!files || !files.length) return ''
    var out = '<div class="composer-files">'
    for (var i = 0; i < files.length; i++) {
      out += '<span class="file-chip">' + icon('clip') + '<span>' + e(files[i].name) + '</span>' +
        '<button type="button" class="ib sm" data-act="unattach" data-i="' + i + '" aria-label="Remove ' + e(files[i].name) + '">' + icon('x') + '</button></span>'
    }
    return out + '</div>'
  }

  function elapsed(since, now) {
    if (typeof since !== 'number' || !(since > 0)) return ''
    var sec = Math.max(0, Math.floor((now - since) / 1000))
    return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
  }

  function live(vm, ui) {
    var orch = vm.orch
    if (!orch || orch.state !== 'working') return ''
    var now = typeof ui.now === 'number' ? ui.now : Date.now()
    var doing = typeof orch.doing === 'string' ? orch.doing : ''
    var time = elapsed(orch.since, now)
    return '<div class="msg live" data-key="live" role="status"><i class="spin" aria-hidden="true"></i>' +
      '<span class="live-text">' + e(doing || 'Working') + '</span>' +
      (time ? '<span class="live-time" data-since="' + e(orch.since) + '">' + time + '</span>' : '') + '</div>'
  }

  V.elapsed = elapsed

  V.chat = function (vm, ui, x) {
    vm = vm || {}
    ui = ui || {}
    x = x || {}
    var chat = vm.chat || []
    var list = ''
    mdOpts = { workspaces: (vm.rows || []).concat(vm.idle || []), images: g.OrchImages || null }
    for (var i = 0; i < chat.length; i++) list += item(chat[i], ui)
    list += live(vm, ui)
    var queued = vm.queued > 0 ? '<div class="queued muted">' + e(vm.queued) + ' queued · sends when the orchestrator finishes its turn</div>' : ''
    var page = vm.firstRun ? 'chip' : ui.menu === true ? 'chip' : ui.menu || ''
    var chipOpen = !!vm.firstRun || page.indexOf('chip') === 0
    var s = x.settings || null
    var menu = ''
    if (vm.firstRun) menu = '<div class="agent-menu pop-chip" role="menu" data-role="agent-menu">' + pickMenu(x.agents || null) + '</div>'
    else if (chipOpen) menu = '<div class="agent-menu pop-chip' + (page === 'chip:instructions' ? ' pop-wide' : '') + '" role="menu" data-role="agent-menu">' + settingsMenu(vm, x.agents || null, s, page, x.instructions || null) + '</div>'
    else if (page === 'plus') menu = '<div class="agent-menu pop-plus" role="menu" data-role="agent-menu">' + plusMenu(s) + '</div>'
    else if (page === 'perm' && isClaude(s)) menu = '<div class="agent-menu pop-perm" role="menu" data-role="agent-menu">' + permMenu(s) + '</div>'
    var off = vm.firstRun ? ' disabled' : ''
    return '<div class="chat-list" data-role="chat-list">' + (list ? list : empty()) + '</div>' + queued +
      (V.pin ? V.pin(vm, ui, x.pinTerm) : '') + (V.strip ? V.strip(vm, ui, x.detail) : '') +
      '<form class="composer" data-act="send">' + menu + filesRow(ui.files) +
      '<textarea data-role="chat-input" rows="2" placeholder="Tell the orchestrator what to do" aria-label="Tell the orchestrator what to do"' + off + '></textarea>' +
      '<input type="file" multiple hidden data-role="attach-input" tabindex="-1">' +
      '<div class="composer-bar">' +
      '<button type="button" class="composer-plus' + (page === 'plus' ? ' on' : '') + '" data-act="menu-go" data-menu="plus" aria-label="Add" aria-haspopup="true" aria-expanded="' + String(page === 'plus') + '"' + off + '>' + icon('plus') + '</button>' +
      agentChip(vm, chipOpen, s) + (s && s.plan && !vm.firstRun ? '<button type="button" class="composer-tag" data-act="toggle" data-name="plan" title="Plan mode is on. Click to turn it off.">' + icon('list') + '<span>Plan</span></button>' : '') + '<span class="sp"></span>' + (vm.firstRun ? '' : permButton(s || {}, page === 'perm')) +
      '<button type="submit" class="send" aria-label="Send"' + off + '>' + icon('up') + '</button></div>' +
      '</form>'
  }
})(window)
