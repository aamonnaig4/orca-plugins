import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const V = (() => {
  const window = {}
  const ctx = vm.createContext({ window })
  for (const f of ['esc.js', 'md.js', 'chat.js', 'time.js', 'strip.js']) vm.runInContext(readFileSync(new URL('../panel/' + f, import.meta.url), 'utf8'), ctx)
  return window.OrchViews
})()

const card = { id: 'approval:k', key: 'k', kind: 'approval', title: 'feat/ops-refresh', detail: 'waiting on a prompt', actions: ['allow', 'deny', 'peek'], at: 1, resolved: null }
const vmOf = () => ({ rev: 1, chat: [], rows: [{ key: 'k', name: 'ops', lane: 'needs', column: 'building', card, autoFix: { ci: false, review: false } }], idle: [], gh: { ok: true }, guard: { on: true } })
const pin = (lines) => V.pin(vmOf(), {}, { key: 'k', data: { lines } })

const RULED = [
  '⏺ Cleaning up the failed merge.',
  '',
  '─'.repeat(80),
  ' Bash command (unsandboxed)',
  " Remove the failed merge's leftover untracked files and read the PR's merge state",
  ' ' + '╌'.repeat(78),
  '   │ rm -f tests/lint/test_review_contract.py; rm -rf docs/plans/review-contract-and-gates; rm -f',
  '   │ .claude/plugins/pr-review/references/review-contract.md 2>&1 | tail -1; git status --short; gh pr',
  '   │ view 4550 --json mergeable,mergeStateStatus,headRefOid,isDraft 2>&1 | tail -3',
  ' ' + '╌'.repeat(78),
  ' Ask rule Bash(rm -rf:*) overrides auto mode for this command.',
  ' /permissions to let auto mode decide',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ''
]

test('a pinned approval shows the tool, what it is for, the full command and the rule note', () => {
  const html = pin(RULED)
  assert.ok(html.includes('<div class="pin-tool">Bash command (unsandboxed)</div>'), html)
  assert.ok(html.includes('<div class="pin-desc">Remove the failed merge&#39;s leftover untracked files and read the PR&#39;s merge state</div>'), html)
  assert.ok(html.includes('<pre class="pin-cmd">rm -f tests/lint/test_review_contract.py; rm -rf docs/plans/review-contract-and-gates; rm -f .claude/plugins/pr-review/references/review-contract.md 2&gt;&amp;1 | tail -1; git status --short; gh pr view 4550 --json mergeable,mergeStateStatus,headRefOid,isDraft 2&gt;&amp;1 | tail -3</pre>'), html)
  assert.ok(html.includes('<div class="pin-note">Ask rule Bash(rm -rf:*) overrides auto mode for this command.<br>/permissions to let auto mode decide</div>'), html)
  assert.ok(html.includes('<div class="pin-q">Do you want to proceed?</div>'))
  assert.ok(html.indexOf('pin-tool') < html.indexOf('pin-cmd') && html.indexOf('pin-cmd') < html.indexOf('pin-q') && html.indexOf('pin-q') < html.indexOf('pin-opt'))
  assert.ok(!html.includes('Cleaning up'), html)
})

test('a boxed prompt shows its tool and body without the box edges', () => {
  const html = pin([
    '╭' + '─'.repeat(40) + '╮',
    '│ Tool use                               │',
    '│                                        │',
    '│   Fetch(https://example.com)           │',
    '│   Claude wants to fetch example.com    │',
    '│                                        │',
    '│ Do you want to allow Claude to fetch?  │',
    '│ ❯ 1. Yes                               │',
    '│   2. No (esc)                          │',
    '╰' + '─'.repeat(40) + '╯'
  ])
  assert.ok(html.includes('<div class="pin-tool">Tool use</div>'), html)
  assert.ok(html.includes('<pre class="pin-cmd">Fetch(https://example.com)\nClaude wants to fetch example.com</pre>'), html)
  assert.ok(html.includes('<div class="pin-q">Do you want to allow Claude to fetch?</div>'))
  assert.ok(!html.includes('│'), html)
})

test('without a prompt frame above the question only the question and choices show', () => {
  const html = pin(['some agent output', '│ old 1. stale', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'])
  assert.ok(!html.includes('pin-tool') && !html.includes('pin-cmd') && !html.includes('stale') && !html.includes('agent output'), html)
  assert.ok(html.includes('<div class="pin-q">Do you want to proceed?</div>'))
})

test('prompt text never becomes markup', () => {
  const html = pin(['─'.repeat(30), ' <img src=x onerror=1>', ' ' + '╌'.repeat(20), ' │ <script>x</script>', ' ' + '╌'.repeat(20), ' <b>note</b>', ' Proceed?', ' ❯ 1. Yes', '   2. No'])
  assert.ok(!/<img|<script|<b>note/.test(html), html)
})
