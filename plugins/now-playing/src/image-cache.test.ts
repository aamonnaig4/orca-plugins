import { assert, test } from 'orca/testing'
import { createImageCache } from './image-cache'

test('browsing new artwork evicts old covers but keeps recently used ones', () => {
  const cache = createImageCache(3, 100)
  cache.set('a', 'cover a')
  cache.set('b', 'cover b')
  cache.set('c', 'cover c')
  assert.equal(cache.get('a'), 'cover a')
  cache.set('d', 'cover d')
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 'cover a')
  assert.equal(cache.get('c'), 'cover c')
  assert.equal(cache.get('d'), 'cover d')
  // An evicted cover is a miss and can be loaded into the cache again.
  cache.set('b', 'reloaded')
  assert.equal(cache.get('b'), 'reloaded')
})

test('large covers stay within the total string budget, including their URLs', () => {
  const cache = createImageCache(100, 12)
  cache.set('one', '111')
  cache.set('two', '222')
  cache.set('three', '333')
  assert.equal(cache.get('one'), undefined)
  assert.equal(cache.get('two'), undefined)
  assert.equal(cache.get('three'), '333')
})

test('replacing a cover updates the budget without evicting other covers early', () => {
  const cache = createImageCache(3, 12)
  cache.set('a', '123456')
  cache.set('a', '1')
  cache.set('b', '123456789')
  assert.equal(cache.get('a'), '1')
  assert.equal(cache.get('b'), '123456789')
})

test('oversized covers do not evict reusable covers or stay retained', () => {
  const cache = createImageCache(3, 12)
  cache.set('a', '1')
  cache.set('big', 'x'.repeat(13))
  assert.equal(cache.get('a'), '1')
  assert.equal(cache.get('big'), undefined)
})

test('a long browsing session retains only the most recent bounded artwork', () => {
  const cache = createImageCache()
  for (let i = 0; i < 2000; i++) cache.set(String(i), 'data:image/jpeg;base64,' + 'x'.repeat(40_000))
  assert.equal(cache.get('0'), undefined)
  assert.equal(cache.get('1890'), undefined)
  assert.ok(cache.get('1999')?.startsWith('data:image/'))
})

test('has reports cached covers without changing which cover is evicted next', () => {
  const cache = createImageCache(2, 100)
  cache.set('a', 'cover a')
  cache.set('b', 'cover b')
  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('missing'), false)
  cache.set('c', 'cover c')
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true)
})
