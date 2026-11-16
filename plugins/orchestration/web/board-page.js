(function (g) {
  var doc = g.document
  var POLL_MS = 3000
  var slot = doc.getElementById('board')
  var state = doc.getElementById('state')
  var ui = { idleOpen: false, readonly: true }
  var data = null
  var last = ''

  function paintTheme() {
    var dark = !g.matchMedia || g.matchMedia('(prefers-color-scheme: dark)').matches
    doc.documentElement.className = dark ? 'dark' : 'light'
  }

  function render() {
    if (!data) return
    ui.now = Date.now()
    var html = g.OrchViews.board(data, ui)
    if (html === last) return
    last = html
    slot.innerHTML = html
  }

  function say(text, bad) {
    state.textContent = text
    state.className = 'web-state' + (bad ? ' bad' : '')
  }

  function load() {
    return g.fetch('view.json', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('bad status')
      return res.json()
    }).then(function (next) {
      data = { rows: Array.isArray(next.rows) ? next.rows : [], idle: Array.isArray(next.idle) ? next.idle : [] }
      say('Live · read only', false)
      render()
    }, function () {
      say('Lost the connection to Orca · retrying', true)
    })
  }

  doc.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act="idle-toggle"]') : null
    if (!el) return
    ui.idleOpen = !ui.idleOpen
    render()
  })
  if (g.matchMedia) g.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTheme)
  paintTheme()
  load()
  setInterval(function () { if (doc.visibilityState !== 'hidden') load() }, POLL_MS)
})(window)
