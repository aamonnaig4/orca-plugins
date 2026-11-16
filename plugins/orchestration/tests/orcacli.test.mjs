import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CliError, createCli } from '../src/orcacli.ts'

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8')

function depsReturning(result) {
  const calls = []
  return {
    calls,
    deps: {
      run: async (cmd, args) => {
        calls.push([cmd, args])
        return { code: 0, stdout: '', stderr: '', missing: false, ...result }
      },
      now: () => 0,
      home: () => '/home',
      env: () => undefined,
      fs: {}
    }
  }
}

test('json appends --json and returns the parsed result', async () => {
  const { deps, calls } = depsReturning({ stdout: JSON.stringify({ ok: true, result: { worktrees: [1] } }) })
  const out = await createCli(deps, '/bin/orca').json(['worktree', 'list'])
  assert.deepEqual(calls[0], ['/bin/orca', ['worktree', 'list', '--json']])
  assert.deepEqual(out, { worktrees: [1] })
})

test('json does not double --json', async () => {
  const { deps, calls } = depsReturning({ stdout: JSON.stringify({ ok: true, result: 1 }) })
  await createCli(deps, 'orca').json(['worktree', 'list', '--json'])
  assert.deepEqual(calls[0][1], ['worktree', 'list', '--json'])
})

test('json unwraps the worker-list fixture', async () => {
  const { deps } = depsReturning({ stdout: fixture('worker-list.json') })
  const out = await createCli(deps, 'orca').json(['orchestration', 'worker-list'])
  assert.deepEqual(out, JSON.parse(fixture('worker-list.json')).result)
})

test('a runtime_unavailable envelope rejects as a retryable CliError', async () => {
  const { deps } = depsReturning({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'down' } }) })
  await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'runtime_unavailable')
    assert.equal(error.retryable, true)
    return true
  })
})

test('a missing binary rejects with orca_missing', async () => {
  const { deps } = depsReturning({ code: 127, missing: true })
  await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'orca_missing')
    return true
  })
})

test('load runs agent-context and has matches commands', async () => {
  const { deps, calls } = depsReturning({ stdout: fixture('agent-context.json') })
  const cli = createCli(deps, 'orca')
  await cli.load()
  assert.deepEqual(calls[0][1], ['agent-context', '--json'])
  assert.equal(cli.has('orchestration worker-start'), true)
  assert.equal(cli.has('terminal send'), true)
  assert.equal(cli.has('nope'), false)
})

test('a timed out command rejects as a retryable timeout CliError', async () => {
  const { deps } = depsReturning({ code: 124, stderr: 'timeout' })
  await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'timeout')
    assert.equal(error.retryable, true)
    return true
  })
})

test('an ok envelope with no result rejects as bad_output', async () => {
  const { deps } = depsReturning({ stdout: JSON.stringify({ ok: true }) })
  await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'bad_output')
    assert.equal(error.retryable, false)
    return true
  })
})

test('a body that is not an envelope or JSON rejects as bad_output', async () => {
  for (const stdout of ['not json', '[1]', '{"a":1}', 'null']) {
    const { deps } = depsReturning({ stdout })
    await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => error.code === 'bad_output')
  }
})

test('load rejects on a non-zero exit even with a valid body', async () => {
  const { deps } = depsReturning({ code: 2, stderr: 'boom', stdout: fixture('agent-context.json') })
  const cli = createCli(deps, 'orca')
  await assert.rejects(cli.load(), (error) => error instanceof CliError && error.code === 'bad_output' && error.message === 'boom')
  assert.equal(cli.has('terminal send'), false)
})

test('load rejects bodies without a commands array as bad_output', async () => {
  for (const stdout of ['[]', '[{"command":"x"}]', '{}', '{"commands":null}', '{"commands":5}', '{"commands":{"a":1}}', '"x"']) {
    const { deps } = depsReturning({ stdout })
    await assert.rejects(createCli(deps, 'orca').load(), (error) => error instanceof CliError && error.code === 'bad_output', stdout)
  }
})

test('load skips entries that are not objects with a string command', async () => {
  const { deps } = depsReturning({ stdout: JSON.stringify({ commands: [null, 3, 'a b', [], { command: 7 }, { command: 'ok go' }] }) })
  const cli = createCli(deps, 'orca')
  await cli.load()
  assert.equal(cli.has('ok go'), true)
  assert.equal(cli.has('a b'), false)
})

test('json still appends --json when --json is a value in the middle', async () => {
  const { deps, calls } = depsReturning({ stdout: JSON.stringify({ ok: true, result: 1 }) })
  await createCli(deps, 'orca').json(['orchestration', 'send', '--body', '--json', '--to', 'w1'])
  assert.deepEqual(calls[0][1], ['orchestration', 'send', '--body', '--json', '--to', 'w1', '--json'])
})

test('an ok false envelope with a non-string error code falls back to unknown', async () => {
  const { deps } = depsReturning({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 5, message: 6 } }) })
  await assert.rejects(createCli(deps, 'orca').json(['x']), (error) => error instanceof CliError && error.code === 'unknown' && error.message === 'unknown')
})

test('load rejects on an ok false body with its error code', async () => {
  const { deps } = depsReturning({ stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'down' } }) })
  await assert.rejects(createCli(deps, 'orca').load(), (error) => error.code === 'runtime_unavailable' && error.retryable === true)
})

test('load rejects with orca_missing when the binary is missing', async () => {
  const { deps } = depsReturning({ code: 127, missing: true })
  await assert.rejects(createCli(deps, 'orca').load(), (error) => error.code === 'orca_missing')
})
