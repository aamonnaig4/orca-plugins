import type { Deps, RunResult } from './deps.ts'

const PR_FIELDS = `fragment PrFields on PullRequest {
  number
  url
  headRefName
  baseRefName
  headRefOid
  baseRefOid
  isDraft
  mergeable
  reviewDecision
  reviewRequests(first: 1) { totalCount }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion databaseId startedAt detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
  reviewThreads(first: 100) {
    nodes {
      id
      isResolved
      comments(last: 20) {
        nodes { id author { __typename login } body url path line }
      }
    }
  }
  reviews(last: 20) {
    nodes { id state author { __typename login } body url }
  }
  comments(last: 30) {
    nodes { id author { __typename login } body url }
  }
}
`

const ALIAS = /^b\d+$/

export function prsQuery(count: number): string {
  const vars = ['$owner: String!', '$name: String!']
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    vars.push(`$b${i}: String!`)
    lines.push(`    b${i}: pullRequests(headRefName: $b${i}, states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...PrFields } }\n`)
  }
  const head = `query (${vars.join(', ')}) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
${lines.join('')}  }
}
`
  return count > 0 ? head + PR_FIELDS : head
}

export type Check = { name: string; state: 'pass' | 'fail' | 'pending'; jobId: string | null; url: string | null }
export type Comment = { id: string; author: string; isBot: boolean; body: string; url: string; path: string | null; line: number | null }
export type Thread = { id: string; resolved: boolean; comments: Comment[] }
export type Review = { id: string; state: 'CHANGES_REQUESTED' | 'COMMENTED' | 'APPROVED' | 'OTHER'; author: string; isBot: boolean; body: string; url: string }
export type PrState = { repo: string; number: number; url: string; branch: string; base: string; headSha: string; baseSha: string; isDraft: boolean; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; reviewDecision: 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | null; reviewRequested: boolean; checks: Check[]; checksTruncated: boolean; threads: Thread[]; reviews: Review[]; comments: Comment[] }
export type GhStatus = { ok: true } | { ok: false; reason: 'missing' | 'signed-out' | 'rate-limited' | 'error'; retryInSec?: number; soft?: boolean }

type Obj = Record<string, unknown>

const FAIL_CONCLUSIONS = ['FAILURE', 'TIMED_OUT', 'ERROR', 'STARTUP_FAILURE']
const PASS_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const MIN_RETRY_SEC = 60
const GH_TIMEOUT_MS = 30000

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nodes(value: unknown): Obj[] {
  return list(obj(value).nodes).map(obj)
}

function author(value: unknown): { author: string; isBot: boolean } {
  const a = obj(value)
  const login = str(a.login)
  return { author: login, isBot: a.__typename === 'Bot' || login.endsWith('[bot]') }
}

function toComment(node: Obj): Comment {
  return {
    id: str(node.id),
    ...author(node.author),
    body: str(node.body),
    url: str(node.url),
    path: typeof node.path === 'string' ? node.path : null,
    line: typeof node.line === 'number' ? node.line : null
  }
}

function toReview(node: Obj): Review {
  const state = node.state === 'CHANGES_REQUESTED' || node.state === 'COMMENTED' || node.state === 'APPROVED' ? node.state : 'OTHER'
  return { id: str(node.id), state, ...author(node.author), body: str(node.body), url: str(node.url) }
}

function checkRunState(node: Obj): Check['state'] {
  if (node.status !== 'COMPLETED') return 'pending'
  const conclusion = str(node.conclusion)
  if (FAIL_CONCLUSIONS.includes(conclusion)) return 'fail'
  if (PASS_CONCLUSIONS.includes(conclusion)) return 'pass'
  return 'pending'
}

function statusContextState(state: unknown): Check['state'] {
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  return 'pending'
}

function startedAt(node: Obj): number {
  const t = Date.parse(str(node.startedAt))
  return Number.isNaN(t) ? -Infinity : t
}

function readChecks(rollup: unknown): { checks: Check[]; checksTruncated: boolean } {
  if (rollup === null || typeof rollup !== 'object') return { checks: [], checksTruncated: false }
  const contexts = obj(obj(rollup).contexts)
  const byName = new Map<string, { check: Check; startedAt: number }>()
  for (const node of nodes(contexts)) {
    if (node.__typename === 'CheckRun') {
      const check: Check = {
        name: str(node.name),
        state: checkRunState(node),
        jobId: typeof node.databaseId === 'number' || typeof node.databaseId === 'string' ? String(node.databaseId) : null,
        url: typeof node.detailsUrl === 'string' ? node.detailsUrl : null
      }
      const at = startedAt(node)
      const prev = byName.get(check.name)
      if (!prev || at > prev.startedAt) byName.set(check.name, { check, startedAt: at })
    } else if (node.__typename === 'StatusContext') {
      const check: Check = {
        name: str(node.context),
        state: statusContextState(node.state),
        jobId: null,
        url: typeof node.targetUrl === 'string' ? node.targetUrl : null
      }
      byName.set(check.name, { check, startedAt: -Infinity })
    }
  }
  return {
    checks: [...byName.values()].map((entry) => entry.check),
    checksTruncated: obj(contexts.pageInfo).hasNextPage === true
  }
}

function toPr(repo: string, node: Obj): PrState {
  const rollup = obj(obj(nodes(node.commits)[0]).commit).statusCheckRollup ?? null
  const mergeable = node.mergeable === 'MERGEABLE' || node.mergeable === 'CONFLICTING' ? node.mergeable : 'UNKNOWN'
  const decision = node.reviewDecision
  const reviewDecision = decision === 'CHANGES_REQUESTED' || decision === 'APPROVED' || decision === 'REVIEW_REQUIRED' ? decision : null
  const requests = obj(node.reviewRequests).totalCount
  return {
    repo,
    number: typeof node.number === 'number' ? node.number : 0,
    url: str(node.url),
    branch: str(node.headRefName),
    base: str(node.baseRefName),
    headSha: str(node.headRefOid),
    baseSha: str(node.baseRefOid),
    isDraft: node.isDraft === true,
    mergeable,
    reviewDecision,
    reviewRequested: typeof requests === 'number' && requests > 0,
    ...readChecks(rollup),
    threads: nodes(node.reviewThreads).map((t) => ({ id: str(t.id), resolved: t.isResolved === true, comments: nodes(t.comments).map(toComment) })),
    reviews: nodes(node.reviews).map(toReview),
    comments: nodes(node.comments).map(toComment)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function retryInSec(deps: Deps, resetAt: unknown): number {
  const reset = Date.parse(str(resetAt))
  if (Number.isNaN(reset)) return MIN_RETRY_SEC
  const sec = Math.ceil((reset - deps.now()) / 1000)
  return sec > 0 ? sec : MIN_RETRY_SEC
}

function failure(status: GhStatus): { status: GhStatus; defaultBranch: string | null; prs: PrState[] } {
  return { status, defaultBranch: null, prs: [] }
}

function classify(deps: Deps, result: RunResult, data: Obj): GhStatus | null {
  const rateLimit = obj(data.rateLimit)
  const stderr = result.stderr.toLowerCase()
  if (result.missing) return { ok: false, reason: 'missing' }
  if (rateLimit.remaining === 0 || (result.code !== 0 && stderr.includes('rate limit'))) {
    return { ok: false, reason: 'rate-limited', retryInSec: retryInSec(deps, rateLimit.resetAt) }
  }
  if (result.code === 4 || (result.code !== 0 && stderr.includes('authentication'))) return { ok: false, reason: 'signed-out' }
  if (result.code !== 0) return { ok: false, reason: 'error' }
  return null
}

async function ask(deps: Deps, gh: string, args: string[]): Promise<{ data: Obj; bad: GhStatus | null; spent: boolean }> {
  const result = await deps.run(gh, args, { timeoutMs: GH_TIMEOUT_MS })
  const data = obj(obj(parseJson(result.stdout)).data)
  return { data, bad: classify(deps, result, data), spent: obj(data.rateLimit).remaining === 0 }
}

async function graphqlBudget(deps: Deps, gh: string): Promise<{ remaining: number; reset: number } | null> {
  const result = await deps.run(gh, ['api', 'rate_limit'], { timeoutMs: GH_TIMEOUT_MS })
  if (result.code !== 0) return null
  const graphql = obj(obj(obj(parseJson(result.stdout)).resources).graphql)
  if (typeof graphql.remaining !== 'number' || typeof graphql.reset !== 'number') return null
  return { remaining: graphql.remaining, reset: graphql.reset }
}

export async function readRepo(deps: Deps, gh: string | null, repo: string, branches: string[]): Promise<{ status: GhStatus; defaultBranch: string | null; prs: PrState[] }> {
  if (gh === null) return failure({ ok: false, reason: 'missing' })
  const slash = repo.indexOf('/')
  const owner = slash < 0 ? repo : repo.slice(0, slash)
  const name = slash < 0 ? '' : repo.slice(slash + 1)
  const wanted = [...new Set(branches)]
  const args = ['api', 'graphql', '-f', 'query=' + prsQuery(wanted.length), '-f', 'owner=' + owner, '-f', 'name=' + name]
  wanted.forEach((branch, i) => args.push('-f', `b${i}=${branch}`))
  let read = await ask(deps, gh, args)
  if (read.bad && read.bad.reason === 'rate-limited' && !read.spent) {
    const budget = await graphqlBudget(deps, gh)
    if (budget !== null && budget.remaining > 0) {
      read = await ask(deps, gh, args)
      if (read.bad && read.bad.reason === 'rate-limited' && !read.spent) return failure({ ok: false, reason: 'rate-limited', retryInSec: MIN_RETRY_SEC, soft: true })
    } else if (budget !== null) {
      return failure({ ok: false, reason: 'rate-limited', retryInSec: retryInSec(deps, new Date(budget.reset * 1000).toISOString()) })
    }
  }
  if (read.bad) return failure(read.bad)
  const data = read.data
  if (data.repository === null || typeof data.repository !== 'object') return failure({ ok: false, reason: 'error' })
  const repository = obj(data.repository)
  const defaultName = obj(repository.defaultBranchRef).name
  return {
    status: { ok: true },
    defaultBranch: typeof defaultName === 'string' ? defaultName : null,
    prs: Object.keys(repository)
      .filter((key) => ALIAS.test(key))
      .flatMap((key) => nodes(repository[key]))
      .map((node) => toPr(repo, node))
  }
}

export function prFor(prs: PrState[], session: { repo: string | null; branch: string | null }, defaultBranch: string | null): PrState | null {
  if (session.repo === null || session.branch === null) return null
  if (session.branch === defaultBranch) return null
  const repo = session.repo.toLowerCase()
  return prs.find((pr) => pr.branch === session.branch && pr.repo.toLowerCase() === repo) ?? null
}

export async function failedLogTail(deps: Deps, gh: string, repo: string, jobId: string, lines: number): Promise<string> {
  const result = await deps.run(gh, ['run', 'view', '--job', jobId, '--log-failed', '-R', repo], { timeoutMs: GH_TIMEOUT_MS })
  if (result.code !== 0) return ''
  const all = result.stdout.replace(/\n+$/, '').split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

export async function prDiff(deps: Deps, gh: string, repo: string, pr: number): Promise<string> {
  const result = await deps.run(gh, ['pr', 'diff', String(pr), '-R', repo], { timeoutMs: GH_TIMEOUT_MS })
  return result.code === 0 ? result.stdout : ''
}
