(function (g) {
  var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function html(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return MAP[c] })
  }
  g.OrchEsc = { html: html }
})(window)
