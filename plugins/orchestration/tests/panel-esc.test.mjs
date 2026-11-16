import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function load() {
  const window = {}
  vm.runInNewContext(readFileSync(new URL('../panel/esc.js', import.meta.url), 'utf8'), { window })
  return window.OrchEsc
}

test('html escapes tags, ampersands and quotes', () => {
  assert.equal(load().html('<img src=x onerror=1>&"'), '&lt;img src=x onerror=1&gt;&amp;&quot;')
})

test('html escapes single quotes and survives null, undefined and numbers', () => {
  const esc = load()
  assert.equal(esc.html("it's"), 'it&#39;s')
  assert.equal(esc.html(null), '')
  assert.equal(esc.html(undefined), '')
  assert.equal(esc.html(4), '4')
})
