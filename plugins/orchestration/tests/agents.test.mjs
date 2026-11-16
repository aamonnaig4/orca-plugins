import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_CATALOG, detectAgents } from '../src/agents.ts'

function depsWith(stdout) {
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
      env: () => undefined,
      fs: {}
    }
  }
}

test('catalog holds the twenty ids in order with the two special commands', () => {
  assert.deepEqual(
    AGENT_CATALOG.map((a) => a.id),
    ['claude', 'codex', 'grok', 'gemini', 'antigravity', 'cursor', 'copilot', 'opencode', 'opencode2', 'aider', 'goose', 'kimi', 'droid', 'pi', 'omp', 'qwen', 'amp', 'cline', 'devin', 'hermes']
  )
  for (const a of AGENT_CATALOG) {
    const expected = a.id === 'antigravity' ? 'agy' : a.id === 'cursor' ? 'cursor-agent' : a.id
    assert.equal(a.cmd, expected)
    assert.ok(a.label.length > 0)
  }
})

test('detectAgents lists installed agents first, then the rest in catalog order', async () => {
  const { deps } = depsWith('ok claude\nok agy')
  const out = await detectAgents(deps)
  assert.equal(out.length, AGENT_CATALOG.length)
  assert.deepEqual(out.slice(0, 2).map((a) => [a.id, a.installed]), [['claude', true], ['antigravity', true]])
  const rest = out.slice(2)
  assert.ok(rest.every((a) => a.installed === false))
  assert.deepEqual(
    rest.map((a) => a.id),
    AGENT_CATALOG.map((a) => a.id).filter((id) => id !== 'claude' && id !== 'antigravity')
  )
})

test('detectAgents makes one /bin/zsh -lc call that checks every catalog command', async () => {
  const { deps, calls } = depsWith('')
  await detectAgents(deps)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/bin/zsh')
  assert.equal(calls[0][1][0], '-lc')
  for (const a of AGENT_CATALOG) assert.ok(calls[0][1][1].includes('command -v ' + a.cmd))
})

test('detectAgents marks nothing installed when the shell is missing', async () => {
  const deps = { ...depsWith('').deps, run: async () => ({ code: 127, stdout: '', stderr: '', missing: true }) }
  const out = await detectAgents(deps)
  assert.ok(out.every((a) => !a.installed))
  assert.equal(out.length, AGENT_CATALOG.length)
})
