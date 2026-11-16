(function (g) {
  var V = (g.OrchViews = g.OrchViews || {})
  var COLUMNS = [['building', 'working', 'Building'], ['validating', 'validating', 'Validating'], ['review', 'review', 'In review'], ['ready', 'ready', 'Ready']]
  var KEYS = [['Enter', 'enter'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['Esc', 'esc']]
  var LABELS = { allow: 'Allow once', deny: 'Deny', peek: 'Peek', retry: 'Retry fix', details: 'Show session', start: 'Start an agent', dismiss: 'Dismiss', fix: 'Fix it' }
  var PRIMARY = { allow: true, start: true, fix: true }
  var TONES = { bad: true, build: true, warn: true, info: true, ok: true }
  var TAIL = 10
  var ALL_IDLE = '*idle'

  function e(s) { return g.OrchEsc.html(s) }
  function own(map, key) { return Object.prototype.hasOwnProperty.call(map, key) }
  function icon(id) { return '<svg class="icon"><use href="#i-' + id + '"></use></svg>' }
  function toneOf(t) { return typeof t === 'string' && own(TONES, t) ? t : 'info' }

  function columnOf(row) {
    for (var i = 0; i < COLUMNS.length; i++) if (row.column === COLUMNS[i][0]) return COLUMNS[i][1]
    for (var j = 0; j < COLUMNS.length; j++) if (row.lane === COLUMNS[j][0]) return COLUMNS[j][1]
    return row.lane === 'idle' || row.column === 'idle' ? 'idle' : 'working'
  }

  function cardsOf(vm) {
    var out = []
    var lists = [(vm && vm.rows) || [], (vm && vm.idle) || []]
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        var c = lists[i][j].card
        if (c && (c.resolved == null || c.resolved === '') && c.actions && c.actions.length) out.push(c)
      }
    }
    return out
  }

  function cardButtons(card, skip) {
    var out = ''
    for (var i = 0; i < card.actions.length; i++) {
      var a = card.actions[i]
      if (!own(LABELS, a) || a === skip) continue
      out += '<button type="button" class="btn' + (own(PRIMARY, a) ? ' pri' : '') + '" data-act="card" data-id="' + e(card.id) + '" data-action="' + e(a) + '">' +
        (a === 'peek' ? icon('term') : '') + LABELS[a] + '</button>'
    }
    return out
  }

  function pinAt(cards, ui) {
    return ui && typeof ui.pin === 'number' ? ((ui.pin % cards.length) + cards.length) % cards.length : 0
  }

  function choicesOf(lines) {
    if (!Array.isArray(lines)) return null
    var options = []
    var first = -1
    for (var i = 0; i < lines.length; i++) {
      var m = /^[\s│|❯>›]*([1-5])\.\s+(.*?)[\s│|]*$/.exec(String(lines[i]))
      if (!m || !m[2]) continue
      var n = Number(m[1])
      if (n === 1) { options = []; first = i }
      if (n === options.length + 1) options.push({ n: n, label: m[2] })
    }
    if (options.length < 2) return null
    var question = ''
    var qi = first
    for (var j = first - 1; j >= 0 && j >= first - 4; j--) {
      var text = String(lines[j]).replace(/^[\s│|]+|[\s│|]+$/g, '')
      if (/\?$/.test(text)) { question = text; qi = j; break }
    }
    var asked = contextOf(lines, qi)
    asked.question = question
    asked.options = options
    return asked
  }

  var TOP = /^\s*[╭┌]?[─━]{6,}[╮┐]?\s*$/
  var DASHED = /^\s*(?=(?:.*[-╌┄┈╍┅┉]){6})[\s\-╌┄┈╍┅┉]+$/
  var CONTEXT_MAX = 40

  function contextOf(lines, end) {
    var block = []
    var boxed = false
    var topped = false
    for (var i = end - 1; i >= 0 && block.length < CONTEXT_MAX; i--) {
      var raw = String(lines[i])
      if (TOP.test(raw)) { boxed = /[╭┌]/.test(raw); topped = true; break }
      block.unshift(raw)
    }
    if (!topped) return { title: '', desc: [], command: [], notes: [], joined: false }
    var rows = block.map(function (l) { return boxed ? l.replace(/^\s*│/, '').replace(/│\s*$/, '') : l })
    var sections = [[]]
    for (var k = 0; k < rows.length; k++) {
      if (DASHED.test(rows[k])) sections.push([])
      else sections[sections.length - 1].push(rows[k])
    }
    var clean = function (list) {
      var out = list.map(function (l) { return l.replace(/\s+$/, '') })
      while (out.length && !out[0].trim()) out.shift()
      while (out.length && !out[out.length - 1].trim()) out.pop()
      return out
    }
    var head = clean(sections[0])
    var title = head.length ? head.shift().trim() : ''
    var desc = []
    var command = []
    var notes = []
    if (sections.length > 1) {
      desc = head.map(function (l) { return l.trim() }).filter(Boolean)
      command = clean(sections[1]).map(function (l) { return l.replace(/^\s*[│|▎┃]\s?/, '').trim() }).filter(Boolean)
      for (var n = 2; n < sections.length; n++) notes = notes.concat(clean(sections[n]).map(function (l) { return l.trim() }).filter(Boolean))
    } else {
      var body = head.filter(function (l) { return l.trim() })
      var pad = Infinity
      for (var b = 0; b < body.length; b++) pad = Math.min(pad, /^\s*/.exec(body[b])[0].length)
      command = body.map(function (l) { return l.slice(pad === Infinity ? 0 : pad) })
      return { title: title, desc: desc, command: command, notes: notes, joined: false }
    }
    return { title: title, desc: desc, command: command, notes: notes, joined: true }
  }

  function promptHtml(asked) {
    var html = ''
    if (asked.title) html += '<div class="pin-tool">' + e(asked.title) + '</div>'
    for (var i = 0; i < asked.desc.length; i++) html += '<div class="pin-desc">' + e(asked.desc[i]) + '</div>'
    if (asked.command.length) html += '<pre class="pin-cmd">' + e(asked.command.join(asked.joined ? ' ' : '\n')) + '</pre>'
    if (asked.notes.length) html += '<div class="pin-note">' + asked.notes.map(e).join('<br>') + '</div>'
    if (asked.question) html += '<div class="pin-q">' + e(asked.question) + '</div>'
    return html
  }

  V.pinned = function (vm, ui) {
    var cards = cardsOf(vm)
    return cards.length ? cards[pinAt(cards, ui)] : null
  }

  V.pin = function (vm, ui, term) {
    var cards = cardsOf(vm)
    if (!cards.length) return ''
    var at = pinAt(cards, ui)
    var c = cards[at]
    var asked = c.kind === 'approval' && term && term.key === c.key && term.data ? choicesOf(term.data.lines) : null
    var prompt = ''
    var buttons = cardButtons(c, '')
    if (asked) {
      prompt = promptHtml(asked)
      buttons = ''
      for (var i = 0; i < asked.options.length; i++) {
        buttons += '<button type="button" class="btn pin-opt' + (i === 0 ? ' pri' : '') + '" data-act="peek-key" data-key="' + e(c.key) + '" data-name="' + asked.options[i].n + '">' + e(asked.options[i].label) + '</button>'
      }
    }
    var nav = cards.length > 1
      ? '<span class="pin-nav"><button type="button" class="ib sm" data-act="pin-step" data-step="-1" aria-label="Previous">' + icon('chev') + '</button>' +
        '<span class="pin-n">' + (at + 1) + ' of ' + cards.length + '</span>' +
        '<button type="button" class="ib sm" data-act="pin-step" data-step="1" aria-label="Next">' + icon('chev') + '</button></span>'
      : ''
    return '<section class="pin" data-card="' + e(c.id) + '" aria-label="Needs you">' +
      '<div class="pin-h"><b>' + e(c.title) + '</b>' + nav + '</div>' +
      (c.detail ? '<div class="pin-text">' + e(c.detail) + '</div>' : '') + prompt +
      '<div class="btns">' + buttons + '</div></section>'
  }

  function warning(vm) {
    var gh = vm.gh || { ok: true }
    if (!gh.ok && gh.reason === 'missing') return 'gh is not installed · PR status is off'
    if (!gh.ok && gh.reason === 'signed-out') return 'gh is not signed in · PR status is paused'
    if (!gh.ok && gh.reason === 'rate-limited') return 'GitHub rate limited · retrying in ' + Math.max(0, Math.round(gh.retryInSec || 0)) + 's'
    if (!gh.ok) return 'GitHub could not be read · PR status may be stale'
    if (vm.hooksOff) return 'Status hooks are off · status may be stale'
    if (vm.guard && vm.guard.on === false) return 'Merge guard is off'
    return ''
  }

  function terminal(key, data) {
    if (!data || !Array.isArray(data.lines)) return '<div class="srow-load muted">Reading the terminal…</div>'
    var lines = data.lines.slice()
    while (lines.length && String(lines[lines.length - 1]).trim() === '') lines.pop()
    var keys = ''
    for (var i = 0; i < KEYS.length; i++) {
      keys += '<button type="button" class="btn key" data-act="peek-key" data-key="' + e(key) + '" data-name="' + KEYS[i][1] + '">' + KEYS[i][0] + '</button>'
    }
    return '<pre class="srow-term">' + e(lines.slice(-TAIL).join('\n')) + '</pre><div class="srow-keys"><span class="muted">Send a key</span>' + keys + '</div>'
  }

  function expanded(row, ui, data) {
    var k = e(row.key)
    var act = 'data-act="row" data-key="' + k + '"'
    var meta = [row.branch, row.pr != null ? '#' + row.pr : 'no PR', row.project, row.agentKind].filter(Boolean).join(' · ')
    var card = row.card && (row.card.resolved == null || row.card.resolved === '') ? row.card : null
    var html = '<div class="srow-x"><div class="srow-meta muted">' + e(meta) + '</div>'
    if (card && card.detail) html += '<div class="srow-need">' + e(card.detail) + '</div>'
    html += terminal(row.key, data) + '<div class="btns">'
    if (card && card.actions) html += cardButtons(card, 'peek')
    html += '<button type="button" class="btn" ' + act + ' data-action="open">' + icon('ext') + 'Open in Orca</button>'
    if (row.pr != null) {
      var ci = !!(row.autoFix && row.autoFix.ci)
      var rv = !!(row.autoFix && row.autoFix.review)
      html += '<button type="button" class="btn" data-act="pr-open" data-key="' + k + '">PR</button>'
      if (!card) html += '<button type="button" class="btn" ' + act + ' data-action="retry">Retry fix</button>'
      html += '<button type="button" class="btn" ' + act + ' data-action="autofix-ci" data-on="' + String(!ci) + '" aria-pressed="' + String(ci) + '">Auto-fix CI ' + (ci ? 'on' : 'off') + '</button>'
      html += '<button type="button" class="btn" ' + act + ' data-action="autofix-review" data-on="' + String(!rv) + '" aria-pressed="' + String(rv) + '">Auto-fix reviews ' + (rv ? 'on' : 'off') + '</button>'
    }
    html += '<button type="button" class="btn" ' + act + ' data-action="stop">Stop</button>'
    if (row.removable === false) {
      html += '</div>'
    } else if (ui.confirmRemove === row.key) {
      html += '</div><div class="srow-confirm"><span class="muted">Its branch and PR stay on GitHub.</span>' +
        '<button type="button" class="btn danger" ' + act + ' data-action="remove" data-confirmed="true">Remove worktree</button>' +
        '<button type="button" class="btn" data-act="remove-cancel">Cancel</button></div>'
    } else {
      html += '<button type="button" class="btn" data-act="remove-ask" data-key="' + k + '">Remove…</button></div>'
    }
    return html + '</div>'
  }

  function cardHtml(row, detail, now) {
    var k = e(row.key)
    var attn = row.lane === 'needs'
    var on = detail.key === row.key
    var label = typeof row.label === 'string' && row.label ? row.label : row.phrase
    var when = g.OrchTime ? g.OrchTime.rel(row.at, now) : ''
    return '<div class="kcard' + (attn ? ' attn' : '') + (on ? ' on' : '') + (row.stale ? ' stale' : '') + '" data-key="' + k + '">' +
      '<button type="button" class="kcard-name" data-act="open-detail" data-key="' + k + '" aria-expanded="' + String(on) + '">' + e(row.name) + '</button>' +
      '<button type="button" class="kcard-foot" data-act="open-detail" data-key="' + k + '" aria-expanded="' + String(on) + '" title="' + (on ? 'Hide its terminal and actions' : 'Show its terminal and actions here') + '"><span class="srow-label tone-' + toneOf(row.tone) + '-text">' + (row.working === true && !attn ? '<i class="spin" aria-hidden="true"></i>' : '') + e(label) + '</span>' +
      (when ? '<span class="srow-time">' + when + '</span>' : '') + '</button></div>'
  }

  function kanban(rows, ui, detail, now) {
    var html = '<div class="klanes">'
    var opened = null
    for (var i = 0; i < COLUMNS.length; i++) {
      var cards = ''
      var n = 0
      for (var r = 0; r < rows.length; r++) {
        if (columnOf(rows[r]) !== COLUMNS[i][1]) continue
        n++
        cards += cardHtml(rows[r], detail, now)
        if (detail.key === rows[r].key) opened = rows[r]
      }
      html += '<section class="klane col-' + COLUMNS[i][1] + '" data-key="klane:' + COLUMNS[i][0] + '"><h4 class="klane-h"><i class="lane-dot"></i><span>' + COLUMNS[i][2] + '</span><b>' + n + '</b></h4>' + cards + '</section>'
    }
    html += '</div>'
    if (opened) {
      html += '<div class="kdetail col-' + columnOf(opened) + (opened.lane === 'needs' ? ' attn' : '') + '" data-key="kdetail:' + e(opened.key) + '">' +
        '<div class="kdetail-h"><i class="lane-dot"></i><b>' + e(opened.name) + '</b><button type="button" class="ib sm" data-act="back" aria-label="Close">' + icon('x') + '</button></div>' +
        expanded(opened, ui, detail.data) + '</div>'
    }
    return html
  }

  function rowHtml(row, ui, detail, now) {
    var k = e(row.key)
    var attn = row.lane === 'needs'
    var on = detail.key === row.key
    var label = typeof row.label === 'string' && row.label ? row.label : row.phrase
    var when = g.OrchTime ? g.OrchTime.rel(row.at, now) : ''
    var head = '<button type="button" class="srow-h" data-act="open-detail" data-key="' + k + '" aria-expanded="' + String(on) + '">' +
      '<i class="lane-dot"></i><span class="srow-name">' + e(row.name) + '</span>' +
      '<span class="srow-label tone-' + toneOf(row.tone) + '-text">' + (row.working === true && !attn ? '<i class="spin" aria-hidden="true"></i>' : '') + e(label) + '</span>' +
      (when ? '<span class="srow-time">' + when + '</span>' : '') + '</button>'
    if (row.lane === 'idle' && row.removable === true) {
      head = '<div class="srow-line">' + head + '<button type="button" class="ib sm srow-trash" data-act="remove-ask" data-key="' + k + '" title="Remove worktree" aria-label="Remove ' + e(row.name) + '">' + icon('trash') + '</button></div>'
      if (!on && ui.confirmRemove === row.key) {
        head += '<div class="srow-confirm strip-confirm"><span class="muted">Removes this worktree. Its branch and PR stay on GitHub.</span>' +
          '<button type="button" class="btn danger" data-act="row" data-key="' + k + '" data-action="remove" data-confirmed="true">Remove</button>' +
          '<button type="button" class="btn" data-act="remove-cancel">Cancel</button></div>'
      }
    }
    return '<div class="srow col-' + columnOf(row) + (attn ? ' attn' : '') + (on ? ' on' : '') + (row.stale ? ' stale' : '') + '" data-key="' + k + '">' +
      head + (on ? expanded(row, ui, detail.data) : '') + '</div>'
  }

  function orchRow(detail) {
    return '<div class="srow col-idle on" data-key="orchestrator">' +
      '<button type="button" class="srow-h" data-act="back" aria-expanded="true"><i class="lane-dot"></i><span class="srow-name">Orchestrator</span><span class="srow-label tone-info-text">Its terminal</span></button>' +
      '<div class="srow-x">' + terminal('orchestrator', detail.data) + '</div></div>'
  }

  V.strip = function (vm, ui, detail) {
    vm = vm || {}
    ui = ui || {}
    detail = detail || { key: null, data: null }
    var rows = vm.rows || []
    var idle = vm.idle || []
    var warn = warning(vm)
    var orch = detail.key === 'orchestrator'
    var now = typeof ui.now === 'number' ? ui.now : Date.now()
    var counts = ''
    for (var i = 0; i < COLUMNS.length; i++) {
      var n = 0
      for (var r = 0; r < rows.length; r++) if (columnOf(rows[r]) === COLUMNS[i][1]) n++
      counts += '<span class="strip-n col-' + COLUMNS[i][1] + '" title="' + n + ' ' + COLUMNS[i][2].toLowerCase() + '"><i class="lane-dot"></i>' + n + '</span>'
    }
    var needs = 0
    for (var q = 0; q < rows.length; q++) if (rows[q].lane === 'needs') needs++
    var open = !!ui.stripOpen || orch
    var html = '<section class="strip' + (open ? ' open' : '') + '" aria-label="Sessions">'
    if (open) {
      html += '<div class="strip-rows">'
      if (orch) html += orchRow(detail)
      if (ui.wide) html += kanban(rows, ui, detail, now)
      else for (var a = 0; a < rows.length; a++) html += rowHtml(rows[a], ui, detail, now)
      if (!rows.length && !orch && !ui.wide) html += '<div class="srow-load muted">Nothing is running.</div>'
      if (idle.length) {
        var spare = 0
        for (var c = 0; c < idle.length; c++) if (idle[c].removable === true) spare++
        if (ui.idleOpen && spare) html += '<div class="strip-idle-row"><button type="button" class="btn strip-clear" data-act="remove-ask" data-key="' + ALL_IDLE + '">Remove idle…</button></div>'
        if (ui.idleOpen && spare && ui.confirmRemove === ALL_IDLE) {
          html += '<div class="srow-confirm strip-confirm"><span class="muted">' + (spare === 1 ? 'Removes 1 idle worktree.' : 'Removes ' + spare + ' idle worktrees.') +
            (spare < idle.length ? ' Main checkouts are kept.' : '') + ' Branches and PRs stay on GitHub.</span>' +
            '<button type="button" class="btn danger" data-act="idle-clear">Remove ' + spare + '</button>' +
            '<button type="button" class="btn" data-act="remove-cancel">Cancel</button></div>'
        }
        if (ui.idleOpen) for (var b = 0; b < idle.length; b++) html += rowHtml(idle[b], ui, detail, now)
      }
      html += '</div>'
    }
    if (warn) html += '<div class="strip-warn">' + e(warn) + '</div>'
    var idleOn = open && !!ui.idleOpen
    html += '<div class="strip-bar"><button type="button" class="strip-sum" data-act="strip-toggle" aria-expanded="' + String(open) + '">' + counts + '</button>' +
      (idle.length ? '<button type="button" class="strip-idle' + (idleOn ? ' on' : '') + '" data-act="idle-toggle" aria-expanded="' + String(idleOn) + '" title="' + idle.length + ' idle, with no agent working and no PR. Click to ' + (idleOn ? 'hide' : 'show') + ' them">' + idle.length + ' idle</button>' : '') +
      '<button type="button" class="strip-fill" data-act="strip-toggle" tabindex="-1">' + (needs ? '<span class="strip-need" title="Waiting on an answer or a decision from you">' + needs + (needs === 1 ? ' needs you' : ' need you') + '</span>' : '') + '</button>' +
      '<button type="button" class="ib strip-full" data-act="board-open" title="Full board in the browser" aria-label="Full board in the browser">' + icon('grid') + '</button>' +
      '<button type="button" class="ib strip-chev" data-act="strip-toggle" aria-label="' + (open ? 'Hide sessions' : 'Show sessions') + '"><svg class="icon chev' + (open ? ' up' : '') + '"><use href="#i-chev"></use></svg></button></div>'
    return html + '</section>'
  }
})(window)
