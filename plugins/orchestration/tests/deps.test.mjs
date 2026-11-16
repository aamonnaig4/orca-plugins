import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_ORCA, DEFAULT_SETTINGS, nodeDeps, readSettings, resolveBins } from '../src/deps.ts'

function fakeDeps(stdout, env = {}) {
  const calls = []
  return {
    calls,
    deps: {
      run: async (cmd, args) => {
        calls.push([cmd, args])
        return { code: 0, stdout, stderr: '', missing: false }
      },
      now: () => 0,
      home: () => '/home',
      env: (name) => env[name],
      fs: {}
    }
  }
}

test('run resolves missing and code 127 for a command that does not exist', async () => {
  const res = await nodeDeps.run('/nonexistent/definitely-not-a-command', [])
  assert.equal(res.missing, true)
  assert.equal(res.code, 127)
})

test('resolveBins makes one login shell call and reads both paths', async () => {
  const { deps, calls } = fakeDeps('orca=/a/orca\ngh=/b/gh')
  assert.deepEqual(await resolveBins(deps), { orca: '/a/orca', gh: '/b/gh' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/bin/zsh')
  assert.equal(calls[0][1][0], '-lc')
})

test('resolveBins gives null gh when no gh line is printed', async () => {
  const { deps } = fakeDeps('orca=/a/orca\n')
  assert.deepEqual(await resolveBins(deps), { orca: '/a/orca', gh: null })
})

test('resolveBins prefers ORCA_CLI_COMMAND', async () => {
  const { deps } = fakeDeps('orca=/a/orca\ngh=/b/gh', { ORCA_CLI_COMMAND: '/x/orca' })
  assert.deepEqual(await resolveBins(deps), { orca: '/x/orca', gh: '/b/gh' })
})

test('resolveBins falls back to the orca inside Orca.app when the login shell has none', async () => {
  const { deps } = fakeDeps('orca=\ngh=/b/gh')
  const asked = []
  deps.fs = { read: async (p) => { asked.push(p); return p === APP_ORCA ? '#!/bin/sh' : null } }
  assert.deepEqual(await resolveBins(deps), { orca: APP_ORCA, gh: '/b/gh' })
  assert.deepEqual(asked, [APP_ORCA])
})

test('resolveBins keeps plain orca when neither the login shell nor Orca.app has it', async () => {
  const { deps } = fakeDeps('gh=/b/gh')
  deps.fs = { read: async () => null }
  assert.deepEqual(await resolveBins(deps), { orca: 'orca', gh: '/b/gh' })
})

test('readSettings of nothing is the defaults', () => {
  assert.deepEqual(readSettings({}), DEFAULT_SETTINGS)
})

test('readSettings keeps defaults for bad values', () => {
  const s = readSettings({ intervalSec: 7, attempts: 'x' })
  assert.equal(s.intervalSec, 60)
  assert.equal(s.attempts, 3)
})

test('readSettings accepts valid choices', () => {
  const s = readSettings({ intervalSec: 120, attempts: 5, guard: false, suffix: '-x' })
  assert.equal(s.intervalSec, 120)
  assert.equal(s.attempts, 5)
  assert.equal(s.guard, false)
  assert.equal(s.suffix, '-x')
})

test('run resolves code 124 and stderr timeout when the command is killed by the timeout', async () => {
  const res = await nodeDeps.run('/bin/sleep', ['5'], { timeoutMs: 100 })
  assert.equal(res.code, 124)
  assert.equal(res.stderr, 'timeout')
  assert.equal(res.missing, false)
})

test('run reports a death by another signal as code 1 with the signal in stderr, not a timeout', async () => {
  const res = await nodeDeps.run('/bin/sh', ['-c', 'kill -TERM $$'], { timeoutMs: 5000 })
  assert.equal(res.code, 1)
  assert.equal(res.missing, false)
  assert.match(res.stderr, /SIGTERM/)
})

test('run reports output past the buffer limit as too large, not a timeout', async () => {
  const res = await nodeDeps.run('/usr/bin/head', ['-c', '40000000', '/dev/zero'], { timeoutMs: 10000 })
  assert.notEqual(res.code, 0)
  assert.notEqual(res.code, 124)
  assert.equal(res.missing, false)
  assert.match(res.stderr, /too large/)
})

test('run ends stdin so a reader finishes promptly', async () => {
  const started = Date.now()
  const res = await nodeDeps.run('/bin/cat', [], { timeoutMs: 5000 })
  assert.equal(res.code, 0)
  assert.equal(res.stdout, '')
  assert.ok(Date.now() - started < 2000)
})

test('run passes input to stdin', async () => {
  const res = await nodeDeps.run('/bin/cat', [], { input: 'hello' })
  assert.equal(res.stdout, 'hello')
})

test('run reports a missing cwd as not missing with the error in stderr', async () => {
  const res = await nodeDeps.run('/bin/echo', ['x'], { cwd: '/nonexistent/definitely-not-a-dir' })
  assert.equal(res.missing, false)
  assert.equal(res.code, 1)
  assert.ok(res.stderr.length > 0)
})

test('run resolves code 1 with the error in stderr when execFile throws synchronously', async () => {
  const bad = await nodeDeps.run('/bin/echo', ['a\u0000b'])
  assert.equal(bad.code, 1)
  assert.equal(bad.missing, false)
  assert.equal(bad.stdout, '')
  assert.ok(bad.stderr.length > 0)
})

test('run resolves code 1, not missing, when the arguments are past the system limit', async () => {
  const res = await nodeDeps.run('/bin/echo', ['x'.repeat(4 * 1024 * 1024)])
  assert.equal(res.code, 1)
  assert.equal(res.missing, false)
  assert.match(res.stderr, /E2BIG/)
})

test('readSettings reads the auto-fix choices and falls back on values it does not know', () => {
  const s = readSettings({ onCi: 'ask', onConflict: 'ignore', onReview: 'nope', noAgent: 'ask', scope: 'workers' })
  assert.deepEqual([s.onCi, s.onConflict, s.onReview, s.noAgent, s.scope], ['ask', 'ignore', 'fix', 'ask', 'workers'])
})

test('readSettings turns the old own-sessions switch into the scope unless a scope is saved', () => {
  assert.equal(readSettings({ autoFixYours: false }).scope, 'workers')
  assert.equal(readSettings({ autoFixYours: true }).scope, 'all')
  assert.equal(readSettings({ autoFixYours: false, scope: 'all' }).scope, 'all')
})

test('readSettings reads the composer choices and falls back on values it does not know', () => {
  const s = readSettings({ model: 'opus', effort: 'xhigh', fast: true, plan: true, permissionMode: 'dontAsk' })
  assert.deepEqual([s.model, s.effort, s.fast, s.plan, s.permissionMode], ['opus', 'xhigh', true, true, 'dontAsk'])
  const d = readSettings({ model: 'gpt', effort: 'max', fast: 'yes', plan: 1, permissionMode: 'plan' })
  assert.deepEqual([d.model, d.effort, d.fast, d.plan, d.permissionMode], ['', '', false, false, ''])
})
