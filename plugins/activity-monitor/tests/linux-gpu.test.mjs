import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createLinux } from '../src/linux.ts'

function gpuFixture(t) {
  let now = 100_000
  let utilization = 35
  let reverseDevices = false
  t.mock.method(Date, 'now', () => now)
  const root = '/fixture'
  const pci = root + '/sys/bus/pci/devices'
  const files = new Map()
  const reads = []
  const lists = []
  let queries = 0
  const linux = createLinux({
    async run(command) {
      if (command !== 'nvidia-smi') return null
      queries += 1
      return utilization + ', NVIDIA Test GPU\n'
    },
    async read(path) {
      reads.push(path)
      return files.get(path) ?? ''
    },
    async list(path) {
      lists.push(path)
      const prefix = path + '/'
      const names = [...new Set([...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split('/')[0]))]
      return path === pci && reverseDevices ? names.reverse() : names
    }
  }, root)
  return {
    files, reads, lists, pci,
    get queries() { return queries },
    set utilization(value) { utilization = value },
    set reverseDevices(value) { reverseDevices = value },
    device(name, vendor = '0x10de', klass = '0x030200', state = 'active') {
      const path = pci + '/' + name
      files.set(path + '/vendor', vendor + '\n')
      files.set(path + '/class', klass + '\n')
      files.set(path + '/power/runtime_status', state + '\n')
      return path
    },
    async sample(advance = 3_000) {
      now += advance
      await linux.read()
      // All fixture I/O resolves immediately; drain the background GPU refresh.
      await setImmediate()
      return (await linux.read()).gpu
    },
    pciLists() { return lists.filter((path) => path === pci).length },
    metadataReads() { return reads.filter((path) => /\/(vendor|class)$/.test(path)).length }
  }
}

test('NVIDIA active polling reuses PCI metadata and verifies identities before declaring sleep', async (t) => {
  const h = gpuFixture(t)
  for (let i = 0; i < 64; i++) h.device('0000:' + i.toString(16).padStart(2, '0') + ':01.0', '0x8086', '0x020000')
  const gpu = h.device('0001:01:00.0')
  h.device('0001:01:00.1', '0x10de', '0x040300', 'suspended')
  h.device('0001:02:00.0', '0x1002', '0x030000', 'suspended')
  assert.deepEqual(await h.sample(0), { utilization: 35, model: 'NVIDIA Test GPU' })
  assert.equal(h.pciLists(), 0)
  await h.sample()
  h.files.set(gpu + '/power/runtime_status', 'suspended\n')
  assert.deepEqual(await h.sample(), { utilization: 0, model: 'NVIDIA GPU (asleep)' })
  assert.equal(h.queries, 2)
  h.files.set(gpu + '/power/runtime_status', 'active\n')
  h.utilization = 72
  assert.deepEqual(await h.sample(), { utilization: 72, model: 'NVIDIA Test GPU' })
  assert.equal(h.queries, 3)
  assert.equal(h.pciLists(), 3)
  // Each identity scan reads every vendor, but classes only for NVIDIA functions.
  assert.equal(h.metadataReads(), (67 + 2) * 2)
  assert.deepEqual(h.reads.filter((path) => path.endsWith('/power/runtime_status')), Array(4).fill(gpu + '/power/runtime_status'))
})

test('an added active NVIDIA GPU is found on the next poll while the existing GPU is asleep', async (t) => {
  const h = gpuFixture(t)
  h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  const added = h.device('0000:02:00.0')
  h.utilization = 48
  assert.deepEqual(await h.sample(), { utilization: 48, model: 'NVIDIA Test GPU' })
  assert.equal(h.pciLists(), 2)
  assert.equal(h.metadataReads(), 6)
  assert.equal(h.queries, 2)
  h.files.set(added + '/power/runtime_status', 'suspended\n')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 10)
  assert.equal(h.queries, 2)
})

for (const [vendor, klass] of [['0x8086', '0x030000'], ['0x10de', '0x040300']]) {
  test(`an active NVIDIA replacement at the same BDF is found after ${vendor}/${klass} was cached`, async (t) => {
    const h = gpuFixture(t)
    h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
    h.device('0000:02:00.0', vendor, klass, 'suspended')
    await h.sample(0)
    assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
    h.device('0000:02:00.0', '0x10de', '0x030200', 'active')
    h.utilization = 61
    assert.deepEqual(await h.sample(), { utilization: 61, model: 'NVIDIA Test GPU' })
    assert.equal(h.queries, 2)
  })
}

test('a cached NVIDIA function replaced by another vendor at the same BDF cannot establish sleep', async (t) => {
  const h = gpuFixture(t)
  h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  h.device('0000:01:00.0', '0x8086', '0x030000', 'suspended')
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.queries, 2)
})

test('missing metadata on a cached NVIDIA function prevents sleep and is retried next poll', async (t) => {
  const h = gpuFixture(t)
  const gpu = h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  await h.sample()
  h.files.delete(gpu + '/vendor')
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.queries, 2)
  h.files.set(gpu + '/vendor', '0x10de\n')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.queries, 2)
})

test('a replaced NVIDIA device is discovered in the same poll even with the same device count', async (t) => {
  const h = gpuFixture(t)
  const removed = h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  await h.sample()
  for (const path of h.files.keys()) if (path.startsWith(removed + '/')) h.files.delete(path)
  const added = h.device('0000:02:00.0', '0x10de', '0x030200', 'suspended')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.queries, 1)
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 6)
  assert.equal(h.queries, 1)
  assert.equal(h.reads.filter((path) => path === removed + '/power/runtime_status').length, 1)
  assert.equal(h.reads.filter((path) => path === added + '/power/runtime_status').length, 3)
})

test('removing one of two NVIDIA GPUs does not wake the remaining suspended GPU', async (t) => {
  const h = gpuFixture(t)
  const removed = h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  const remaining = h.device('0000:02:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  await h.sample()
  for (const path of h.files.keys()) if (path.startsWith(removed + '/')) h.files.delete(path)
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.queries, 1)
  assert.equal(h.pciLists(), 2)
  assert.equal(h.metadataReads(), 6)
  assert.equal(h.reads.filter((path) => path === remaining + '/power/runtime_status').length, 2)
  await h.sample()
  assert.equal(h.queries, 1)
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 8)
})

test('NVIDIA falls back after one incomplete status recheck and recovers on the next poll', async (t) => {
  const h = gpuFixture(t)
  const gpu = h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  await h.sample(0)
  await h.sample()
  h.files.delete(gpu + '/power/runtime_status')
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.queries, 2)
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 4)
  h.files.set(gpu + '/power/runtime_status', 'suspended\n')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.queries, 2)
  assert.equal(h.pciLists(), 4)
  assert.equal(h.metadataReads(), 6)
})

test('empty NVIDIA discovery is retried on the next poll', async (t) => {
  const h = gpuFixture(t)
  await h.sample(0)
  await h.sample()
  assert.equal(h.pciLists(), 1)
  assert.equal(h.queries, 2)
  h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.pciLists(), 2)
  assert.equal(h.queries, 2)
})

test('incomplete PCI metadata cannot report all GPUs asleep and is retried on the next poll', async (t) => {
  const h = gpuFixture(t)
  h.device('0000:01:00.0', '0x10de', '0x030200', 'suspended')
  const other = h.device('0000:02:00.0', '0x10de', '0x030000', 'suspended')
  h.files.delete(other + '/class')
  await h.sample(0)
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.queries, 2)
  h.files.set(other + '/class', '0x030000\n')
  assert.equal((await h.sample()).model, 'NVIDIA GPU (asleep)')
  assert.equal(h.pciLists(), 2)
  assert.equal(h.metadataReads(), 8)
  assert.equal(h.queries, 2)
  await h.sample()
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 12)
})

test('PCI directory order changes do not invalidate cached active NVIDIA identities', async (t) => {
  const h = gpuFixture(t)
  h.device('0000:01:00.0')
  h.device('0000:02:00.0', '0x8086', '0x020000')
  await h.sample(0)
  await h.sample()
  h.reverseDevices = true
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.pciLists(), 2)
  assert.equal(h.metadataReads(), 3)
  assert.equal(h.queries, 3)
})

test('cached active NVIDIA PCI identities are refreshed after a minute', async (t) => {
  const h = gpuFixture(t)
  h.device('0000:01:00.0')
  await h.sample(0)
  await h.sample()
  await h.sample(57_000)
  assert.equal(h.metadataReads(), 2)
  assert.equal((await h.sample()).model, 'NVIDIA Test GPU')
  assert.equal(h.pciLists(), 3)
  assert.equal(h.metadataReads(), 4)
  assert.equal(h.queries, 4)
})
