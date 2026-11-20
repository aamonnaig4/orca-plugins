import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteSampler, HOST_RE, parseKill, parseProcStatCpus, parseStatF, sshArgs, sshDeps, sshHosts } from '../src/remote.ts'

function scripted(handler) {
  const calls = []
  const spawn = async (cmd, args, input, timeoutMs) => {
    calls.push({ cmd, args, input, timeoutMs })
    return handler({ cmd, args, input }, calls.length)
  }
  return { spawn, calls }
}

function shellEmulator(files, lists = {}, links = {}) {
  return ({ input }) => {
    let out = ''
    for (const m of input.matchAll(/printf '\\n%s\\n' '([^']+)'\n(?:(cat|ls -1A|readlink) -- '((?:[^']|'\\'')*)' 2>\/dev\/null\n)?/g)) {
      out += '\n' + m[1] + '\n'
      if (!m[2]) continue
      const path = m[3].replace(/'\\''/g, "'")
      if (m[2] === 'cat') out += files[path] ?? ''
      else if (m[2] === 'ls -1A') out += (lists[path] ?? []).map((n) => n + '\n').join('')
      else out += links[path] !== undefined ? links[path] + '\n' : ''
    }
    return { code: 0, out, err: '' }
  }
}

test('reads issued in one tick share one ssh exec and keep their bytes intact', async () => {
  const files = { '/a': 'one\n', '/b': 'x\0y\nz', '/c': '', "/it's": 'quoted', '/d': '\n@@am:deadbeef:1\nstill content\n' }
  const { spawn, calls } = scripted(shellEmulator(files, { '/dir': ['p', 'q'] }, { '/l': '/dest' }))
  const deps = sshDeps('devbox', spawn)
  const [a, b, c, q, d, list, link, nolink] = await Promise.all([
    deps.read('/a'), deps.read('/b'), deps.read('/c'), deps.read("/it's"), deps.read('/d'), deps.list('/dir'), deps.readlink('/l'), deps.readlink('/none')
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'ssh')
  assert.equal(calls[0].args.at(-2), 'sh')
  assert.equal(calls[0].args.at(-1), '-s')
  assert.deepEqual([a, b, c, q, d], ['one\n', 'x\0y\nz', '', 'quoted', files['/d']])
  assert.deepEqual(list, ['p', 'q'])
  assert.equal(link, '/dest')
  assert.equal(nolink, null)
  assert.match(calls[0].input, /cat -- '\/it'\\''s'/)
  assert.equal(deps.error(), null)
})

test('a failed exec resolves empty, records the first stderr line and clears on success', async () => {
  let fail = true
  const { spawn } = scripted((req) => (fail ? { code: 255, out: '', err: '\nssh: Could not resolve hostname x\nmore\n' } : shellEmulator({ '/a': 'ok' })(req)))
  const deps = sshDeps('devbox', spawn)
  assert.equal(await deps.read('/a'), '')
  assert.deepEqual(await deps.list('/a'), [])
  assert.equal(await deps.readlink('/a'), null)
  assert.equal(deps.error(), 'ssh: Could not resolve hostname x')
  fail = false
  assert.equal(await deps.read('/a'), 'ok')
  assert.equal(deps.error(), null)
})

test('a truncated reply resolves the missing reads as empty', async () => {
  const { spawn } = scripted((req) => {
    const full = shellEmulator({ '/a': 'A', '/b': 'B' })(req)
    return { ...full, out: full.out.slice(0, full.out.indexOf('B')) }
  })
  const deps = sshDeps('devbox', spawn)
  const [a, b] = await Promise.all([deps.read('/a'), deps.read('/b')])
  assert.equal(a, 'A')
  assert.equal(b, '')
})

test('run maps exit codes like the local deps', async () => {
  const codes = [0, 1, 1, 255]
  const { spawn, calls } = scripted(() => ({ code: codes.shift(), out: 'out', err: 'boom' }))
  const deps = sshDeps('devbox', spawn)
  assert.equal(await deps.run('echo', ['a b', "it's"]), 'out')
  assert.equal(await deps.run('false', []), null)
  assert.equal(await deps.run('false', [], { anyExit: true }), 'out')
  assert.equal(await deps.run('x', []), null)
  assert.equal(deps.error(), 'boom')
  assert.equal(calls[0].input, "exec 'echo' 'a b' 'it'\\''s' </dev/null\n")
})

test('the first exec runs alone and at most four run at once', async () => {
  let live = 0
  let peak = 0
  const starts = []
  const { spawn } = scripted(async () => {
    starts.push(live)
    live += 1
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 15))
    live -= 1
    return { code: 0, out: 'x', err: '' }
  })
  const deps = sshDeps('devbox', spawn)
  await Promise.all(Array.from({ length: 10 }, (_, i) => deps.run('echo', [String(i)])))
  assert.equal(starts[0], 0)
  assert.equal(starts[1], 0)
  assert.equal(peak, 4)
})

test('a batch over 2000 ops splits into several execs', async () => {
  const { spawn, calls } = scripted(shellEmulator({}))
  const deps = sshDeps('devbox', spawn)
  await Promise.all(Array.from({ length: 2500 }, (_, i) => deps.read('/f' + i)))
  assert.equal(calls.length, 2)
})

test('close asks the master to exit', async () => {
  const { spawn, calls } = scripted(() => ({ code: 0, out: '', err: '' }))
  await sshDeps('devbox', spawn).close()
  assert.deepEqual(calls[0].args, ['-O', 'exit', '-o', 'ControlPath=/tmp/orca-am-' + process.getuid() + '-%C', 'devbox'])
})

test('hosts that could be read as ssh options are refused', () => {
  assert.throws(() => sshDeps('-oProxyCommand=x'))
  assert.throws(() => sshArgs('a b'))
  assert.equal(HOST_RE.test('devbox.lan'), true)
  const args = sshArgs('devbox')
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ControlPath=/tmp/orca-am-' + process.getuid() + '-%C'))
})

test('sshHosts lists concrete aliases only', () => {
  const text = `Host *
  User me
host devbox nas # home
  HostName 192.0.2.10
Host web-* !bad ?x
Host devbox other
Host -oProxyCommand=x
# Host commented
`
  assert.deepEqual(sshHosts(text), ['devbox', 'nas', 'other'])
})

test('parseProcStatCpus orders per-core counters and skips the aggregate', () => {
  const text = 'cpu  9 9 9 9 9 9 9 0 0 0\ncpu1 10 1 20 300 5 2 3 0 0 0\ncpu0 11 2 21 301 6 4 5 0 0 0\nintr 1\n'
  assert.deepEqual(parseProcStatCpus(text), [
    { user: 11, nice: 2, sys: 21, idle: 301, irq: 4 },
    { user: 10, nice: 1, sys: 20, idle: 300, irq: 2 }
  ])
  assert.deepEqual(parseProcStatCpus(''), [])
})

test('parseStatF and parseKill read the command output', () => {
  assert.deepEqual(parseStatF('4096 1000 400 300\n'), { bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 })
  assert.equal(parseStatF(''), null)
  assert.equal(parseStatF('a b c d'), null)
  assert.deepEqual(parseKill('rc=0\n'), { ok: true })
  assert.deepEqual(parseKill('sh: 1: kill: No such process\nrc=1\n'), { ok: false, reason: 'Already gone' })
  assert.deepEqual(parseKill('sh: 1: kill: Operation not permitted\nrc=1\n'), { ok: false, reason: 'Not allowed: another user owns it' })
  assert.deepEqual(parseKill('weird\nrc=2\n'), { ok: false, reason: 'Could not quit it' })
  assert.deepEqual(parseKill(null), { ok: false, reason: 'Could not reach the machine' })
})

const MEMINFO = 'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nBuffers: 0 kB\nCached: 200 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n'
const STAT = 'cpu 1 0 1 1 0 0 0 0 0 0\ncpu0 100 0 50 850 0 0 0 0 0 0\ncpu1 10 0 5 985 0 0 0 0 0 0\n'

function devboxHandler(state) {
  const files = { '/proc/meminfo': MEMINFO, '/proc/stat': STAT, '/proc/1/stat': '1 (systemd) S 0 1 1 0 0 0 0 0 0 0 5 5 0 0 20 0 1 0 100 4096 10 0\n' }
  const emulate = shellEmulator(files, { '/proc': ['1', 'self'] })
  return (req) => {
    if (state.down) return { code: 255, out: '', err: 'ssh: connect to host devbox port 22: Connection refused\n' }
    if (!req.input.startsWith('exec ')) return emulate(req)
    if (req.input.startsWith("exec 'uname'")) return { code: 0, out: state.kernel ?? 'Linux\n', err: '' }
    if (req.input.startsWith("exec 'stat'")) return { code: 0, out: '4096 1000 400 300\n', err: '' }
    if (req.input.startsWith("exec 'getconf'")) return { code: 0, out: '100\n', err: '' }
    if (req.input.startsWith("exec 'sh'")) return { code: 0, out: 'rc=0\n', err: '' }
    return { code: 127, out: '', err: '' }
  }
}

test('the remote sampler reads the remote numbers', async () => {
  const { spawn } = scripted(devboxHandler({}))
  const { sampler, deps } = createRemoteSampler('devbox', spawn)
  const out = await sampler.read({ procs: true })
  assert.equal(out.sample.memory.total, 1000 * 1024)
  assert.equal(out.sample.cores.length, 2)
  assert.equal(out.sample.disk.total, 4096 * 1000)
  assert.deepEqual(out.procs.map((p) => p.name), ['systemd'])
  await deps.close()
})

test('a failed batch rejects instead of falling back to the local memory', async () => {
  const { spawn } = scripted(devboxHandler({ down: true }))
  const { sampler } = createRemoteSampler('devbox', spawn)
  await assert.rejects(sampler.read({}), /Connection refused/)
})

test('a machine that is not Linux is refused', async () => {
  const { spawn } = scripted(devboxHandler({ kernel: 'Darwin\n' }))
  const { sampler } = createRemoteSampler('mac', spawn)
  await assert.rejects(sampler.read({}), /Only Linux machines are supported/)
})
