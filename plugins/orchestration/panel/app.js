(function (g) {
  var api = g.orca
  var doc = g.document
  var root = doc.getElementById('app')
  var Esc = g.OrchEsc
  var Views = g.OrchViews || {}
  var POLL_MS = 5000
  var TERMINAL_MS = 1000
  var NOTICE_MS = 5000
  var NUMERIC = { intervalSec: true, attempts: true }
  var SETTING_KEYS = ['orchestratorAgent', 'workerAgent', 'suffix', 'intervalSec', 'attempts', 'guard', 'onCi', 'onConflict', 'onReview', 'noAgent', 'scope', 'model', 'effort', 'fast', 'plan', 'permissionMode']
  var MAX_FILES = 4
  var MAX_FILE_BYTES = 4 * 1024 * 1024
  var BODY = '<main class="body" id="body"></main>'
  var IMAGE_CACHE = 40
  var Images = (g.OrchImages = { data: {}, want: {} })
  var imagePending = {}
  var CLICK_SKIP = { send: true, setting: true }
  var LISTS = ['chat-list', 'strip', 'strip-rows', 'srow', 'srow-x', 'klanes', 'klane', 'kdetail']
  var WIDE_PX = 640

  var state = {
    vm: null,
    agents: null,
    settings: null,
    instructions: null,
    detail: { key: null, tab: 'terminal', data: null },
    ui: { idleOpen: false, stripOpen: false, menu: false, files: [], wide: false, pin: 0, confirmRemove: null, plans: {}, copied: null }
  }
  var notice = ''
  var noticeTimer = null
  var lastHtml = null
  var paint = null
  var vmJson = null
  var readSeq = 0
  var detailSeq = 0
  var stick = true
  var terminalTimer = null
  var failStreak = false
  var copyTimer = null
  var liveTimer = null
  var pinTimer = null
  var pinTerm = { key: null, data: null }
  var pinSeq = 0
  var PIN_MS = 1500
  var LIVE_MS = 1000

  function request(name, input) {
    return Promise.resolve().then(function () { return api.plugin.request(name, input || {}) })
  }

  function loadImages() {
    var want = Images.want
    Images.want = {}
    Object.keys(want).forEach(function (src) {
      if (Images.data[src] !== undefined || imagePending[src]) return
      imagePending[src] = true
      request('image.read', { src: src }).then(function (res) {
        return res && typeof res.data === 'string' && res.data.indexOf('data:image/') === 0 ? res.data : false
      }, function () { return false }).then(function (data) {
        delete imagePending[src]
        var keys = Object.keys(Images.data)
        if (keys.length >= IMAGE_CACHE) delete Images.data[keys[0]]
        Images.data[src] = data
        render()
      })
    })
  }

  function fail(err) {
    notice = (err && err.message) || String(err || 'Something went wrong')
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(function () { notice = ''; render() }, NOTICE_MS)
    render()
  }

  function viewFn(name) {
    return Object.prototype.hasOwnProperty.call(Views, name) && typeof Views[name] === 'function' ? Views[name] : null
  }

  function unavailable() {
    return '<div class="unavailable muted">View unavailable</div>'
  }

  function safe(name, args) {
    var fn = viewFn(name)
    if (!fn) return unavailable()
    try { return String(fn.apply(Views, args)) } catch (err) { return unavailable() }
  }

  function currentView() {
    return 'chat'
  }

  function bodyHtml() {
    return safe('chat', [state.vm, state.ui, { detail: state.detail, agents: state.agents, settings: state.settings, instructions: state.instructions, pinTerm: pinTerm }])
  }

  function all(selector) {
    return root && root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(selector)) : []
  }

  function one(selector) {
    return root && root.querySelector ? root.querySelector(selector) : null
  }

  function snapshot() {
    var fields = all('[data-role]').filter(function (el) { return 'value' in el })
    var active = doc.activeElement
    var list = one('[data-role="chat-list"]')
    var body = one('#body')
    return {
      fields: fields.map(function (el) {
        return { el: el, role: el.dataset.role, key: el.dataset.key || '', value: el.value, active: el === active, start: el.selectionStart, end: el.selectionEnd }
      }),
      list: list,
      listTop: list ? list.scrollTop : null,
      listAtEnd: list ? list.scrollHeight - list.scrollTop - list.clientHeight < 24 : true,
      bodyTop: body ? body.scrollTop : 0
    }
  }

  function restore(snap) {
    var fields = all('[data-role]').filter(function (el) { return 'value' in el })
    snap.fields.forEach(function (f) {
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i]
        if (el.dataset.role === f.role && (el.dataset.key || '') === f.key) {
          if (el === f.el) break
          if (f.value) el.value = f.value
          if (f.active && el.focus) {
            el.focus()
            if (el.setSelectionRange && f.start != null) el.setSelectionRange(f.start, f.end)
          }
          break
        }
      }
    })
    var list = one('[data-role="chat-list"]')
    if (list) {
      if (stick || snap.listAtEnd || snap.listTop == null) list.scrollTop = list.scrollHeight
      else if (list !== snap.list || list.scrollTop !== snap.listTop) list.scrollTop = snap.listTop
    }
    var body = one('#body')
    if (body && snap.bodyTop && body.scrollTop !== snap.bodyTop) body.scrollTop = snap.bodyTop
  }

  function syncTerminalTimer() {
    var want = !!(state.detail.key && state.detail.tab === 'terminal')
    if (want && terminalTimer == null) {
      terminalTimer = setInterval(function () {
        if (visible() && state.detail.key && state.detail.tab === 'terminal') fetchDetail(true)
      }, TERMINAL_MS)
    } else if (!want && terminalTimer != null) {
      clearInterval(terminalTimer)
      terminalTimer = null
    }
  }

  function nodes(list) {
    return Array.prototype.slice.call(list || [])
  }

  function parse(html) {
    var t = doc.createElement('template')
    t.innerHTML = html
    return t.content || t
  }

  function swap(old, html, before) {
    var fresh = nodes(parse(html).childNodes)
    var anchor = old.length ? old[0] : before
    fresh.forEach(function (n) { root.insertBefore(n, anchor) })
    old.forEach(function (n) { root.removeChild(n) })
    return fresh
  }

  function descend(node) {
    var cls = ' ' + String((node.getAttribute && node.getAttribute('class')) || '') + ' '
    for (var i = 0; i < LISTS.length; i++) if (cls.indexOf(' ' + LISTS[i] + ' ') >= 0) return true
    return false
  }

  function firstPaint(head, foot) {
    root.innerHTML = head + BODY + foot
    lastHtml = null
    var kids = nodes(root.childNodes)
    var body = one('#body')
    var at = kids.indexOf(body)
    paint = { head: kids.slice(0, at), body: body, foot: kids.slice(at + 1), headHtml: head, footHtml: foot, inner: null }
  }

  function patchBody(inner) {
    var Patch = g.OrchPatch
    if (paint.inner === null || !Patch || typeof Patch.reconcile !== 'function') paint.body.innerHTML = inner
    else Patch.reconcile(paint.body, parse(inner), descend)
    paint.inner = inner
  }

  function tickLive() {
    var fn = viewFn('elapsed')
    if (!fn) return
    all('[data-since]').forEach(function (el) {
      var text = fn(Number(el.dataset.since), Date.now())
      if (text && el.textContent !== text) el.textContent = text
    })
  }

  function pinKey() {
    var fn = viewFn('pinned')
    var card = null
    try { card = fn && state.vm ? fn(state.vm, state.ui) : null } catch (err) { card = null }
    return card && card.kind === 'approval' ? card.key : null
  }

  function fetchPin() {
    var key = pinTerm.key
    if (!key) return Promise.resolve()
    var seq = ++pinSeq
    return request('row.detail', { key: key, tab: 'terminal' }).then(function (data) {
      if (seq !== pinSeq || pinTerm.key !== key) return
      pinTerm = { key: key, data: data || null }
      render()
    }, function () {})
  }

  function syncPinTimer() {
    var key = pinKey()
    if (key !== pinTerm.key) {
      pinTerm = { key: key, data: null }
      if (key) fetchPin()
    }
    if (key && pinTimer == null) pinTimer = setInterval(function () { if (visible()) fetchPin() }, PIN_MS)
    else if (!key && pinTimer != null) {
      clearInterval(pinTimer)
      pinTimer = null
    }
  }

  function syncLiveTimer() {
    var want = !!(state.vm && state.vm.orch && state.vm.orch.state === 'working')
    if (want && liveTimer == null) liveTimer = setInterval(function () { if (visible()) tickLive() }, LIVE_MS)
    else if (!want && liveTimer != null) {
      clearInterval(liveTimer)
      liveTimer = null
    }
  }

  function render() {
    syncTerminalTimer()
    syncLiveTimer()
    syncPinTimer()
    if (!root) return
    if (!state.vm) {
      var loading = '<div class="unavailable muted">Loading…</div>'
      if (lastHtml !== loading) { root.innerHTML = loading; lastHtml = loading; paint = null }
      return
    }
    var view = currentView()
    var chrome = viewFn('chrome')
    var frame
    try { frame = chrome ? String(chrome(state.vm, view)) : BODY } catch (err) { frame = BODY }
    var at = frame.indexOf(BODY)
    if (at < 0) { frame = BODY; at = 0 }
    var head = frame.slice(0, at)
    var foot = frame.slice(at + BODY.length)
    var inner = (notice ? '<div class="notice">' + Esc.html(notice) + '</div>' : '') + bodyHtml(view)
    loadImages()
    if (paint && paint.headHtml === head && paint.footHtml === foot && paint.inner === inner) return
    var snap = snapshot()
    if (!paint) firstPaint(head, foot)
    if (head !== paint.headHtml) { paint.head = swap(paint.head, head, paint.body); paint.headHtml = head }
    if (foot !== paint.footHtml) { paint.foot = swap(paint.foot, foot, null); paint.footHtml = foot }
    if (inner === paint.inner) return
    patchBody(inner)
    restore(snap)
    stick = false
  }

  function refresh() {
    var seq = ++readSeq
    return request('view.read').then(function (vm) {
      if (seq !== readSeq || !vm) return
      var json = JSON.stringify(vm)
      var same = json === vmJson
      vmJson = json
      state.vm = vm
      if (vm.firstRun && !state.agents) loadAgents()
      if (!same) render()
    }, fail)
  }

  function loadAgents() {
    return request('agents.list').then(function (list) {
      state.agents = Array.isArray(list) ? list : []
      render()
    }, fail)
  }

  function acceptSettings(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return
    for (var i = 0; i < SETTING_KEYS.length; i++) if (!(SETTING_KEYS[i] in s)) return
    state.settings = s
  }

  function loadSettings() {
    return request('settings.save', {}).then(function (s) {
      acceptSettings(s)
      render()
    }, function () {})
  }

  function fetchDetail(fromTimer) {
    var key = state.detail.key
    var tab = state.detail.tab
    if (!key) return Promise.resolve()
    var seq = ++detailSeq
    return request('row.detail', { key: key, tab: tab }).then(function (data) {
      if (seq !== detailSeq || state.detail.key !== key || state.detail.tab !== tab) return
      failStreak = false
      state.detail.data = data || null
      render()
    }, function (err) {
      if (fromTimer && failStreak) return
      failStreak = true
      fail(err)
    })
  }

  function closeDetail() {
    state.detail = { key: null, tab: 'terminal', data: null }
    state.ui.confirmRemove = null
  }

  function openDetail(key) {
    if (state.detail.key === key) {
      closeDetail()
      render()
      return Promise.resolve()
    }
    state.detail = { key: key, tab: 'terminal', data: null }
    state.ui.stripOpen = true
    state.ui.menu = false
    state.ui.confirmRemove = null
    render()
    return fetchDetail()
  }

  function openMenu(name) {
    state.ui.menu = name
    render()
    if (!name) return
    if (String(name).indexOf('chip') === 0 && !state.agents) loadAgents()
    loadSettings()
  }

  function toggleMenu() {
    openMenu(String(state.ui.menu).indexOf('chip') === 0 || state.ui.menu === true ? false : 'chip')
  }

  function loadInstructions() {
    state.instructions = null
    return request('instructions.read').then(function (res) {
      state.instructions = res && Array.isArray(res.files) ? res : { started: false, files: [] }
      render()
    }, fail)
  }

  function goMenu(name) {
    if (name === 'chip:instructions') loadInstructions()
    var inChip = String(name).indexOf('chip') === 0 && String(state.ui.menu).indexOf('chip') === 0
    if (state.ui.menu === name && !inChip) return openMenu(false)
    if (inChip) {
      state.ui.menu = name
      return render()
    }
    openMenu(name)
  }

  function save(patch, next) {
    return request('settings.save', patch).then(function (s) {
      acceptSettings(s)
      if (next !== undefined) state.ui.menu = next
      render()
      return refresh()
    }, fail)
  }

  function setValue(d) {
    var patch = {}
    patch[d.name] = d.value
    var page = String(state.ui.menu)
    return save(patch, page.indexOf('chip:') === 0 ? 'chip' : undefined)
  }

  function toggleValue(name) {
    var patch = {}
    patch[name] = !(state.settings && state.settings[name])
    return save(patch, false)
  }

  function inputBox() {
    return doc.querySelector ? doc.querySelector('[data-role="chat-input"]') : null
  }

  function newWorker() {
    state.ui.menu = false
    render()
    var box = inputBox()
    if (!box) return
    var lead = 'Start a new worker to '
    if (String(box.value).indexOf(lead) !== 0) box.value = lead + String(box.value || '')
    if (box.focus) box.focus()
    if (box.setSelectionRange) box.setSelectionRange(box.value.length, box.value.length)
  }

  function pickFiles() {
    state.ui.menu = false
    render()
    var input = doc.querySelector ? doc.querySelector('[data-role="attach-input"]') : null
    if (input && input.click) input.click()
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new g.FileReader()
      r.onload = function () { resolve(String(r.result || '')) }
      r.onerror = function () { reject(new Error('Could not read ' + file.name)) }
      r.readAsDataURL(file)
    })
  }

  function addFiles(input) {
    var list = Array.prototype.slice.call(input.files || [])
    input.value = ''
    var room = MAX_FILES - state.ui.files.length
    if (list.length > room) fail(new Error('Attach up to ' + MAX_FILES + ' files'))
    list = list.slice(0, Math.max(0, room))
    var big = list.filter(function (f) { return f.size > MAX_FILE_BYTES })
    if (big.length) fail(new Error(big[0].name + ' is over 4 MB'))
    list = list.filter(function (f) { return f.size <= MAX_FILE_BYTES })
    return Promise.all(list.map(function (f) {
      return readFile(f).then(function (data) { return { name: f.name, data: data } })
    })).then(function (files) {
      state.ui.files = state.ui.files.concat(files).slice(0, MAX_FILES)
      render()
    }, fail)
  }

  function after(promise) {
    return promise.then(function (res) {
      state.ui.confirmRemove = null
      return refresh().then(function () { return res })
    }, fail)
  }

  function bool(v) { return v === 'true' || v === true }

  function openExternal(url) {
    if (!url) return Promise.resolve()
    if (api.shell && api.shell.openExternal) return Promise.resolve(api.shell.openExternal(url))
    return Promise.resolve(api.host.call('shell.openExternal', { url: url }))
  }

  function copyLegacy(text) {
    var box = doc.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.opacity = '0'
    doc.body.appendChild(box)
    box.select()
    var ok = false
    try { ok = doc.execCommand('copy') } catch (err) { ok = false }
    doc.body.removeChild(box)
    return ok ? Promise.resolve() : Promise.reject(new Error('Could not copy the message'))
  }

  function copyText(text) {
    var nav = g.navigator
    if (!nav || !nav.clipboard || !nav.clipboard.writeText) return copyLegacy(text)
    var wrote
    try { wrote = nav.clipboard.writeText(text) } catch (err) { return copyLegacy(text) }
    return Promise.resolve(wrote).then(null, function () { return copyLegacy(text) })
  }

  function copyItem(id) {
    var chat = (state.vm && state.vm.chat) || []
    var hit = null
    for (var i = 0; i < chat.length; i++) if (chat[i].id === id) hit = chat[i]
    if (!hit) return Promise.resolve()
    return copyText(String(hit.text || '')).then(function () {
      state.ui.copied = id
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(function () { state.ui.copied = null; render() }, 1500)
      render()
    }, function () { fail(new Error('Could not copy the message')) })
  }

  function send(text, files) {
    text = String(text || '').trim()
    files = files || []
    if (!text && !files.length) return Promise.resolve()
    stick = true
    if (!files.length) return after(request('chat.send', { text: text }))
    var paths = []
    var chain = Promise.resolve()
    files.forEach(function (f) {
      chain = chain.then(function () {
        return request('chat.attach', { name: f.name, data: f.data }).then(function (res) { paths.push(res.path) })
      })
    })
    return after(chain.then(function () {
      var input = { files: paths }
      if (text) input.text = text
      return request('chat.send', input)
    }))
  }

  function onSubmit(form) {
    var box = form.querySelector ? form.querySelector('[data-role="chat-input"]') : null
    var text = box ? box.value : ''
    var files = state.ui.files
    if (!String(text).trim() && !files.length) return
    if (box) box.value = ''
    state.ui.files = []
    if (files.length) render()
    send(text, files)
  }

  function act(el, ev) {
    var d = el.dataset
    switch (d.act) {
      case 'open-detail': return openDetail(d.key)
      case 'back':
        closeDetail()
        return render()
      case 'agent-menu': return toggleMenu()
      case 'menu-go': return goMenu(d.menu)
      case 'set': return setValue(d)
      case 'toggle': return toggleValue(d.name)
      case 'perm': return save({ permissionMode: d.value }, false)
      case 'attach': return pickFiles()
      case 'unattach':
        state.ui.files.splice(Number(d.i), 1)
        return render()
      case 'new-worker': return newWorker()
      case 'pin-step':
        state.ui.pin += Number(d.step) < 0 ? -1 : 1
        return render()
      case 'strip-toggle':
        state.ui.stripOpen = !state.ui.stripOpen
        if (!state.ui.stripOpen) closeDetail()
        return render()
      case 'board-open':
        return request('board.url').then(function (res) { return openExternal(res && res.url) }).then(null, fail)
      case 'starter': return send(d.text)
      case 'answer': return after(request('chat.answer', { id: d.id, option: d.option }))
      case 'pick-agent': return after(request('firstrun.save', { agent: d.agent }))
      case 'card':
        return request('card.act', { id: d.id, action: d.action }).then(function (res) {
          return refresh().then(function () {
            if (res && res.open && state.detail.key !== res.open) return openDetail(res.open)
          })
        }, fail)
      case 'plan-toggle':
        state.ui.plans[d.id] = bool(d.open)
        return render()
      case 'copy': return copyItem(d.id)
      case 'link':
        return /^https?:\/\//i.test(d.url || '') ? openExternal(d.url).then(null, fail) : undefined
      case 'idle-toggle':
        if (!state.ui.stripOpen) {
          state.ui.stripOpen = true
          state.ui.idleOpen = true
        } else state.ui.idleOpen = !state.ui.idleOpen
        return render()
      case 'remove-ask':
        state.ui.confirmRemove = d.key
        return render()
      case 'remove-cancel':
        state.ui.confirmRemove = null
        return render()
      case 'idle-clear':
        return request('idle.clear', { confirmed: true }).then(function () {
          state.ui.confirmRemove = null
          return refresh()
        }, function (err) {
          state.ui.confirmRemove = null
          fail(err)
          return refresh()
        })
      case 'row': return rowAct(el, d)
      case 'peek-key':
        return request('peek.key', { key: d.key, name: d.name }).then(function () { return Promise.all([fetchDetail(), fetchPin()]) }, fail)
      case 'pr-open':
        return request('pr.url', { key: d.key }).then(function (res) { return openExternal(res && res.url) }, fail)
      default:
        return undefined
    }
  }

  function rowAct(el, d) {
    var input = { key: d.key, action: d.action }
    if (d.on != null) input.on = bool(d.on)
    if (d.confirmed != null) input.confirmed = bool(d.confirmed)
    return after(request('row.act', input))
  }

  function target(ev, attr) {
    var t = ev && ev.target
    return t && t.closest ? t.closest(attr || '[data-act]') : null
  }

  function onClick(ev) {
    var el = target(ev)
    if (state.ui.menu && !target(ev, '[data-role="agent-menu"]') && !(el && el.dataset && (el.dataset.act === 'agent-menu' || el.dataset.act === 'menu-go'))) {
      state.ui.menu = false
      render()
    }
    if (!el || !el.dataset || Object.prototype.hasOwnProperty.call(CLICK_SKIP, el.dataset.act)) return
    if (ev.preventDefault && el.dataset.act !== 'pr-open') ev.preventDefault()
    act(el, ev)
  }

  function onChange(ev) {
    var t = ev && ev.target
    if (t && t.dataset && t.dataset.role === 'attach-input') return addFiles(t)
    var el = target(ev)
    if (!el || !el.dataset || el.dataset.act !== 'setting') return
    var name = el.dataset.name
    var value
    if (el.type === 'checkbox') value = !!el.checked
    else if (Object.prototype.hasOwnProperty.call(NUMERIC, name)) value = Number(el.value)
    else if (el.value === 'true' || el.value === 'false') value = el.value === 'true'
    else value = el.value
    var patch = {}
    patch[name] = value
    request('settings.save', patch).then(function (s) {
      acceptSettings(s)
      render()
      return refresh()
    }, fail)
  }

  function onSubmitEvent(ev) {
    var form = target(ev, 'form[data-act="send"]') || target(ev)
    if (!form || !form.dataset || form.dataset.act !== 'send') return
    if (ev.preventDefault) ev.preventDefault()
    onSubmit(form)
  }

  function onKeydown(ev) {
    var t = ev.target
    if (!t || !t.dataset || t.dataset.role !== 'chat-input') return
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    if (ev.preventDefault) ev.preventDefault()
    var form = t.closest ? t.closest('form') : null
    if (form) onSubmit(form)
  }

  function onScroll(ev) {
    var t = ev.target
    if (t && t.dataset && t.dataset.role === 'chat-list') {
      stick = t.scrollHeight - t.scrollTop - t.clientHeight < 24
    }
  }

  function paintTheme() {
    var el = doc.documentElement
    if (!el || !el.classList || !g.getComputedStyle) return
    if (el.classList.contains('light') || el.classList.contains('dark')) return
    var bg = g.getComputedStyle(doc.body).getPropertyValue('--orca-background').trim()
    var m = /^#([0-9a-f]{6})$/i.exec(bg)
    var rgb = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(bg)
    var lum = 0
    if (m) { var n = parseInt(m[1], 16); lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 }
    else if (rgb) lum = (0.2126 * rgb[1] + 0.7152 * rgb[2] + 0.0722 * rgb[3]) / 255
    else lum = g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches ? 0 : 1
    el.classList.add(lum > 0.5 ? 'light' : 'dark')
  }

  function visible() { return doc.visibilityState !== 'hidden' }

  function measure() {
    var el = doc.documentElement
    var width = (root && root.clientWidth) || (el && el.clientWidth) || 0
    var wide = width >= WIDE_PX
    if (wide === state.ui.wide) return
    state.ui.wide = wide
    render()
  }

  doc.addEventListener('click', onClick)
  if (g.addEventListener) g.addEventListener('resize', measure)
  if (g.ResizeObserver && root) new g.ResizeObserver(measure).observe(root)
  doc.addEventListener('change', onChange)
  doc.addEventListener('submit', onSubmitEvent)
  doc.addEventListener('keydown', onKeydown)
  if (doc.addEventListener) doc.addEventListener('scroll', onScroll, true)
  if (api.plugin && api.plugin.on) api.plugin.on('view', function () { refresh() })
  if (api.on) api.on('theme', function () { setTimeout(function () { paintTheme() }, 0) })
  setInterval(function () { if (visible()) refresh() }, POLL_MS)
  paintTheme()
  measure()
  render()
  refresh()
  loadSettings()
  g.OrchApp = { state: state, refresh: refresh, measure: measure }
})(window)
