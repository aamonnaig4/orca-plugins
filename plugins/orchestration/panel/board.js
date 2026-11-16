(function () {
  var LANES = [
    ['building', 'Building'],
    ['validating', 'Validating'],
    ['review', 'In review'],
    ['ready', 'Ready'],
  ]
  var CARD_BUTTONS = {
    allow: ['Allow once', 'btn pri', ''],
    deny: ['Deny', 'btn', ''],
    peek: ['Peek', 'btn', 'i-term'],
    retry: ['Retry fix', 'btn', ''],
    details: ['Details', 'btn', ''],
  }

  var TONES = { bad: true, build: true, warn: true, info: true, ok: true }
  var COLUMNS = { building: true, validating: true, review: true, ready: true }

  function toneOf(t) {
    return typeof t === 'string' && Object.prototype.hasOwnProperty.call(TONES, t) ? t : 'info'
  }

  function columnOf(row) {
    var c = row.column
    if (typeof c === 'string' && Object.prototype.hasOwnProperty.call(COLUMNS, c)) return c
    var l = row.lane
    if (typeof l === 'string' && Object.prototype.hasOwnProperty.call(COLUMNS, l)) return l
    return 'building'
  }

  function esc(s) {
    return window.OrchEsc.html(s)
  }

  function icon(id) {
    return '<svg class="icon"><use href="#' + id + '"></use></svg>'
  }

  function rel(at, now) {
    return window.OrchTime ? window.OrchTime.rel(at, now) : ''
  }

  function cardButtons(card) {
    var out = ''
    for (var i = 0; i < card.actions.length; i++) {
      var spec = Object.prototype.hasOwnProperty.call(CARD_BUTTONS, card.actions[i]) ? CARD_BUTTONS[card.actions[i]] : null
      if (!spec) continue
      out +=
        '<button type="button" class="' + spec[1] + '" data-act="card" data-id="' + esc(card.id) +
        '" data-action="' + esc(card.actions[i]) + '">' + (spec[2] ? icon(spec[2]) : '') + spec[0] + '</button>'
    }
    return out
  }

  function menuItem(label, attrs, extra) {
    return '<button type="button" class="menu-item" ' + attrs + '>' + label + (extra || '') + '</button>'
  }

  function menu(row) {
    var k = esc(row.key)
    var rowAct = 'data-act="row" data-key="' + k + '"'
    var items = [
      menuItem('Details', 'data-act="open-detail" data-key="' + k + '"'),
      menuItem('Message', 'data-act="open-detail" data-key="' + k + '" data-tab="status"'),
    ]
    if (row.pr != null) {
      var ci = !!(row.autoFix && row.autoFix.ci)
      var rv = !!(row.autoFix && row.autoFix.review)
      items.push(menuItem('Retry fix', rowAct + ' data-action="retry"'))
      items.push(
        menuItem('Auto-fix CI', rowAct + ' data-action="autofix-ci" data-on="' + String(!ci) + '"', '<span class="menu-state">' + (ci ? 'On' : 'Off') + '</span>'),
      )
      items.push(
        menuItem('Auto-fix review comments', rowAct + ' data-action="autofix-review" data-on="' + String(!rv) + '"', '<span class="menu-state">' + (rv ? 'On' : 'Off') + '</span>'),
      )
    }
    items.push(menuItem('Stop agent', rowAct + ' data-action="stop"'))
    items.push(menuItem('Remove worktree…', 'data-act="remove-ask" data-key="' + k + '"'))
    return '<div class="menu" role="menu">' + items.join('') + '</div>'
  }

  function confirm(row) {
    var k = esc(row.key)
    return (
      '<div class="board-confirm"><span class="muted">Its branch and PR stay on GitHub.</span>' +
      '<button type="button" class="btn danger" data-act="row" data-key="' + k + '" data-action="remove" data-confirmed="true">Remove</button>' +
      '<button type="button" class="btn" data-act="remove-cancel">Cancel</button></div>'
    )
  }

  function avatar(row) {
    var kind = typeof row.agentKind === 'string' ? row.agentKind.trim() : ''
    return '<span class="avatar" aria-hidden="true">' + (kind ? esc(kind.charAt(0).toUpperCase()) : '·') + '</span>'
  }

  function prLine(row) {
    var tag = '<span class="tag">' + esc(row.project) + '</span>'
    if (row.pr == null) return '<div class="bcard-line board-prline"><span class="pr-ic pr-none">' + icon('i-pr') + '</span><em class="board-pr none">no PR</em>' + tag + '</div>'
    var state = row.draft === true ? 'pr-draft' : 'pr-open'
    return '<div class="bcard-line board-prline"><span class="pr-ic ' + state + '">' + icon('i-pr') + '</span><em class="board-pr">#' + esc(row.pr) + '</em>' + tag + '</div>'
  }

  function need(row, ui) {
    var card = row.card
    if (!card || !card.actions || !card.actions.length) return ''
    var detail = card.detail ? '<div class="bcard-need-text">' + esc(card.detail) + '</div>' : ''
    if (ui && ui.readonly) return detail ? '<div class="bcard-need">' + detail + '</div>' : ''
    return '<div class="bcard-need">' + detail + '<div class="board-actions">' + cardButtons(card) + '</div></div>'
  }

  function rowHtml(row, ui, now) {
    var k = esc(row.key)
    var tone = toneOf(row.tone)
    var attn = row.lane === 'needs'
    var open = ui && ui.menuKey === row.key
    var working = row.working === true && !attn
    var cls = 'bcard board-row' + (attn ? ' attn' : '') + (row.stale ? ' stale' : '') + (open ? ' menu-open' : '')
    var label = typeof row.label === 'string' && row.label ? row.label : row.phrase
    var when = rel(row.at, now)
    var branch = row.branch ? '<div class="bcard-line board-branch">' + icon('i-branch') + '<span>' + esc(row.branch) + '</span></div>' : ''
    return (
      '<div class="' + cls + '" data-key="' + k + '">' +
      '<div class="board-main" data-act="open-detail" data-key="' + k + '" role="button" tabindex="0">' +
      '<div class="bcard-top">' + avatar(row) +
      '<div class="row-title board-title"><span class="board-name">' + esc(row.name) + '</span></div></div>' +
      branch + prLine(row) + '</div>' +
      (ui && ui.readonly ? '' : '<button type="button" class="board-more" data-act="menu" data-key="' + k + '" aria-label="More">' + icon('i-more') + '</button>') +
      need(row, ui) +
      '<div class="bcard-foot"><span class="row-sub board-sub tone-' + tone + '-text">' +
      (working ? '<i class="spin" aria-hidden="true"></i>' : '') + esc(label) + '</span>' +
      (when ? '<span class="board-time">' + when + '</span>' : '') + '</div>' +
      (open ? menu(row) : '') +
      (ui && ui.confirmRemove === row.key ? confirm(row) : '') +
      '</div>'
    )
  }

  function lane(id, title, rows, ui, now) {
    return (
      '<section class="lane lane-' + id + (rows.length ? '' : ' lane-empty') + '" data-key="lane:' + esc(id) + '"><h3 class="lane-h"><i class="lane-dot"></i><span>' + title + '</span><b>' + rows.length + '</b></h3>' +
      '<div class="lane-cards">' + rows.map(function (r) { return rowHtml(r, ui, now) }).join('') + '</div>' +
      '</section>'
    )
  }

  function board(vm, ui) {
    ui = ui || {}
    var now = typeof ui.now === 'number' ? ui.now : Date.now()
    var rows = (vm && vm.rows) || []
    var idle = (vm && vm.idle) || []
    if (!rows.length && !idle.length) {
      return '<div class="board"><p class="muted board-empty">No sessions yet. Agents you start in Orca show up here.</p></div>'
    }
    var lanes = ''
    for (var i = 0; i < LANES.length; i++) {
      var inLane = rows.filter(function (r) { return columnOf(r) === LANES[i][0] })
      lanes += lane(LANES[i][0], LANES[i][1], inLane, ui, now)
    }
    var idleHtml = ''
    if (idle.length) {
      idleHtml =
        '<div class="board-foot"><button type="button" class="board-idle" data-act="idle-toggle" aria-expanded="' + String(!!ui.idleOpen) + '">' +
        icon('i-archive') + '<span>Idle</span><b>' + idle.length + '</b></button>' +
        (ui.idleOpen ? '<div class="board-idle-rows">' + idle.map(function (r) { return rowHtml(r, ui, now) }).join('') + '</div>' : '') + '</div>'
    }
    return '<div class="board"><div class="lanes">' + lanes + '</div>' + idleHtml + '</div>'
  }

  window.OrchViews = window.OrchViews || {}
  window.OrchViews.board = board
})()
