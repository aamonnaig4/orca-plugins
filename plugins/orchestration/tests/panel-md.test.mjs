import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const MD = (() => {
  const window = {}
  const ctx = vm.createContext({ window })
  for (const f of ['esc.js', 'md.js']) vm.runInContext(readFileSync(new URL('../panel/' + f, import.meta.url), 'utf8'), ctx)
  return window.OrchMd
})()

test('bold that wraps inline code stays bold', () => {
  const html = MD.html('**Cleaned up the merged workspace for PR #4356 (`chore/review-contract-and-gates`, merged 02:12 UTC).**')
  assert.equal(html, '<p><strong>Cleaned up the merged workspace for PR #4356 (<code>chore/review-contract-and-gates</code>, merged 02:12 UTC).</strong></p>')
})

test('the cleanup report from the screenshot renders with no stray markers', () => {
  const src = [
    '**Cleaned up the merged workspace for PR #4356 (`chore/review-contract-and-gates`, merged 02:12 UTC).**',
    '',
    '- I closed its terminal, deleted the worktree (yimby-86) and deleted the local branch.',
    '- I saved it anyway as a git stash: `stash@{0}` "leftover from yimby-86". Drop it with `git stash drop` once you are sure.',
    '- **Heads up:** `fix/mail-ipad-search-oa` is back on disk.'
  ].join('\n')
  const html = MD.html(src)
  assert.ok(!html.includes('**'), html)
  assert.ok(html.includes('<li><strong>Heads up:</strong> <code>fix/mail-ipad-search-oa</code> is back on disk.</li>'))
  assert.ok(html.includes('<code>stash@{0}</code> &quot;leftover from yimby-86&quot;'))
})

test('emphasis variants render and code inside them is left literal', () => {
  assert.equal(MD.inline('__bold__ and _it_ and ***both*** and ~~gone~~'), '<strong>bold</strong> and <em>it</em> and <strong><em>both</em></strong> and <del>gone</del>')
  assert.equal(MD.inline('*see `a*b`*'), '<em>see <code>a*b</code></em>')
  assert.equal(MD.inline('`**not bold**`'), '<code>**not bold**</code>')
  assert.equal(MD.inline('``a ` b``'), '<code>a ` b</code>')
  assert.equal(MD.inline('\\*literal\\* and snake_case_name and 2 * 3'), '*literal* and snake_case_name and 2 * 3')
})

test('links keep code in their label and bare URLs become links', () => {
  assert.equal(MD.inline('[`main`](https://x.y/a)'), '<a href="#" data-act="link" data-url="https://x.y/a"><code>main</code></a>')
  assert.equal(MD.inline('see https://github.com/o/r/pull/12.'), 'see <a href="#" data-act="link" data-url="https://github.com/o/r/pull/12">https://github.com/o/r/pull/12</a>.')
  assert.equal(MD.inline('(<https://a.b/c>)'), '(<a href="#" data-act="link" data-url="https://a.b/c">https://a.b/c</a>)')
  assert.equal(MD.inline('`https://a.b`'), '<code>https://a.b</code>')
})

test('quotes, rules, deep headings and numbered starts render', () => {
  assert.equal(MD.html('> **Note:** careful\n> second'), '<blockquote class="md-quote"><p><strong>Note:</strong> careful<br>second</p></blockquote>')
  assert.equal(MD.html('a\n\n---\n\nb'), '<p>a</p><hr class="md-hr"><p>b</p>')
  assert.equal(MD.html('##### Small'), '<div class="md-h md-h5">Small</div>')
  assert.equal(MD.html('## Fix C#'), '<div class="md-h md-h2">Fix C#</div>')
  assert.equal(MD.html('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>')
})

test('nested lists nest and a loose list stays one list', () => {
  assert.equal(MD.html('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>')
  assert.equal(MD.html('1. one\n   - detail\n2. two'), '<ol><li>one<ul><li>detail</li></ul></li><li>two</li></ol>')
  assert.equal(MD.html('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(MD.html('+ plus'), '<ul><li>plus</li></ul>')
})

test('a paragraph stops at a heading, quote or rule that follows it', () => {
  assert.equal(MD.html('text\n## Head'), '<p>text</p><div class="md-h md-h2">Head</div>')
  assert.equal(MD.html('text\n> q'), '<p>text</p><blockquote class="md-quote"><p>q</p></blockquote>')
})

test('tables keep escaped pipes and inline code in cells', () => {
  const html = MD.html('| cmd | note |\n| --- | --- |\n| `a \\| b` | **ok** |')
  assert.ok(html.includes('<td><code>a | b</code></td><td><strong>ok</strong></td>'), html)
})

test('the new syntax never lets markup through', () => {
  const evil = ['> <img src=x>', '~~<img src=x>~~', '__<img src=x>__', 'https://a.b/"onmouseover="1', '<https://a.b/"x>', '[`<img>`](https://a.b)', '\\<img src=x>', 'a\u0000 0\u0000 b'].join('\n')
  const html = MD.html(evil)
  assert.ok(!html.includes('<img'), html)
  assert.ok(!/data-url="[^"]*"[^>]*on\w+=/.test(html), html)
  assert.ok(!html.includes('\u0000'), html)
})

const WS = [{ key: '/w/yimby-86', name: 'yimby-86', branch: 'fix/mail-ipad-search-oa' }, { key: '/w/root', name: 'rhettworks', branch: 'main' }]
const open = (key, inner) => '<a href="#" class="md-ws" data-act="row" data-action="open" data-key="' + key + '" title="Open ' + (key === '/w/root' ? 'rhettworks' : 'yimby-86') + ' in Orca">' + inner + '</a>'

test('workspace names and branches link to the workspace, in plain text and in code', () => {
  const html = MD.html('- deleted the worktree (yimby-86) and `fix/mail-ipad-search-oa` came back, see rhettworks.', { workspaces: WS })
  assert.equal(html, '<ul><li>deleted the worktree (' + open('/w/yimby-86', 'yimby-86') + ') and ' + open('/w/yimby-86', '<code>fix/mail-ipad-search-oa</code>') + ' came back, see ' + open('/w/root', 'rhettworks') + '.</li></ul>')
})

test('workspace links skip near misses, paths, URLs and bare main', () => {
  const html = MD.inline('yimby-860 x/yimby-86 yimby-86.txt https://a.b/yimby-86 on main', { workspaces: WS })
  assert.ok(!html.includes('md-ws'), html)
  assert.ok(!MD.inline('yimby-86').includes('md-ws'))
})

test('workspace names render as headings, bold and table cells with their links', () => {
  const html = MD.html('**yimby-86 is done**\n\n| ws | state |\n| --- | --- |\n| yimby-86 | merged |', { workspaces: WS })
  assert.ok(html.includes('<strong>' + open('/w/yimby-86', 'yimby-86') + ' is done</strong>'), html)
  assert.ok(html.includes('<td>' + open('/w/yimby-86', 'yimby-86') + '</td>'), html)
})

test('a markdown image waits, then shows once its data arrives, and falls back when it cannot load', () => {
  const images = { data: {}, want: {} }
  const src = '![Before](/tmp/before.png) and ![](https://x.y/a.png)'
  const waiting = MD.html(src, { images })
  assert.equal(waiting, '<p><span class="md-img-wait">Before</span> and <span class="md-img-wait">a.png</span></p>')
  assert.deepEqual(Object.keys(images.want).sort(), ['/tmp/before.png', 'https://x.y/a.png'])
  images.data['/tmp/before.png'] = 'data:image/png;base64,AAAA'
  images.data['https://x.y/a.png'] = false
  images.want = {}
  const shown = MD.html(src, { images })
  assert.equal(shown, '<p><img class="md-img" src="data:image/png;base64,AAAA" alt="Before"> and <a href="#" data-act="link" data-url="https://x.y/a.png">a.png</a></p>')
  assert.deepEqual(images.want, {})
})

test('an image never takes a non-image data URL or a relative or javascript source', () => {
  const images = { data: { '/x.png': 'data:text/html,<script>1</script>' }, want: {} }
  const html = MD.html('![a](/x.png) ![b](javascript:alert(1)) ![c](rel/x.png) ![<img src=x>](/y.png)', { images })
  assert.ok(!html.includes('<img'), html)
  assert.ok(!html.includes('<script'), html)
  assert.ok(html.includes('![b](javascript:alert(1))') && html.includes('![c](rel/x.png)'), html)
})
