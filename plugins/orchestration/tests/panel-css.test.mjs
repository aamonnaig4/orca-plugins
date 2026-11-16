import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = (name) => readFileSync(new URL('../panel/' + name, import.meta.url), 'utf8')
const FILES = ['style.css', 'board.css']

function selectors(text) {
  const out = []
  const re = /([^{}]+)\{/g
  let m
  while ((m = re.exec(text))) for (const part of m[1].split(',')) out.push(part.trim())
  return out
}

test('style.css defines .btn.danger', () => {
  assert.ok(selectors(css('style.css')).some((s) => /(^|\s)\.btn\.danger(?![\w-])/.test(s)))
})

test('board.css defines no rule ending in .row-title or .row-sub', () => {
  for (const s of selectors(css('board.css'))) assert.ok(!/\.row-(title|sub)$/.test(s), s)
})

test('the panel page loads no stylesheet or script that is missing', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const refs = [...html.matchAll(/(?:href|src)="([\w.-]+\.(?:css|js))"/g)].map((m) => m[1])
  assert.ok(refs.length >= 6)
  for (const ref of refs) assert.ok(readFileSync(new URL('../panel/' + ref, import.meta.url), 'utf8').length > 0, ref)
  for (const gone of ['detail.js', 'settings.js', 'detail.css', 'board.js', 'board.css']) assert.ok(!refs.includes(gone), gone)
})

test('no stylesheet contains a comment', () => {
  for (const file of FILES) assert.ok(!css(file).includes('/*'), file)
})
