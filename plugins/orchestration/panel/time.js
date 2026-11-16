(function (g) {
  function rel(at, now) {
    if (typeof at !== 'number' || !(at > 0)) return ''
    var sec = Math.max(0, Math.floor((now - at) / 1000))
    if (sec < 60) return 'now'
    var min = Math.floor(sec / 60)
    if (min < 60) return min + 'm ago'
    var hr = Math.floor(min / 60)
    if (hr < 24) return hr + 'h ago'
    return Math.floor(hr / 24) + 'd ago'
  }

  g.OrchTime = { rel: rel }
})(window)
