(function () {
  var Fmt = window.AMFormat
  var Graph = window.AMGraph
  var Cols = window.AMColumns
  var api = window.orca
  var root = document.getElementById('app')
  var PREFS_KEY = 'activity-monitor:prefs'
  var HISTORY = 900
  var RATE_MIN = 100
  var RATE_MAX = 10000
  var RATE_STEP = 100
  var RATE_FAST = 500
  var HOLD_MS = 1000
  var COPIED_MS = 1200
  var TIP_MS = 1500
  var QUIT_GRACE = 8000
  var NAMES = { all: 'All', cpu: 'CPU', mem: 'Memory', net: 'Network', disk: 'Disk', gpu: 'GPU', energy: 'Energy', procs: 'Processes' }
  var ICONS = { all: 'grid', cpu: 'cpu', mem: 'mem', net: 'net', disk: 'disk', gpu: 'gpu', energy: 'bolt', procs: 'proc' }
  var FOCUS_KEYS = ['tile', 'tab', 'hero', 'hquit', 'loadmore', 'htoastx', 'sort', 'colmenu', 'togglecol', 'resetcols', 'quitsel', 'quit', 'force', 'copy', 'copyname', 'explain', 'no', 'gear', 'pause', 'step', 'crit', 'cleanup', 'cutoastx', 'setgraph', 'setline', 'setcolor', 'setgrid', 'sethist', 'setclock', 'setrecord', 'setfocus', 'setagent', 'setstrip', 'setalert', 'setsort', 'setpulse', 'setopen', 'setrows', 'settext', 'resetprefs']

  var DEFAULTS = { graph: 'smooth', line: 'fill', color: 'heat', grid: true, rate: 1000, hist: 60, clock: false, record: true, strip: true, alert: true, critAt: 95, sort: 'cpu', pulse: true, open: 'last', rows: 'default', text: 'default', focus: true, agent: 'claude' }
  var CRIT_MIN = 70
  var CRIT_MAX = 99
  var HISTS = [60, 300, 900, 3600, 21600, 86400]
  var LINES = ['fill', 'line', 'bars']
  var AGENTS = ['claude', 'codex', 'grok']
  var WINDOW_POINTS = 600
  var EDGE = 0.1
  var SORTS = ['cpu', 'mem', 'name']
  var OPENS = ['last', 'all', 'procs']
  var DENSITIES = ['compact', 'default', 'comfortable']
  var TEXT_SCALE = { small: 0.9, default: 1, large: 1.15 }
  var prefs = Object.assign({ tab: 'all', hero: 'cpu' }, DEFAULTS)
  var HEROES = ['cpu', 'mem', 'net', 'disk', 'gpu', 'energy']
  var HINT_MS = 5000
  var TAB_TIP_MS = 350
  var PULSE_MS = 1400
  var PULSE_KEYS = { cpu: 0.5, mem: 0.02, gpu: 0.5, power: 0.5, threads: 1, ports: 1 }
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')) } catch (e) {}
  prefs.rate = clampRate(prefs.rate)
  prefs.critAt = clampCrit(prefs.critAt)
  prefs.cols = Cols.clean(prefs.cols)
  if (HEROES.indexOf(prefs.hero) < 0) prefs.hero = 'cpu'
  if (HISTS.indexOf(prefs.hist) < 0) prefs.hist = DEFAULTS.hist
  if (LINES.indexOf(prefs.line) < 0) prefs.line = DEFAULTS.line
  if (AGENTS.indexOf(prefs.agent) < 0) prefs.agent = DEFAULTS.agent
  ;['grid', 'clock', 'record', 'focus'].forEach(function (k) { if (typeof prefs[k] !== 'boolean') prefs[k] = DEFAULTS[k] })
  if (SORTS.indexOf(prefs.sort) < 0) prefs.sort = DEFAULTS.sort
  if (OPENS.indexOf(prefs.open) < 0) prefs.open = DEFAULTS.open
  if (DENSITIES.indexOf(prefs.rows) < 0) prefs.rows = DEFAULTS.rows
  if (!TEXT_SCALE[prefs.text]) prefs.text = DEFAULTS.text
  function ts() { return TEXT_SCALE[prefs.text] }
  if (prefs.open !== 'last') prefs.tab = prefs.open

  var data = { boot: null, sample: null, health: null, procs: null, seq: 0, at: 0, windowed: false, tot: [], mem: [], down: [], up: [], gpu: [], dr: [], dw: [], bat: [], core: [], norms: {} }
  var view = {
    paused: false, settings: false, sort: prefs.sort, query: '', ask: null, askMsg: '', stuck: false, gone: {}, error: '', busy: false,
    menu: null, colMenu: null, heroMenu: null, open: null, unselect: null, copied: null, holding: false, sel: null, drag: null, dragged: false, fitted: [],
    glyph: 7.8, seen: {}, rows: 150, toastSeen: 0, cleanup: { kind: 'rest', n: null, count: 0 }, cleanupStarting: false, cleanupErr: '', cleanupErrAt: 0, hmsg: '', hmsgAt: 0, pointer: false, composing: false, hoverList: false, order: null, pending: false, dirty: true
  }
  var palette = { primary: '#e6e6e6', secondary: '#a3a3a3', grid: '#1f1f1f', bg: '#000000' }

  function clampRate(ms) {
    var n = Math.round(Number(ms) / RATE_STEP) * RATE_STEP
    return isFinite(n) ? Math.min(RATE_MAX, Math.max(RATE_MIN, n)) : 1000
  }
  function clampCrit(n) {
    var v = Math.round(Number(n))
    return isFinite(v) ? Math.min(CRIT_MAX, Math.max(CRIT_MIN, v)) : DEFAULTS.critAt
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch (e) {} }
  function syncPrefs() {
    if (!api || !api.plugin) return
    api.plugin.request('prefs.sync', { record: prefs.record, focus: prefs.focus, agent: prefs.agent, critAt: prefs.critAt }).then(null, function () {})
  }
  function push(arr, v) { arr.push(v); if (arr.length > HISTORY) arr.shift() }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] }) }
  function icon(id, cls) { return '<svg class="ico' + (cls ? ' ' + cls : '') + '"><use href="#i-' + id + '"/></svg>' }

  function toRgb(color, fallback) {
    try {
      var cv = document.createElement('canvas')
      cv.width = cv.height = 1
      var g = cv.getContext('2d')
      g.fillStyle = fallback
      g.fillStyle = color || fallback
      g.fillRect(0, 0, 1, 1)
      var d = g.getImageData(0, 0, 1, 1).data
      return '#' + [d[0], d[1], d[2]].map(function (v) { return ('0' + v.toString(16)).slice(-2) }).join('')
    } catch (e) { return fallback }
  }

  function readTheme() {
    var cs = getComputedStyle(document.body)
    var get = function (k) { return cs.getPropertyValue(k).trim() }
    palette.primary = toRgb(get('--orca-primary') || get('--orca-foreground'), '#e6e6e6')
    palette.secondary = toRgb(get('--orca-muted-foreground'), '#a3a3a3')
    palette.grid = toRgb(get('--orca-border'), '#1f1f1f')
    palette.bg = toRgb(get('--orca-background'), '#000000')
    var bg = parseInt(toRgb(get('--orca-background'), '#000000').slice(1), 16)
    var light = (0.2126 * (bg >> 16) + 0.7152 * ((bg >> 8) & 255) + 0.0722 * (bg & 255)) / 255 > 0.5
    Fmt.setLight(light)
    document.body.classList.toggle('light', light)
    var probe = document.createElement('span')
    probe.className = 'br'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.textContent = '⣿'.repeat(40)
    document.body.appendChild(probe)
    view.glyph = probe.getBoundingClientRect().width / 40 || 7.8
    probe.remove()
  }

  function batColor(pct) {
    if (prefs.color === 'theme') return pct < 20 ? 'var(--danger)' : palette.primary
    return pct < 20 ? Fmt.heat(1) : Fmt.heat(0)
  }

  function tone(kind, f) {
    if (kind === 'bat') return prefs.color === 'theme' ? palette.primary : Fmt.heat(0)
    if (prefs.color === 'heat') return Fmt.heat(f)
    return kind === 'up' || kind === 'dw' ? palette.secondary : palette.primary
  }

  function series(src) {
    if (src === 'down' || src === 'up' || src === 'dr' || src === 'dw') {
      if (!data.norms[src]) data.norms[src] = Fmt.norm(data[src], span())
      return data.norms[src]
    }
    if (src.indexOf('core') === 0) return data.core[Number(src.slice(4))] || []
    return data[src] || []
  }

  function reset() {
    ;['tot', 'mem', 'down', 'up', 'gpu', 'dr', 'dw'].forEach(function (k) { data[k] = [] })
    data.core = []
    data.seq = 0
  }

  var FIELDS = [['tot', 'total'], ['mem', 'mem'], ['down', 'down'], ['up', 'up'], ['gpu', 'gpu'], ['dr', 'read'], ['dw', 'write']]
  function blank() { var a = []; for (var i = 0; i < WINDOW_POINTS; i++) a.push(null); return a }

  function placeWindow(points, spanSec, now) {
    FIELDS.forEach(function (f) { data[f[0]] = blank() })
    data.core = []
    var spanMs = spanSec * 1000
    var start = now - spanMs
    var last = -1
    points.forEach(function (p) {
      var i = Math.max(last + 1, Math.floor((p.at - start) / (spanMs / WINDOW_POINTS)))
      if (i >= WINDOW_POINTS) i = WINDOW_POINTS - 1
      if (i <= last) return
      last = i
      FIELDS.forEach(function (f) { data[f[0]][i] = p[f[1]] })
      p.cores.forEach(function (v, c) { if (!data.core[c]) data.core[c] = blank(); data.core[c][i] = v })
    })
  }

  function ingest(r, spanSec) {
    if (r.boot !== data.boot) {
      reset()
      data.boot = r.boot
    }
    if (r.windowed || data.windowed) reset()
    data.windowed = !!r.windowed
    if (r.windowed) placeWindow(r.history, spanSec, Date.now())
    else r.history.forEach(function (p) {
      if (p.seq <= data.seq) return
      FIELDS.forEach(function (f) { push(data[f[0]], p[f[1]]) })
      p.cores.forEach(function (v, i) { if (!data.core[i]) data.core[i] = []; push(data.core[i], v) })
      data.seq = p.seq
    })
    if (r.sample.battery && (!data.sample || r.sample.seq !== data.sample.seq)) push(data.bat, r.sample.battery.percent)
    data.sample = r.sample
    data.health = r.health || null
    data.norms = {}
    ;['net', 'disk', 'gpu'].forEach(function (k) { if (r.sample[k]) view.seen[k] = true })
    if (r.procs) {
      trackMoves(data.procs, r.procs)
      data.procs = r.procs
      var alive = {}
      r.procs.forEach(function (p) { alive[p.pid] = p })
      if (view.sel !== null && !alive[view.sel]) { view.sel = null; view.open = null }
      Object.keys(view.gone).forEach(function (pid) {
        if (!alive[pid]) { delete view.gone[pid]; return }
        if (Date.now() - view.gone[pid] < QUIT_GRACE) return
        delete view.gone[pid]
        view.ask = Number(pid)
        view.askMsg = alive[pid].name + ' is still running.'
        view.stuck = true
      })
    }
  }

  function trackMoves(before, after) {
    var moves = {}
    var changed = !before || before.length !== after.length
    if (before) {
      var old = {}
      before.forEach(function (p) { old[p.pid] = p })
      after.forEach(function (p) {
        var q = old[p.pid]
        if (!q) return
        Object.keys(PULSE_KEYS).forEach(function (k) {
          var a = q[k]
          var b = p[k]
          if (typeof a !== 'number' || typeof b !== 'number') return
          if (a !== b) changed = true
          var limit = k === 'mem' ? Math.max(1048576, a * PULSE_KEYS[k]) : PULSE_KEYS[k]
          if (Math.abs(b - a) < limit) return
          if (!moves[p.pid]) moves[p.pid] = {}
          moves[p.pid][k] = b > a ? 'up' : 'down'
        })
      })
    }
    if (!changed) return
    data.moves = moves
    data.movesAt = performance.now()
  }

  function pulse(pid, key) {
    var dir = data.moves && data.moves[pid] && data.moves[pid][key]
    if (!dir || !prefs.pulse) return null
    var age = performance.now() - data.movesAt
    if (age >= PULSE_MS) return null
    return { cls: ' ' + dir, style: ' style="--pulse:-' + Math.round(age) + 'ms"' }
  }

  function wantsProcs() { return prefs.tab === 'procs' || prefs.tab === 'mem' || prefs.tab === 'energy' }
  function wantsEnergy() { return prefs.tab === 'energy' || (wantsProcs() && view.fitted.indexOf('power') >= 0) || view.open !== null }
  function wantsDetails() { return prefs.tab === 'cpu' || prefs.tab === 'procs' || prefs.tab === 'energy' || view.open !== null }

  function poll() {
    if (view.paused || view.busy || document.hidden || !api || !api.plugin) return
    view.busy = true
    var spanSec = prefs.hist
    api.plugin.request('stats.read', { procs: wantsProcs(), details: wantsDetails(), energy: wantsEnergy(), since: data.seq, interval: prefs.rate, span: spanSec, boot: data.boot }, { timeoutMs: 15000 }).then(function (r) {
      ingest(r, spanSec)
      data.at = performance.now()
      view.error = ''
    }, function (e) {
      view.error = (e && (e.message || e.code)) || 'Could not read system stats'
    }).then(function () {
      view.busy = false
      render()
    })
  }

  var timer = null
  function schedule() {
    clearInterval(timer)
    timer = setInterval(poll, prefs.rate)
    poll()
  }

  function pmeter(parts) {
    return '<div class="brbar" data-parts="' + esc(JSON.stringify(parts)) + '"></div>'
  }

  function fillBar(cell) {
    var size = parseFloat(getComputedStyle(cell).fontSize) || 8
    var cols = Math.max(4, Math.floor(cell.clientWidth / (view.glyph * size / 13)))
    var parts = JSON.parse(cell.dataset.parts)
    var used = 0
    var html = parts.map(function (pt) {
      var n = Math.min(cols - used, Math.round((Fmt.clamp(pt[0], 0, 100) / 100) * cols))
      used += n
      return n > 0 ? '<span style="color:' + pt[1] + ';opacity:' + pt[2] + '">' + '⣿'.repeat(n) + '</span>' : ''
    }).join('')
    cell.innerHTML = html + '<span class="brempty">' + '⣿'.repeat(cols - used) + '</span>'
  }

  function meter(v, color) {
    if (prefs.graph === 'braille') return pmeter([[v, color, 1]])
    var w = Fmt.clamp(v, 0, 100).toFixed(1)
    return '<div class="meter"><i data-w="' + w + '" style="width:' + w + '%;background:' + color + '"></i></div>'
  }

  function plot(src, kind, big, n, noX) {
    if (prefs.graph === 'braille') return '<div class="brfill" data-src="' + src + '" data-kind="' + kind + '"></div>'
    return '<canvas data-src="' + src + '" data-kind="' + kind + '" data-n="' + n + '"' + (big ? ' data-big="1"' : '') + (noX ? ' data-xl="0"' : '') + '></canvas>'
  }

  function graph(layout, src, kind, rows, flex, nospan) {
    if (layout.page) return '<div class="grow" style="flex:' + (flex || rows) + '">' + plot(src, kind, true, 90).replace('<canvas ', nospan ? '<canvas data-nospan="1" ' : '<canvas ') + '</div>'
    return '<div class="box" style="height:' + rows * 16 + 'px">' + plot(src, kind, true, 60) + '</div>'
  }

  function some(v, show) { return v === null || v === undefined ? null : show(v) }
  function perSec(v) { return some(v, function (x) { return Fmt.count(x) + '/s' }) }

  function chip(label, value, cls, swatch) {
    if (value === null || value === undefined || value === '–') return ''
    return '<span>' + (swatch ? '<i style="' + swatch + '"></i>' : '') + label + ' <b class="num' + (cls ? ' ' + cls : '') + '">' + value + '</b></span>'
  }

  function head(big, chips, more) {
    var a = chips.join('')
    var b = (more || []).join('')
    return '<div class="hc"><div class="big num">' + big + '</div>' + (a ? '<div class="chips">' + a + '</div>' : '') + (b ? '<div class="chips mut">' + b + '</div>' : '') + '</div>'
  }

  function cap(text, value) { return '<div class="cap"><span>' + text + '</span><span class="num">' + value + '</span></div>' }

  function cpuBody(layout) {
    var s = data.sample
    var split = s.split || {}
    var pc = function (v) { return v.toFixed(1) + '%' }
    var html = head(Fmt.pct(s.total) + '<u> · ' + s.cores.length + ' cores</u>', [
      chip('User', some(split.user, pc), 'usr'),
      chip('System', some(split.system, pc), 'sys'),
      chip('Idle', some(split.idle, pc))
    ], [
      chip('Threads', some(s.counts && s.counts.threads, Fmt.count)),
      chip('Processes', some(s.counts && s.counts.procs, Fmt.count))
    ]) + graph(layout, 'tot', 'cpu', 3, 1.2)
    var sec = windowSec()
    html += '<div class="cnote">Cores · 0–100% · ' + spanLabel(sec) + '</div><div class="cspark' + (s.cores.length > 24 ? ' many' : '') + '">'
    s.cores.forEach(function (core, i) {
      html += '<div class="cs"><span class="cl">' + esc(core.label) + '</span><div class="grow">' + plot('core' + i, 'cpu', false, span(), true) + '</div><span class="cp num">' + Fmt.pct(s.loads[i]) + '</span></div>'
    })
    return html + '</div>' + timeRow(sec)
  }

  function memBody(layout) {
    var m = data.sample.memory
    var f = m.total ? m.used / m.total : 0
    var color = tone('mem', f)
    var detailed = m.wired + m.compressed > 0
    var parts = [[detailed ? 'App' : 'Used', m.app, 1], ['Wired', m.wired, 0.65], ['Compressed', m.compressed, 0.4], ['Cached', m.cached, 0.18]]
      .filter(function (s) { return s[1] > 0 })
    var bar = prefs.graph === 'braille' ? pmeter(parts.map(function (s) { return [m.total ? (s[1] / m.total) * 100 : 0, color, s[2]] })) : '<div class="meter" style="height:8px;flex:none">' + parts.map(function (s) {
      var w = m.total ? ((s[1] / m.total) * 100).toFixed(1) : 0
      return '<i data-w="' + w + '" style="width:' + w + '%;background:' + color + ';opacity:' + s[2] + '"></i>'
    }).join('') + '</div>'
    var html = head(Fmt.gib(m.used) + '<u> / ' + Math.round(m.total / 1073741824) + ' GB</u>', parts.map(function (s) {
      return chip(s[0], Fmt.memSize(s[1]), '', 'background:' + color + ';opacity:' + s[2])
    }), [
      chip('Swap', some(data.sample.swap, Fmt.gb)),
      chip('Pressure', data.sample.pressure ? esc(data.sample.pressure) : null)
    ]) + bar + graph(layout, 'mem', 'mem', 2)
    if (data.procs) {
      var top = Fmt.visibleProcs(data.procs, '', 'mem', view.gone, 6).rows
      html += '<table class="ptab"><tr><th>Top by memory</th><th class="n">Mem</th></tr>' + top.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td class="n">' + Fmt.memSize(p.mem) + '</td></tr>'
      }).join('') + '</table>'
    }
    return html
  }

  function netBody(layout) {
    var n = data.sample.net
    var where = n.iface ? esc(n.iface) + (n.name && n.name !== n.iface ? ' · ' + esc(n.name) : '') : 'All interfaces'
    return head('↓ ' + Fmt.rate(n.down) + '<u>  </u>↑ ' + Fmt.rate(n.up), [
      '<span>' + where + '</span>',
      chip('In', perSec(n.packetsInRate), 'usr'),
      chip('Out', perSec(n.packetsOutRate), 'sys')
    ], [
      chip('Received', Fmt.bytes(n.rx)),
      chip('Sent', Fmt.bytes(n.tx)),
      chip('Packets', n.packetsIn === null ? null : Fmt.count(n.packetsIn) + ' / ' + Fmt.count(n.packetsOut))
    ]) + cap('↓ Download', Fmt.rate(n.down)) + graph(layout, 'down', 'down', 2, null, true) + cap('↑ Upload', Fmt.rate(n.up)) + graph(layout, 'up', 'up', 2)
  }

  function diskBody(layout) {
    var d = data.sample.disk
    var io = d.read !== null || d.write !== null || data.dr.some(function (v) { return v > 0 })
    var f = d.total ? d.used / d.total : 0
    var html = head(io ? 'R ' + Fmt.rate(d.read) + '<u>  </u>W ' + Fmt.rate(d.write) : Fmt.diskSize(d.used) + '<u> / ' + Fmt.diskSize(d.total) + '</u>', [
      '<span>' + esc(d.name) + ' <b class="num">' + Fmt.diskSize(d.free) + ' free</b></span>',
      chip('Reads', perSec(d.readOpsRate), 'usr'),
      chip('Writes', perSec(d.writeOpsRate), 'sys')
    ], [
      chip('Read', some(d.readBytes, Fmt.bytes)),
      chip('Written', some(d.writeBytes, Fmt.bytes)),
      chip('Ops', d.readOps === null ? null : Fmt.count(d.readOps) + ' / ' + Fmt.count(d.writeOps))
    ]) + meter(f * 100, tone('disk', f))
    if (io) html += cap('Read', Fmt.rate(d.read)) + graph(layout, 'dr', 'disk', 2, null, true) + cap('Write', Fmt.rate(d.write)) + graph(layout, 'dw', 'dw', 2)
    return html
  }

  function batteryStatus(b) {
    var state = String(b.state || '').toLowerCase()
    var time = b.remaining && b.remaining !== '0:00' ? b.remaining : null
    var ac = /ac/i.test(b.source || '')
    if (state === 'charged' || state === 'full') return 'Charged'
    if (state === 'finishing charge') return 'Finishing charge'
    if (state.indexOf('charging') === 0) return 'Charging' + (time ? ' · ' + time + ' to full' : '')
    if (state === 'discharging' || !ac) return time ? time + ' left' : 'On battery'
    return ac ? 'On AC, not charging' : b.state
  }

  function energyBody(layout) {
    var b = data.sample.battery
    var html = b ? head(b.percent + '%', [
      '<span>' + esc(batteryStatus(b)) + '</span>',
      chip('Power', b.source ? esc(b.source.replace(/ Power$/, '')) : null)
    ]) + meter(b.percent, batColor(b.percent)) : head('–', ['<span>No battery</span>'])
    if (!data.procs) return html + '<div class="note">Reading processes…</div>'
    var top = Fmt.visibleProcs(data.procs, '', 'power', view.gone, 80).rows
    var known = top.some(function (p) { return typeof p.power === 'number' })
    return html + '<div class="pscroll"><table class="ptab"><tr><th>Top by energy impact</th><th class="n">Energy</th><th class="n">Sleep</th></tr>' + top.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td class="n">' + Fmt.fixed(p.power, 1) + '</td><td class="n mut">' + (p.sleep ? 'Yes' : 'No') + '</td></tr>'
    }).join('') + '</table>' + (known ? '' : '<div class="more">Energy impact appears after a few seconds</div>') + '</div>'
  }

  function gpuBody(layout) {
    var g = data.sample.gpu
    return head(Fmt.pct(g.utilization) + '<u> busy</u>', ['<span>' + esc(g.model || 'GPU') + '</span>']) + graph(layout, 'gpu', 'gpu', 2)
  }

  function holdButton(pid, cls) {
    return '<a class="hb' + (cls ? ' ' + cls : '') + '" data-force="' + pid + '" tabindex="0" title="Kills it without saving">' + '<i></i><span>Hold to force quit</span></a>'
  }

  function askRow(p, span) {
    if (view.stuck) return '<tr class="ask" data-pid="' + p.pid + '"><td colspan="' + span + '">' + esc(view.askMsg) + holdButton(p.pid) + '<a class="btn" data-no tabindex="0">Leave it</a></td></tr>'
    return '<tr class="ask" data-pid="' + p.pid + '"><td colspan="' + span + '">' + esc(view.askMsg) + '<a class="btn" data-no tabindex="0">OK</a></td></tr>'
  }

  function expandRow(p, span) {
    var pairs = Cols.LIST.filter(function (c) { return c.key !== 'name' }).map(function (c) {
      return [c.long || c.label, c.key === 'pid' ? String(p.pid) : esc(c.show(p))]
    })
    return '<tr class="exp"><td colspan="' + span + '"><div class="kv">' + pairs.map(function (x) { return '<span>' + x[0] + '</span><b class="num">' + x[1] + '</b>' }).join('') + '</div></td></tr>'
  }

  function colMenuView() {
    var on = {}
    prefs.cols.forEach(function (k) { on[k] = true })
    var shown = {}
    view.fitted.forEach(function (k) { shown[k] = true })
    return '<div class="menu cols" role="menu" style="left:' + view.colMenu.x + 'px;top:' + view.colMenu.y + 'px">' +
      Cols.LIST.filter(function (c) { return !c.fixed }).map(function (c) {
        var hidden = on[c.key] && !shown[c.key]
        return '<a data-togglecol="' + c.key + '" role="menuitemcheckbox" aria-checked="' + !!on[c.key] + '" tabindex="0"><i class="ck">' + (on[c.key] ? '✓' : '') + '</i>' + (c.long || c.label) +
          (hidden ? '<kbd>needs room</kbd>' : '') + '</a>'
      }).join('') + '<hr><a data-resetcols tabindex="0"><i class="ck"></i>Reset columns</a></div>'
  }

  function copiedFor(pid) {
    var c = view.copied
    return c && c.pid === pid && performance.now() - c.at < COPIED_MS ? c : null
  }

  function rowAttrs(p) {
    var c = copiedFor(p.pid)
    if (view.sel === p.pid) return ' class="sel' + (view.open === p.pid ? ' open' : '') + '" aria-selected="true"'
    if (c && c.ok) return ' class="flash" style="--fade:-' + Math.round(performance.now() - c.at) + 'ms"'
    return ''
  }

  function pidCell(p) {
    var c = copiedFor(p.pid)
    var label = c ? (c.ok ? 'Copied' : 'Failed') : p.pid
    return '<td class="pid"><a data-copy="' + p.pid + '" class="' + (c ? (c.ok ? 'ok' : 'bad') : '') + '" aria-label="Copy PID ' + p.pid + '" tabindex="0">' + label + '</a></td>'
  }

  function menuView() {
    var p = view.menu && (data.procs || []).filter(function (x) { return x.pid === view.menu.pid })[0]
    if (!p) { view.menu = null; return '' }
    return '<div class="menu" role="menu" style="left:' + view.menu.x + 'px;top:' + view.menu.y + 'px">' +
      '<a class="d" data-quit="' + p.pid + '" role="menuitem" tabindex="0">Quit ' + esc(p.name) + '</a>' +
      holdButton(p.pid, 'mi') + '<hr>' +
      '<a data-explain="' + p.pid + '" role="menuitem" tabindex="0">What is this?</a>' +
      '<a data-copy="' + p.pid + '" role="menuitem" tabindex="0">Copy PID<kbd>' + p.pid + '</kbd></a>' +
      '<a data-copyname="' + p.pid + '" role="menuitem" tabindex="0">Copy name</a></div>'
  }

  var PAGE_ROWS = 150
  var LOAD_AHEAD_PX = 400

  function procBody(layout) {
    if (!data.procs) return '<div class="note">Reading processes…</div>'
    var freeze = view.hoverList || view.sel !== null
    var res = Fmt.visibleProcs(data.procs, view.query, view.sort, view.gone, view.rows, freeze ? view.order : null)
    if (!freeze || !view.order) view.order = res.rows.map(function (p) { return p.pid })
    function th(key, label, cls) {
      var on = view.sort === key
      return '<th class="' + (cls || '') + (on ? ' on' : '') + '"><a data-sort="' + key + '" tabindex="0">' + label + (on ? ' ▾' : '') + '</a></th>'
    }
    var sel = view.sel !== null && !view.gone[view.sel] ? data.procs.filter(function (p) { return p.pid === view.sel })[0] : null
    var html = '<div class="ptools"><label class="search">' + icon('search') + '<input class="filter" data-q placeholder="Search ' + Fmt.count(data.procs.length) + ' processes" value="' + esc(view.query) + '"></label>' +
      '<a class="tool" data-colmenu tabindex="0" aria-label="Add or remove columns" data-name="Add or remove columns">' + icon('plus') + '</a>' +
      '<a class="tool' + (sel ? '' : ' off') + '" data-quitsel tabindex="0" aria-disabled="' + !sel + '" data-name="' + (sel ? 'Quit ' + esc(sel.name) : 'Select a process to quit it') + '">' + icon('xcircle') + '</a></div>'
    var width = Math.max(160, root.clientWidth - 28)
    var keys = Cols.fit(prefs.cols, width / ts())
    view.fitted = keys
    var span = keys.length
    html += (layout.page ? '<div class="pscroll">' : '') + '<table class="ptab cols"><thead><tr>' + keys.map(function (k) {
      var c = Cols.BY[k]
      var on = view.sort === k
      return '<th class="' + c.cls + (on ? ' on' : '') + '" data-col="' + k + '"' + (k === 'name' ? '' : ' style="width:' + Math.round(c.width * ts()) + 'px"') + '><a data-sort="' + k + '" tabindex="0" title="' + esc(c.long || c.label) + ' · drag to move">' + c.label + (on ? ' ▾' : '') + '</a></th>'
    }).join('') + '</tr></thead>'
    res.rows.forEach(function (p) {
      if (view.ask === p.pid) { html += askRow(p, span); return }
      html += '<tr data-pid="' + p.pid + '"' + rowAttrs(p) + '>' + keys.map(function (k) {
        if (k === 'pid') return pidCell(p)
        if (k === 'name') return '<td class="nm" title="' + esc(p.name) + '">' + esc(p.name) + '</td>'
        var c = Cols.BY[k]
        var m = pulse(p.pid, k)
        return '<td class="' + c.cls + (m ? m.cls : '') + '"' + (m ? m.style : '') + '>' + esc(c.show(p)) + '</td>'
      }).join('') + '</tr>'
      if (view.sel === p.pid && view.open === p.pid) html += expandRow(p, span)
    })
    html += '</table>'
    if (res.more) html += '<a class="more loadmore" data-loadmore tabindex="0">Showing ' + Fmt.count(res.rows.length) + ' of ' + Fmt.count(res.matched) + ' · scroll or click for more</a>'
    if (!res.matched) html += '<div class="more">No process matches</div>'
    return html + (layout.page ? '</div>' : '')
  }

  function missing() { return '<div class="note">Not available right now</div>' }

  function sections(layout) {
    var s = data.sample
    var list = [
      ['cpu', Fmt.pct(s.total) + ' · ' + s.cores.length + ' cores', function () { return cpuBody(layout) }],
      ['mem', Fmt.gib(s.memory.used) + ' / ' + Math.round(s.memory.total / 1073741824) + ' GB', function () { return memBody(layout) }]
    ]
    if (s.net) list.push(['net', '↓ ' + Fmt.rate(s.net.down) + '  ↑ ' + Fmt.rate(s.net.up), function () { return netBody(layout) }])
    else if (view.seen.net) list.push(['net', '–', missing])
    if (s.disk) list.push(['disk', Fmt.diskSize(s.disk.used) + ' / ' + Fmt.diskSize(s.disk.total), function () { return diskBody(layout) }])
    else if (view.seen.disk) list.push(['disk', '–', missing])
    if (s.gpu) list.push(['gpu', Fmt.pct(s.gpu.utilization), function () { return gpuBody(layout) }])
    else if (view.seen.gpu) list.push(['gpu', '–', missing])
    var b = s.battery
    list.push(['energy', b ? b.percent + '% · ' + esc(batteryStatus(b)) : '', function () { return energyBody(layout) }])
    list.push(['procs', data.procs ? data.procs.length + ' running' : '', function () { return procBody(layout) }])
    return list
  }

  function tileChart(key, n) {
    var s = data.sample
    function one(src, kind) { return '<div class="grow">' + plot(src, kind, false, n) + '</div>' }
    if (key === 'cpu') return one('tot', 'cpu')
    if (key === 'mem') {
      var m = s.memory
      var f = m.total ? m.used / m.total : 0
      return meter(f * 100, tone('mem', f)) + one('mem', 'mem')
    }
    if (key === 'net') return one('down', 'down') + one('up', 'up')
    if (key === 'disk') {
      var d = s.disk
      if (d.read !== null || d.write !== null || data.dr.some(function (v) { return v > 0 })) return one('dr', 'disk') + one('dw', 'dw')
      var u = d.total ? d.used / d.total : 0
      return meter(u * 100, tone('disk', u)) + '<div class="grow tnote mut">' + Fmt.diskSize(d.free) + ' free</div>'
    }
    if (key === 'gpu') return one('gpu', 'gpu')
    if (key === 'energy') {
      var b = s.battery
      return b ? meter(b.percent, batColor(b.percent)) : '<div class="tnote mut">No battery</div>'
    }
    return ''
  }

  function short(bps) {
    if (bps === null || bps === undefined) return '–'
    var units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'K']]
    for (var i = 0; i < units.length; i++) {
      var v = bps / units[i][0]
      if (v >= 1 || i === units.length - 1) return (v >= 10 || i === units.length - 1 ? Math.round(v) : v.toFixed(1)) + units[i][1]
    }
    return '0K'
  }

  function headline(s, cls) {
    var key = s[0]
    var x = data.sample
    if (cls === 'big' || s[1] === '–') return s[1]
    if (key === 'net' && x.net) return '↓' + short(x.net.down) + ' ↑' + short(x.net.up)
    if (key === 'disk' && x.disk && (x.disk.read !== null || x.disk.write !== null)) return 'R ' + short(x.disk.read) + ' W ' + short(x.disk.write)
    if (key === 'cpu') return Fmt.pct(x.total)
    return s[1]
  }

  function tile(s, cls, missing) {
    var key = s[0]
    var body = missing ? '<div class="grow tnote mut">Not available right now</div>' : tileChart(key, cls === 'big' ? 90 : 50)
    if (key === 'energy' && cls === 'big' && !missing && data.sample.battery) body += '<div class="grow">' + plot('bat', 'bat', true, 90) + '</div>'
    return '<a class="tile ' + cls + '" data-tab="' + key + '" data-tile="' + key + '" tabindex="0" aria-label="' + NAMES[key] + '">' +
      '<div class="sh">' + icon(ICONS[key]) + '<b>' + NAMES[key] + '</b><span class="r">' + headline(s, cls) + '</span></div>' + body + '</a>'
  }

  function allView(list) {
    var by = {}
    list.forEach(function (s) { by[s[0]] = s })
    var hero = by[prefs.hero] ? prefs.hero : 'cpu'
    var rest = HEROES.filter(function (k) { return k !== hero && k !== 'energy' && by[k] })
    var html = '<div class="allv">' + tile(by[hero], 'big', by[hero][1] === '–') + '<div class="tgrid' + (rest.length > 2 ? '' : ' one') + '">' + rest.map(function (k, i) {
      return tile(by[k], i === rest.length - 1 && rest.length % 2 ? 'span' : '', by[k][1] === '–')
    }).join('') + '</div>'
    if (hero !== 'energy' && by.energy) html += tile(by.energy, 'line', false)
    return html + '</div>'
  }

  function heroMenuView() {
    var k = view.heroMenu.key
    return '<div class="menu" role="menu" style="left:' + view.heroMenu.x + 'px;top:' + view.heroMenu.y + 'px">' +
      (k === prefs.hero ? '' : '<a data-hero="' + k + '" role="menuitem" tabindex="0">Make hero</a>') +
      '<a data-tab="' + k + '" role="menuitem" tabindex="0">Open ' + NAMES[k] + '</a></div>'
  }

  function section(s) {
    return '<div class="sec" data-s="' + s[0] + '">' + s[2]() + '</div>'
  }

  var DEMO = [10, 30, 22, 55, 40, 70, 48, 62, 35, 50, 28, 44]
  var LINE_ICONS = {
    fill: '<span class="lv"><svg viewBox="0 0 26 12"><path d="M0 9 L5 6 L9 8 L14 3 L19 6 L26 2 L26 12 L0 12z" fill="currentColor" opacity=".3"/><path d="M0 9 L5 6 L9 8 L14 3 L19 6 L26 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></span>',
    line: '<span class="lv"><svg viewBox="0 0 26 12"><path d="M0 9 L5 6 L9 8 L14 3 L19 6 L26 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></span>',
    bars: '<span class="lv"><svg viewBox="0 0 26 12"><g fill="currentColor"><rect x="1" y="7" width="3" height="5"/><rect x="6" y="4" width="3" height="8"/><rect x="11" y="8" width="3" height="4"/><rect x="16" y="2" width="3" height="10"/><rect x="21" y="5" width="3" height="7"/></g></svg></span>'
  }
  function settingsView() {
    function choice(attr, current, opts) {
      return '<div class="seg">' + opts.map(function (o) {
        var on = String(o[0]) === String(current)
        var named = o[3] ? ' title="' + o[3] + '" aria-label="' + o[3] + '" aria-pressed="' + on + '"' : ''
        return '<a data-' + attr + '="' + o[0] + '" class="' + (on ? 'on' : '') + '"' + named + ' tabindex="0">' + (o[2] || '') + o[1] + '</a>'
      }).join('') + '</div>'
    }
    var pts = DEMO.map(function (v, i) { return i * 10 + ',' + (18 - (v / 100) * 16).toFixed(1) }).join(' ')
    var smooth = '<span class="pv"><svg viewBox="0 0 110 18" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></span>'
    var pixel = '<span class="pv">' + Graph.braille(DEMO.concat(DEMO), 12, 2, function () { return 'currentColor' }) + '</span>'
    function row(label, ctl, sub) { return '<div class="sr"><span>' + label + (sub ? '<em>' + sub + '</em>' : '') + '</span>' + ctl + '</div>' }
    function grp(title, rows) { return '<div class="sg"><div class="sgh">' + title + '</div><div class="srows">' + rows.join('') + '</div></div>' }
    function toggle(attr, on, label) { return '<a class="tg' + (on ? ' on' : '') + '" data-' + attr + '="t" role="switch" aria-checked="' + on + '" aria-label="' + label + '" tabindex="0"></a>' }
    return '<div class="setv">' +
      grp('Graphs', [
        row('Graph style', choice('setgraph', prefs.graph, [['smooth', 'Smooth', smooth], ['braille', 'Pixel', pixel]])),
        row('Line style', choice('setline', prefs.line, [['fill', '', LINE_ICONS.fill, 'Line + fill'], ['line', '', LINE_ICONS.line, 'Line'], ['bars', '', LINE_ICONS.bars, 'Bars']]), 'Smooth graphs only'),
        row('Color', choice('setcolor', prefs.color, [['heat', 'Heat'], ['theme', 'Theme']])),
        row('Gridlines', toggle('setgrid', prefs.grid, 'Gridlines')),
        row('History', choice('sethist', prefs.hist, [[60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'], [21600, '6h'], [86400, '24h']])),
        row('Time labels', choice('setclock', prefs.clock ? 'clock' : 'relative', [['relative', 'Relative'], ['clock', 'Clock']])),
        row('Record in background', toggle('setrecord', prefs.record, 'Record in background'), 'Keeps long history full while the panel is closed'),
        row('Refresh', stepper())
      ]) +
      grp('Cleanup', [
        row('Open cleanup terminal', toggle('setfocus', prefs.focus, 'Open cleanup terminal'), 'Switch to the agent when cleanup starts'),
        row('Cleanup agent', choice('setagent', prefs.agent, [['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']]))
      ]) +
      grp('Health', [
        row('Health strip', toggle('setstrip', prefs.strip, 'Health strip'), 'Shows anyway when Strained or Critical'),
        row('Memory alert', toggle('setalert', prefs.alert, 'Memory alert'), 'Pop-up when memory is nearly full'),
        row('Critical at', critStepper(), 'Footer warning when memory use reaches this')
      ]) +
      grp('Processes', [
        row('Default sort', choice('setsort', prefs.sort, [['cpu', 'CPU'], ['mem', 'Memory'], ['name', 'Name']])),
        row('Pulse on change', toggle('setpulse', prefs.pulse, 'Pulse on change'), 'Flash numbers that jump')
      ]) +
      grp('General', [
        row('Open on', choice('setopen', prefs.open, [['last', 'Last'], ['all', 'All'], ['procs', 'Processes']])),
        row('Text size', choice('settext', prefs.text, [['small', 'Small'], ['default', 'Default'], ['large', 'Large']])),
        row('Table rows', choice('setrows', prefs.rows, [['compact', 'Compact'], ['default', 'Default'], ['comfortable', 'Comfortable']]), 'Process list and Settings')
      ]) +
      '<a class="sreset" data-resetprefs tabindex="0">Reset to defaults</a>' +
      '</div>'
  }

  var HEAT_STEPS = ['#4ade80', '#4ade80', '#a3e635', '#fbbf24', 'var(--danger)']
  var THEME_STEPS = ['var(--hi)', 'var(--hi)', 'color-mix(in srgb, var(--danger) 30%, var(--hi))', 'color-mix(in srgb, var(--danger) 65%, var(--hi))', 'var(--danger)']
  function stepColors() { return prefs.color === 'theme' ? THEME_STEPS : HEAT_STEPS }
  var TOAST_MS = 8000
  var HMSG_MS = 4000

  function healthStrip() {
    var h = data.health
    if (!h || !data.sample) return '<div class="hs"></div>'
    var step = typeof h.step === 'number' ? h.step : 1
    if (!prefs.strip && step < 3) return '<div class="hs"></div>'
    var c = stepColors()[step] || stepColors()[1]
    if (view.hmsg && Date.now() - view.hmsgAt < HMSG_MS) return '<div class="hs" style="--c:' + c + '"><span class="hc2 mut">' + esc(view.hmsg) + '</span></div>'
    var pips = '<span class="pips" aria-hidden="true">'
    for (var i = 0; i < 5; i++) pips += '<i' + (i <= step ? ' class="on"' : '') + '></i>'
    pips += '</span>'
    var q = ''
    if (step === 4 && h.culprit && h.culprit.quittable) {
      q = '<a class="hq" data-hquit tabindex="0" title="Quit ' + esc(h.culprit.app) + '">Quit<span class="n"> ' + esc(h.culprit.app) + '</span></a>'
    }
    var tipText = h.cause + (h.culprit && step === 4 ? ' · ' + h.culprit.app + ' ' + Fmt.memSize(h.culprit.mem) : '')
    var open = !!pop.el
    return '<div class="hs' + (open ? ' open' : '') + '" style="--c:' + c + '" data-cause="' + esc(tipText) + '" tabindex="0" role="button" aria-haspopup="dialog" aria-expanded="' + open + '" aria-label="' + esc(h.word + ': ' + tipText + '. Show likely culprits') + '"><b class="hword">' + esc(h.word) + '</b><span class="hchev">' + icon('chev') + '</span>' + pips + q + '</div>'
  }

  var POP_REFRESH_MS = 2000
  var FORCE_AFTER_MS = 3000
  var pop = { el: null, refreshT: null, data: null, busy: false, quitting: {}, errors: {} }

  function popHeader() {
    var h = data.health
    if (!h) return ''
    var c = stepColors()[typeof h.step === 'number' ? h.step : 1]
    return '<div class="pop-h"><b style="color:' + c + '">' + esc(h.word) + '</b><span class="mut">' + esc(h.cause) + '</span></div>'
  }

  function popRow(it, by) {
    var q = pop.quitting[it.pid]
    var value = by === 'cpu' ? Fmt.pct(it.cpu) : Fmt.memSize(it.mem)
    var name = esc(it.app) + (it.count > 1 ? ' <em class="mut">×' + it.count + '</em>' : '')
    var act
    if (pop.errors[it.pid]) act = '<span class="pq-msg mut" title="' + esc(pop.errors[it.pid]) + '">' + esc(pop.errors[it.pid]) + '</span>'
    else if (!it.quittable) act = '<span class="pq-no mut" title="' + (/^orca/i.test(it.app) ? 'Orca is never quit from here' : 'Protected or shared process') + '">–</span>'
    else if (q && !q.force && Date.now() - q.at > FORCE_AFTER_MS) act = '<a class="pq force" data-pq="' + it.pid + '" data-force="1" tabindex="0">Force quit</a>'
    else if (q) act = '<span class="pq-msg mut">Quitting…</span>'
    else act = '<a class="pq" data-pq="' + it.pid + '" tabindex="0">Quit</a>'
    return '<div class="pop-r"><span class="pop-n" title="' + esc(it.name + ' · pid ' + it.pid) + '">' + name + '</span><span class="pop-v num">' + value + '</span>' + act + '</div>'
  }

  function popFade(list) {
    list.classList.toggle('end', list.scrollTop + list.clientHeight >= list.scrollHeight - 2)
  }

  function popPaint() {
    if (!pop.el) return
    var d = pop.data
    var body
    if (!d) body = '<div class="pop-e mut">Looking…</div>'
    else if (!d.items.length) body = '<div class="pop-e mut">No processes to show</div>'
    else body = '<div class="pop-list">' + d.items.map(function (it) { return popRow(it, d.by) }).join('') + '</div>'
    var oldList = pop.el.querySelector('.pop-list')
    var listTop = oldList ? oldList.scrollTop : 0
    var focusPid = document.activeElement && pop.el.contains(document.activeElement) ? document.activeElement.dataset.pq : null
    pop.el.innerHTML = popHeader() + '<div class="pop-s mut">Likely culprits · by ' + (d && d.by === 'cpu' ? 'CPU' : 'memory') + '</div>' + body
    var newList = pop.el.querySelector('.pop-list')
    if (newList) { newList.scrollTop = listTop; popFade(newList) }
    if (focusPid) { var f = pop.el.querySelector('[data-pq="' + focusPid + '"]'); if (f) f.focus({ preventScroll: true }) }
    popPlace()
  }

  function popPlace() {
    var bar = root.querySelector('.top')
    if (!pop.el || !bar) return
    var r = bar.getBoundingClientRect()
    var box = root.getBoundingClientRect()
    pop.el.style.left = box.left + 'px'
    pop.el.style.width = box.width + 'px'
    pop.el.style.bottom = Math.max(0, window.innerHeight - r.top) + 'px'
    pop.el.style.maxHeight = Math.max(80, r.top - box.top - 8) + 'px'
  }

  function popFetch() {
    if (!api || pop.busy) return
    pop.busy = true
    api.plugin.request('health.suspects', {}, { timeoutMs: 15000 }).then(function (r) {
      pop.data = r
      var alive = {}
      ;(r.items || []).forEach(function (it) { alive[it.pid] = true })
      Object.keys(pop.quitting).forEach(function (pid) { if (!alive[pid]) delete pop.quitting[pid] })
    }, function () {}).then(function () {
      pop.busy = false
      popPaint()
    })
  }

  function popOpen() {
    if (pop.el) return
    hideTip()
    pop.el = document.createElement('div')
    pop.el.className = 'pop'
    pop.el.setAttribute('role', 'dialog')
    pop.el.setAttribute('aria-label', 'Likely culprits')
    pop.el.addEventListener('click', popClick)
    pop.el.addEventListener('scroll', function (ev) { if (ev.target.classList && ev.target.classList.contains('pop-list')) popFade(ev.target) }, true)
    pop.el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { popClose(); var hs = root.querySelector('.hs'); if (hs) hs.focus() }
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset.pq) { ev.preventDefault(); popClick(ev) }
    })
    document.body.appendChild(pop.el)
    root.classList.add('drawer-open')
    popPaint()
    void pop.el.offsetHeight
    pop.el.classList.add('in')
    syncStrip()
    popFetch()
    pop.refreshT = setInterval(function () { popFetch() }, POP_REFRESH_MS)
  }

  function popClose() {
    clearInterval(pop.refreshT)
    if (pop.el) pop.el.remove()
    pop.el = null
    pop.errors = {}
    root.classList.remove('drawer-open')
    syncStrip()
  }

  function syncStrip() {
    var hs = root.querySelector('.hs[data-cause]')
    if (!hs) return
    hs.classList.toggle('open', !!pop.el)
    hs.setAttribute('aria-expanded', String(!!pop.el))
  }

  function popToggle() {
    if (pop.el) popClose(); else popOpen()
  }

  function popClick(ev) {
    var a = ev.target.closest('[data-pq]')
    if (!a || !pop.data) return
    var pid = Number(a.dataset.pq)
    var it = pop.data.items.filter(function (x) { return x.pid === pid })[0]
    if (!it || !it.quittable) return
    var force = a.dataset.force === '1'
    pop.quitting[pid] = { at: Date.now(), force: force }
    delete pop.errors[pid]
    popPaint()
    api.plugin.request('process.quit', { pid: it.pid, name: it.name, start: it.start, force: force }, { timeoutMs: 15000 }).then(function (r) {
      if (!r || !r.ok) { delete pop.quitting[pid]; pop.errors[pid] = (r && r.reason) || 'Could not quit it' }
      popPaint()
      setTimeout(popFetch, 600)
      setTimeout(popPaint, FORCE_AFTER_MS + 50)
    }, function (e) {
      delete pop.quitting[pid]
      pop.errors[pid] = (e && e.message) || 'Could not quit it'
      popPaint()
    })
  }

  function healthToast() {
    var h = data.health
    if (!h || !h.alertAt || h.alertAt === view.toastSeen || Date.now() - h.alertAt > TOAST_MS) return ''
    if (h.level !== 'risk' && h.level !== 'crit') return ''
    if (!prefs.alert) return ''
    var who = h.culprit ? h.culprit.app + ' ' + Fmt.memSize(h.culprit.mem) : h.cause
    return '<div class="htoast" role="alert"><i class="hdot" style="--c:var(--danger)"></i><b>Memory almost full</b><span class="mut">' + esc(who) + '</span><a class="ib" data-htoastx title="Dismiss" tabindex="0">' + icon('x') + '</a></div>'
  }

  function quitCulprit() {
    var h = data.health
    if (!h || !h.culprit || !h.culprit.quittable || !api) return
    var c = h.culprit
    api.plugin.request('process.quit', { pid: c.pid, name: c.name, start: c.start, force: false }, { timeoutMs: 15000 }).then(function (r) {
      view.hmsg = r && r.ok ? 'Quitting ' + c.app + '…' : (r && r.reason) || 'Could not quit ' + c.app
      view.hmsgAt = Date.now()
      render()
    }, function (e) {
      view.hmsg = (e && e.message) || 'Could not quit ' + c.app
      view.hmsgAt = Date.now()
      render()
    })
  }

  function fitFooter() {
    var top = root.querySelector('.top')
    var hs = top && top.querySelector('.hs')
    if (!hs) return
    var hq = hs.querySelector('.hq')
    function over(el) { return !!el && el.scrollWidth > el.clientWidth }
    if (over(hq)) hq.classList.add('short')
    if (over(hs) || over(hq)) hs.classList.add('tight')
    if (over(hs) || over(hq)) top.classList.add('slim')
  }

  function stepper() {
    var fast = prefs.rate < RATE_FAST
    return '<div class="stp push' + (fast ? ' fast' : '') + '" title="Refresh every ' + prefs.rate + 'ms' + (fast ? '. Fast refresh uses more CPU.' : '') + '">' +
      '<a data-step="-1" tabindex="0" aria-label="Refresh faster">−</a><b class="num">' + prefs.rate + 'ms</b><a data-step="1" tabindex="0" aria-label="Refresh slower">+</a></div>'
  }

  function critStepper() {
    return '<div class="stp" title="Critical warning in the Orca footer at this memory use">' +
      '<a data-crit="-1" tabindex="0" aria-label="Warn at a lower memory percent">−</a><b class="num">' + prefs.critAt + '%</b><a data-crit="1" tabindex="0" aria-label="Warn at a higher memory percent">+</a></div>'
  }

  var CLEANUP_POLL_MS = 3000
  var RING_MS = 900
  var cleanupTimer = null
  var cleanupSeq = 0

  function cleanupTip(c) {
    if (c.kind === 'working') return 'Agent is checking ' + c.count + ' processes · click to open'
    if (c.kind === 'review') return 'Agent has a kill list for you · click to review'
    if (c.kind === 'quit') return 'Cleanup finished: ' + c.n + ' quit · click to open'
    return 'Ask your agent to clean up stale processes'
  }

  function cleanupText(c) {
    if (c.kind === 'working') return 'Cleaning…'
    if (c.kind === 'review') return c.n == null ? 'Review' : 'Review ' + c.n
    if (c.kind === 'quit') return c.n + ' quit'
    return ''
  }

  function ring() { return '<span class="ring" style="animation-delay:-' + Math.round(performance.now() % RING_MS) + 'ms"></span>' }

  function cleanupButton() {
    var c = view.cleanup
    var tip = esc(cleanupTip(c))
    if (c.kind === 'rest') {
      return '<a class="ib" data-cleanup title="' + tip + '" aria-label="' + tip + '" tabindex="0"' + (view.cleanupStarting ? ' aria-busy="true"' : '') + '>' + (view.cleanupStarting ? ring() : icon('broom')) + '</a>'
    }
    var text = esc(cleanupText(c))
    var cls = c.kind === 'review' ? ' review' : c.kind === 'quit' ? ' done' : ''
    var lead = c.kind === 'working' ? ring() : c.kind === 'quit' ? icon('check', 'wide') + icon('broom', 'slim') : icon('broom')
    var dot = c.kind === 'review' ? '<span class="dot"></span>' : c.kind === 'quit' ? '<span class="dot ok"></span>' : ''
    return '<a class="cu' + cls + '" data-cleanup title="' + tip + '" aria-label="' + text + '. ' + tip + '" tabindex="0">' + lead + '<span class="t">' + text + '</span>' + dot + '</a>'
  }

  function cleanupApply(r) {
    if (!r || !r.state) return
    var st = r.state
    view.cleanup = { kind: st.kind, n: typeof st.n === 'number' ? st.n : null, count: typeof r.count === 'number' ? r.count : view.cleanup.count }
    clearTimeout(cleanupTimer)
    if (st.kind !== 'rest') cleanupTimer = setTimeout(cleanupRead, CLEANUP_POLL_MS)
  }

  function cleanupRead() {
    if (!api || !api.plugin) return
    var my = ++cleanupSeq
    api.plugin.request('cleanup.state', {}, { timeoutMs: 15000 }).then(function (r) {
      if (my !== cleanupSeq) return
      cleanupApply(r)
      render()
    }, function () {
      if (my !== cleanupSeq) return
      clearTimeout(cleanupTimer)
      cleanupTimer = setTimeout(cleanupRead, CLEANUP_POLL_MS)
    })
  }

  function cleanupError(msg) {
    view.cleanupErr = msg || 'Could not start a cleanup'
    view.cleanupErrAt = Date.now()
    setTimeout(render, TOAST_MS + 50)
  }

  function cleanupClick() {
    if (!api || !api.plugin || view.cleanupStarting) return
    var my = ++cleanupSeq
    if (view.cleanup.kind === 'rest') {
      view.cleanupStarting = true
      view.cleanupErr = ''
      render()
      api.plugin.request('cleanup.start', {}, { timeoutMs: 60000 }).then(function (r) {
        if (!r || !r.ok) { cleanupError(r && r.reason); cleanupRead() }
        else if (my === cleanupSeq) cleanupApply(r)
      }, function (e) {
        cleanupError(e && (e.message || e.code))
      }).then(function () {
        view.cleanupStarting = false
        render()
      })
      return
    }
    api.plugin.request('cleanup.open', {}, { timeoutMs: 15000 }).then(function (r) {
      if (my !== cleanupSeq) return
      cleanupApply(r)
      render()
    }, function (e) {
      cleanupError(e && (e.message || e.code))
      render()
    })
  }

  function cleanupToast() {
    if (!view.cleanupErr || Date.now() - view.cleanupErrAt > TOAST_MS) return ''
    var msg = esc(view.cleanupErr)
    return '<div class="htoast" role="alert"><i class="hdot" style="--c:var(--danger)"></i><b class="cerr" title="' + msg + '">' + msg + '</b><a class="ib" data-cutoastx title="Dismiss" tabindex="0">' + icon('x') + '</a></div>'
  }

  function focusKey() {
    var a = document.activeElement
    if (!a || !root.contains(a)) return null
    if (a.matches('input[data-q]')) return { input: true, at: a.selectionStart }
    if (a.matches('.hs')) return { selector: '.hs' }
    var role = a.getAttribute('role')
    var scope = role ? '[role="' + role + '"]' : ':not([role])'
    for (var i = 0; i < FOCUS_KEYS.length; i++) {
      var attr = 'data-' + FOCUS_KEYS[i]
      if (a.hasAttribute(attr)) return { selector: scope + '[' + attr + '="' + a.getAttribute(attr).replace(/["\\]/g, '\\$&') + '"]' }
    }
    return null
  }

  function restoreFocus(key) {
    if (!key) return
    if (key.input) {
      var inp = root.querySelector('input[data-q]')
      if (inp) { inp.focus(); inp.setSelectionRange(key.at, key.at) }
      return
    }
    var el = root.querySelector(key.selector)
    if (el) el.focus({ preventScroll: true })
  }

  function render() {
    if (view.pointer || view.composing || view.holding) { view.pending = true; return }
    view.pending = false
    var layout = { page: false }
    var top
    var tabs = ''
    var body
    if (view.settings) {
      top = '<div class="top"><b class="stitle">Settings</b><a class="ib on" data-gear title="Close settings" aria-label="Close settings" tabindex="0">' + icon('x') + '</a></div>'
      body = settingsView()
    } else {
      var lv = data.health && data.sample ? data.health.level : 'ok'
      top = (healthToast() || cleanupToast()) + '<div class="top lv-' + lv + '">' + healthStrip() + stepper() + cleanupButton() + '<a class="ib" data-pause title="' + (view.paused ? 'Resume' : 'Pause') + '" tabindex="0">' + icon(view.paused ? 'play' : 'pause') +
        '</a><a class="ib" data-gear title="Settings" tabindex="0">' + icon('gear') + '</a></div>'
      if (!data.sample) {
        body = '<div class="note">' + esc(view.error || (api ? 'Reading your system…' : 'Open this panel in Orca.')) + '</div>'
      } else {
        var list = sections(layout)
        var keys = ['all', 'procs'].concat(list.map(function (s) { return s[0] }).filter(function (k) { return k !== 'procs' }))
        var current = keys.indexOf(prefs.tab) < 0 ? 'all' : prefs.tab
        tabs = '<div class="tabs" role="tablist">' + keys.map(function (k) {
          var on = k === current
          return '<a data-tab="' + k + '" role="tab" aria-selected="' + on + '" aria-label="' + NAMES[k] + '" data-name="' + NAMES[k] + '" class="' + (on ? 'on' : '') + '" tabindex="0">' + icon(ICONS[k]) + (on ? '<span class="tl">' + NAMES[k] + '</span>' : '') + '</a>'
        }).join('') + '</div>'
        if (current === 'all') { layout.all = true; body = allView(list) }
        else { layout.page = true; body = section(list.filter(function (s) { return s[0] === current })[0]) }
        if (data.sample.note) body = '<div class="nl mut"><span>' + esc(data.sample.note) + '</span></div>' + body
        if (view.error) body = '<div class="nl mut"><span>' + esc(view.error) + '</span></div>' + body
      }
    }
    var oldBody = root.querySelector('.pbody')
    var scrollTop = oldBody ? oldBody.scrollTop : 0
    var oldList = root.querySelector('.pscroll')
    var listTop = oldList ? oldList.scrollTop : 0
    var prevWidths = Array.prototype.map.call(root.querySelectorAll('[data-w]'), function (x) { return x.dataset.w })
    var focus = focusKey()
    root.classList.toggle('paused', view.paused)
    root.classList.toggle('themed', prefs.color === 'theme')
    root.dataset.rows = prefs.rows
    root.classList.toggle('pixel', prefs.graph === 'braille')
    document.body.style.setProperty('--ts', ts())
    var menu = view.settings || !data.sample ? '' : view.heroMenu ? heroMenuView() : view.colMenu ? colMenuView() : menuView()
    root.innerHTML = tabs + '<div class="pbody' + (layout.page ? ' page' : '') + (layout.all ? ' allp' : '') + '">' + body + '</div>' + top + menu
    placeMenu()
    fitFooter()
    root.querySelector('.pbody').scrollTop = scrollTop
    var newList = root.querySelector('.pscroll')
    if (newList) newList.scrollTop = listTop
    restoreFocus(focus)
    var bars = root.querySelectorAll('[data-w]')
    if (prevWidths.length === bars.length) {
      Array.prototype.forEach.call(bars, function (x, i) { x.style.transition = 'none'; x.style.width = prevWidths[i] + '%' })
      void root.offsetWidth
      Array.prototype.forEach.call(bars, function (x) { x.style.transition = ''; x.style.width = x.dataset.w + '%' })
    }
    root.querySelectorAll('.brbar').forEach(fillBar)
    root.querySelectorAll('.brfill').forEach(function (cell) {
      var rows = Math.max(1, Math.floor(cell.clientHeight / 13))
      var cols = Math.max(4, Math.floor(cell.clientWidth / view.glyph))
      var kind = cell.dataset.kind
      cell.innerHTML = Graph.braille(series(cell.dataset.src), cols, rows, function (f) { return tone(kind, f) })
    })
    view.dirty = true
    drawAll(view.paused ? 1 : (performance.now() - data.at) / prefs.rate)
  }

  function spanLabel(sec) {
    if (sec < 90) return 'last ' + Math.round(sec) + 's'
    if (sec < 5400) return 'last ' + Math.round(sec / 60) + ' min'
    return 'last ' + (sec / 3600).toFixed(1).replace(/\.0$/, '') + ' h'
  }

  function ago(sec) {
    if (sec < 90) return '−' + Math.round(sec) + 's'
    if (sec < 5400) return '−' + Math.round(sec / 60) + 'm'
    return '−' + (sec / 3600).toFixed(1).replace(/\.0$/, '') + 'h'
  }

  function liveSpan() { return Math.max(10, Math.min(HISTORY, Math.round(prefs.hist * 1000 / prefs.rate))) }
  function liveSec() { return (liveSpan() - 1) * prefs.rate / 1000 }
  function span() { return data.windowed ? WINDOW_POINTS : liveSpan() }
  function windowSec() { return data.windowed ? prefs.hist : liveSec() }

  function timeRow(sec) {
    if (!prefs.clock) return '<div class="ctime"><span>' + ago(sec) + '</span><span>' + ago(sec / 2) + '</span><span>now</span></div>'
    return '<div class="ctime abs">' + Fmt.clockTicks(sec, Date.now()).map(function (t) {
      var edge = t.frac < EDGE ? ' class="l"' : t.frac > 1 - EDGE ? ' class="r"' : ''
      return '<span' + edge + ' style="left:' + (t.frac * 100).toFixed(2) + '%">' + esc(t.label) + '</span>'
    }).join('') + '</div>'
  }

  function axes(src, labeled, withSpan) {
    if (!labeled) return { top: null }
    var top = '100%'
    var mid = '50%'
    if (src === 'mem' && data.sample) {
      var gb = data.sample.memory.total / 1073741824
      top = Math.round(gb) + 'G'
      mid = Math.round(gb / 2) + 'G'
    } else if (src === 'down' || src === 'up' || src === 'dr' || src === 'dw') {
      var max = 1
      data[src].slice(-span()).forEach(function (v) { if (v > max) max = v })
      top = short(max) + '/s'
      mid = short(max / 2) + '/s'
    }
    return { top: top, mid: mid, span: withSpan ? spanLabel(src === 'bat' ? liveSec() : windowSec()) : null }
  }

  function syncBg() {
    var raw = getComputedStyle(document.body).getPropertyValue('--orca-background').trim()
    if (raw !== palette.bgRaw) {
      palette.bgRaw = raw
      palette.bg = toRgb(raw, '#000000')
      palette.grid = toRgb(getComputedStyle(document.body).getPropertyValue('--orca-border').trim(), '#1f1f1f')
    }
  }

  function drawAll(progress) {
    syncBg()
    root.querySelectorAll('canvas[data-src]').forEach(function (cv) {
      var kind = cv.dataset.kind
      var spark = cv.dataset.xl === '0'
      var live = kind === 'bat' || !data.windowed
      Graph.draw(cv, series(cv.dataset.src), {
        axes: axes(cv.dataset.src, cv.dataset.xl !== '0', !!cv.dataset.big && !cv.dataset.nospan),
        text: palette.secondary,
        bg: palette.bg,
        n: kind === 'bat' ? liveSpan() : span(),
        end: live && kind !== 'bat' ? data.seq : null,
        big: !!cv.dataset.big,
        spark: spark,
        progress: live ? progress : 1,
        heat: prefs.color === 'heat' && kind !== 'bat',
        color: tone(kind, 0),
        line: spark ? 'fill' : prefs.line,
        grid: prefs.grid,
        rule: palette.grid,
        ts: ts()
      })
    })
  }

  function frame() {
    var progress = (performance.now() - data.at) / prefs.rate
    if (!view.paused && !document.hidden && (view.dirty || progress < 1.05)) {
      drawAll(progress)
      view.dirty = progress < 1.05
    }
    requestAnimationFrame(frame)
  }

  function placeMenu() {
    var m = root.querySelector('.menu')
    var at = view.heroMenu || view.colMenu || view.menu
    if (!m || !at) return
    var x = Math.max(4, Math.min(at.x, root.clientWidth - m.offsetWidth - 4))
    var y = at.y
    if (y + m.offsetHeight > root.clientHeight - 4) y = Math.max(4, y - m.offsetHeight - 22)
    m.style.left = x + 'px'
    m.style.top = y + 'px'
  }

  function fail(pid, msg) {
    view.ask = pid
    view.askMsg = msg
    view.stuck = false
    render()
  }

  function quit(pid, force) {
    var proc = (data.procs || []).filter(function (p) { return p.pid === pid })[0]
    view.menu = null
    if (!proc) { view.ask = null; return }
    api.plugin.request('process.quit', { pid: pid, name: proc.name, start: proc.start, force: !!force }, { timeoutMs: 15000 }).then(function (r) {
      if (!r || !r.ok) return fail(pid, (r && r.reason) || 'Could not quit it')
      view.gone[pid] = Date.now()
      if (view.sel === pid) { view.sel = null; view.open = null }
      if (view.ask === pid) { view.ask = null; view.askMsg = ''; view.stuck = false }
      render()
    }, function (e) { fail(pid, (e && e.message) || 'Could not quit it') })
  }

  function writeClipboard(text) {
    function legacy() {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) {}
      ta.remove()
      return ok
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true }, legacy)
    }
    return Promise.resolve(legacy())
  }

  function copy(pid, text) {
    writeClipboard(text).then(function (ok) {
      view.copied = { pid: pid, at: performance.now(), ok: ok }
      render()
      setTimeout(render, COPIED_MS)
    })
  }

  function say(msg) {
    view.hmsg = msg
    view.hmsgAt = Date.now()
    render()
    setTimeout(render, HMSG_MS)
  }

  function explain(p) {
    if (!p) return
    say('Asking your agent about ' + p.name + '…')
    var input = { pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem, user: p.user || null, threads: p.threads, start: p.start }
    api.plugin.request('process.explain', input, { timeoutMs: 15000 }).then(function (r) {
      if (r && r.ok) return say('Sent to ' + r.title)
      var why = (r && r.reason) || 'Could not reach your agent'
      if (r && r.prompt) writeClipboard(r.prompt).then(function (ok) { say(why + (ok ? '; question copied' : '')) })
      else say(why)
    }, function (e) {
      say((e && e.message) || 'Could not reach your agent')
    })
  }

  var rateTimer = null
  function setRate(ms) {
    prefs.rate = clampRate(ms)
    savePrefs()
    var box = root.querySelector('[data-step]')
    if (box && box.parentNode) {
      box.parentNode.querySelector('b').textContent = prefs.rate + 'ms'
      box.parentNode.classList.toggle('fast', prefs.rate < RATE_FAST)
    }
    clearTimeout(rateTimer)
    rateTimer = setTimeout(schedule, 250)
  }

  var critTimer = null
  function setCrit(n) {
    prefs.critAt = clampCrit(n)
    savePrefs()
    var box = root.querySelector('[data-crit]')
    if (box && box.parentNode) box.parentNode.querySelector('b').textContent = prefs.critAt + '%'
    clearTimeout(critTimer)
    critTimer = setTimeout(syncPrefs, 250)
  }

  var stepping = null
  function startNudge(dir, apply) {
    stopStep()
    apply(dir)
    stepping = { delay: setTimeout(function () { stepping.repeat = setInterval(function () { apply(dir) }, 60) }, 400) }
  }
  function startStep(dir) {
    startNudge(dir, function (d) { setRate(prefs.rate + d * RATE_STEP) })
  }
  function stopStep() {
    if (!stepping) return
    clearTimeout(stepping.delay)
    clearInterval(stepping.repeat)
    stepping = null
  }

  var hold = null
  function startHold(el) {
    if (hold) return
    var pid = Number(el.dataset.force)
    el.classList.add('go')
    view.holding = true
    hold = { el: el, timer: setTimeout(function () { hold = null; view.holding = false; quit(pid, true) }, HOLD_MS) }
  }
  function endHold() {
    if (!hold) return
    clearTimeout(hold.timer)
    hold.el.classList.remove('go')
    hold = null
    view.holding = false
    if (view.pending) render()
  }

  function select(pid) {
    view.sel = pid
    if (view.ask !== null && view.ask !== pid && !view.stuck) { view.ask = null; view.askMsg = '' }
    render()
  }

  function openMenu(row, x, y) {
    view.sel = Number(row.dataset.pid)
    view.menu = { pid: view.sel, x: x, y: y }
    view.pointer = false
    render()
    var first = root.querySelector('.menu a')
    if (first) first.focus()
  }
  function closeMenu() {
    if (!view.menu && !view.colMenu && !view.heroMenu) return
    view.menu = null
    view.colMenu = null
    view.heroMenu = null
    render()
  }

  function openColMenu(x, y) {
    view.menu = null
    view.colMenu = { x: x, y: y }
    view.pointer = false
    render()
    var first = root.querySelector('.menu a')
    if (first) first.focus()
  }

  function toggleCol(key) {
    var i = prefs.cols.indexOf(key)
    if (i >= 0) prefs.cols.splice(i, 1)
    else prefs.cols.push(key)
    if (prefs.cols.indexOf(view.sort) < 0) view.sort = 'cpu'
    savePrefs()
  }

  function act(a) {
    var d = a.dataset
    if (d.force) return
    if (d.step) { setRate(prefs.rate + Number(d.step) * RATE_STEP); return }
    if (d.crit) { setCrit(prefs.critAt + Number(d.crit)); return }
    if ('hquit' in d) { quitCulprit(); return }
    if ('cleanup' in d) { cleanupClick(); return }
    if ('cutoastx' in d) { view.cleanupErr = ''; render(); return }
    if ('loadmore' in d) { loadMore(); return }
    if ('htoastx' in d) { view.toastSeen = data.health ? data.health.alertAt : 0; render(); return }
    if (d.togglecol) { toggleCol(d.togglecol); render(); restoreFocus({ selector: '[data-togglecol="' + d.togglecol + '"]' }); return }
    if ('colmenu' in d) {
      if (view.colMenu) { closeMenu(); return }
      var box = root.getBoundingClientRect()
      var r = a.getBoundingClientRect()
      openColMenu(r.right - box.left - 180, r.bottom - box.top + 4)
      return
    }
    var proc = function (pid) { return (data.procs || []).filter(function (p) { return p.pid === Number(pid) })[0] }
    view.menu = null
    view.colMenu = null
    view.heroMenu = null
    if (d.hero) { prefs.hero = d.hero; savePrefs() }
    if ('resetcols' in d) { prefs.cols = Cols.DEFAULT.slice(); savePrefs() }
    if ('gear' in d) { popClose(); view.settings = !view.settings }
    else if (d.setgraph) { prefs.graph = d.setgraph; savePrefs() }
    else if (d.setline) { prefs.line = d.setline; savePrefs() }
    else if (d.setcolor) { prefs.color = d.setcolor; savePrefs() }
    else if (d.setgrid) { prefs.grid = !prefs.grid; savePrefs() }
    else if (d.sethist) { prefs.hist = Number(d.sethist); data.norms = {}; savePrefs() }
    else if (d.setclock) { prefs.clock = d.setclock === 'clock'; savePrefs() }
    else if (d.setrecord) { prefs.record = !prefs.record; savePrefs(); syncPrefs() }
    else if (d.setfocus) { prefs.focus = !prefs.focus; savePrefs(); syncPrefs() }
    else if (d.setagent) { prefs.agent = d.setagent; savePrefs(); syncPrefs() }
    else if (d.setstrip) { prefs.strip = !prefs.strip; savePrefs() }
    else if (d.setalert) { prefs.alert = !prefs.alert; savePrefs() }
    else if (d.setpulse) { prefs.pulse = !prefs.pulse; savePrefs() }
    else if (d.setsort) { prefs.sort = d.setsort; view.sort = d.setsort; view.order = null; savePrefs() }
    else if (d.setopen) { prefs.open = d.setopen; savePrefs() }
    else if (d.setrows) { prefs.rows = d.setrows; savePrefs() }
    else if (d.settext) { prefs.text = d.settext; savePrefs() }
    else if ('resetprefs' in d) { Object.assign(prefs, DEFAULTS); view.sort = prefs.sort; view.order = null; data.norms = {}; savePrefs(); setRate(prefs.rate); syncPrefs() }
    else if (d.tab) {
      popClose()
      var before = wantsProcs()
      prefs.tab = d.tab
      savePrefs()
      var body = root.querySelector('.pbody')
      if (body) body.scrollTop = 0
      if (!before && wantsProcs()) poll()
    }
    else if (d.sort) { if (view.dragged) { view.dragged = false } else { view.sort = d.sort; view.order = null; view.rows = PAGE_ROWS } }
    else if ('quitsel' in d) { if (view.sel !== null) quit(view.sel, false) }
    else if (d.quit) quit(Number(d.quit), false)
    else if (d.copy) copy(Number(d.copy), d.copy)
    else if (d.copyname) { var p = proc(d.copyname); if (p) copy(p.pid, p.name) }
    else if (d.explain) explain(proc(d.explain))
    else if ('no' in d) { view.ask = null; view.askMsg = ''; view.stuck = false }
    else if ('pause' in d) {
      view.paused = !view.paused
      if (!view.paused) poll()
    }
    render()
  }

  root.addEventListener('click', function (ev) {
    var a = ev.target.closest('a')
    if (a && root.contains(a)) {
      if (!a.dataset.step && !a.dataset.crit) act(a)
      return
    }
    var row = ev.target.closest('tr[data-pid]:not(.ask)')
    if (row) {
      view.menu = null
      view.colMenu = null
      var pid = Number(row.dataset.pid)
      clearTimeout(view.unselect)
      if (ev.detail > 1) return
      if (view.sel === pid) view.unselect = setTimeout(function () { view.sel = null; view.open = null; render() }, 280)
      else { if (view.open !== pid) view.open = null; select(pid) }
      return
    }
    if ((view.menu || view.colMenu || view.heroMenu) && !ev.target.closest('.menu')) closeMenu()
  })
  root.addEventListener('dblclick', function (ev) {
    var row = ev.target.closest('tr[data-pid]:not(.ask)')
    if (!row || ev.target.closest('a')) return
    clearTimeout(view.unselect)
    var pid = Number(row.dataset.pid)
    view.sel = pid
    view.open = view.open === pid ? null : pid
    var sel = window.getSelection && window.getSelection()
    if (sel) sel.removeAllRanges()
    render()
    if (view.open !== null) poll()
  })
  root.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && (view.menu || view.colMenu || view.heroMenu)) { ev.preventDefault(); closeMenu(); return }
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    var a = ev.target.closest('a[tabindex]')
    if (!a) return
    ev.preventDefault()
    if (a.dataset.force) { if (!ev.repeat) startHold(a); return }
    act(a)
  })
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && view.sel !== null && !view.menu && !view.colMenu && !view.heroMenu && !ev.target.matches('input, textarea')) {
      view.sel = null
      view.open = null
      render()
      return
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
    if (view.sel === null || view.menu || view.colMenu || ev.target.matches('input, textarea')) return
    var i = (view.order || []).indexOf(view.sel)
    var next = i >= 0 ? view.order[i + (ev.key === 'ArrowDown' ? 1 : -1)] : undefined
    if (next === undefined) return
    ev.preventDefault()
    if (view.open !== null) view.open = next
    select(next)
    var tr = root.querySelector('tr[data-pid="' + next + '"]')
    if (tr) tr.scrollIntoView({ block: 'nearest' })
  })
  root.addEventListener('keyup', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') endHold()
  })
  root.addEventListener('contextmenu', function (ev) {
    var box = root.getBoundingClientRect()
    if (ev.target.closest('.ptab.cols thead')) {
      ev.preventDefault()
      openColMenu(ev.clientX - box.left, ev.clientY - box.top + 2)
      return
    }
    var tl = ev.target.closest('.tile[data-tile]')
    if (tl) {
      ev.preventDefault()
      var tr = tl.getBoundingClientRect()
      view.menu = null
      view.colMenu = null
      view.heroMenu = { key: tl.dataset.tile, x: ev.clientX ? ev.clientX - box.left : tr.left - box.left + 20, y: ev.clientY ? ev.clientY - box.top + 2 : tr.top - box.top + 30 }
      view.pointer = false
      render()
      var first = root.querySelector('.menu a')
      if (first) first.focus()
      return
    }
    var row = ev.target.closest('tr[data-pid]:not(.ask)')
    if (!row) return
    ev.preventDefault()
    var r = row.getBoundingClientRect()
    var x = ev.clientX ? ev.clientX - box.left : r.left - box.left + 40
    var y = ev.clientY ? ev.clientY - box.top + 2 : r.bottom - box.top
    openMenu(row, x, y)
  })
  root.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return
    var hb = ev.target.closest('.hb')
    if (hb) { startHold(hb); return }
    var head = ev.target.closest('.ptab.cols th[data-col]')
    if (head) { view.drag = { key: head.dataset.col, x: ev.clientX, on: false, before: undefined }; return }
    var cr = ev.target.closest('[data-crit]')
    if (cr) { startNudge(Number(cr.dataset.crit), function (d) { setCrit(prefs.critAt + d) }); return }
    var st = ev.target.closest('[data-step]')
    if (st) startStep(Number(st.dataset.step))
  })
  var tip = { pid: null, timer: null, el: null, x: 0, y: 0 }
  function hideTip() {
    clearTimeout(tip.timer)
    tip.pid = null
    if (tip.el) { tip.el.remove(); tip.el = null }
  }
  root.addEventListener('mousemove', function (ev) {
    var a = ev.target.closest('td.pid a')
    var tl = a ? null : ev.target.closest('.tile[data-tile]:not(.big)')
    var tb = a || tl ? null : ev.target.closest('.tabs a:not(.on), .ptools .tool')
    var pid = a ? 'pid:' + a.dataset.copy : tl ? 'tile:' + tl.dataset.tile : tb ? 'btn:' + tb.dataset.name : null
    var text = a ? 'Click to copy' : tl ? 'Right-click to make it the hero' : tb ? tb.dataset.name : ''
    var wait = a ? TIP_MS : tl ? HINT_MS : TAB_TIP_MS
    var anchor = tb ? tb.getBoundingClientRect() : null
    tip.x = ev.clientX
    tip.y = ev.clientY
    if (pid === tip.pid) return
    hideTip()
    if (!pid) return
    tip.pid = pid
    tip.timer = setTimeout(function () {
      tip.el = document.createElement('div')
      tip.el.className = 'tip'
      tip.el.textContent = text
      document.body.appendChild(tip.el)
      var x = anchor ? anchor.left + anchor.width / 2 - tip.el.offsetWidth / 2 : tip.x + 8
      x = Math.min(x, window.innerWidth - tip.el.offsetWidth - 4)
      var y = anchor ? anchor.bottom + 6 : tip.y + 18 + tip.el.offsetHeight > window.innerHeight ? tip.y - tip.el.offsetHeight - 8 : tip.y + 18
      tip.el.style.left = Math.max(4, x) + 'px'
      tip.el.style.top = y + 'px'
    }, wait)
  })
  root.addEventListener('mouseleave', hideTip)
  function loadMore() {
    if (!data.procs || view.rows >= data.procs.length) return
    view.rows += PAGE_ROWS
    render()
  }
  root.addEventListener('scroll', function (ev) {
    var el = ev.target
    if (!el.classList || !el.classList.contains('pscroll')) return
    if (!el.querySelector('[data-loadmore]')) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_AHEAD_PX) loadMore()
  }, true)
  root.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-hquit]')) return
    if (ev.target.closest('.hs[data-cause]')) popToggle()
  })
  root.addEventListener('keydown', function (ev) {
    if (!ev.target.matches('.hs[data-cause]')) return
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); popToggle() }
    if (ev.key === 'Escape') popClose()
    if (ev.key === 'ArrowUp' && pop.el) { var f = pop.el.querySelector('[data-pq]'); if (f) { ev.preventDefault(); f.focus() } }
  })
  var swallowUntil = 0
  document.addEventListener('pointerdown', function (ev) {
    if (!pop.el) return
    if (pop.el.contains(ev.target) || ev.target.closest('.hs[data-cause]')) return
    ev.stopPropagation()
    ev.preventDefault()
    swallowUntil = Date.now() + 1000
    popClose()
  }, true)
  ;['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup'].forEach(function (type) {
    document.addEventListener(type, function (ev) {
      if (Date.now() > swallowUntil) return
      ev.stopPropagation()
      ev.preventDefault()
      if (type === 'click' || type === 'contextmenu') swallowUntil = 0
    }, true)
  })
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && pop.el) popClose() })
  window.addEventListener('resize', function () { popPlace(); fitFooter() })
  root.addEventListener('pointerdown', hideTip)
  root.addEventListener('wheel', hideTip, { passive: true })
  root.addEventListener('pointerout', function (ev) {
    if (hold && !hold.el.contains(ev.relatedTarget)) endHold()
  })
  root.addEventListener('wheel', function () { if (view.menu || view.colMenu || view.heroMenu) closeMenu() }, { passive: true })
  window.addEventListener('blur', function () { view.drag = null; endHold(); stopStep(); closeMenu() })
  root.addEventListener('input', function (ev) {
    if (!ev.target.matches('input[data-q]')) return
    view.query = ev.target.value
    view.rows = PAGE_ROWS
    if (!ev.isComposing) render()
  })
  root.addEventListener('compositionstart', function () { view.composing = true })
  root.addEventListener('compositionend', function (ev) {
    view.composing = false
    view.query = ev.target.value
    view.rows = PAGE_ROWS
    render()
  })
  root.addEventListener('pointerdown', function () { view.pointer = true })
  window.addEventListener('pointermove', function (ev) {
    var g = view.drag
    if (!g) return
    if (!g.on && Math.abs(ev.clientX - g.x) < 6) return
    g.on = true
    var heads = Array.prototype.slice.call(root.querySelectorAll('.ptab.cols th[data-col]'))
    var before = null
    for (var i = 0; i < heads.length; i++) {
      var r = heads[i].getBoundingClientRect()
      if (ev.clientX < r.left + r.width / 2) { before = heads[i].dataset.col; break }
    }
    g.before = before
    heads.forEach(function (h) {
      h.classList.toggle('dragging', h.dataset.col === g.key)
      h.classList.toggle('drop', h.dataset.col === before && before !== g.key)
    })
    var last = heads[heads.length - 1]
    if (last) last.classList.toggle('drop-end', before === null && last.dataset.col !== g.key)
  })
  window.addEventListener('pointerup', function () {
    var g = view.drag
    view.drag = null
    if (g && g.on) {
      view.dragged = true
      setTimeout(function () { view.dragged = false }, 0)
      if (g.before !== g.key) {
        var next = g.before
        if (next === null) {
          var shown = view.fitted.filter(function (k) { return k !== g.key })
          var rest = prefs.cols.filter(function (k) { return k !== g.key })
          var at = shown.length ? rest.indexOf(shown[shown.length - 1]) : -1
          next = at >= 0 && at + 1 < rest.length ? rest[at + 1] : null
        }
        prefs.cols = Cols.move(prefs.cols, g.key, next)
        savePrefs()
      }
      view.pending = true
    }
    endHold()
    stopStep()
    view.pointer = false
    if (view.pending) setTimeout(render, 0)
  })
  window.addEventListener('pointercancel', function () { view.drag = null; endHold(); stopStep(); view.pointer = false })
  root.addEventListener('mouseover', function (ev) {
    var over = !!ev.target.closest('.ptab')
    if (over !== view.hoverList) {
      view.hoverList = over
      if (!over) render()
    }
  })
  root.addEventListener('mouseleave', function () {
    if (view.hoverList) { view.hoverList = false; render() }
  })
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { view.dirty = true; poll() }
  })

  readTheme()
  if (api && api.on) api.on('theme', function () { setTimeout(function () { readTheme(); render() }, 0) })
  if (window.ResizeObserver) {
    var size = ''
    new ResizeObserver(function () {
      var next = root.clientWidth + 'x' + root.clientHeight
      if (next === size) return
      size = next
      render()
    }).observe(root)
  }
  requestAnimationFrame(frame)
  render()
  syncPrefs()
  schedule()
  cleanupRead()
})()
