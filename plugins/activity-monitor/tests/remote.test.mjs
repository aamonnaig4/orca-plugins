import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLink, createRemote, hostInfo, parseCpuTimes, parseDf, parseInit, parseSnapshot, snapshotDeps, sshArgs, SCRIPT } from '../src/remote.ts'
import { buildSources, discover, readTargets } from '../src/sources.ts'
import { createSampler } from '../src/sampler.ts'

const STAT = 'cpu  10 0 10 80 0 0 0 0 0 0\ncpu0 5 0 5 40 0 0 0 0 0 0\ncpu1 5 0 5 30 10 1 1 1 0 0\nintr 1\n'
const MEMINFO = 'MemTotal:       65626552 kB\nMemFree:        40000000 kB\nMemAvailable:   49718132 kB\nBuffers:          100000 kB\nCached:          9000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n'

function init(host = 'srv-01') {
  return '@@init\nclk 100\npage 4096\nhome /home/me\nhost ' + host + '\n@@passwd\nroot:x:0:0::/root:/bin/sh\nme:x:1000:1000::/home/me:/bin/bash\n@@cpuinfo\nmodel name\t: AMD Ryzen 7\n@@ready\n'
}

function snap({ stat = STAT, procs = false } = {}) {
  let out = '@@begin\n@@file /proc/stat\n' + stat + '@@file /proc/meminfo\n' + MEMINFO + '@@file /proc/loadavg\n1.50 2.00 3.25 2/300 99\n'
  out += '@@file /sys/fs/cgroup/user.slice/user-1000.slice/cpu.max\n600000 100000\n@@file /sys/fs/cgroup/user.slice/user-1000.slice/memory.max\nmax\n'
  out += '@@df\n/dev/md1 1000 400 500 45% /\n'
  if (procs) out += '@@stats\n42 (node) S 1 42 42 0 -1 4194560 0 0 0 0 150 50 0 0 20 0 7 0 1234 0 2560 0 0\n43 (bash) S 1 43 43 0 -1 4194560 0 0 0 0 1 1 0 0 20 0 1 0 1300 0 100 0 0\n@@uids\n   42  1000\n   43     0\n'
  return out + '@@end\n'
}

test('the remote script has no single quote, so it fits one quoted sh -c argument', () => {
  assert.equal(SCRIPT.includes("'"), false)
})

test('parseInit reads tick, page size, home, host name, passwd and the CPU model', () => {
  const i = parseInit(init())
  assert.equal(i.clk, 100)
  assert.equal(i.page, 4096)
  assert.equal(i.home, '/home/me')
  assert.equal(i.host, 'srv-01')
  assert.match(i.passwd, /^root:x:0:0/)
  assert.match(i.cpuinfo, /AMD Ryzen 7/)
})

test('parseSnapshot splits files, df, process stat lines and uids', () => {
  const s = parseSnapshot(snap({ procs: true }), 5)
  assert.equal(s.at, 5)
  assert.equal(s.files.get('/proc/stat'), STAT)
  assert.equal(s.df, '/dev/md1 1000 400 500 45% /')
  assert.equal(s.procs, true)
  assert.deepEqual([...s.stats.keys()], [42, 43])
  assert.equal(s.uids.get(42), 1000)
})

test('a snapshot without process lines says so, so the process list keeps its last value', () => {
  assert.equal(parseSnapshot(snap()).procs, false)
})

test('parseCpuTimes folds iowait into idle and irq, softirq and steal into irq', () => {
  assert.deepEqual(parseCpuTimes(STAT), [
    { user: 5, nice: 0, sys: 5, idle: 40, irq: 0 },
    { user: 5, nice: 0, sys: 5, idle: 40, irq: 3 }
  ])
})

test('parseDf reads KiB totals and refuses a short line', () => {
  assert.deepEqual(parseDf('/dev/md1 1000 400 500 45% /'), { blocks: 1000, bsize: 1024, bavail: 500, bfree: 600 })
  assert.equal(parseDf('garbage'), null)
})

test('hostInfo gives load average and the per-user cgroup limit, with max as no limit', () => {
  assert.deepEqual(hostInfo(parseSnapshot(snap()), 'srv'), { name: 'srv', load: [1.5, 2, 3.25], cpuLimit: 6, memLimit: null, memUsed: null })
})

test('snapshotDeps answers the Linux provider from the snapshot', async () => {
  const s = parseSnapshot(snap({ procs: true }))
  const d = snapshotDeps(() => ({ snap: s, init: parseInit(init()) }))
  assert.equal(await d.read('/proc/meminfo'), MEMINFO)
  assert.match(await d.read('/proc/42/stat'), /^42 \(node\)/)
  assert.match(await d.read('/proc/42/status'), /^Uid:\t1000\t/)
  assert.equal(await d.read('/proc/42/io'), '')
  assert.deepEqual(await d.list('/proc'), ['42', '43'])
  assert.deepEqual(await d.list('/sys/class/power_supply'), [])
  assert.equal(await d.run('getconf', ['CLK_TCK']), '100')
  assert.equal(await d.run('nvidia-smi', []), null)
  assert.equal(await d.run('ps', []), null)
})

test('sshArgs prefers the ssh config alias, else the host, port, user and key Orca saved', () => {
  const alias = sshArgs({ id: 'a', label: 'dev', configHost: 'webdelo-dev' })
  assert.equal(alias.at(-2), 'webdelo-dev')
  assert.ok(alias.includes('BatchMode=yes'))
  const direct = sshArgs({ id: 'b', label: 'box', host: '10.0.0.2', port: 2222, username: 'me', identityFile: '/k', identitiesOnly: true })
  assert.equal(direct.at(-2), 'me@10.0.0.2')
  assert.ok(direct.includes('2222') && direct.includes('/k') && direct.includes('IdentitiesOnly=yes'))
  assert.match(direct.at(-1), /^exec sh -c '/)
})

function fakeSsh(script) {
  const spawned = []
  const spawn = (cmd, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    child.stdin = {
      write(line) { script.onLine(child, line) },
      end() {}
    }
    spawned.push({ cmd, args, child })
    setImmediate(() => script.onStart(child))
    return child
  }
  return { spawn, spawned }
}

test('a link connects once, then answers each request with one snapshot', async () => {
  const lines = []
  const ssh = fakeSsh({
    onStart: (c) => c.stdout.emit('data', init()),
    onLine: (c, line) => { lines.push(line); setImmediate(() => c.stdout.emit('data', snap({ procs: line === 'procs\n' }))) }
  })
  const link = createLink({ id: 't', label: 'dev', configHost: 'dev' }, { spawn: ssh.spawn })
  const a = await link.snapshot(false)
  const b = await link.snapshot(true)
  assert.equal(ssh.spawned.length, 1)
  assert.equal(ssh.spawned[0].cmd, 'ssh')
  assert.deepEqual(lines, ['tick\n', 'procs\n'])
  assert.equal(a.procs, false)
  assert.equal(b.procs, true)
  assert.equal(link.state().status, 'connected')
  assert.equal(link.init().host, 'srv-01')
  link.dispose()
})

test('a link that cannot connect reports the last ssh error line and waits before retrying', async () => {
  let now = 1000
  const ssh = fakeSsh({
    onStart: (c) => { c.stderr.emit('data', 'Warning: x\nme@dev: Permission denied (publickey).\n'); c.emit('exit', 255) },
    onLine: () => {}
  })
  const link = createLink({ id: 't', label: 'dev', configHost: 'dev' }, { spawn: ssh.spawn, clock: () => now })
  await assert.rejects(link.snapshot(false), /Permission denied \(publickey\)/)
  assert.equal(link.state().status, 'error')
  await assert.rejects(link.snapshot(false), /Permission denied/)
  assert.equal(ssh.spawned.length, 1)
  now += 6000
  await assert.rejects(link.snapshot(false), /Permission denied/)
  assert.equal(ssh.spawned.length, 2)
  link.dispose()
})

test('a remote sampler reads CPU, memory, disk, host limits and processes from the server', async () => {
  let tick = 0
  const ssh = fakeSsh({
    onStart: (c) => c.stdout.emit('data', init()),
    onLine: (c, line) => {
      tick += 1
      const busy = tick > 1 ? 'cpu  0 0 0 0\ncpu0 15 0 5 80 0 0 0 0\ncpu1 5 0 5 30 10 1 1 1\n' : STAT
      setImmediate(() => c.stdout.emit('data', snap({ stat: busy, procs: line === 'procs\n' })))
    }
  })
  const link = createLink({ id: 't', label: 'dev', configHost: 'dev' }, { spawn: ssh.spawn })
  const r = createRemote(link)
  const sampler = createSampler({ provider: r.provider, cpus: r.cpus, space: r.space, selfPids: [], settle: 1 })
  const first = await sampler.read({ procs: true })
  assert.equal(first.sample.cores.length, 2)
  assert.equal(first.sample.loads[0], 20)
  assert.equal(first.sample.memory.total, 65626552 * 1024)
  assert.equal(first.sample.disk.total, 1000 * 1024)
  assert.equal(first.sample.disk.name, 'Home')
  assert.deepEqual(first.sample.host.load, [1.5, 2, 3.25])
  assert.equal(first.sample.host.cpuLimit, 6)
  assert.equal(first.sample.host.name, 'srv-01')
  await new Promise((res) => setTimeout(res, 5))
  const quit = await sampler.quit(42, 'node', '1234', false)
  assert.equal(quit.ok, false)
  link.dispose()
})

test('buildSources lists this computer and only the SSH targets Orca is connected to', () => {
  const hosts = [
    { kind: 'local', id: 'local', name: 'this machine', machineName: 'My Mac' },
    { kind: 'ssh', id: 'a', name: 'webdelo-dev', connected: true },
    { kind: 'ssh', id: 'b', name: 'github.com', connected: false },
    { kind: 'ssh', id: 'c', name: 'raw', connected: true },
    { kind: 'environment', id: 'env', name: 'webdelo-dev' }
  ]
  const targets = new Map([
    ['a', { id: 'a', label: 'webdelo-dev', configHost: 'webdelo-dev', host: '1.2.3.4' }],
    ['c', { id: 'c', label: 'raw', configHost: null, host: '5.6.7.8', username: 'u' }]
  ])
  const out = buildSources(hosts, targets, new Set(['a']))
  assert.deepEqual(out.sources.map((s) => [s.id, s.label, s.server]), [['local', 'My Mac', false], ['ssh:a', 'webdelo-dev', true], ['ssh:c', 'raw', false]])
  assert.equal(out.targets.get('ssh:a').configHost, 'webdelo-dev')
  assert.equal(out.targets.get('ssh:c').configHost, null)
  assert.equal(out.targets.get('ssh:c').host, '5.6.7.8')
})

test('a connected target Orca has no saved record for is reached by its name as an ssh alias', () => {
  const out = buildSources([{ kind: 'ssh', id: 'z', name: 'box', connected: true }], new Map(), new Set())
  assert.equal(out.targets.get('ssh:z').configHost, 'box')
})

test('discover marks the SSH target an Orca server runs over', async () => {
  const cli = async (args) => {
    if (args[0] === 'host') return { ok: true, result: { hosts: [{ kind: 'ssh', id: 'a', name: 'dev', connected: true }, { kind: 'environment', id: 'env', name: 'dev' }] } }
    if (args[0] === 'environment') return { ok: true, result: { environment: { orcadDeployment: { sshTargetId: 'a' } } } }
    return null
  }
  const out = await discover(cli, async () => new Map())
  assert.equal(out.sources[1].server, true)
  assert.equal(await discover(async () => null, async () => new Map()), null)
})

test('readTargets keeps connection fields and leaves everything else out', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'am-targets-'))
  await mkdir(path.join(dir, 'p1'))
  await writeFile(path.join(dir, 'p1', 'orca-data.json'), JSON.stringify({ sshTargets: [{ id: 'a', label: 'dev', configHost: 'dev', host: 'h', port: 22, username: 'me', identityFile: '/k', identitiesOnly: true, password: 'nope' }] }))
  const out = await readTargets([dir])
  assert.deepEqual(out.get('a'), { id: 'a', label: 'dev', configHost: 'dev', host: 'h', port: 22, username: 'me', identityFile: '/k', identitiesOnly: true })
  assert.equal((await readTargets([path.join(dir, 'missing')])).size, 0)
})

test('a server that is not Linux is refused with a clear reason', async () => {
  const ssh = fakeSsh({
    onStart: (c) => c.stdout.emit('data', '@@init\nclk 100\nos Darwin\n@@ready\n'),
    onLine: () => {}
  })
  const link = createLink({ id: 't', label: 'mini', configHost: 'mini' }, { spawn: ssh.spawn })
  await assert.rejects(link.snapshot(false), /Only Linux servers are supported; mini runs Darwin/)
  assert.equal(ssh.spawned[0].child.killed, true)
  link.dispose()
})

test('a host or user name that could be read as an ssh option never reaches ssh', async () => {
  assert.throws(() => sshArgs({ id: 'x', label: 'x', configHost: '-oProxyCommand=touch /tmp/x' }), /Unsupported SSH host name/)
  assert.throws(() => sshArgs({ id: 'x', label: 'x', host: 'h', username: '-oX=y' }), /Unsupported SSH user name/)
  const ssh = fakeSsh({ onStart: () => {}, onLine: () => {} })
  const link = createLink({ id: 'x', label: 'x', configHost: '-evil' }, { spawn: ssh.spawn })
  await assert.rejects(link.snapshot(false), /Unsupported SSH host name/)
  assert.equal(ssh.spawned.length, 0)
  link.dispose()
})
