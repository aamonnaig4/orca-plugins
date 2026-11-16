import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_ATTACH_BYTES, attachedNote, checkAttachments, decode, safeName, saveAttachment, withAttachments } from '../src/attach.ts'
import { nodeAttachIo } from '../src/attach-node.ts'

function fakeIo() {
  const files = new Map()
  return { files, dir: () => '/h/inbox', async save(p, b) { files.set(p, b) }, async exists(p) { return files.has(p) } }
}

const b64 = (text) => Buffer.from(text).toString('base64')

test('safeName keeps a plain file name and strips folders and odd characters', () => {
  assert.equal(safeName('shot.png'), 'shot.png')
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('C:\\Users\\me\\notes.txt'), 'notes.txt')
  assert.equal(safeName('.hidden'), 'hidden')
  assert.equal(safeName('a<b>|c.md'), 'a_b__c.md')
  assert.equal(safeName('...'), 'file')
  assert.equal(safeName('x'.repeat(300)).length, 100)
})

test('decode takes base64 or a data URL and refuses bad or oversized input', () => {
  assert.equal(Buffer.from(decode(b64('hello'))).toString(), 'hello')
  assert.equal(Buffer.from(decode('data:text/plain;base64,' + b64('hi'))).toString(), 'hi')
  assert.equal(decode('not base64!'), null)
  assert.equal(decode('abc'), null)
  assert.equal(decode(Buffer.alloc(MAX_ATTACH_BYTES + 1).toString('base64')), null)
  assert.equal(decode(Buffer.alloc(MAX_ATTACH_BYTES).toString('base64')).length, MAX_ATTACH_BYTES)
})

test('saveAttachment writes the bytes under the inbox with a stamped name', async () => {
  const io = fakeIo()
  const saved = await saveAttachment(io, '../a b.txt', b64('hey'), '17-ab')
  assert.deepEqual(saved, { path: '/h/inbox/17-ab-a b.txt', name: 'a b.txt' })
  assert.equal(Buffer.from(io.files.get(saved.path)).toString(), 'hey')
  assert.equal(await saveAttachment(io, 'x', '***', '1-a'), null)
})

test('checkAttachments accepts only saved files directly inside the inbox, at most four', async () => {
  const io = fakeIo()
  for (const n of [1, 2, 3, 4, 5]) io.files.set('/h/inbox/' + n, new Uint8Array())
  io.files.set('/h/inbox/7-ab-v1..2.png', new Uint8Array())
  assert.deepEqual(await checkAttachments(io, ['/h/inbox/7-ab-v1..2.png']), ['/h/inbox/7-ab-v1..2.png'])
  assert.deepEqual(await checkAttachments(io, undefined), [])
  assert.deepEqual(await checkAttachments(io, ['/h/inbox/1', '/h/inbox/2']), ['/h/inbox/1', '/h/inbox/2'])
  for (const bad of ['nope', [1], ['/h/inbox/9'], ['/etc/passwd'], ['/h/inbox/../x'], ['/h/inbox/a/b'], ['/h/inbox2/1'], ['/h/inbox/1', '/h/inbox/2', '/h/inbox/3', '/h/inbox/4', '/h/inbox/5']]) {
    assert.equal(await checkAttachments(io, bad), null, JSON.stringify(bad))
  }
})

test('the orchestrator gets full paths and the chat shows only the names', () => {
  const paths = ['/h/inbox/17-ab12cd34-a.png', '/h/inbox/17-ef56-b.txt']
  assert.equal(withAttachments('look', paths), 'look\n\nAttached files:\n- /h/inbox/17-ab12cd34-a.png\n- /h/inbox/17-ef56-b.txt')
  assert.equal(withAttachments('', paths.slice(0, 1)), 'Attached files:\n- /h/inbox/17-ab12cd34-a.png')
  assert.equal(withAttachments('look', []), 'look')
  assert.equal(attachedNote('look', paths), 'look\n\nAttached: a.png, b.txt')
  assert.equal(attachedNote('', paths), 'Attached: a.png, b.txt')
})

test('the node io creates the inbox and reports only regular files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orch-attach-'))
  try {
    const io = nodeAttachIo(root + '/inbox')
    const saved = await saveAttachment(io, 'n.txt', b64('on disk'), '5-x')
    assert.equal(await readFile(saved.path, 'utf8'), 'on disk')
    assert.equal(await io.exists(saved.path), true)
    assert.equal(await io.exists(root + '/inbox'), false)
    assert.equal(await io.exists(root + '/inbox/missing'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
