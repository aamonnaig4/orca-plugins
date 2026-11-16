import test from 'node:test'
import assert from 'node:assert/strict'
import { createWeb } from '../src/web.ts'

const board = () => ({ rows: [{ key: 'k1', name: 'alpha' }], idle: [], at: 5 })

test('the board page server answers the page, its files and the board data on localhost only', async () => {
  const web = createWeb({ board, port: 0 })
  try {
    const url = await web.start()
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal(await web.start(), url)
    assert.equal(web.url(), url)
    const page = await fetch(url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    const html = await page.text()
    assert.ok(html.includes('board-page.js') && html.includes('id="board"'))
    for (const ref of [...html.matchAll(/(?:href|src)="([\w.-]+\.(?:css|js))"/g)].map((m) => m[1])) {
      const res = await fetch(url + ref)
      assert.equal(res.status, 200, ref)
      assert.ok((await res.text()).length > 0, ref)
    }
    const data = await (await fetch(url + 'view.json?x=1')).json()
    assert.deepEqual(data, board())
  } finally {
    web.stop()
  }
  assert.equal(web.url(), null)
})

test('the board page server is read only and serves nothing outside its list', async () => {
  const web = createWeb({ board, port: 0 })
  try {
    const url = await web.start()
    for (const path of ['app.js', 'chat.js', '../src/worker.ts', '%2e%2e/orca-plugin.json', 'panel/app.js']) {
      assert.equal((await fetch(url + path)).status, 404, path)
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(url + 'view.json', { method })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    }
  } finally {
    web.stop()
  }
})

test('the board page server falls back to a free port when its own is taken and reports a board that throws', async () => {
  const first = createWeb({ board, port: 0 })
  const taken = Number(new URL(await first.start()).port)
  const second = createWeb({ board: () => { throw new Error('boom') }, port: taken })
  try {
    const url = await second.start()
    assert.notEqual(Number(new URL(url).port), taken)
    assert.equal((await fetch(url + 'view.json')).status, 500)
  } finally {
    first.stop()
    second.stop()
  }
})
