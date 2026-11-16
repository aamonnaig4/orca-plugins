export type GuardHit = { rule: 'merge' | 'force-push' | 'push-main'; command: string }

type Rule = GuardHit['rule']

type Sub = { text: string; proc: boolean }
type Tok = { k: 'w'; v: string; subs: Sub[] } | { k: 'op'; v: string } | { k: 'in'; v: string; open: boolean }
type Seg = { toks: { v: string; subs: Sub[] }[]; ins: string[]; pipedFrom: Seg | null; words: string[] | null; lit: boolean[] | null; fed: string[]; sep: string | null }
type Ctx = { vars: Map<string, string>; shellAliases: Map<string, string>; gitAliases: Map<string, string>; ghAliases: Map<string, string>; budget: number; onMain: boolean }
type Doc = { delim: string; strip: boolean }

const SHELL_TOOLS = new Set(['Bash', 'shell', 'run_shell_command'])
const MERGE_TOOLS = ['merge_pull_request', 'mergepullrequest', 'pr_merge', 'enable_auto_merge']
const WRAPPED = new Set(['git', 'gh', 'ao'])
const HARMLESS_HEADS = new Set(['echo', 'printf', 'print', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'man', 'which', 'whereis', 'whence', 'where', 'type', 'apropos', 'whatis', 'info', 'help', 'tldr', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'port', 'pip', 'pip3', 'pipx', 'gem', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'tee', 'ls', 'cd', 'pwd', 'test', '[', '[[', 'true', 'false', 'read', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'diff', 'cmp', 'file', 'stat', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'printenv', 'unset', 'open', 'code', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'history', 'hash', 'compgen', 'complete'])
const DELIM = /<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|()<>'"`\\])+)/y
const PROTECTED = new Set(['main', 'master'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'fish'])
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const FORCE_LONG = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--prune']
const MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest)\b/
const MAX_DEPTH = 8
const MAX_STEPS = 4000
const MAX_CANDIDATES = 8
const SUB_MARK = '\u0000'
const PROC_MARK = '\u0002'
const END_MARK = '\u0001'
const UNKNOWN = '$SUB'

class Unparseable extends Error {}

export function matchGuard(tool: string, input: unknown): GuardHit | null {
  if (!SHELL_TOOLS.has(tool)) {
    const name = typeof tool === 'string' ? tool.toLowerCase() : ''
    return MERGE_TOOLS.some((part) => name.includes(part)) ? { rule: 'merge', command: tool } : null
  }
  if (!input || typeof input !== 'object') return null
  const raw = (input as { command?: unknown }).command
  let command: string
  if (typeof raw === 'string') command = raw
  else if (Array.isArray(raw) && raw.length > 0 && raw.every((part) => typeof part === 'string')) command = (raw as string[]).map(quote).join(' ')
  else return null
  if (!command.trim()) return null
  let found: Rule | null
  try {
    found = judge(command, newCtx(), 0)
  } catch {
    found = rawFallback(command)
  }
  return found ? { rule: found, command: typeof raw === 'string' ? raw : command } : null
}

function newCtx(): Ctx {
  return { vars: new Map(), shellAliases: new Map(), gitAliases: new Map(), ghAliases: new Map(), budget: MAX_STEPS, onMain: false }
}

function quote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

function rawFallback(text: string): Rule | null {
  if (MUTATIONS.test(text) || followedBy(text, /\b(gh|ao|glab)\b/, /\bmerge\b/) || /\/pulls\/[^/\s]+\/merge\b/.test(text)) return 'merge'
  if (followedBy(text, /\bgit\b/, /\b(push|send-pack)\b/)) return /\b(main|master)\b/.test(text) ? 'push-main' : 'force-push'
  return null
}

function followedBy(text: string, first: RegExp, then: RegExp): boolean {
  const m = first.exec(text)
  return m !== null && then.test(text.slice(m.index + m[0].length))
}

function judge(command: string, ctx: Ctx, depth: number): Rule | null {
  ctx.budget -= 1
  if (depth > MAX_DEPTH || ctx.budget < 0) return rawFallback(command)
  let toks: Tok[]
  try {
    toks = lex(command)
  } catch (error) {
    if (!(error instanceof Unparseable)) throw error
    for (const closer of ["'", '"', ')', '`']) {
      try {
        const repaired = judgeTokens(lex(command + closer), ctx, depth)
        if (repaired) return repaired
        break
      } catch (inner) {
        if (!(inner instanceof Unparseable)) throw inner
      }
    }
    return rawFallback(command)
  }
  return judgeTokens(toks, ctx, depth)
}

function judgeTokens(toks: Tok[], ctx: Ctx, depth: number): Rule | null {
  const outer = ctx.onMain
  try {
    for (const seg of split(toks)) {
      if (seg.sep !== null && seg.sep !== '&&' && seg.sep !== ';') ctx.onMain = false
      const found = judgeSegment(seg, ctx, depth)
      if (found) return found
      const target = checkoutTarget(seg.words ?? [])
      if (target !== null) ctx.onMain = target
    }
    return null
  } finally {
    ctx.onMain = outer
  }
}

function checkoutTarget(words: string[]): boolean | null {
  let i = 0
  while (i < words.length && (isAssign(words[i]) || PLAIN_PREFIX.has(words[i]))) i += 1
  if (basename(words[i] ?? '') !== 'git') return null
  i += 1
  while (i < words.length && words[i].startsWith('-')) i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1
  const sub = words[i]
  if (sub !== 'checkout' && sub !== 'switch') return null
  const args = words.slice(i + 1)
  if (args.includes('--')) return null
  const create = args.findIndex((arg) => /^(-[bBcC]|--orphan(=.*)?|--create|--force-create)$/.test(arg))
  if (create >= 0) {
    const flag = args[create]
    const name = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : args[create + 1] ?? ''
    return PROTECTED.has(normalize(name))
  }
  const positionals = args.filter((arg) => !arg.startsWith('-'))
  if (positionals.length !== 1) return null
  return PROTECTED.has(normalize(positionals[0]))
}

function lex(src: string): Tok[] {
  const out: Tok[] = []
  const n = src.length
  let i = 0
  let word = ''
  let inWord = false
  let subs: Sub[] = []
  let pendingRedir: string | null = null
  const docs: { delim: string; strip: boolean; slot: { k: 'in'; v: string; open: boolean } }[] = []

  const flush = () => {
    if (!inWord) return
    if (pendingRedir !== null) {
      if (pendingRedir === '<<' || pendingRedir === '<<-') {
        const slot = { k: 'in' as const, v: '', open: false }
        out.push(slot)
        docs.push({ delim: word, strip: pendingRedir === '<<-', slot })
      } else if (pendingRedir === '<<<') {
        out.push({ k: 'in', v: word, open: false })
      }
      for (const sub of subs) out.push({ k: 'w', v: '', subs: [sub] })
      pendingRedir = null
    } else {
      out.push({ k: 'w', v: word, subs })
    }
    word = ''
    inWord = false
    subs = []
  }
  const op = (v: string) => {
    flush()
    pendingRedir = null
    out.push({ k: 'op', v })
  }
  const addSub = (text: string, proc: boolean) => {
    word += (proc ? PROC_MARK : SUB_MARK) + subs.length + END_MARK
    subs.push({ text, proc })
    inWord = true
  }
  const readDollar = (at: number): number => {
    if (src[at + 1] === '(') {
      const end = readBalanced(src, at + 1)
      addSub(src.slice(at + 2, end), false)
      return end + 1
    }
    if (src[at + 1] === '{') {
      const end = readBrace(at + 1)
      return end + 1
    }
    word += '$'
    inWord = true
    return at + 1
  }
  const readBrace = (open: number): number => {
    let j = open + 1
    let depthCount = 1
    word += '${'
    inWord = true
    while (j < n) {
      const c = src[j]
      if (c === '\\' && j + 1 < n) {
        word += src[j + 1]
        j += 2
        continue
      }
      if (c === '$' && src[j + 1] === '(') {
        const end = readBalanced(src, j + 1)
        addSub(src.slice(j + 2, end), false)
        j = end + 1
        continue
      }
      if (c === '`') {
        const end = readBacktick(src, j)
        addSub(unescapeBacktick(src.slice(j + 1, end)), false)
        j = end + 1
        continue
      }
      if (c === "'") {
        const end = src.indexOf("'", j + 1)
        if (end < 0) throw new Unparseable()
        word += src.slice(j + 1, end)
        j = end + 1
        continue
      }
      if (c === '{') depthCount += 1
      if (c === '}') {
        depthCount -= 1
        if (depthCount === 0) {
          word += '}'
          return j
        }
      }
      word += c
      j += 1
    }
    throw new Unparseable()
  }
  const readDocs = (from: number): number => {
    let pos = from
    while (docs.length > 0) {
      const doc = docs.shift()!
      const lines: string[] = []
      let closed = false
      while (pos < n) {
        let end = src.indexOf('\n', pos)
        if (end < 0) end = n
        const line = src.slice(pos, end)
        pos = end + 1
        const test = doc.strip ? line.replace(/^\t+/, '') : line
        if (test === doc.delim) {
          closed = true
          break
        }
        lines.push(line)
      }
      doc.slot.v = lines.join('\n')
      doc.slot.open = !closed
    }
    return Math.min(pos, n)
  }

  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      flush()
      i += 1
    } else if (c === '\n') {
      flush()
      out.push({ k: 'op', v: ';' })
      pendingRedir = null
      i = docs.length > 0 ? readDocs(i + 1) : i + 1
    } else if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
      } else if (i + 1 < n) {
        word += src[i + 1]
        inWord = true
        i += 2
      } else {
        i += 1
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new Unparseable()
      word += src.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      inWord = true
      let j = i + 1
      let closed = false
      while (j < n) {
        const d = src[j]
        if (d === '"') {
          closed = true
          j += 1
          break
        }
        if (d === '\\' && j + 1 < n) {
          const next = src[j + 1]
          if (next === '\n') {
            j += 2
            continue
          }
          if ('$`"\\'.includes(next)) word += next
          else word += '\\' + next
          j += 2
          continue
        }
        if (d === '$') {
          j = readDollar(j)
          continue
        }
        if (d === '`') {
          const end = readBacktick(src, j)
          addSub(unescapeBacktick(src.slice(j + 1, end)), false)
          j = end + 1
          continue
        }
        word += d
        j += 1
      }
      if (!closed) throw new Unparseable()
      i = j
    } else if (c === '`') {
      const end = readBacktick(src, i)
      addSub(unescapeBacktick(src.slice(i + 1, end)), false)
      i = end + 1
    } else if (c === '$') {
      i = readDollar(i)
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = readBalanced(src, i + 1)
      addSub(src.slice(i + 2, end), true)
      i = end + 1
    } else if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word) && subs.length === 0) {
        word = ''
        inWord = false
      } else {
        flush()
      }
      const m = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(src.slice(i, i + 3))!
      pendingRedir = m[1]
      i += m[1].length
    } else if (c === '#' && !inWord) {
      while (i < n && src[i] !== '\n') i += 1
    } else if (c === '&') {
      if (src[i + 1] === '&') {
        op('&&')
        i += 2
      } else if (src[i + 1] === '>') {
        flush()
        pendingRedir = src[i + 2] === '>' ? '&>>' : '&>'
        i += pendingRedir.length
      } else {
        op('&')
        i += 1
      }
    } else if (c === '|') {
      if (src[i + 1] === '|') {
        op('||')
        i += 2
      } else {
        op('|')
        i += src[i + 1] === '&' ? 2 : 1
      }
    } else if (c === ';') {
      op(';')
      i += src[i + 1] === ';' ? 2 : 1
    } else if (c === '(' || c === ')') {
      op(c)
      i += 1
    } else {
      word += c
      inWord = true
      i += 1
    }
  }
  flush()
  if (docs.length > 0) readDocs(n)
  return out
}

function heredocAt(src: string, at: number, docs: Doc[]): number {
  if (src[at + 2] === '<') return at + 3
  DELIM.lastIndex = at
  const m = DELIM.exec(src)
  if (!m) return at + 2
  const delim = m[2].replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_all: string, a?: string, b?: string, c?: string) => a ?? b ?? c ?? '')
  docs.push({ delim, strip: m[1] === '-' })
  return at + m[0].length
}

function skipBodies(src: string, from: number, docs: Doc[], closer: string): number {
  let pos = from
  while (docs.length > 0) {
    const doc = docs.shift()!
    let closed = false
    while (pos < src.length) {
      let end = src.indexOf('\n', pos)
      if (end < 0) end = src.length
      const line = src.slice(pos, end)
      const test = doc.strip ? line.replace(/^\t+/, '') : line
      if (test === doc.delim) {
        pos = end + 1
        closed = true
        break
      }
      if (test.startsWith(doc.delim + closer)) {
        docs.length = 0
        return pos + (line.length - test.length) + doc.delim.length
      }
      pos = end + 1
    }
    if (!closed) return src.length
  }
  return Math.min(pos, src.length)
}

function readBalanced(src: string, open: number): number {
  let depth = 0
  let j = open
  const arith = src[open + 1] === '('
  const docs: Doc[] = []
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n' && docs.length > 0) {
      j = skipBodies(src, j + 1, docs, ')')
      continue
    }
    if (c === '<' && src[j + 1] === '<' && !arith) {
      j = heredocAt(src, j, docs)
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", j + 1)
      if (end < 0) throw new Unparseable()
      j = end + 1
      continue
    }
    if (c === '"') {
      j += 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) throw new Unparseable()
      j += 1
      continue
    }
    if (c === '`') {
      j = readBacktick(src, j) + 1
      continue
    }
    if (c === '(') depth += 1
    if (c === ')') {
      depth -= 1
      if (depth === 0) return j
    }
    j += 1
  }
  throw new Unparseable()
}

function readBacktick(src: string, open: number): number {
  let j = open + 1
  const docs: Doc[] = []
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === '\n' && docs.length > 0) {
      j = skipBodies(src, j + 1, docs, '`')
      continue
    }
    if (src[j] === '<' && src[j + 1] === '<') {
      j = heredocAt(src, j, docs)
      continue
    }
    if (src[j] === '`') return j
    j += 1
  }
  throw new Unparseable()
}

function unescapeBacktick(text: string): string {
  return text.replace(/\\([`$\\])/g, '$1')
}

function split(toks: Tok[]): Seg[] {
  const segs: Seg[] = []
  let current: Seg = emptySeg(null)
  for (const tok of toks) {
    if (tok.k === 'op') {
      segs.push(current)
      current = emptySeg(tok.v === '|' ? current : null)
      current.sep = tok.v
    } else if (tok.k === 'in') {
      current.ins.push(tok.v)
      if (tok.open && tok.v.trim()) current.toks.push({ v: '', subs: [{ text: tok.v, proc: false }] })
    } else {
      current.toks.push({ v: tok.v, subs: tok.subs })
    }
  }
  segs.push(current)
  return segs.filter((seg) => seg.toks.length > 0 || seg.ins.length > 0)
}

function emptySeg(pipedFrom: Seg | null): Seg {
  return { toks: [], ins: [], pipedFrom, words: null, lit: null, fed: [], sep: null }
}

function judgeSegment(seg: Seg, ctx: Ctx, depth: number): Rule | null {
  const words: string[] = []
  const lit: boolean[] = []
  for (const tok of seg.toks) {
    for (const sub of tok.subs) {
      const found = judge(sub.text, ctx, depth + 1)
      if (found) return found
    }
    const parts = expand(tok, seg, ctx, depth)
    const plain = tok.subs.length === 0
    words.push(...parts)
    for (let k = 0; k < parts.length; k++) lit.push(plain)
  }
  seg.words = words
  seg.lit = lit
  return judgeWords(words, seg, ctx, depth)
}

function expand(tok: { v: string; subs: Sub[] }, seg: Seg, ctx: Ctx, depth: number): string[] {
  if (tok.v === '' && tok.subs.length > 0) return []
  let changed = false
  let text = tok.v.replace(/([\u0000\u0002])(\d+)\u0001/g, (_m, mark: string, index: string) => {
    changed = true
    const sub = tok.subs[Number(index)]
    const output = staticOutput(sub.text, ctx, depth)
    if (mark === PROC_MARK) {
      if (output !== null) seg.fed.push(output)
      return '/dev/fd/63'
    }
    return output ?? UNKNOWN
  })
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match: string, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    const value = ctx.vars.get(name) ?? (name === 'IFS' ? ' ' : undefined)
    if (value === undefined) return match
    changed = true
    return value
  })
  if (!changed) return [text]
  return text.split(/\s+/).filter((part) => part.length > 0)
}

function staticOutput(text: string, ctx: Ctx, depth: number): string | null {
  ctx.budget -= 1
  if (depth > MAX_DEPTH || ctx.budget < 0) return null
  let toks: Tok[]
  try {
    toks = lex(text)
  } catch {
    return null
  }
  const segs = split(toks)
  if (segs.length !== 1) return null
  const words: string[] = []
  for (const tok of segs[0].toks) words.push(...expand(tok, segs[0], ctx, depth + 1))
  segs[0].words = words
  return printed(segs[0])
}

function printed(seg: Seg): string | null {
  const words = seg.words ?? []
  if (words.length === 0) return null
  const head = basename(words[0])
  let args = words.slice(1)
  if (head === 'echo') {
    while (args.length > 0 && /^-[neE]+$/.test(args[0])) args = args.slice(1)
    return args.join(' ')
  }
  if (head === 'printf') {
    if (args.length > 1 && args[0].includes('%')) return args.slice(1).join(' ')
    return args.join(' ')
  }
  if (head === 'cat' && args.length === 0 && seg.ins.length > 0) return seg.ins.join('\n')
  return null
}

function basename(word: string): string {
  const slash = word.lastIndexOf('/')
  return slash >= 0 ? word.slice(slash + 1) : word
}

function isAssign(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)
}

function recordAssign(word: string, ctx: Ctx): void {
  const eq = word.indexOf('=')
  ctx.vars.set(word.slice(0, eq).replace(/\+$/, ''), word.slice(eq + 1))
}

function skipFlags(words: string[], from: number, withValue: Set<string>): number {
  let i = from
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') return i + 1
    i += withValue.has(words[i]) ? 2 : 1
  }
  return i
}

const PLAIN_PREFIX = new Set(['command', 'builtin', 'noglob', 'nohup', 'nocorrect', 'time', '!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'coproc', 'unbuffer', 'chronic', 'caffeinate', 'arch'])
const SUDO_VALUE = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout'])
const ENV_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-P'])
const NICE_VALUE = new Set(['-n', '--adjustment'])
const TIMEOUT_VALUE = new Set(['-s', '--signal', '-k', '--kill-after'])
const STDBUF_VALUE = new Set(['-i', '-o', '-e'])
const EXEC_VALUE = new Set(['-a'])
const XARGS_VALUE = new Set(['-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '-I', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--eof', '--max-chars', '--arg-file', '--replace'])
const WATCH_VALUE = new Set(['-n', '--interval', '-d'])
const CONTROL_ENDS = new Set(['fi', 'done', 'esac'])
const RUNNER_VALUE = new Set(['-p', '--package', '--registry', '--cache', '--userconfig', '--prefix', '-w', '--workspace', '--filter', '-F', '--dir', '-C'])
const RUNNER_CALL = new Set(['-c', '--call', '--shell-mode'])
const SSH_VALUE = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w'])
const DOCKER_EXEC_VALUE = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys'])

function judgeWords(input: string[], seg: Seg, ctx: Ctx, depth: number): Rule | null {
  ctx.budget -= 1
  if (ctx.budget < 0) return rawFallback(input.join(' '))
  let words = input
  if (words.length === 0) return null
  if (words.every(isAssign)) {
    for (const word of words) recordAssign(word, ctx)
    return null
  }
  if (['export', 'declare', 'local', 'readonly', 'typeset'].includes(words[0])) {
    for (const word of words.slice(1)) if (isAssign(word)) recordAssign(word, ctx)
    return null
  }
  if (words[0] === 'alias') {
    for (const word of words.slice(1)) {
      const eq = word.indexOf('=')
      if (eq > 0) ctx.shellAliases.set(word.slice(0, eq), word.slice(eq + 1))
    }
    return null
  }
  if (words[0] === 'for' || words[0] === 'case' || words[0] === 'select') return null
  let i = 0
  let xargsInput: { replace: string | null } | null = null
  const env = new Map<string, string>()
  while (i < words.length) {
    const word = words[i]
    const name = basename(word)
    if (isAssign(word)) {
      const eq = word.indexOf('=')
      env.set(word.slice(0, eq), word.slice(eq + 1))
      i += 1
    } else if (name === 'command' && (words[i + 1] === '-v' || words[i + 1] === '-V')) {
      return null
    } else if (PLAIN_PREFIX.has(name)) {
      i = skipFlags(words, i + 1, new Set())
    } else if (name === 'exec') {
      i = skipFlags(words, i + 1, EXEC_VALUE)
    } else if (name === 'sudo' || name === 'doas') {
      i = skipFlags(words, i + 1, SUDO_VALUE)
    } else if (name === 'env') {
      let j = i + 1
      while (j < words.length && words[j].startsWith('-')) {
        if (words[j] === '--') {
          j += 1
          break
        }
        if (words[j] === '-S' || words[j] === '--split-string') {
          const rest = words.slice(j + 2)
          const inner = words[j + 1] ?? ''
          return judge(inner + ' ' + rest.map(quote).join(' '), ctx, depth + 1)
        }
        if (words[j].startsWith('-S') && words[j].length > 2) {
          return judge(words[j].slice(2) + ' ' + words.slice(j + 1).map(quote).join(' '), ctx, depth + 1)
        }
        j += ENV_VALUE.has(words[j]) ? 2 : 1
      }
      i = j
    } else if (name === 'npx' || name === 'bunx' || ((name === 'pnpm' || name === 'yarn' || name === 'bun') && words[i + 1] === 'dlx') || ((name === 'npm' || name === 'pnpm') && words[i + 1] === 'exec')) {
      const start = name === 'npx' || name === 'bunx' ? i + 1 : i + 2
      let j = start
      while (j < words.length && words[j].startsWith('-')) {
        if (words[j] === '--') {
          j += 1
          break
        }
        if (RUNNER_CALL.has(words[j])) return words[j + 1] === undefined ? null : judge(words[j + 1], ctx, depth + 1)
        if (words[j].startsWith('--call=')) return judge(words[j].slice(7), ctx, depth + 1)
        j += RUNNER_VALUE.has(words[j]) ? 2 : 1
      }
      i = j
    } else if (name === 'nice') {
      i = skipFlags(words, i + 1, NICE_VALUE)
    } else if (name === 'timeout' || name === 'gtimeout') {
      i = skipFlags(words, i + 1, TIMEOUT_VALUE) + 1
    } else if (name === 'stdbuf') {
      i = skipFlags(words, i + 1, STDBUF_VALUE)
    } else if (name === 'watch') {
      i = skipFlags(words, i + 1, WATCH_VALUE)
    } else if (name === 'xargs') {
      let replace: string | null = null
      let j = i + 1
      while (j < words.length && words[j].startsWith('-')) {
        const flag = words[j]
        if (flag === '--') {
          j += 1
          break
        }
        if (flag === '-I' || flag === '--replace') {
          replace = words[j + 1] ?? '{}'
          j += 2
          continue
        }
        if (flag.startsWith('-I') && flag.length > 2) replace = flag.slice(2)
        else if (flag === '-i' || flag.startsWith('--replace=')) replace = flag.includes('=') ? flag.split('=')[1] : '{}'
        j += XARGS_VALUE.has(flag) ? 2 : 1
      }
      xargsInput = { replace }
      i = j
    } else if (CONTROL_ENDS.has(name)) {
      return null
    } else {
      break
    }
  }
  words = words.slice(i)
  if (words.length === 0) return null
  let lit = input === seg.words && seg.lit !== null && seg.lit.length === input.length ? seg.lit.slice(i) : null
  if (xargsInput && seg.pipedFrom) {
    const piped = printed(seg.pipedFrom)
    lit = null
    if (piped !== null) {
      if (xargsInput.replace) words = words.map((word) => word.split(xargsInput!.replace!).join(piped))
      else words = [...words, ...piped.split(/\s+/).filter((part) => part.length > 0)]
    }
  }
  const head = basename(words[0])
  const alias = ctx.shellAliases.get(words[0])
  if (alias !== undefined) {
    ctx.shellAliases.delete(words[0])
    const found = judge(alias + ' ' + words.slice(1).map(quote).join(' '), ctx, depth + 1)
    ctx.shellAliases.set(words[0], alias)
    return found
  }
  if (SHELLS.has(head)) return judgeShell(words, seg, ctx, depth)
  if (head === 'ssh') return judgeSsh(words, ctx, depth)
  if ((head === 'docker' || head === 'podman') && (words[1] === 'exec' || (words[1] === 'container' && words[2] === 'exec'))) {
    return judgeDockerExec(words.slice(words[1] === 'exec' ? 2 : 3), ctx, depth)
  }
  if (head === 'eval') return judge(words.slice(1).join(' '), ctx, depth + 1)
  if (head === 'source' || head === '.') return judgeFed(seg, ctx, depth)
  if (head === 'find') return judgeFind(words, seg, ctx, depth)
  if (head === 'git') return judgeGit(['git', ...gitEnvConfig(env), ...words.slice(1)], ctx, depth)
  if (head === 'gh') return judgeGh(words, ctx, depth)
  if (head === 'ao') return firstPositionals(words.slice(1), 2).join(' ') === 'pr merge' ? 'merge' : null
  if (head === 'glab') return firstPositionals(words.slice(1), 2).join(' ') === 'mr merge' ? 'merge' : null
  if (head === 'curl' || head === 'wget' || head === 'http' || head === 'https' || head === 'xh') return judgeHttp(words)
  if (words[0].startsWith('$')) {
    return judgeGit(['git', ...words.slice(1)], ctx, depth) ?? judgeGh(['gh', ...words.slice(1)], ctx, depth)
  }
  if (HARMLESS_HEADS.has(head)) return null
  let tried = 0
  for (let k = 1; k < words.length; k++) {
    if (!WRAPPED.has(words[k]) || (lit !== null && !lit[k])) continue
    if (tried >= MAX_CANDIDATES || ctx.budget <= 0) return rawFallback(words.join(' '))
    tried += 1
    const found = judgeWords(words.slice(k), emptySeg(null), ctx, depth + 1)
    if (found) return found
    if (ctx.budget < 0) return rawFallback(words.join(' '))
  }
  return null
}

function gitEnvConfig(env: Map<string, string>): string[] {
  const out: string[] = []
  for (const [key, name] of env) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(key)
    if (!m) continue
    out.push('-c', name + '=' + (env.get('GIT_CONFIG_VALUE_' + m[1]) ?? ''))
  }
  return out
}

function firstPositionals(args: string[], count: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < args.length && out.length < count) {
    if (args[i] === '-R' || args[i] === '--repo') {
      i += 2
      continue
    }
    if (!args[i].startsWith('-')) out.push(args[i])
    i += 1
  }
  return out
}

function judgeFed(seg: Seg, ctx: Ctx, depth: number): Rule | null {
  const texts = [...seg.ins, ...seg.fed]
  if (seg.pipedFrom) {
    const piped = printed(seg.pipedFrom)
    if (piped !== null) texts.push(piped)
  }
  for (const text of texts) {
    const found = judge(text, ctx, depth + 1)
    if (found) return found
  }
  return null
}

function judgeShell(words: string[], seg: Seg, ctx: Ctx, depth: number): Rule | null {
  let i = 1
  let script: string | null = null
  let hasC = false
  while (i < words.length) {
    const word = words[i]
    if (word === '--' || word === '-') {
      i += 1
      break
    }
    if (word === '-o' || word === '+o' || word === '-O' || word === '+O' || word === '--rcfile' || word === '--init-file') {
      i += 2
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith('-') && word.includes('c')) hasC = true
      i += 1
      continue
    }
    if (word.startsWith('--')) {
      if (word === '--command') hasC = true
      i += 1
      continue
    }
    break
  }
  if (hasC) {
    script = words[i] ?? null
    if (script === null) return null
    return judge(script, ctx, depth + 1) ?? (i + 1 < words.length ? judge(words.slice(i).join(' '), ctx, depth + 1) : null)
  }
  const fed = [...seg.ins, ...seg.fed]
  if (seg.pipedFrom) {
    const piped = printed(seg.pipedFrom)
    if (piped !== null) fed.push(piped)
  }
  for (const text of fed) {
    const found = judge(text, ctx, depth + 1)
    if (found) return found
  }
  return null
}

function judgeSsh(words: string[], ctx: Ctx, depth: number): Rule | null {
  let i = 1
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '--') {
      i += 1
      break
    }
    i += SSH_VALUE.has(words[i]) ? 2 : 1
  }
  const remote = words.slice(i + 1)
  return remote.length === 0 ? null : judge(remote.join(' '), ctx, depth + 1)
}

function judgeDockerExec(args: string[], ctx: Ctx, depth: number): Rule | null {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '--') {
      i += 1
      break
    }
    i += DOCKER_EXEC_VALUE.has(args[i]) ? 2 : 1
  }
  const argv = args.slice(i + 1)
  return argv.length === 0 ? null : judgeWords(argv, emptySeg(null), ctx, depth + 1)
}

function judgeFind(words: string[], seg: Seg, ctx: Ctx, depth: number): Rule | null {
  for (let i = 1; i < words.length; i++) {
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(words[i])) {
      let end = i + 1
      while (end < words.length && words[end] !== ';' && words[end] !== '+') end += 1
      const found = judgeWords(words.slice(i + 1, end), emptySeg(null), ctx, depth + 1)
      if (found) return found
      i = end
    }
  }
  return null
}

function wordsOf(text: string): string[] {
  try {
    const segs = split(lex(text))
    return segs.length > 0 ? segs[0].toks.map((tok) => tok.v) : []
  } catch {
    return text.split(/\s+/).filter((part) => part.length > 0)
  }
}

function judgeGit(words: string[], ctx: Ctx, depth: number): Rule | null {
  const configs: [string, string][] = []
  let i = 1
  while (i < words.length) {
    const token = words[i]
    if (token === '-c' && i + 1 < words.length) {
      const pair = words[i + 1]
      const eq = pair.indexOf('=')
      configs.push(eq < 0 ? [pair.toLowerCase(), 'true'] : [pair.slice(0, eq).toLowerCase(), pair.slice(eq + 1)])
      i += 2
    } else if (GIT_GLOBAL_WITH_VALUE.has(token) && i + 1 < words.length) {
      i += 2
    } else if (token.startsWith('-')) {
      i += 1
    } else {
      break
    }
  }
  if (i >= words.length) return null
  const sub = words[i]
  const args = words.slice(i + 1)
  const aliases = new Map(ctx.gitAliases)
  for (const [key, value] of configs) if (key.startsWith('alias.')) aliases.set(key.slice(6), value)
  const alias = aliases.get(sub.toLowerCase())
  if (alias !== undefined && depth < MAX_DEPTH) {
    if (alias.startsWith('!')) return judge(alias.slice(1) + ' ' + args.map(quote).join(' '), ctx, depth + 1)
    const prefix = configs.filter(([key]) => !key.startsWith('alias.')).flatMap(([key, value]) => ['-c', key + '=' + value])
    return judgeGit(['git', ...prefix, ...wordsOf(alias), ...args], ctx, depth + 1)
  }
  if (sub === 'config') {
    let rest = args.filter((arg) => !arg.startsWith('-'))
    if (rest[0] === 'set') rest = rest.slice(1)
    if (rest.length >= 2 && rest[0].toLowerCase().startsWith('alias.')) ctx.gitAliases.set(rest[0].slice(6).toLowerCase(), rest[1])
    return null
  }
  if (sub === 'push' || sub === 'send-pack') return judgePush(args, configs, ctx.onMain)
  return null
}

function isForceLong(name: string): boolean {
  if (name.length < 3) return false
  return FORCE_LONG.some((flag) => flag.startsWith(name))
}

function isDeleteLong(name: string): boolean {
  return name.length >= 4 && '--delete'.startsWith(name)
}

function normalize(ref: string): string {
  for (const prefix of ['refs/heads/', 'heads/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return ref
}

function isProtected(dest: string): boolean {
  if (PROTECTED.has(normalize(dest))) return true
  if (!dest.includes('*')) return false
  const pattern = new RegExp('^' + dest.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return ['main', 'master', 'refs/heads/main', 'refs/heads/master'].some((ref) => pattern.test(ref))
}

function judgePush(args: string[], configs: [string, string][], onMain: boolean): Rule | null {
  let force = false
  let del = false
  let afterDashes = false
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (afterDashes) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      afterDashes = true
      continue
    }
    if (PUSH_WITH_VALUE.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0]
      if (name.startsWith('--no-')) continue
      if (isForceLong(name)) force = true
      else if (isDeleteLong(name)) del = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg.slice(1).includes('f')) force = true
      if (arg.slice(1).includes('d')) del = true
      continue
    }
    positionals.push(arg)
  }
  if (force) return 'force-push'
  let refspecs = positionals.slice(1)
  if (del) {
    return refspecs.some((ref) => isProtected(ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref)) ? 'push-main' : 'force-push'
  }
  if (refspecs.length === 0) {
    for (const [key, value] of configs) {
      if (/^remote\..+\.mirror$/.test(key) && /^(true|yes|on|1)$/i.test(value)) return 'force-push'
    }
    refspecs = configs.filter(([key]) => /^remote\..+\.push$/.test(key)).map(([, value]) => value)
    if (refspecs.length === 0) {
      const matching = configs.some(([key, value]) => key === 'push.default' && value === 'matching')
      return matching || onMain ? 'push-main' : null
    }
  }
  let onlyHead = true
  for (const ref of refspecs) {
    if (ref.startsWith('+')) return 'force-push'
    if (ref === ':') return 'push-main'
    if (ref.startsWith(':')) return isProtected(ref.slice(1)) ? 'push-main' : 'force-push'
    const dest = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
    if (dest === 'HEAD' || dest === '@') continue
    onlyHead = false
    if (isProtected(dest)) return 'push-main'
  }
  return onMain && onlyHead ? 'push-main' : null
}

const GH_TOP_VALUE = new Set(['-R', '--repo', '--hostname'])

function judgeGh(words: string[], ctx: Ctx, depth: number): Rule | null {
  const args = words.slice(1)
  const i = skipFlags(args, 0, GH_TOP_VALUE)
  if (i >= args.length) return null
  const sub = args[i]
  const rest = args.slice(i + 1)
  const alias = ctx.ghAliases.get(sub)
  if (alias !== undefined && depth < MAX_DEPTH) {
    if (alias.startsWith('!')) return judge(alias.slice(1) + ' ' + rest.map(quote).join(' '), ctx, depth + 1)
    return judgeGh(['gh', ...wordsOf(alias), ...rest], ctx, depth + 1)
  }
  if (sub === 'alias') {
    const positional = rest.filter((arg) => !arg.startsWith('-'))
    if (positional[0] === 'set' && positional.length >= 3) {
      const shell = rest.includes('--shell') || rest.includes('-s')
      ctx.ghAliases.set(positional[1], (shell ? '!' : '') + positional[2])
    }
    return null
  }
  if (sub === 'pr') return firstPositionals(rest, 1)[0] === 'merge' ? 'merge' : null
  if (sub === 'api') return judgeApi(rest)
  return null
}

const API_VALUE = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache'])
const API_BODY = new Set(['-f', '-F', '--field', '--raw-field', '--input'])

function judgeApi(args: string[]): Rule | null {
  let method: string | null = null
  let hasBody = false
  const bodies: string[] = []
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-X' || arg === '--method') {
      method = args[i + 1] ?? null
      i += 1
    } else if (arg.startsWith('--method=')) {
      method = arg.slice(9)
    } else if (/^-X./.test(arg)) {
      method = arg.slice(2)
    } else if (API_BODY.has(arg)) {
      hasBody = true
      bodies.push(args[i + 1] ?? '')
      i += 1
    } else if (/^--(field|raw-field|input)=/.test(arg)) {
      hasBody = true
      bodies.push(arg.slice(arg.indexOf('=') + 1))
    } else if (/^-[fF]./.test(arg)) {
      hasBody = true
      bodies.push(arg.slice(2))
    } else if (API_VALUE.has(arg)) {
      i += 1
    } else if (!arg.startsWith('-')) {
      positionals.push(arg)
    }
  }
  const endpoint = positionals[0] ?? ''
  if (endpoint === 'graphql') return args.some((arg) => MUTATIONS.test(arg)) ? 'merge' : null
  const verb = (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
  return judgeRest(endpoint, verb)
}

function judgeRest(endpoint: string, verb: string): Rule | null {
  const path = endpoint.split('?')[0].replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '')
  if (verb === 'GET' || verb === 'HEAD') return null
  if (/(^|\/)pulls\/[^/]+\/merge$/.test(path)) return 'merge'
  if (/(^|\/)repos\/[^/]+\/[^/]+\/merges$/.test(path) && verb === 'POST') return 'merge'
  if (/(^|\/)git\/refs\/heads\/(main|master)$/.test(path)) return 'push-main'
  return null
}

function judgeHttp(words: string[]): Rule | null {
  let method: string | null = null
  let hasBody = false
  let upload = false
  const args = words.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-X' || arg === '--request' || arg === '--method') {
      method = args[i + 1] ?? null
      i += 1
    } else if (/^--(request|method)=/.test(arg)) {
      method = arg.slice(arg.indexOf('=') + 1)
    } else if (/^-X./.test(arg)) {
      method = arg.slice(2)
    } else if (arg === '-I' || arg === '--head') {
      method = method ?? 'HEAD'
    } else if (arg === '-T' || arg === '--upload-file') {
      upload = true
    } else if (/^(-d|--data.*|--json|-F|--form.*|--post-data.*|--body-data.*)$/.test(arg) || /^(-d|-F).+/.test(arg) || /^--(post|body)-data=/.test(arg)) {
      hasBody = true
    } else if (/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(arg)) {
      method = arg
    }
  }
  if (args.some((arg) => MUTATIONS.test(arg))) return 'merge'
  const verb = (method ?? (upload ? 'PUT' : hasBody ? 'POST' : 'GET')).toUpperCase()
  for (const arg of args) {
    if (!arg.includes('/') || arg.startsWith('-')) continue
    const found = judgeRest(arg, verb)
    if (found) return found
  }
  return null
}
