import { open } from 'node:fs/promises'
import os from 'node:os'
import type { ImageIo } from './images.ts'

const FETCH_MS = 10000

async function readCapped(path: string, max: number): Promise<Uint8Array | null> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) return null
    const buf = Buffer.alloc(info.size)
    await handle.read(buf, 0, info.size, 0)
    return new Uint8Array(buf)
  } finally {
    await handle.close()
  }
}

async function fetchCapped(url: string, max: number): Promise<{ type: string; bytes: Uint8Array } | null> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_MS) })
  if (!res.ok) return null
  const length = Number(res.headers.get('content-length') || 0)
  if (length > max) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  return bytes.length > max ? null : { type: res.headers.get('content-type') || '', bytes }
}

export const nodeImageIo: ImageIo = {
  home: () => os.homedir(),
  bytes: readCapped,
  fetch: fetchCapped
}
