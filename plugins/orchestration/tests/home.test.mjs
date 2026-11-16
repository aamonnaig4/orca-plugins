import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, access, writeFile, symlink, mkdir, chmod, readFile, lstat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_SETTINGS, nodeDeps } from '../src/deps.ts'
import { claudeSettings, ensureHome, homeOptionsOf, homePath, readOutbox, workerFlags, writeBoard } from '../src/home.ts'

const run = promisify(execFile)
const OPTS = { marker: 'orch:x', workerAgent: 'claude', suffix: '-oa' }

function memory(initial = {}) {
  const files = new Map(Object.entries(initial))
  const modes = new Map()
  const writes = []
  const removed = []
  const fs = {
    read: async (p) => (files.has(p) ? files.get(p) : null),
    write: async (p, text, mode) => {
      writes.push(p)
      files.set(p, text)
      if (mode !== undefined) modes.set(p, mode)
    },
    list: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = []
      for (const p of files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.push(p.slice(prefix.length))
      }
      return names
    },
    remove: async (p) => {
      removed.push(p)
      files.delete(p)
    },
    mkdir: async () => {}
  }
  const deps = { run: async () => ({ code: 0, stdout: '', stderr: '', missing: false }), now: () => 0, home: () => '/h', env: () => undefined, fs }
  return { deps, files, modes, writes, removed }
}

test('homePath is under the user home', () => {
  assert.equal(homePath(memory().deps), '/h/.orca-orchestration/home')
})

test('ensureHome writes the six paths and marks the scripts executable', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  assert.equal(home, '/h/.orca-orchestration/home')
  assert.ok(m.files.get(`${home}/AGENTS.md`).includes('board.md'))
  assert.equal(m.files.get(`${home}/CLAUDE.md`), '@AGENTS.md')
  assert.ok(m.files.has(`${home}/.claude/settings.json`))
  assert.ok(m.files.get(`${home}/bin/say`).startsWith('#!/bin/sh'))
  assert.ok(m.files.get(`${home}/bin/tell`).startsWith('#!/bin/sh'))
  assert.equal(m.modes.get(`${home}/bin/say`), 0o755)
  assert.equal(m.modes.get(`${home}/bin/tell`), 0o755)
})

test('ensureHome creates the outbox directory', async () => {
  const made = []
  const m = memory()
  m.deps.fs.mkdir = async (d) => {
    made.push(d)
  }
  const home = await ensureHome(m.deps, OPTS)
  assert.ok(made.includes(`${home}/outbox`))
})

test('ensureHome makes no write the second time', async () => {
  const m = memory()
  await ensureHome(m.deps, OPTS)
  m.writes.length = 0
  await ensureHome(m.deps, OPTS)
  assert.deepEqual(m.writes, [])
})

test('ensureHome rewrites a file whose text changed', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  m.files.set(`${home}/AGENTS.md`, 'old')
  m.writes.length = 0
  await ensureHome(m.deps, OPTS)
  assert.deepEqual(m.writes, [`${home}/AGENTS.md`])
})

test('settings.json sets nothing about the model or permissions until the user picks them', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  const settings = JSON.parse(m.files.get(`${home}/.claude/settings.json`))
  assert.deepEqual(Object.keys(settings).sort(), ['permissions', 'sandbox'])
  assert.equal('defaultMode' in settings.permissions, false)
})

test('settings.json carries the picked model, effort, fast mode and permission mode', async () => {
  const m = memory()
  const s = { ...DEFAULT_SETTINGS, orchestratorAgent: 'claude', model: 'opus', effort: 'high', fast: true, permissionMode: 'acceptEdits' }
  const home = await ensureHome(m.deps, homeOptionsOf('orch:x', s))
  const settings = JSON.parse(m.files.get(`${home}/.claude/settings.json`))
  assert.equal(settings.model, 'opus')
  assert.equal(settings.effortLevel, 'high')
  assert.equal(settings.fastMode, true)
  assert.equal(settings.permissions.defaultMode, 'acceptEdits')
  assert.equal(settings.permissions.allow.length, 7)
})

test('Manual is stored as Claude\'s default mode and plan mode never becomes a Claude permission mode', () => {
  const base = { ...DEFAULT_SETTINGS, orchestratorAgent: 'claude' }
  assert.equal(claudeSettings(homeOptionsOf('m', { ...base, permissionMode: 'manual' }).launch).permissions.defaultMode, 'default')
  assert.equal(claudeSettings(homeOptionsOf('m', { ...base, permissionMode: 'auto', plan: true }).launch).permissions.defaultMode, 'auto')
  assert.equal('defaultMode' in claudeSettings(homeOptionsOf('m', { ...base, plan: true }).launch).permissions, false)
  assert.equal('fastMode' in claudeSettings(homeOptionsOf('m', base).launch), false)
})

test('workers get the model and effort flags only when they run Claude and a model is picked', () => {
  const base = { ...DEFAULT_SETTINGS, orchestratorAgent: 'claude' }
  assert.equal(workerFlags(base), '')
  assert.equal(workerFlags({ ...base, effort: 'high' }), '')
  assert.equal(workerFlags({ ...base, model: 'sonnet' }), ' --model sonnet')
  assert.equal(workerFlags({ ...base, model: 'opus', effort: 'xhigh' }), ' --model opus --effort xhigh')
  assert.equal(workerFlags({ ...base, model: 'opus', workerAgent: 'codex' }), '')
  assert.equal(workerFlags({ ...base, orchestratorAgent: 'codex', model: 'opus' }), '')
})

test('plan mode adds the plan-first rule to AGENTS.md for any agent, and only while it is on', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, homeOptionsOf('orch:x', { ...DEFAULT_SETTINGS, orchestratorAgent: 'codex', plan: true }))
  const on = m.files.get(`${home}/AGENTS.md`)
  assert.ok(on.includes('## Plan mode is on') && on.includes('./bin/say question --options "Go|Change it"'))
  assert.ok(on.indexOf('## Plan mode is on') < on.indexOf('## Use the workspace that already exists'))
  await ensureHome(m.deps, homeOptionsOf('orch:x', { ...DEFAULT_SETTINGS, orchestratorAgent: 'codex' }))
  assert.ok(!m.files.get(`${home}/AGENTS.md`).includes('Plan mode'))
})

test('the worker-start commands in AGENTS.md carry the worker flags', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, homeOptionsOf('orch:x', { ...DEFAULT_SETTINGS, orchestratorAgent: 'claude', model: 'opus', effort: 'medium' }))
  const agents = m.files.get(`${home}/AGENTS.md`)
  assert.equal(agents.split('--agent claude --model opus --effort medium --worktree').length - 1, 2)
})

test('settings.json lets orca out of the sandbox and allows the five commands and memory.md', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  const settings = JSON.parse(m.files.get(`${home}/.claude/settings.json`))
  assert.deepEqual(settings.sandbox.excludedCommands, ['orca'])
  assert.deepEqual(settings.permissions.allow, [
    'Bash(orca:*)',
    'Bash(gh:*)',
    'Bash(./bin/say:*)',
    'Bash(./bin/tell:*)',
    'Read(board.md)',
    'Read(memory.md)',
    'Edit(memory.md)'
  ])
})

test('generated scripts carry no comment lines besides the shebang', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  for (const name of ['say', 'tell']) {
    const lines = m.files.get(`${home}/bin/${name}`).split('\n')
    assert.equal(lines.filter((l) => l.trimStart().startsWith('#')).length, 1)
    assert.equal(lines[0], '#!/bin/sh')
  }
})

test('readOutbox returns messages in file-name order, parses each kind and removes the files', async () => {
  const dir = '/h/.orca-orchestration/home/outbox'
  const m = memory({
    [`${dir}/0000000000003-0000000002.msg`]: 'question\nYes|No\nShip it?',
    [`${dir}/0000000000001-0000000009.msg`]: 'text\n\nhello',
    [`${dir}/0000000000002-0000000001.msg`]: 'track\nctx_1\n',
    [`${dir}/0000000000004-0000000001.msg`]: 'tell\nfix-oa\nplease rebase',
    [`${dir}/0000000000005-0000000001.msg`]: 'progress\n\nhalfway',
    [`${dir}/0000000000006-0000000001.msg`]: 'result\n\ndone'
  })
  const got = await readOutbox(m.deps, '/h/.orca-orchestration/home')
  assert.deepEqual(got, [
    { kind: 'text', text: 'hello' },
    { kind: 'track', dispatchId: 'ctx_1' },
    { kind: 'question', text: 'Ship it?', options: ['Yes', 'No'] },
    { kind: 'tell', target: 'fix-oa', text: 'please rebase' },
    { kind: 'progress', text: 'halfway' },
    { kind: 'result', text: 'done' }
  ])
  assert.equal(m.removed.length, 6)
  assert.deepEqual(await m.deps.fs.list(dir), [])
})

test('readOutbox orders by epoch then pid numerically', async () => {
  const dir = '/h/home/outbox'
  const m = memory({
    [`${dir}/1000-5.msg`]: 'text\n\nsecond',
    [`${dir}/999-5.msg`]: 'text\n\nfirst'
  })
  const got = await readOutbox(m.deps, '/h/home')
  assert.deepEqual(
    got.map((g) => g.text),
    ['first', 'second']
  )
})

test('hostile html comes back unchanged', async () => {
  const dir = '/h/home/outbox'
  const m = memory({ [`${dir}/1-1.msg`]: 'text\n\n<img src=x onerror=1>' })
  assert.deepEqual(await readOutbox(m.deps, '/h/home'), [{ kind: 'text', text: '<img src=x onerror=1>' }])
})

test('an oversized file is cut to 16384 bytes of text', async () => {
  const dir = '/h/home/outbox'
  const m = memory({ [`${dir}/1-1.msg`]: `text\n\n${'a'.repeat(20000)}` })
  const got = await readOutbox(m.deps, '/h/home')
  assert.equal(got.length, 1)
  assert.equal(Buffer.byteLength(got[0].text), 16384)
})

test('a cut inside a multi-byte character leaves no broken character', async () => {
  const dir = '/h/home/outbox'
  const m = memory({ [`${dir}/1-1.msg`]: `text\n\n${'é'.repeat(9000)}` })
  const got = await readOutbox(m.deps, '/h/home')
  assert.ok(Buffer.byteLength(got[0].text) <= 16384)
  assert.ok(!got[0].text.includes('�'))
})

test('unknown kinds and missing parts are removed and skipped', async () => {
  const dir = '/h/home/outbox'
  const m = memory({
    [`${dir}/1-1.msg`]: 'rm -rf\n\nx',
    [`${dir}/2-1.msg`]: 'text\n\n',
    [`${dir}/3-1.msg`]: 'track\n\n',
    [`${dir}/4-1.msg`]: 'tell\n\nno target',
    [`${dir}/5-1.msg`]: 'tell\nname\n',
    [`${dir}/6-1.msg`]: 'question\nA|B\n',
    [`${dir}/7-1.msg`]: 'text\n\nkept'
  })
  const got = await readOutbox(m.deps, '/h/home')
  assert.deepEqual(got, [{ kind: 'text', text: 'kept' }])
  assert.equal(m.removed.length, 7)
})

test('an unreadable file is skipped and left, the other four are returned and removed', async () => {
  const dir = '/h/home/outbox'
  const m = memory()
  for (let i = 1; i <= 5; i++) m.files.set(`${dir}/${i}-1.msg`, `text\n\nm${i}`)
  const read = m.deps.fs.read
  m.deps.fs.read = async (p) => {
    if (p === `${dir}/3-1.msg`) throw new Error('EACCES')
    return read(p)
  }
  const got = await readOutbox(m.deps, '/h/home')
  assert.deepEqual(got.map((g) => g.text), ['m1', 'm2', 'm4', 'm5'])
  assert.equal(m.files.has(`${dir}/3-1.msg`), true)
  for (const i of [1, 2, 4, 5]) assert.equal(m.files.has(`${dir}/${i}-1.msg`), false)
})

test('a failing directory listing returns an empty list', async () => {
  const m = memory()
  m.deps.fs.list = async () => {
    throw new Error('EIO')
  }
  assert.deepEqual(await readOutbox(m.deps, '/h/home'), [])
})

test('a tmp file is left alone', async () => {
  const dir = '/h/home/outbox'
  const m = memory({ [`${dir}/1-1.msg.tmp`]: 'text\n\nhalf' })
  assert.deepEqual(await readOutbox(m.deps, '/h/home'), [])
  assert.equal(m.files.has(`${dir}/1-1.msg.tmp`), true)
  assert.deepEqual(m.removed, [])
})

test('writeBoard writes once and reports whether it wrote', async () => {
  const m = memory()
  assert.equal(await writeBoard(m.deps, '/h/home', 'one'), true)
  assert.equal(m.files.get('/h/home/board.md'), 'one')
  assert.equal(await writeBoard(m.deps, '/h/home', 'one'), false)
  assert.equal(await writeBoard(m.deps, '/h/home', 'two'), true)
  assert.equal(m.files.get('/h/home/board.md'), 'two')
})

async function realHome() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'orch-home-'))
  const deps = { ...nodeDeps, home: () => tmp }
  const home = await ensureHome(deps, OPTS)
  return { tmp, deps, home }
}

async function exists(p) {
  return access(p).then(
    () => true,
    () => false
  )
}

test('real shell: say question round-trips through readOutbox', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    assert.equal((await stat(path.join(home, 'bin', 'say'))).mode & 0o777, 0o755)
    await run('./bin/say', ['question', '--options', 'Yes|No', 'Ship it?'], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [{ kind: 'question', text: 'Ship it?', options: ['Yes', 'No'] }])
    assert.deepEqual(await readOutbox(deps, home), [])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

const NASTY = [
  ["it's", "it's"],
  ['say "hi"', 'say "hi"'],
  ['$(touch PWNED_SUB)', '$(touch PWNED_SUB)'],
  ['`touch PWNED_TICK`', '`touch PWNED_TICK`'],
  ['-n --options $HOME \\n %s', '-n --options $HOME \\n %s'],
  ['line one\nline two\n\n', 'line one\nline two\n\n'],
  ["a'b\"c$(id)`id`", "a'b\"c$(id)`id`"]
]

for (const [input, expected] of NASTY) {
  test(`real shell: say keeps ${JSON.stringify(input)} byte for byte and runs nothing`, async () => {
    const { tmp, deps, home } = await realHome()
    try {
      await run('./bin/say', ['text', input], { cwd: home })
      const got = await readOutbox(deps, home)
      assert.deepEqual(got, [{ kind: 'text', text: expected }])
      assert.equal(await exists(path.join(home, 'PWNED_SUB')), false)
      assert.equal(await exists(path.join(home, 'PWNED_TICK')), false)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
}

test('real shell: words after the kind are joined with single spaces', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await run('./bin/say', ['progress', 'one', 'two', "three's"], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [{ kind: 'progress', text: "one two three's" }])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real shell: say track and tell', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await run('./bin/say', ['track', 'ctx_92026b9d61c3'], { cwd: home })
    await run('./bin/tell', ['fix-oa', '$(touch PWNED_SUB)', "don't", '`x`'], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [
      { kind: 'track', dispatchId: 'ctx_92026b9d61c3' },
      { kind: 'tell', target: 'fix-oa', text: "$(touch PWNED_SUB) don't `x`" }
    ])
    assert.equal(await exists(path.join(home, 'PWNED_SUB')), false)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real shell: messages sent in a row come back in order and no tmp file is left', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    for (const n of ['1', '2', '3', '4']) await run('./bin/say', ['text', n], { cwd: home })
    const got = await readOutbox(deps, home)
    assert.deepEqual(
      got.map((g) => g.text),
      ['1', '2', '3', '4']
    )
    assert.deepEqual(await deps.fs.list(path.join(home, 'outbox')), [])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real shell: bad use exits non-zero and writes nothing', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await assert.rejects(run('./bin/say', ['text'], { cwd: home }))
    await assert.rejects(run('./bin/say', ['bogus', 'x'], { cwd: home }))
    await assert.rejects(run('./bin/say', ['track'], { cwd: home }))
    await assert.rejects(run('./bin/tell', ['only-a-name'], { cwd: home }))
    assert.deepEqual(await deps.fs.list(path.join(home, 'outbox')), [])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real shell: say plan queues one step per argument and rejects an empty plan', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await run('./bin/say', ['plan', '[x] merge main', '[~] fix $CI `now`', "[ ] it's last"], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [
      {
        kind: 'plan',
        steps: [
          { text: 'merge main', status: 'done' },
          { text: 'fix $CI `now`', status: 'active' },
          { text: "it's last", status: 'pending' }
        ]
      }
    ])
    await assert.rejects(run('./bin/say', ['plan'], { cwd: home }))
    await run('./bin/say', ['plan', 'no marks here'], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real shell: the script works when called from another directory', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await run(path.join(home, 'bin', 'say'), ['result', 'ok'], { cwd: tmp })
    assert.deepEqual(await readOutbox(deps, home), [{ kind: 'result', text: 'ok' }])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('readOutbox strips a trailing carriage return from the header lines', async () => {
  const dir = '/h/home/outbox'
  const m = memory({
    [`${dir}/1-1.msg`]: 'tell\r\nfix-oa\r\nhello',
    [`${dir}/2-1.msg`]: 'track\nctx_1\r\n'
  })
  assert.deepEqual(await readOutbox(m.deps, '/h/home'), [
    { kind: 'tell', target: 'fix-oa', text: 'hello' },
    { kind: 'track', dispatchId: 'ctx_1' }
  ])
})

test('real shell: a line break in the options, target or id is refused with exit 2 and nothing is written', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const cases = [
      ['./bin/say', ['question', '--options', 'A\nB', 'q']],
      ['./bin/say', ['question', '--options', 'A\rB', 'q']],
      ['./bin/tell', ['fix\noa', 'hi']],
      ['./bin/say', ['track', 'ctx\n1']]
    ]
    for (const [cmd, args] of cases) {
      await assert.rejects(run(cmd, args, { cwd: home }), (e) => e.code === 2 && e.stderr.length > 0)
    }
    assert.deepEqual(await deps.fs.list(path.join(home, 'outbox')), [])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: a symlink named x.msg is removed and its target is neither read nor deleted', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const outside = path.join(tmp, 'outside.txt')
    await writeFile(outside, 'text\n\nsecret')
    await symlink(outside, path.join(home, 'outbox', 'x.msg'))
    assert.deepEqual(await readOutbox(deps, home), [])
    assert.equal(await exists(path.join(home, 'outbox', 'x.msg')), false)
    assert.equal(await readFile(outside, 'utf8'), 'text\n\nsecret')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: a directory named d.msg is skipped without throwing and a FIFO does not hang', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await mkdir(path.join(home, 'outbox', 'd.msg'))
    await run('mkfifo', [path.join(home, 'outbox', 'f.msg')])
    await run('./bin/say', ['text', 'kept'], { cwd: home })
    assert.deepEqual(await readOutbox(deps, home), [{ kind: 'text', text: 'kept' }])
    assert.equal(await exists(path.join(home, 'outbox', 'd.msg')), false)
    assert.equal(await exists(path.join(home, 'outbox', 'f.msg')), false)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: a 1 MB file returns exactly the capped text', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await writeFile(path.join(home, 'outbox', '1-1.msg'), `text\n\n${'a'.repeat(1024 * 1024)}`)
    const got = await readOutbox(deps, home)
    assert.deepEqual(got, [{ kind: 'text', text: 'a'.repeat(16384) }])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: the read cap stops at 24576 bytes, so a body behind a huge header is never reached', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const body = `${'a'.repeat(19999)}MARK${'b'.repeat(100000)}`
    await writeFile(path.join(home, 'outbox', '1-1.msg'), `text\n\n${body}`)
    const [one] = await readOutbox(deps, home)
    assert.equal(one.text.length, 16384)
    assert.ok(!one.text.includes('MARK'))
    await writeFile(path.join(home, 'outbox', '2-1.msg'), `text\n${'x'.repeat(100000)}\nhello`)
    assert.deepEqual(await readOutbox(deps, home), [])
    assert.equal(await exists(path.join(home, 'outbox', '2-1.msg')), false)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: a wrapped Fs over a real home still gets the symlink and size protections', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const wrapped = { ...deps, fs: { ...deps.fs } }
    const outside = path.join(tmp, 'outside.txt')
    await writeFile(outside, 'text\n\nsecret')
    await symlink(outside, path.join(home, 'outbox', 'x.msg'))
    await mkdir(path.join(home, 'outbox', 'd.msg'))
    assert.deepEqual(await readOutbox(wrapped, home), [])
    assert.equal(await exists(path.join(home, 'outbox', 'x.msg')), false)
    assert.equal(await exists(path.join(home, 'outbox', 'd.msg')), false)
    assert.equal(await readFile(outside, 'utf8'), 'text\n\nsecret')
    await rm(path.join(home, 'bin', 'say'))
    await symlink(outside, path.join(home, 'bin', 'say'))
    await ensureHome(wrapped, OPTS)
    assert.equal(await readFile(outside, 'utf8'), 'text\n\nsecret')
    assert.equal((await lstat(path.join(home, 'bin', 'say'))).isFile(), true)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: files come back by modification time first, then name', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const a = path.join(home, 'outbox', '1-1.msg')
    const b = path.join(home, 'outbox', '2-1.msg')
    await writeFile(a, 'text\n\nlate')
    await writeFile(b, 'text\n\nearly')
    await utimes(a, 2000, 2000)
    await utimes(b, 1000, 1000)
    assert.deepEqual(
      (await readOutbox(deps, home)).map((g) => g.text),
      ['early', 'late']
    )
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: ensureHome fixes the mode of an existing bin/say and bin/tell', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    await chmod(path.join(home, 'bin', 'say'), 0o644)
    await chmod(path.join(home, 'bin', 'tell'), 0o600)
    await ensureHome(deps, OPTS)
    assert.equal((await stat(path.join(home, 'bin', 'say'))).mode & 0o777, 0o755)
    assert.equal((await stat(path.join(home, 'bin', 'tell'))).mode & 0o777, 0o755)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('real fs: ensureHome replaces a symlink at a target path with a regular file and leaves the target alone', async () => {
  const { tmp, deps, home } = await realHome()
  try {
    const outside = path.join(tmp, 'outside.txt')
    await writeFile(outside, 'precious')
    for (const rel of ['AGENTS.md', 'bin/say']) {
      await rm(path.join(home, rel))
      await symlink(outside, path.join(home, rel))
    }
    await ensureHome(deps, OPTS)
    assert.equal(await readFile(outside, 'utf8'), 'precious')
    for (const rel of ['AGENTS.md', 'bin/say']) {
      const info = await lstat(path.join(home, rel))
      assert.equal(info.isSymbolicLink(), false)
      assert.equal(info.isFile(), true)
    }
    assert.ok((await readFile(path.join(home, 'AGENTS.md'), 'utf8')).includes('board.md'))
    assert.equal((await stat(path.join(home, 'bin', 'say'))).mode & 0o777, 0o755)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('readOutbox returns a message whose file cannot be removed once, and the others once', async () => {
  const dir = '/h/stuck-home/outbox'
  const m = memory({
    [`${dir}/1000-0000000001.msg`]: 'text\n\nfirst',
    [`${dir}/1000-0000000002.msg`]: 'tell\nalpha\nstuck',
    [`${dir}/1000-0000000003.msg`]: 'text\n\nthird'
  })
  const stuck = `${dir}/1000-0000000002.msg`
  const inner = m.deps.fs.remove
  m.deps.fs.remove = async (p) => {
    if (p === stuck) throw new Error('busy')
    return inner(p)
  }
  const all = []
  for (let i = 0; i < 3; i++) all.push(...(await readOutbox(m.deps, '/h/stuck-home')))
  const texts = all.map((x) => x.text)
  assert.equal(texts.filter((t) => t === 'stuck').length, 1)
  assert.equal(texts.filter((t) => t === 'first').length, 1)
  assert.equal(texts.filter((t) => t === 'third').length, 1)
  assert.ok(m.files.has(stuck))
})

test('ensureHome creates memory.md when it is missing', async () => {
  const m = memory()
  const home = await ensureHome(m.deps, OPTS)
  assert.ok(m.files.get(`${home}/memory.md`).startsWith('# Orchestrator memory\n'))
  assert.equal(m.writes.filter((p) => p === `${home}/memory.md`).length, 1)
  await ensureHome(m.deps, OPTS)
  assert.equal(m.writes.filter((p) => p === `${home}/memory.md`).length, 1)
})

test('ensureHome never overwrites an existing memory.md, even an empty one', async () => {
  for (const kept of ['# Orchestrator memory\n\n- 2026-11-15: use squash PRs\n', '']) {
    const m = memory({ '/h/.orca-orchestration/home/memory.md': kept })
    const home = await ensureHome(m.deps, OPTS)
    assert.equal(m.files.get(`${home}/memory.md`), kept)
    assert.equal(m.writes.includes(`${home}/memory.md`), false)
  }
})

test('ensureHome keeps a real memory.md on disk untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-mem-'))
  try {
    const deps = { ...nodeDeps, home: () => dir }
    const home = await ensureHome(deps, OPTS)
    const first = await readFile(`${home}/memory.md`, 'utf8')
    assert.ok(first.includes('Orchestrator memory'))
    await writeFile(`${home}/memory.md`, 'mine\n')
    await ensureHome(deps, OPTS)
    assert.equal(await readFile(`${home}/memory.md`, 'utf8'), 'mine\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeBoard puts the Best match section right under the title', async () => {
  const m = memory()
  const md = '# Board · updated X\n\n## Building\n\n- a\n'
  assert.equal(await writeBoard(m.deps, '/h', md, { request: 'fix #7', match: { kind: 'one', name: 'feat', key: 'k', by: 'PR' } }), true)
  assert.equal(m.files.get('/h/board.md'), "# Board · updated X\n\n## Best match for the latest request\n\nRequest: 'fix #7'\nBest match: feat (by PR)\n\n## Building\n\n- a\n")
  assert.equal(await writeBoard(m.deps, '/h', md, { request: 'fix #7', match: { kind: 'one', name: 'feat', key: 'k', by: 'PR' } }), false)
  assert.equal(await writeBoard(m.deps, '/h', md), true)
  assert.equal(m.files.get('/h/board.md'), md)
})
