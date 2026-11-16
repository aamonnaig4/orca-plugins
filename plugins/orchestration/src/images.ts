export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type ImageIo = {
  home(): string
  bytes(path: string, max: number): Promise<Uint8Array | null>
  fetch(url: string, max: number): Promise<{ type: string; bytes: Uint8Array } | null>
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false
  return true
}

export function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

export function localPath(src: string, home: string): string | null {
  let path = src
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return null
    }
  } else if (path.startsWith('~/')) path = home.replace(/\/+$/, '') + path.slice(1)
  if (!path.startsWith('/') || path.split('/').includes('..')) return null
  const ext = (path.split('.').pop() || '').toLowerCase()
  return TYPES[ext] ? path : null
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export async function readImage(src: string, io: ImageIo): Promise<string | null> {
  if (typeof src !== 'string' || src.length > 4096) return null
  let bytes: Uint8Array | null = null
  if (/^https:\/\//i.test(src)) {
    const got = await io.fetch(src, MAX_IMAGE_BYTES).catch(() => null)
    if (!got || !/^image\//i.test(got.type)) return null
    bytes = got.bytes
  } else {
    const path = localPath(src, io.home())
    if (!path) return null
    bytes = await io.bytes(path, MAX_IMAGE_BYTES).catch(() => null)
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  const type = sniff(bytes)
  return type ? `data:${type};base64,${toBase64(bytes)}` : null
}
