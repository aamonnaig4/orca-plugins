(function (g) {
  var RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
  var BULLET = /^(\s*)[-*+]\s+(.*)$/
  var NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/
  var HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
  var FENCE = /^\s*(`{3,}|~{3,})/
  var HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
  var QUOTE = /^\s{0,3}>\s?(.*)$/
  var HOLD = '\u0000'
  var IMG_SRC = /^(https?:\/\/\S+|file:\/\/\/\S+|~?\/\S+)$/
  var opts = {}

  function wsLink(ws, inner) {
    return '<a href="#" class="md-ws" data-act="row" data-action="open" data-key="' + e(ws.key) + '" title="Open ' + e(ws.label) + ' in Orca">' + inner + '</a>'
  }

  function workspaceFor(text) {
    var list = opts.workspaces
    if (!list) return null
    for (var i = 0; i < list.length; i++) if (list[i].token === text) return list[i]
    return null
  }

  function image(alt, src) {
    var cache = opts.images
    var data = cache && cache.data[src]
    if (typeof data === 'string' && /^data:image\//.test(data)) return '<img class="md-img" src="' + e(data) + '" alt="' + e(alt) + '">'
    if (cache && data !== false) cache.want[src] = true
    var label = e(alt || src.split('/').pop())
    if (data === false) return /^https?:\/\//.test(src) ? '<a href="#" data-act="link" data-url="' + e(src) + '">' + label + '</a>' : '<span class="md-img-miss">' + label + '</span>'
    return '<span class="md-img-wait">' + label + '</span>'
  }

  function e(s) { return g.OrchEsc.html(s) }

  function format(s) {
    s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^\w])__([^\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    s = s.replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^\w])_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>')
    return s
  }

  function inline(text) {
    var held = []
    function hold(html) { held.push(html); return HOLD + (held.length - 1) + HOLD }
    var s = String(text == null ? '' : text).replace(/\u0000/g, '')
    s = s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, function (_, ticks, body) {
      var b = body.replace(/\n/g, ' ')
      if (/^ .* $/.test(b)) b = b.slice(1, -1)
      var ws = workspaceFor(b.trim())
      return hold(ws ? wsLink(ws, '<code>' + e(b) + '</code>') : '<code>' + e(b) + '</code>')
    })
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, function (_, c) { return hold(e(c)) })
    s = s.replace(/!\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, function (all, alt, src) {
      return IMG_SRC.test(src) ? hold(image(alt, src)) : all
    })
    function link(url, label) { return hold('<a href="#" data-act="link" data-url="' + e(url) + '">' + label + '</a>') }
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) { return link(url, format(e(label))) })
    s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, function (_, url) { return link(url, e(url)) })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"'`\u0000]*[^\s<>"'`\u0000.,;:!?)*_])/g, function (_, pre, url) { return pre + link(url, e(url)) })
    var names = opts.pattern
    if (names) s = s.replace(names, function (_, pre, name) { return pre + hold(wsLink(workspaceFor(name), e(name))) })
    s = e(s)
    s = format(s)
    var again = new RegExp(HOLD + '(\\d+)' + HOLD, 'g')
    for (var n = 0; n < 3 && s.indexOf(HOLD) >= 0; n++) s = s.replace(again, function (_, k) { return held[+k] })
    return s
  }

  function cells(line) {
    var t = line.trim()
    if (t.charAt(0) === '|') t = t.slice(1)
    if (t.charAt(t.length - 1) === '|' && t.charAt(t.length - 2) !== '\\') t = t.slice(0, -1)
    return t.split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|') })
  }

  function table(head, rows) {
    var html = '<div class="md-table"><table><thead><tr>'
    for (var i = 0; i < head.length; i++) html += '<th>' + inline(head[i]) + '</th>'
    html += '</tr></thead><tbody>'
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>'
      for (var c = 0; c < head.length; c++) html += '<td>' + inline(rows[r][c] || '') + '</td>'
      html += '</tr>'
    }
    return html + '</tbody></table></div>'
  }

  function width(s) { return s.replace(/\t/g, '    ').length }

  function item(line) {
    var b = BULLET.exec(line)
    if (b && !HR.test(line)) return { indent: width(b[1]), tag: 'ul', text: b[2] }
    var m = NUMBER.exec(line)
    if (m) return { indent: width(m[1]), tag: 'ol', text: m[3], start: +m[2] }
    return null
  }

  function list(lines, start) {
    var first = item(lines[start])
    var base = first.indent
    var tag = first.tag
    var items = []
    var i = start
    while (i < lines.length) {
      var it = item(lines[i])
      if (it && it.indent < base) break
      if (it && it.indent <= base + 1) {
        if (it.tag !== tag) break
        items.push({ text: it.text, sub: '' })
        i++
        continue
      }
      if (it && items.length) {
        var nested = list(lines, i)
        items[items.length - 1].sub += nested.html
        i = nested.next
        continue
      }
      if (items.length && lines[i].trim() !== '' && /^\s+\S/.test(lines[i]) && !FENCE.test(lines[i])) {
        items[items.length - 1].text += '\n' + lines[i].trim()
        i++
        continue
      }
      if (items.length && lines[i].trim() === '' && i + 1 < lines.length) {
        var nx = item(lines[i + 1])
        if (nx && nx.tag === tag && nx.indent <= base + 1) { i++; continue }
        if (nx && nx.indent > base + 1) { i++; continue }
      }
      break
    }
    var open = tag === 'ol' && first.start !== 1 ? '<ol start="' + first.start + '">' : '<' + tag + '>'
    var html = open
    for (var k = 0; k < items.length; k++) html += '<li>' + inline(items[k].text).replace(/\n/g, '<br>') + items[k].sub + '</li>'
    return { html: html + '</' + tag + '>', next: i }
  }

  function startsBlock(lines, i) {
    var line = lines[i]
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || item(line) !== null || isTable(lines, i)
  }

  function isTable(lines, i) {
    return lines[i].indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('-') >= 0 && RULE.test(lines[i + 1])
  }

  function html(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')
    var out = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      if (line.trim() === '') { i++; continue }
      var fence = FENCE.exec(line)
      if (fence) {
        var body = []
        var pad = /^\s*/.exec(line)[0].length
        i++
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { body.push(lines[i].slice(Math.min(pad, /^\s*/.exec(lines[i])[0].length))); i++ }
        i++
        out += '<pre class="md-pre"><code>' + e(body.join('\n')) + '</code></pre>'
        continue
      }
      var h = HEADING.exec(line)
      if (h) {
        out += '<div class="md-h md-h' + h[1].length + '">' + inline(h[2]) + '</div>'
        i++
        continue
      }
      if (HR.test(line)) {
        out += '<hr class="md-hr">'
        i++
        continue
      }
      if (QUOTE.test(line)) {
        var quoted = []
        while (i < lines.length && lines[i].trim() !== '') {
          var q = QUOTE.exec(lines[i])
          if (q) quoted.push(q[1])
          else if (quoted.length && !startsBlock(lines, i)) quoted.push(lines[i])
          else break
          i++
        }
        out += '<blockquote class="md-quote">' + html(quoted.join('\n')) + '</blockquote>'
        continue
      }
      if (isTable(lines, i)) {
        var head = cells(line)
        var rows = []
        i += 2
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim() !== '') { rows.push(cells(lines[i])); i++ }
        out += table(head, rows)
        continue
      }
      if (item(line)) {
        var l = list(lines, i)
        out += l.html
        i = l.next
        continue
      }
      var para = []
      while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !startsBlock(lines, i))) {
        para.push(lines[i].trim())
        i++
      }
      out += '<p>' + para.map(inline).join('<br>') + '</p>'
    }
    return out
  }

  function escapeRe(t) { return t.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&') }

  function prepare(o) {
    o = o || {}
    var list = []
    var seen = {}
    var ws = o.workspaces || []
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i]
      if (!w || !w.key) continue
      var tokens = [w.name, w.branch]
      for (var k = 0; k < tokens.length; k++) {
        var t = tokens[k]
        if (typeof t !== 'string' || t.length < 3 || /^(main|master|trunk|develop|HEAD)$/.test(t) || /\s/.test(t) || seen[t]) continue
        seen[t] = true
        list.push({ token: t, key: w.key, label: w.name || t })
      }
    }
    list.sort(function (a, b) { return b.token.length - a.token.length })
    var pattern = list.length ? new RegExp('(^|[^\\w/.@-])(' + list.map(function (x) { return escapeRe(x.token) }).join('|') + ')(?![\\w/@-]|\\.\\w)', 'g') : null
    return { workspaces: list, pattern: pattern, images: o.images || null }
  }

  function withOpts(fn) {
    return function (text, o) {
      var before = opts
      opts = prepare(o)
      try { return fn(text) } finally { opts = before }
    }
  }

  g.OrchMd = { html: withOpts(html), inline: withOpts(inline) }
})(window)
