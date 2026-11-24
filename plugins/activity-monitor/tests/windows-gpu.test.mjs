import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { nodeDeps } from '../src/deps.ts'
import { createWindows, nvidiaSmiPaths } from '../src/windows.ts'

function gpuFixture(t, commands, env = {}) {
  let now = 100_000
  t.mock.method(Date, 'now', () => now)
  const calls = []
  const win = createWindows({
    async run(command, args, options) {
      calls.push({ command, args, options })
      const out = commands[command]
      if (out === undefined) return null
      return typeof out === 'function' ? out(args, options) : out
    },
    async read() { return '' },
    async list() { return [] },
    async readlink() { return null }
  }, env)
  return {
    calls,
    smiCalls() { return calls.filter((c) => c.command.toLowerCase().includes('nvidia-smi')) },
    async sample(advance = 3_000) {
      now += advance
      await win.read()
      await setImmediate()
      return (await win.read()).gpu
    }
  }
}

test('nvidiaSmiPaths starts with PATH lookup and adds System32 and NVSMI fallbacks when env vars exist', () => {
  assert.deepEqual(nvidiaSmiPaths({}), ['nvidia-smi'])
  assert.deepEqual(nvidiaSmiPaths({ SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }), [
    'nvidia-smi',
    'C:\\Windows\\System32\\nvidia-smi.exe',
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
  ])
  assert.deepEqual(nvidiaSmiPaths({ SYSTEMDRIVE: 'D:', SystemRoot: 'D:\\Windows' }), [
    'nvidia-smi',
    'D:\\Windows\\System32\\nvidia-smi.exe',
    'D:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
  ])
})

test('Windows reads NVIDIA GPU utilization and model from nvidia-smi off the sample path', async (t) => {
  let output = '35, NVIDIA GeForce RTX 3080 Ti\r\n45, NVIDIA GeForce RTX 3080 Ti\r\n'
  const h = gpuFixture(t, { 'nvidia-smi': () => output }, { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' })
  assert.deepEqual(await h.sample(0), { utilization: 40, model: 'NVIDIA GeForce RTX 3080 Ti' })
  assert.equal(h.smiCalls().length, 1)
  assert.deepEqual(h.smiCalls()[0].args, ['--query-gpu=utilization.gpu,name', '--format=csv,noheader,nounits'])
  assert.equal(h.smiCalls()[0].options, undefined)
  output = '72, NVIDIA GeForce RTX 3080 Ti\r\n'
  assert.deepEqual(await h.sample(1_000), { utilization: 40, model: 'NVIDIA GeForce RTX 3080 Ti' })
  assert.equal(h.smiCalls().length, 1)
  assert.deepEqual(await h.sample(2_000), { utilization: 72, model: 'NVIDIA GeForce RTX 3080 Ti' })
  assert.equal(h.smiCalls().length, 2)
})

test('Windows supplies ProgramFiles to nvidia-smi when the worker env omits it', async (t) => {
  const h = gpuFixture(t, { 'nvidia-smi': '22, NVIDIA GeForce RTX 3080 Ti\r\n' }, { SYSTEMDRIVE: 'D:', SystemRoot: 'D:\\Windows' })
  assert.deepEqual(await h.sample(0), { utilization: 22, model: 'NVIDIA GeForce RTX 3080 Ti' })
  assert.deepEqual(h.smiCalls()[0].options, { env: { ProgramFiles: 'D:\\Program Files' } })
})

test('Windows falls back to the NVSMI install path when nvidia-smi is not on PATH and caches it', async (t) => {
  const nvsmi = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
  let utilization = 18
  const h = gpuFixture(t, { [nvsmi]: () => utilization + ', NVIDIA GeForce RTX 4090\r\n' }, { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' })
  assert.deepEqual(await h.sample(0), { utilization: 18, model: 'NVIDIA GeForce RTX 4090' })
  assert.deepEqual(h.smiCalls().map((c) => c.command), [
    'nvidia-smi',
    'C:\\Windows\\System32\\nvidia-smi.exe',
    nvsmi
  ])
  utilization = 64
  assert.deepEqual(await h.sample(3_000), { utilization: 64, model: 'NVIDIA GeForce RTX 4090' })
  assert.deepEqual(h.smiCalls().map((c) => c.command), [
    'nvidia-smi',
    'C:\\Windows\\System32\\nvidia-smi.exe',
    nvsmi,
    nvsmi
  ])
})

test('Windows stops probing nvidia-smi after it is unavailable or returns unparseable output', async (t) => {
  const missing = gpuFixture(t, {}, { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' })
  assert.equal(await missing.sample(0), null)
  assert.equal(missing.smiCalls().length, 3)
  assert.equal(await missing.sample(3_000), null)
  assert.equal(await missing.sample(3_000), null)
  assert.equal(missing.smiCalls().length, 3)

  const bad = gpuFixture(t, { 'nvidia-smi': '[N/A], NVIDIA GeForce RTX 3080 Ti\r\n' }, {})
  assert.equal(await bad.sample(0), null)
  assert.equal(bad.smiCalls().length, 1)
  assert.equal(await bad.sample(3_000), null)
  assert.equal(bad.smiCalls().length, 1)
})

test('Windows keeps the last GPU reading across a transient nvidia-smi failure and recovers on the next poll', async (t) => {
  let out = '25, NVIDIA GeForce RTX 3080 Ti\r\n'
  const h = gpuFixture(t, { 'nvidia-smi': () => out }, {})
  assert.deepEqual(await h.sample(0), { utilization: 25, model: 'NVIDIA GeForce RTX 3080 Ti' })
  out = null
  assert.deepEqual(await h.sample(3_000), { utilization: 25, model: 'NVIDIA GeForce RTX 3080 Ti' })
  out = '81, NVIDIA GeForce RTX 3080 Ti\r\n'
  assert.deepEqual(await h.sample(3_000), { utilization: 81, model: 'NVIDIA GeForce RTX 3080 Ti' })
  assert.equal(h.smiCalls().length, 3)
})

test('nodeDeps.run forwards extra env variables to child processes', async () => {
  const out = await nodeDeps.run(process.execPath, ['-e', 'process.stdout.write(process.env.ORCA_AM_TEST_ENV || "")'], {
    env: { ORCA_AM_TEST_ENV: 'present' }
  })
  assert.equal(out, 'present')
})
