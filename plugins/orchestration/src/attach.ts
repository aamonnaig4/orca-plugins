export const MAX_ATTACH_BYTES = 4 * 1024 * 1024
export const MAX_ATTACH_FILES = 4

export type AttachIo = {
  dir(): string
  save(path: string, bytes: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim().slice(0, 100)
  return clean === '' ? 'file' : clean
}

export function decode(data: string): Uint8Array | null {
  const body = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data
  if (body.length % 4 !== 0 || !BASE64.test(body)) return null
  if ((body.length / 4) * 3 > MAX_ATTACH_BYTES + 2) return null
  const bytes = new Uint8Array(Buffer.from(body, 'base64'))
  return bytes.length > MAX_ATTACH_BYTES ? null : bytes
}

export async function saveAttachment(io: AttachIo, name: string, data: string, stamp: string): Promise<{ path: string; name: string } | null> {
  const bytes = decode(data)
  if (!bytes) return null
  const clean = safeName(name)
  const path = `${io.dir()}/${stamp}-${clean}`
  await io.save(path, bytes)
  return { path, name: clean }
}

export async function checkAttachments(io: AttachIo, paths: unknown): Promise<string[] | null> {
  if (paths === undefined) return []
  if (!Array.isArray(paths) || paths.length > MAX_ATTACH_FILES) return null
  const dir = io.dir() + '/'
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(dir) || p.slice(dir.length).includes('/')) return null
    if (!(await io.exists(p))) return null
    out.push(p)
  }
  return out
}

export function withAttachments(body: string, paths: string[]): string {
  if (paths.length === 0) return body
  return (body === '' ? '' : body + '\n\n') + 'Attached files:\n' + paths.map((p) => '- ' + p).join('\n')
}

export function attachedNote(body: string, paths: string[]): string {
  if (paths.length === 0) return body
  const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1).replace(/^\d+-[a-z0-9]+-/, ''))
  return (body === '' ? '' : body + '\n\n') + 'Attached: ' + names.join(', ')
}
