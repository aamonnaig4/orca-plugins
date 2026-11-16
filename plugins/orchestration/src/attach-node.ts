import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { AttachIo } from './attach.ts'

export function nodeAttachIo(dir: string): AttachIo {
  return {
    dir: () => dir,
    async save(path, bytes) {
      await mkdir(dir, { recursive: true })
      await writeFile(path, bytes)
    },
    async exists(path) {
      return (await stat(path).catch(() => null))?.isFile() ?? false
    }
  }
}
