import { chmod, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Deps, Settings } from './deps.ts'
import { standingInstructions } from './instructions.ts'
import { parsePlan } from './board.ts'
import type { PlanStep } from './board.ts'

export type OutMsg =
  | { kind: 'text' | 'progress' | 'result'; text: string }
  | { kind: 'question'; text: string; options: string[] }
  | { kind: 'plan'; steps: PlanStep[] }
  | { kind: 'track'; dispatchId: string }
  | { kind: 'tell'; target: string; text: string }

const MAX_MESSAGE_BYTES = 16384
const MAX_HEADER_BYTES = 4096
const MAX_READ_BYTES = MAX_MESSAGE_BYTES + 2 * MAX_HEADER_BYTES

const ALLOW = ['Bash(orca:*)', 'Bash(gh:*)', 'Bash(./bin/say:*)', 'Bash(./bin/tell:*)', 'Read(board.md)']

export type Launch = { model: string; effort: string; fast: boolean; mode: string }

export type HomeOptions = { marker: string; workerAgent: string; suffix: string; workerFlags?: string; plan?: boolean; launch?: Launch }

export const NO_LAUNCH: Launch = { model: '', effort: '', fast: false, mode: '' }

export function launchOf(s: Settings): Launch {
  return { model: s.model, effort: s.effort, fast: s.fast, mode: s.permissionMode }
}

export function workerFlags(s: Settings): string {
  const agent = s.workerAgent || s.orchestratorAgent
  if (agent !== 'claude' || s.model === '') return ''
  return ` --model ${s.model}` + (s.effort === '' ? '' : ` --effort ${s.effort}`)
}

export function homeOptionsOf(marker: string, s: Settings): HomeOptions {
  return { marker, workerAgent: s.workerAgent || s.orchestratorAgent, suffix: s.suffix, workerFlags: workerFlags(s), plan: s.plan, launch: launchOf(s) }
}

export function claudeSettings(l: Launch): Record<string, unknown> {
  const permissions: Record<string, unknown> = { allow: ALLOW }
  if (l.mode !== '') permissions.defaultMode = l.mode === 'manual' ? 'default' : l.mode
  const out: Record<string, unknown> = { permissions, sandbox: { excludedCommands: ['orca'] } }
  if (l.model !== '') out.model = l.model
  if (l.effort !== '') out.effortLevel = l.effort
  if (l.fast) out.fastMode = true
  return out
}

const PREAMBLE = [
  '#!/bin/sh',
  "IFS=' '",
  'case "$0" in',
  '*/*) d=${0%/*} ;;',
  '*) d=. ;;',
  'esac',
  'out="$d/../outbox"',
  'fail() {',
  '  printf "%s\\n" "$1" >&2',
  '  exit 1',
  '}',
  '[ -d "$out" ] || fail "outbox folder not found"'
]

const WRITE = [
  `nl=$(printf '\\n.')`,
  'nl=${nl%.}',
  `cr=$(printf '\\r.')`,
  'cr=${cr%.}',
  'case "$arg" in',
  '*"$nl"*|*"$cr"*)',
  '  printf "%s\\n" "a line break is not allowed in the option list, target or id" >&2',
  '  exit 2',
  '  ;;',
  'esac',
  't=$(date +%s)',
  'name=$(printf "%s000-%010d" "$t" "$$")',
  'printf "%s\\n%s\\n%s" "$kind" "$arg" "$body" > "$out/$name.msg.tmp" || fail "could not write the message"',
  'mv "$out/$name.msg.tmp" "$out/$name.msg" || fail "could not queue the message"'
]

const SAY = [
  ...PREAMBLE,
  'kind="$1"',
  'case "$kind" in',
  'text|progress|result|question|plan|track) ;;',
  '*) fail "usage: say text|progress|result|question|plan|track ..." ;;',
  'esac',
  'shift',
  'arg=""',
  'body=""',
  'if [ "$kind" = question ] && [ "$#" -ge 1 ] && [ "$1" = "--options" ]; then',
  '  [ "$#" -ge 2 ] || fail "say question --options needs a value"',
  '  arg="$2"',
  '  shift 2',
  'fi',
  'if [ "$kind" = track ]; then',
  '  [ "$#" -eq 1 ] && [ -n "$1" ] || fail "usage: say track <dispatch_id>"',
  '  arg="$1"',
  'elif [ "$kind" = plan ]; then',
  '  [ "$#" -ge 1 ] || fail "usage: say plan \\"[x] done step\\" \\"[~] current step\\" \\"[ ] later step\\""',
  '  body=$(printf "%s\\n" "$@")',
  '  [ -n "$body" ] || fail "say plan needs at least one step"',
  'else',
  '  [ "$#" -ge 1 ] || fail "say needs a message"',
  '  body="$*"',
  '  [ -n "$body" ] || fail "say needs a message"',
  'fi',
  ...WRITE,
  ''
].join('\n')

const TELL = [
  ...PREAMBLE,
  'kind=tell',
  '[ "$#" -ge 2 ] && [ -n "$1" ] || fail "usage: tell <session-name-or-key> <text>"',
  'arg="$1"',
  'shift',
  'body="$*"',
  '[ -n "$body" ] || fail "tell needs a message"',
  ...WRITE,
  ''
].join('\n')

export function homePath(deps: Deps): string {
  return `${deps.home()}/.orca-orchestration/home`
}

async function onDisk(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => null)) !== null
}

async function dropSymlink(deps: Deps, path: string, real: boolean): Promise<void> {
  if (!real) return
  const info = await lstat(path).catch(() => null)
  if (info?.isSymbolicLink()) await deps.fs.remove(path)
}

async function putIfChanged(deps: Deps, path: string, text: string, mode?: number): Promise<void> {
  const real = await onDisk(path.slice(0, path.lastIndexOf('/')))
  await dropSymlink(deps, path, real)
  const current = await deps.fs.read(path)
  if (current !== text) await deps.fs.write(path, text, mode)
  if (mode !== undefined && real) await chmod(path, mode)
}

export async function ensureHome(
  deps: Deps,
  o: HomeOptions
): Promise<string> {
  const home = homePath(deps)
  for (const dir of [home, `${home}/.claude`, `${home}/bin`, `${home}/outbox`]) await deps.fs.mkdir(dir)
  await putIfChanged(deps, `${home}/AGENTS.md`, standingInstructions(o))
  await putIfChanged(deps, `${home}/CLAUDE.md`, '@AGENTS.md')
  await putIfChanged(deps, `${home}/.claude/settings.json`, `${JSON.stringify(claudeSettings(o.launch ?? NO_LAUNCH), null, 2)}\n`)
  await putIfChanged(deps, `${home}/bin/say`, SAY, 0o755)
  await putIfChanged(deps, `${home}/bin/tell`, TELL, 0o755)
  return home
}

const unremovable = new Set<string>()

const NAME = /^(\d+)-(\d+)\.msg$/

function byName(a: string, b: string): number {
  const x = NAME.exec(a)
  const y = NAME.exec(b)
  if (x && y) {
    const epoch = Number(x[1]) - Number(y[1])
    if (epoch !== 0) return epoch
    const pid = Number(x[2]) - Number(y[2])
    if (pid !== 0) return pid
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function cutBytes(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_MESSAGE_BYTES) return text
  const cut = bytes.subarray(0, MAX_MESSAGE_BYTES).toString('utf8')
  return cut.endsWith('�') ? cut.slice(0, -1) : cut
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function parse(raw: string): OutMsg | null {
  const first = raw.indexOf('\n')
  const kind = stripCr(first < 0 ? raw : raw.slice(0, first))
  const afterFirst = first < 0 ? '' : raw.slice(first + 1)
  const second = afterFirst.indexOf('\n')
  const arg = stripCr(second < 0 ? afterFirst : afterFirst.slice(0, second))
  const text = cutBytes(second < 0 ? '' : afterFirst.slice(second + 1))
  const blank = text.trim() === ''
  if (kind === 'text' || kind === 'progress' || kind === 'result') return blank ? null : { kind, text }
  if (kind === 'question') {
    if (blank) return null
    return { kind, text, options: arg.split('|').filter((s) => s !== '') }
  }
  if (kind === 'plan') {
    const steps = parsePlan(text)
    return steps.length === 0 ? null : { kind, steps }
  }
  if (kind === 'track') return arg.trim() === '' ? null : { kind, dispatchId: arg }
  if (kind === 'tell') return arg.trim() === '' || blank ? null : { kind, target: arg, text }
  return null
}

async function readRegular(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (!info.isFile()) return null
    const buf = Buffer.alloc(MAX_READ_BYTES)
    const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return info.size > bytesRead && text.endsWith('�') ? text.slice(0, -1) : text
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function realEntries(deps: Deps, dir: string, names: string[]): Promise<{ name: string; mtime: number }[]> {
  const kept: { name: string; mtime: number }[] = []
  for (const name of names) {
    const info = await lstat(`${dir}/${name}`).catch(() => null)
    if (info?.isFile()) kept.push({ name, mtime: info.mtimeMs })
    else if (info) await deps.fs.remove(`${dir}/${name}`).catch(() => undefined)
  }
  return kept.sort((a, b) => a.mtime - b.mtime || byName(a.name, b.name))
}

export async function readOutbox(deps: Deps, home: string): Promise<OutMsg[]> {
  const dir = `${home}/outbox`
  let names: string[]
  let real: boolean
  try {
    const listed = (await deps.fs.list(dir)).filter((n) => n.endsWith('.msg'))
    real = await onDisk(dir)
    names = real ? (await realEntries(deps, dir, listed)).map((e) => e.name) : listed.sort(byName)
  } catch {
    return []
  }
  const out: OutMsg[] = []
  const present = new Set(names.map((n) => `${dir}/${n}`))
  for (const path of [...unremovable]) {
    if (path.startsWith(`${dir}/`) && !present.has(path)) unremovable.delete(path)
  }
  for (const name of names) {
    const path = `${dir}/${name}`
    try {
      const raw = real ? await readRegular(path) : await deps.fs.read(path)
      if (raw === null) continue
      const msg = parse(raw)
      let removed = true
      try {
        await deps.fs.remove(path)
      } catch {
        removed = false
      }
      if (removed) {
        if (msg) out.push(msg)
      } else if (!unremovable.has(path)) {
        unremovable.add(path)
        if (msg) out.push(msg)
      }
    } catch {
      continue
    }
  }
  return out
}

export async function writeBoard(deps: Deps, home: string, markdown: string): Promise<boolean> {
  const path = `${home}/board.md`
  if ((await deps.fs.read(path)) === markdown) return false
  await deps.fs.write(path, markdown)
  return true
}
