import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { doingText, describeTool, approvalCard, reconcile, isPermissionPrompt, answerApproval, PEEK_KEYS } from '../src/needs.ts'

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))
const promptScreen = fixture('terminal-read-prompt.json')
const deniedScreen = fixture('terminal-read-denied.json')

function bashScreen(command) {
  const tail = promptScreen.result.terminal.tail.map((line) => {
    if (line.includes('Fetch(')) return '│   Bash(' + command + ')'
    if (line.includes('wants to fetch')) return '│   Run shell command'
    return line
  })
  return { result: { terminal: { ...promptScreen.result.terminal, tail } } }
}
const pnpmScreen = bashScreen('pnpm install')

function session(kind, terminalId) {
  return {
    key: '/w/a',
    ids: ['a'],
    path: '/w/a',
    name: 'a',
    project: 'p',
    repoId: 'r',
    repo: null,
    branch: null,
    isMain: false,
    agent: { state: 'blocked', terminalId, sessionId: null, chatId: null, kind, since: 0, permissionMasked: false },
    dispatchId: null,
    started: 'you'
  }
}

function fakeCli(screens, readError) {
  const calls = []
  let reads = 0
  return {
    calls,
    cli: {
      has: () => true,
      load: async () => {},
      json: async (args) => {
        calls.push(args)
        if (args[1] === 'read') {
          if (readError && reads >= readError.after) throw new Error('read failed')
          const screen = screens[Math.min(reads, screens.length - 1)]
          reads++
          return screen.result
        }
        return {}
      }
    }
  }
}

test('describeTool shows shell commands, other tools, and missing calls', () => {
  const now = Date.now()
  assert.equal(describeTool({ tool: 'Bash', input: { command: 'pnpm install' }, at: now }), 'wants to run: pnpm install')
  assert.equal(describeTool({ tool: 'Edit', input: { file_path: 'x' }, at: now }), 'wants to use: Edit')
  assert.equal(describeTool(undefined), 'waiting on a prompt')
  assert.equal(describeTool({ tool: 'Bash', input: { command: 'ls' }, at: now - 121000 }), 'waiting on a prompt')
  const long = describeTool({ tool: 'Bash', input: { command: 'x'.repeat(300) }, at: now })
  assert.equal(long, 'wants to run: ' + 'x'.repeat(120))
})

test('approvalCard offers Allow and Deny only for Claude in a terminal', () => {
  const call = { tool: 'Bash', input: { command: 'ls' }, at: 1000 }
  const card = approvalCard(session('claude', 't1'), call, 1000)
  assert.deepEqual(card.actions, ['allow', 'deny', 'peek'])
  assert.equal(card.id, 'approval:/w/a')
  assert.equal(card.kind, 'approval')
  assert.equal(card.resolved, null)
  assert.deepEqual(approvalCard(session('codex', 't1'), undefined, 1).actions, ['peek'])
  assert.deepEqual(approvalCard(session('claude', null), undefined, 1).actions, ['peek'])
})

test('reconcile adds once, keeps the first at, then closes', () => {
  const s = session('claude', 't1')
  const first = approvalCard(s, undefined, 100)
  const t1 = reconcile([], [first], 100)
  assert.equal(t1.added.length, 1)
  assert.equal(t1.open.length, 1)
  const again = approvalCard(s, undefined, 200)
  const t2 = reconcile(t1.open, [again], 200)
  assert.equal(t2.added.length, 0)
  assert.equal(t2.closed.length, 0)
  assert.equal(t2.open[0].at, 100)
  const t3 = reconcile(t2.open, [], 300)
  assert.equal(t3.open.length, 0)
  assert.equal(t3.closed.length, 1)
  assert.equal(t3.closed[0].resolved, 'cleared')
  assert.equal(t3.closed[0].at, 100)
})

test('isPermissionPrompt matches the prompt screen and not the denied screen', () => {
  assert.equal(isPermissionPrompt(promptScreen.result.terminal.tail), true)
  assert.equal(isPermissionPrompt(deniedScreen.result.terminal.tail), false)
  assert.equal(isPermissionPrompt([]), false)
})

function answerOpts(extra) {
  const screens = extra.screens ?? [promptScreen, extra.screen ?? deniedScreen]
  const { cli, calls } = fakeCli(screens, extra.readError)
  const waits = []
  let masks = 0
  let polls = 0
  const states = extra.states ?? ['blocked']
  return {
    calls,
    waits,
    masks: () => masks,
    polls: () => polls,
    opts: {
      cli,
      session: extra.session ?? session('claude', 't1'),
      choice: extra.choice,
      stateOf: () => {
        const s = states[Math.min(polls, states.length - 1)]
        polls++
        return s
      },
      wait: async (ms) => {
        waits.push(ms)
      },
      mask: async () => {
        masks++
      },
      ...(extra.expect === undefined ? {} : { expect: extra.expect })
    }
  }
}

test('allow sends 1 without Enter and answers when the state leaves blocked', async () => {
  const h = answerOpts({ choice: 'allow', expect: 'pnpm install', screens: [pnpmScreen], states: ['blocked', 'blocked', 'blocked', 'working'] })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.deepEqual(h.calls[0], ['terminal', 'read', '--screen', '--terminal', 't1'])
  assert.deepEqual(h.calls[1], ['terminal', 'send', '--terminal', 't1', '--text=1'])
  assert.equal(h.calls.length, 2)
  assert.equal(h.waits.length, 2)
})

test('nothing is sent when the state leaves blocked during the screen read', async () => {
  for (const choice of ['allow', 'deny']) {
    const h = answerOpts({ choice, expect: 'pnpm install', screens: [pnpmScreen], states: ['blocked', 'working'] })
    assert.equal(await answerApproval(h.opts), 'use-peek')
    assert.equal(sends(h).length, 0)
    assert.equal(h.masks(), 0)
  }
})

test('allow falls back to Peek after 3000 ms still blocked', async () => {
  const h = answerOpts({ choice: 'allow', expect: 'pnpm install', screens: [pnpmScreen], states: ['blocked'] })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.calls.filter((c) => c[1] === 'send').length, 1)
  assert.equal(
    h.waits.reduce((a, b) => a + b, 0),
    3000
  )
  assert.ok(h.waits.every((w) => w === 250))
})

test('allow sends nothing when the effective state starts as waiting', async () => {
  const h = answerOpts({ choice: 'allow', expect: 'pnpm install', screens: [pnpmScreen], states: ['waiting'] })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.calls.length, 0)
})

test('nothing is sent for a session without a terminal', async () => {
  const h = answerOpts({ choice: 'deny', session: session('claude', null) })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.calls.length, 0)
})

test('deny sends Escape, skips the state check, and masks on the denied screen', async () => {
  const h = answerOpts({ choice: 'deny', screen: deniedScreen })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.deepEqual(h.calls[0], ['terminal', 'read', '--screen', '--terminal', 't1'])
  assert.deepEqual(h.calls[1], ['terminal', 'send', '--terminal', 't1', '--text=\u001b'])
  assert.ok(!h.calls[1].includes('--enter'))
  assert.deepEqual(h.calls[2], ['terminal', 'read', '--screen', '--terminal', 't1'])
  assert.equal(h.polls(), 2)
  assert.equal(h.masks(), 1)
  assert.deepEqual(h.waits, [1000])
})

test('deny with the prompt still on screen does not mask and uses Peek', async () => {
  const h = answerOpts({ choice: 'deny', screen: promptScreen })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.masks(), 0)
})

const emptyTail = { result: { terminal: { tail: [] } } }
const missingTail = { result: { terminal: {} } }
const sends = (h) => h.calls.filter((c) => c[1] === 'send')

test('deny with an empty screen read does not mask and uses Peek', async () => {
  const h = answerOpts({ choice: 'deny', screens: [promptScreen, emptyTail] })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.masks(), 0)
})

test('deny with a screen read missing its tail does not mask and uses Peek', async () => {
  const h = answerOpts({ choice: 'deny', screens: [promptScreen, missingTail] })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.masks(), 0)
})

test('deny whose after-read throws does not mask and uses Peek', async () => {
  const h = answerOpts({ choice: 'deny', screens: [promptScreen], readError: { after: 1 } })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(h.masks(), 0)
})

test('nothing is sent when the pre-read throws', async () => {
  const h = answerOpts({ choice: 'deny', screens: [promptScreen], readError: { after: 0 } })
  assert.equal(await answerApproval(h.opts), 'use-peek')
  assert.equal(sends(h).length, 0)
  assert.equal(h.masks(), 0)
})

test('nothing is sent for a non-Claude agent', async () => {
  for (const choice of ['allow', 'deny']) {
    const h = answerOpts({ choice, expect: 'pnpm install', session: session('codex', 't1'), screens: [pnpmScreen] })
    assert.equal(await answerApproval(h.opts), 'use-peek')
    assert.equal(sends(h).length, 0)
    assert.equal(h.masks(), 0)
  }
})

test('nothing is sent when the blocked screen is not a permission prompt', async () => {
  for (const choice of ['allow', 'deny']) {
    const h = answerOpts({ choice, expect: 'pnpm install', screens: [deniedScreen] })
    assert.equal(await answerApproval(h.opts), 'use-peek')
    assert.equal(sends(h).length, 0)
    assert.equal(h.masks(), 0)
  }
})

test('reconcile updates a kept card whose detail changed and reports it in changed', () => {
  const s = session('claude', 't1')
  const a = approvalCard(s, { tool: 'Bash', input: { command: 'rm -rf build' }, at: 100 }, 100)
  const t1 = reconcile([], [a], 100)
  const b = { ...approvalCard(s, { tool: 'Bash', input: { command: 'git push' }, at: 200 }, 200), actions: ['peek'] }
  const t2 = reconcile(t1.open, [b], 200)
  assert.equal(t2.added.length, 0)
  assert.equal(t2.closed.length, 0)
  assert.equal(t2.changed.length, 1)
  assert.equal(t2.open[0].detail, 'wants to run: git push')
  assert.deepEqual(t2.open[0].actions, ['peek'])
  assert.equal(t2.open[0].at, 100)
  assert.deepEqual(t2.changed[0], t2.open[0])
  const t3 = reconcile(t2.open, [b], 300)
  assert.deepEqual(t3.changed, [])
})

test('allow and deny send nothing when the prompt on screen is for another command', async () => {
  for (const choice of ['allow', 'deny']) {
    const h = answerOpts({ choice, expect: 'rm -rf build', screens: [pnpmScreen] })
    assert.equal(await answerApproval(h.opts), 'use-peek')
    assert.equal(sends(h).length, 0)
    assert.equal(h.masks(), 0)
  }
})

test('allow sends 1 when the prompt on screen shows the expected command', async () => {
  const h = answerOpts({ choice: 'allow', expect: 'pnpm   install', screens: [pnpmScreen], states: ['blocked', 'blocked', 'working'] })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.deepEqual(sends(h), [['terminal', 'send', '--terminal', 't1', '--text=1']])
})

test('deny sends Escape when the prompt on screen shows the expected command', async () => {
  const h = answerOpts({ choice: 'deny', expect: 'pnpm install', screens: [pnpmScreen, deniedScreen] })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.deepEqual(sends(h), [['terminal', 'send', '--terminal', 't1', '--text=\u001b']])
})

test('a long expected command is matched on its first 60 characters', async () => {
  const long = 'pnpm exec vitest run --reporter verbose packages/' + 'x'.repeat(80)
  const shown = bashScreen(long.slice(0, 70))
  const h = answerOpts({ choice: 'allow', expect: long, screens: [shown], states: ['blocked', 'blocked', 'working'] })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.equal(sends(h).length, 1)
  const miss = answerOpts({ choice: 'allow', expect: long, screens: [bashScreen(long.slice(0, 50))], states: ['blocked', 'blocked', 'working'] })
  assert.equal(await answerApproval(miss.opts), 'use-peek')
  assert.equal(sends(miss).length, 0)
})

test('allow with no expected command sends nothing and uses Peek', async () => {
  for (const expect of [undefined, '', '   ']) {
    const h = answerOpts({ choice: 'allow', expect, screens: [pnpmScreen], states: ['blocked', 'working'] })
    assert.equal(await answerApproval(h.opts), 'use-peek')
    assert.equal(sends(h).length, 0)
  }
})

test('deny with no expected command keeps sending Escape at any permission prompt', async () => {
  const h = answerOpts({ choice: 'deny', expect: '', screens: [pnpmScreen, deniedScreen] })
  assert.equal(await answerApproval(h.opts), 'answered')
  assert.equal(sends(h).length, 1)
})

test('describeTool and approvalCard take staleness from the given now', () => {
  const call = { tool: 'Bash', input: { command: 'ls' }, at: 1000 }
  assert.equal(describeTool(call, 1000 + 121000), 'waiting on a prompt')
  assert.equal(describeTool(call, 1000 + 119000), 'wants to run: ls')
  assert.equal(approvalCard(session('claude', 't1'), call, 1000 + 121000).detail, 'waiting on a prompt')
  assert.equal(approvalCard(session('claude', 't1'), call, 1000 + 1000).detail, 'wants to run: ls')
})

test('PEEK_KEYS carries the raw bytes', () => {
  assert.equal(PEEK_KEYS.esc, '\u001b')
  assert.equal(PEEK_KEYS.enter, '\r')
  assert.equal(PEEK_KEYS['1'], '1')
  assert.equal(PEEK_KEYS['5'], '5')
})

test('reconcile gives an open card the actions its kind has now', () => {
  const old = { id: 'unreachable:k', key: 'k', kind: 'unreachable', title: 't', detail: 'No agent to message in this session', actions: ['details'], at: 1, resolved: null }
  const want = { ...old, actions: ['start', 'dismiss', 'details'], at: 9 }
  const out = reconcile([old], [want], 9)
  assert.deepEqual(out.open[0].actions, ['start', 'dismiss', 'details'])
  assert.equal(out.open[0].at, 1)
  assert.equal(out.changed.length, 1)
  assert.equal(reconcile(out.open, [want], 10).changed.length, 0)
})

test('doingText says what the agent is doing from its latest tool call', () => {
  const at = 1000
  const sh = (command) => doingText({ tool: 'Bash', input: { command }, at }, at)
  assert.equal(sh('gh pr list --json number'), 'Running gh pr list --json number')
  assert.equal(sh("./bin/say progress 'starting'"), 'Writing to you')
  assert.equal(sh('./bin/tell spike-oa rebase'), 'Writing to a session')
  assert.equal(sh('orca orchestration worker-start --spec-file - <<EOF\ntask\nEOF'), 'Starting a worker')
  assert.equal(sh('x'.repeat(200)), 'Running ' + 'x'.repeat(72) + '…')
  assert.equal(sh('first line\nsecond line'), 'Running first line')
  assert.equal(doingText({ tool: 'Read', input: { file_path: '/home/board.md' }, at }, at), 'Reading board.md')
  assert.equal(doingText({ tool: 'Grep', input: {}, at }, at), 'Using Grep')
  assert.equal(doingText({ tool: 'Bash', input: { command: 'ls' }, at }, at + 121000), '')
  assert.equal(doingText(undefined, at), '')
})
