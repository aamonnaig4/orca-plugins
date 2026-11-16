import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const WEB_PORT = 4319

const FILES: Record<string, [string, string]> = {
  '/': ['web/board.html', 'text/html; charset=utf-8'],
  '/board-page.js': ['web/board-page.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['panel/style.css', 'text/css; charset=utf-8'],
  '/board.css': ['panel/board.css', 'text/css; charset=utf-8'],
  '/esc.js': ['panel/esc.js', 'text/javascript; charset=utf-8'],
  '/time.js': ['panel/time.js', 'text/javascript; charset=utf-8'],
  '/board.js': ['panel/board.js', 'text/javascript; charset=utf-8']
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

export type BoardData = { rows: unknown[]; idle: unknown[]; at: number }

export function createWeb(o: { board(): BoardData; root?: string; port?: number }) {
  const root = o.root ?? fileURLToPath(new URL('..', import.meta.url))
  let server: Server | null = null
  let url: string | null = null
  let starting: Promise<string> | null = null

  function send(res: ServerResponse, code: number, type: string, body: string): void {
    res.writeHead(code, { ...HEADERS, 'Content-Type': type })
    res.end(body)
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD')
      return send(res, 405, 'text/plain; charset=utf-8', 'Read only')
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/view.json') {
      let body: string
      try {
        body = JSON.stringify(o.board())
      } catch {
        return send(res, 500, 'text/plain; charset=utf-8', 'Could not read the board')
      }
      return send(res, 200, 'application/json; charset=utf-8', req.method === 'HEAD' ? '' : body)
    }
    const hit = Object.prototype.hasOwnProperty.call(FILES, path) ? FILES[path] : null
    if (!hit) return send(res, 404, 'text/plain; charset=utf-8', 'Not found')
    try {
      const text = await readFile(root + '/' + hit[0], 'utf8')
      send(res, 200, hit[1], req.method === 'HEAD' ? '' : text)
    } catch {
      send(res, 500, 'text/plain; charset=utf-8', 'Could not read the page')
    }
  }

  function listen(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const made = createServer((req, res) => {
        void onRequest(req, res)
      })
      made.once('error', reject)
      made.listen(port, '127.0.0.1', () => {
        made.removeListener('error', reject)
        const addr = made.address()
        const bound = addr !== null && typeof addr === 'object' ? addr.port : port
        server = made
        url = `http://127.0.0.1:${bound}/`
        resolve(url)
      })
    })
  }

  return {
    start(): Promise<string> {
      if (url) return Promise.resolve(url)
      if (starting) return starting
      const first = o.port ?? WEB_PORT
      starting = listen(first)
        .catch((error: { code?: string }) => {
          if (first !== 0 && error.code === 'EADDRINUSE') return listen(0)
          throw error
        })
        .finally(() => {
          starting = null
        })
      return starting
    },
    url(): string | null {
      return url
    },
    stop(): void {
      const old = server
      server = null
      url = null
      old?.close()
      old?.closeAllConnections?.()
    }
  }
}
