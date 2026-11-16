;(function () {
  var W = typeof window !== 'undefined' ? window : globalThis
  var KEY_ATTRS = ['data-key', 'data-id', 'data-card', 'id']

  function list(nodes) {
    return Array.prototype.slice.call(nodes || [])
  }

  function attr(node, name) {
    return node.nodeType === 1 && node.getAttribute ? node.getAttribute(name) : null
  }

  function tag(node) {
    return String(node.nodeName || '').toLowerCase()
  }

  function html(node) {
    return node.nodeType === 1 ? node.outerHTML : '#' + node.nodeType + ':' + node.nodeValue
  }

  function opening(node) {
    var attrs = list(node.attributes).map(function (a) { return a.name + '=' + a.value }).sort()
    return tag(node) + ' ' + attrs.join(' ')
  }

  function keys(nodes) {
    var seen = {}
    return nodes.map(function (n) {
      for (var i = 0; i < KEY_ATTRS.length; i++) {
        var v = attr(n, KEY_ATTRS[i])
        if (v != null && v !== '') return tag(n) + '|' + KEY_ATTRS[i] + '=' + v
      }
      var sig = n.nodeType === 1 ? tag(n) + '.' + String(attr(n, 'class') || '').trim().split(/\s+/).join('.') : '#' + n.nodeType
      seen[sig] = (seen[sig] || 0) + 1
      return sig + '|' + seen[sig]
    })
  }

  function reconcile(live, next, descend) {
    var olds = list(live.childNodes)
    var news = list(next.childNodes)
    var oldKeys = keys(olds)
    var newKeys = keys(news)
    var pool = {}
    olds.forEach(function (n, i) {
      if (!Object.prototype.hasOwnProperty.call(pool, oldKeys[i])) pool[oldKeys[i]] = []
      pool[oldKeys[i]].push(n)
    })
    var plan = news.map(function (n, i) {
      var queue = Object.prototype.hasOwnProperty.call(pool, newKeys[i]) ? pool[newKeys[i]] : null
      var match = queue && queue.length ? queue.shift() : null
      if (!match) return n
      if (html(match) === html(n)) return match
      if (descend && match.nodeType === 1 && descend(match) && opening(match) === opening(n)) {
        reconcile(match, n, descend)
        return match
      }
      live.replaceChild(n, match)
      return n
    })
    Object.keys(pool).forEach(function (k) {
      pool[k].forEach(function (n) { live.removeChild(n) })
    })
    for (var i = 0; i < plan.length; i++) {
      var cur = live.childNodes[i] || null
      if (cur !== plan[i]) live.insertBefore(plan[i], cur)
    }
  }

  W.OrchPatch = { reconcile: reconcile }
})()
