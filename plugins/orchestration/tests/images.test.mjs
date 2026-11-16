import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localPath, readImage, sniff } from '../src/images.ts'

const enc = (s) => new TextEncoder().encode(s)

test('sniff recognises real image bytes and nothing else', () => {
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniff(enc('GIF89a')), 'image/gif')
  assert.equal(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  assert.equal(sniff(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml')
  assert.equal(sniff(enc('<html><svg></svg></html>')), null)
  assert.equal(sniff(enc('ssh-rsa AAAA')), null)
})

test('localPath takes absolute, home and file URLs with an image extension only', () => {
  assert.equal(localPath('/a/b.PNG', '/h'), '/a/b.PNG')
  assert.equal(localPath('~/s.jpg', '/h/'), '/h/s.jpg')
  assert.equal(localPath('file:///a/my%20shot.webp', '/h'), '/a/my shot.webp')
  assert.equal(localPath('/a/../etc/x.png', '/h'), null)
  assert.equal(localPath('rel/x.png', '/h'), null)
  assert.equal(localPath('/a/notes.txt', '/h'), null)
})

test('readImage fetches https images, checks the type and the bytes, and caps the size', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const io = (got) => ({ home: () => '/h', bytes: async () => null, fetch: async () => got })
  assert.equal(await readImage('https://x/a.png', io({ type: 'image/png', bytes: png })), 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(await readImage('https://x/a', io({ type: 'text/html', bytes: png })), null)
  assert.equal(await readImage('https://x/a', io({ type: 'image/png', bytes: enc('<html>') })), null)
  assert.equal(await readImage('https://x/a', io(null)), null)
  assert.equal(await readImage('https://x/a', { home: () => '/h', bytes: async () => null, fetch: async () => { throw new Error('down') } }), null)
  assert.equal(await readImage('http://x/a.png', io({ type: 'image/png', bytes: png })), null)
})
