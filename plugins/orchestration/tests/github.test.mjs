import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { failedLogTail, prDiff, prFor, prsQuery, readRepo } from '../src/github.ts'

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8')
const QUERY = fixture('gh-prs.graphql')
const NOW = Date.parse('2026-11-15T21:50:00Z')

function fakeDeps(result) {
  const calls = []
  return {
    calls,
    deps: {
      run: async (cmd, args, opts) => {
        calls.push([cmd, args, opts])
        return { code: 0, stdout: '', stderr: '', missing: false, ...result }
      },
      now: () => NOW,
      home: () => '/home',
      env: () => undefined,
      fs: {}
    }
  }
}

function checkRun(overrides) {
  return {
    __typename: 'CheckRun',
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    databaseId: 111,
    startedAt: '2026-11-15T21:00:00Z',
    detailsUrl: 'https://github.com/o/r/actions/runs/1/job/111',
    ...overrides
  }
}

function prNode(overrides = {}, contexts = [], hasNextPage = false) {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    headRefName: 'feature/x',
    baseRefName: 'main',
    headRefOid: 'aaa',
    baseRefOid: 'bbb',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviewRequests: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { pageInfo: { hasNextPage }, nodes: contexts } } } }] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    ...overrides
  }
}

function response(nodes, rateLimit = { remaining: 4000, resetAt: '2026-11-15T22:00:00Z' }) {
  return JSON.stringify({ data: { rateLimit, repository: { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, b0: { nodes } } } })
}

async function readOne(node) {
  const { deps } = fakeDeps({ stdout: response([node]) })
  const out = await readRepo(deps, '/bin/gh', 'o/r')
  assert.deepEqual(out.status, { ok: true })
  return out.prs[0]
}

async function stateOf(conclusion, status = 'COMPLETED') {
  const pr = await readOne(prNode({}, [checkRun({ status, conclusion })]))
  return pr.checks[0].state
}

test('readRepo makes one gh api graphql call that asks only for the given branches', async () => {
  const { deps, calls } = fakeDeps({ stdout: fixture('gh-prs.json') })
  await readRepo(deps, '/opt/bin/gh', 'stablyai/orca', ['feat/a', 'fix/b', 'feat/a'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/opt/bin/gh')
  assert.deepEqual(calls[0][1], ['api', 'graphql', '-f', 'query=' + QUERY, '-f', 'owner=stablyai', '-f', 'name=orca', '-f', 'b0=feat/a', '-f', 'b1=fix/b'])
  assert.equal(prsQuery(2), QUERY)
})

test('the query never asks for a page of every open pull request', () => {
  for (const count of [0, 1, 7]) {
    const query = prsQuery(count)
    assert.equal((query.match(/pullRequests\(/g) ?? []).length, count)
    assert.equal((query.match(/first: 1, orderBy/g) ?? []).length, count)
    assert.equal(query.includes('fragment PrFields'), count > 0)
  }
})

test('readRepo with no branches still reads the default branch and the rate limit', async () => {
  const { deps, calls } = fakeDeps({ stdout: JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: '2026-11-15T22:00:00Z' }, repository: { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } } } }) })
  const out = await readRepo(deps, 'gh', 'o/r', [])
  assert.deepEqual(calls[0][1], ['api', 'graphql', '-f', 'query=' + prsQuery(0), '-f', 'owner=o', '-f', 'name=r'])
  assert.deepEqual(out, { status: { ok: true }, defaultBranch: 'main', prs: [] })
})

test('readRepo gathers the pull requests from every branch alias', async () => {
  const data = { rateLimit: { remaining: 4000, resetAt: '2026-11-15T22:00:00Z' }, repository: { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, b0: { nodes: [prNode({ number: 1, headRefName: 'a' })] }, b1: { nodes: [] }, b2: { nodes: [prNode({ number: 3, headRefName: 'c' })] } } }
  const out = await readRepo(fakeDeps({ stdout: JSON.stringify({ data }) }).deps, 'gh', 'o/r', ['a', 'b', 'c'])
  assert.deepEqual(out.prs.map((p) => [p.number, p.branch]), [[1, 'a'], [3, 'c']])
})

test('the fixture parses to the expected PrState list', async () => {
  const { deps } = fakeDeps({ stdout: fixture('gh-prs.json') })
  const out = await readRepo(deps, 'gh', 'stablyai/orca')
  assert.deepEqual(out.status, { ok: true })
  assert.equal(out.defaultBranch, 'main')
  assert.deepEqual(out.prs.map((p) => p.number), [42796, 42783, 42710, 42782, 6404])
  for (const pr of out.prs) assert.equal(pr.repo, 'stablyai/orca')

  const failing = out.prs.find((p) => p.number === 42783)
  assert.equal(failing.checks.length, 19)
  assert.ok(failing.checks.every((c) => c.state === 'fail'))
  assert.ok(failing.checks.some((c) => c.name === 'Mobile verify'))
  assert.ok(failing.checks.some((c) => c.name === 'static analysis and typecheck'))
  assert.ok(failing.checks.some((c) => c.name === 'PR checks passed'))

  const green = out.prs.find((p) => p.number === 42710)
  assert.equal(green.mergeable, 'MERGEABLE')
  assert.ok(green.checks.length > 0)
  assert.ok(green.checks.every((c) => c.state === 'pass'))

  const draft = out.prs.find((p) => p.number === 6404)
  assert.equal(draft.isDraft, true)
  assert.deepEqual(draft.checks, [])
  assert.equal(draft.checksTruncated, false)
  assert.equal(draft.reviewRequested, true)

  for (const pr of out.prs) {
    for (const check of pr.checks) assert.equal(typeof check.jobId, 'string')
  }
})

test('the fixture maps PR fields, threads, reviews, comments and bots', async () => {
  const { deps } = fakeDeps({ stdout: fixture('gh-prs.json') })
  const out = await readRepo(deps, 'gh', 'stablyai/orca')
  const pr = out.prs.find((p) => p.number === 42796)
  assert.equal(pr.url, 'https://github.com/stablyai/orca/pull/42796')
  assert.equal(pr.branch, 'feat/cli-worktree-notes')
  assert.equal(pr.base, 'main')
  assert.equal(pr.headSha, 'f3f6bca7179c042f01a8a1239899ce98ff51aecf')
  assert.equal(pr.baseSha, '69cfecdf700ef94f65b2c38a078f404684ca5482')
  assert.equal(pr.isDraft, false)
  assert.equal(pr.mergeable, 'UNKNOWN')
  assert.equal(pr.reviewDecision, null)
  assert.equal(pr.reviewRequested, false)
  assert.equal(pr.checksTruncated, false)
  assert.deepEqual(pr.checks[0], {
    name: 'clean',
    state: 'pass',
    jobId: '132962510999',
    url: 'https://github.com/stablyai/orca/actions/runs/43763243914/job/132962510999'
  })
  assert.equal(pr.threads.length, 2)
  assert.equal(pr.threads[0].id, 'PRRT_kwDORpCz1s63tgCV')
  assert.equal(pr.threads[0].resolved, false)
  const [bot, human] = pr.threads[0].comments
  assert.equal(bot.author, 'coderabbitai')
  assert.equal(bot.isBot, true)
  assert.equal(bot.path, 'src/cli/specs/worktree-notes.ts')
  assert.equal(bot.line, 46)
  assert.equal(human.author, 'jxnxts')
  assert.equal(human.isBot, false)
  assert.equal(pr.reviews.length, 3)
  assert.equal(pr.reviews[0].state, 'COMMENTED')
  assert.equal(pr.reviews[1].author, 'jxnxts')
  assert.equal(pr.reviews[1].isBot, false)
  assert.equal(pr.comments.length, 1)
  assert.equal(pr.comments[0].isBot, true)
  assert.equal(pr.comments[0].path, null)
  assert.equal(pr.comments[0].line, null)
})

test('a completed CheckRun conclusion maps to fail, pass or pending', async () => {
  for (const c of ['FAILURE', 'TIMED_OUT', 'ERROR', 'STARTUP_FAILURE']) assert.equal(await stateOf(c), 'fail', c)
  for (const c of ['SUCCESS', 'NEUTRAL', 'SKIPPED']) assert.equal(await stateOf(c), 'pass', c)
  for (const c of ['CANCELLED', 'ACTION_REQUIRED', 'STALE', null]) assert.equal(await stateOf(c), 'pending', String(c))
})

test('a CheckRun in progress with no conclusion is pending', async () => {
  assert.equal(await stateOf(null, 'IN_PROGRESS'), 'pending')
})

test('a StatusContext maps context, targetUrl and state', async () => {
  const ctx = (state) => ({ __typename: 'StatusContext', context: 'ci/legacy', state, targetUrl: 'https://ci.example/1' })
  const pr = await readOne(prNode({}, [ctx('SUCCESS'), { ...ctx('FAILURE'), context: 'a' }, { ...ctx('ERROR'), context: 'b' }, { ...ctx('PENDING'), context: 'c' }, { ...ctx('EXPECTED'), context: 'd' }]))
  assert.deepEqual(pr.checks[0], { name: 'ci/legacy', state: 'pass', jobId: null, url: 'https://ci.example/1' })
  assert.deepEqual(pr.checks.slice(1).map((c) => [c.name, c.state]), [['a', 'fail'], ['b', 'fail'], ['c', 'pending'], ['d', 'pending']])
})

test('two check runs with the same name keep only the later startedAt', async () => {
  const pr = await readOne(prNode({}, [
    checkRun({ name: 'build', conclusion: 'SUCCESS', databaseId: 2, startedAt: '2026-11-15T21:10:00Z' }),
    checkRun({ name: 'build', conclusion: 'FAILURE', databaseId: 1, startedAt: '2026-11-15T21:00:00Z' }),
    checkRun({ name: 'lint', databaseId: 3 })
  ]))
  assert.deepEqual(pr.checks.map((c) => [c.name, c.state, c.jobId]), [['build', 'pass', '2'], ['lint', 'pass', '3']])

  const flipped = await readOne(prNode({}, [
    checkRun({ name: 'build', conclusion: 'FAILURE', databaseId: 1, startedAt: '2026-11-15T21:00:00Z' }),
    checkRun({ name: 'build', conclusion: 'SUCCESS', databaseId: 2, startedAt: '2026-11-15T21:10:00Z' })
  ]))
  assert.deepEqual(flipped.checks.map((c) => [c.name, c.state, c.jobId]), [['build', 'pass', '2']])

  const { deps } = fakeDeps({ stdout: fixture('gh-prs.json') })
  const out = await readRepo(deps, 'gh', 'stablyai/orca')
  const bundles = out.prs.find((p) => p.number === 42710).checks.filter((c) => c.name === 'mobile_web_bundle')
  assert.equal(bundles.length, 1)
})

test('hasNextPage true sets checksTruncated', async () => {
  const pr = await readOne(prNode({}, [checkRun({})], true))
  assert.equal(pr.checksTruncated, true)
})

test('CONFLICTING and a non-null reviewDecision are kept', async () => {
  const pr = await readOne(prNode({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }))
  assert.equal(pr.mergeable, 'CONFLICTING')
  assert.equal(pr.reviewDecision, 'CHANGES_REQUESTED')
  const approved = await readOne(prNode({ reviewDecision: 'APPROVED' }))
  assert.equal(approved.reviewDecision, 'APPROVED')
  const required = await readOne(prNode({ reviewDecision: 'REVIEW_REQUIRED' }))
  assert.equal(required.reviewDecision, 'REVIEW_REQUIRED')
})

test('review states and bot logins ending in [bot] map', async () => {
  const pr = await readOne(prNode({
    reviews: { nodes: [
      { id: 'r1', state: 'CHANGES_REQUESTED', author: { __typename: 'User', login: 'dependabot[bot]' }, body: 'x', url: 'u1' },
      { id: 'r2', state: 'APPROVED', author: { __typename: 'User', login: 'amy' }, body: '', url: 'u2' },
      { id: 'r3', state: 'DISMISSED', author: null, body: '', url: 'u3' }
    ] }
  }))
  assert.deepEqual(pr.reviews.map((r) => [r.state, r.author, r.isBot]), [['CHANGES_REQUESTED', 'dependabot[bot]', true], ['APPROVED', 'amy', false], ['OTHER', '', false]])
})

test('Review Focus 1: gh missing gives missing with no run call', async () => {
  const { deps, calls } = fakeDeps({})
  const out = await readRepo(deps, null, 'o/r')
  assert.deepEqual(out, { status: { ok: false, reason: 'missing' }, defaultBranch: null, prs: [] })
  assert.equal(calls.length, 0)
})

test('Review Focus 1: a binary that cannot run gives missing', async () => {
  const { deps } = fakeDeps({ code: 127, missing: true })
  const out = await readRepo(deps, '/gone/gh', 'o/r')
  assert.equal(out.status.ok, false)
  assert.equal(out.status.reason, 'missing')
  assert.deepEqual(out.prs, [])
})

test('Review Focus 1: exit 4 or an authentication stderr gives signed-out', async () => {
  const exit4 = await readRepo(fakeDeps({ code: 4, stderr: 'oops' }).deps, 'gh', 'o/r')
  assert.equal(exit4.status.ok, false)
  assert.equal(exit4.status.reason, 'signed-out')
  assert.deepEqual(exit4.prs, [])
  const auth = await readRepo(fakeDeps({ code: 1, stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\nauthentication required' }).deps, 'gh', 'o/r')
  assert.equal(auth.status.reason, 'signed-out')
  assert.deepEqual(auth.prs, [])
})

test('Review Focus 1: rateLimit.remaining 0 gives rate-limited with retryInSec from resetAt', async () => {
  const stdout = response([prNode()], { remaining: 0, resetAt: '2026-11-15T21:55:00Z' })
  const out = await readRepo(fakeDeps({ stdout }).deps, 'gh', 'o/r')
  assert.deepEqual(out.status, { ok: false, reason: 'rate-limited', retryInSec: 300 })
  assert.deepEqual(out.prs, [])
})

test('Review Focus 1: a rate limit stderr gives rate-limited, at least 60 s when reset is unknown', async () => {
  const out = await readRepo(fakeDeps({ code: 1, stderr: 'GraphQL: API rate limit exceeded for user ID 1.' }).deps, 'gh', 'o/r')
  assert.equal(out.status.ok, false)
  assert.equal(out.status.reason, 'rate-limited')
  assert.ok(out.status.retryInSec >= 60)
  assert.deepEqual(out.prs, [])
})

test('Review Focus 1: a rate limit stderr with a resetAt in stdout uses it', async () => {
  const stdout = JSON.stringify({ data: { rateLimit: { remaining: 0, resetAt: '2026-11-15T21:52:00Z' }, repository: null } })
  const out = await readRepo(fakeDeps({ code: 1, stdout, stderr: 'API rate limit exceeded' }).deps, 'gh', 'o/r')
  assert.deepEqual(out.status, { ok: false, reason: 'rate-limited', retryInSec: 120 })
})

test('Review Focus 1: any other non-zero exit gives error with no PRs', async () => {
  const out = await readRepo(fakeDeps({ code: 1, stderr: 'Could not resolve to a Repository' }).deps, 'gh', 'o/r')
  assert.equal(out.status.ok, false)
  assert.equal(out.status.reason, 'error')
  assert.deepEqual(out.prs, [])
  assert.equal(out.defaultBranch, null)
  const garbage = await readRepo(fakeDeps({ stdout: 'not json' }).deps, 'gh', 'o/r')
  assert.equal(garbage.status.reason, 'error')
  assert.deepEqual(garbage.prs, [])
})

function pr(repo, branch, number) {
  return { repo, branch, number }
}

test('Review Focus 5: prFor needs both branch and repo to match', () => {
  const prs = [pr('other/r', 'feature/x', 1), pr('o/r', 'feature/x', 2), pr('o/r', 'feature/y', 3)]
  assert.equal(prFor(prs, { repo: 'o/r', branch: 'feature/x' }, 'main').number, 2)
  assert.equal(prFor(prs, { repo: 'other/r', branch: 'feature/x' }, 'main').number, 1)
})

test('Review Focus 5: prFor returns null for the default branch, a null repo or another repository', () => {
  const prs = [pr('o/r', 'main', 1), pr('other/r', 'feature/z', 2)]
  assert.equal(prFor(prs, { repo: 'o/r', branch: 'main' }, 'main'), null)
  assert.equal(prFor(prs, { repo: null, branch: 'feature/z' }, 'main'), null)
  assert.equal(prFor(prs, { repo: 'o/r', branch: 'feature/z' }, 'main'), null)
  assert.equal(prFor(prs, { repo: 'o/r', branch: null }, 'main'), null)
})

test('failedLogTail runs gh run view and keeps the last lines', async () => {
  const log = Array.from({ length: 200 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
  const { deps, calls } = fakeDeps({ stdout: log })
  const out = await failedLogTail(deps, '/bin/gh', 'o/r', '132962510999', 80)
  assert.deepEqual(calls[0].slice(0, 2), ['/bin/gh', ['run', 'view', '--job', '132962510999', '--log-failed', '-R', 'o/r']])
  const lines = out.split('\n')
  assert.equal(lines.length, 80)
  assert.equal(lines[0], 'line 121')
  assert.equal(lines[79], 'line 200')
})

test('failedLogTail keeps a short log whole and returns empty on failure', async () => {
  const short = await failedLogTail(fakeDeps({ stdout: 'a\nb\n' }).deps, 'gh', 'o/r', '1', 80)
  assert.equal(short, 'a\nb')
  const failed = await failedLogTail(fakeDeps({ code: 1, stdout: 'partial', stderr: 'no logs' }).deps, 'gh', 'o/r', '1', 80)
  assert.equal(failed, '')
})

test('prDiff runs gh pr diff and returns empty on failure', async () => {
  const { deps, calls } = fakeDeps({ stdout: 'diff --git a/x b/x\n' })
  assert.equal(await prDiff(deps, 'gh', 'o/r', 42), 'diff --git a/x b/x\n')
  assert.deepEqual(calls[0].slice(0, 2), ['gh', ['pr', 'diff', '42', '-R', 'o/r']])
  assert.equal(await prDiff(fakeDeps({ code: 1, stderr: 'x' }).deps, 'gh', 'o/r', 42), '')
})

function scripted(results) {
  const calls = []
  let i = 0
  return {
    calls,
    deps: {
      run: async (cmd, args) => {
        calls.push(args.slice(0, 2).join(' '))
        return { code: 0, stdout: '', stderr: '', missing: false, ...results[Math.min(i++, results.length - 1)] }
      },
      now: () => NOW
    }
  }
}

const REFUSED = { code: 1, stdout: '{"errors":[{"type":"RATE_LIMIT"}]}', stderr: 'gh: API rate limit already exceeded for user ID 1.' }
const budget = (remaining, reset) => ({ stdout: JSON.stringify({ resources: { graphql: { limit: 5000, remaining, reset } } }) })

test('a rate-limit refusal with budget left is retried once and the retry is used', async () => {
  const { deps, calls } = scripted([REFUSED, budget(4400, NOW / 1000 + 900), { stdout: response([prNode()]) }])
  const out = await readRepo(deps, 'gh', 'o/r', ['feature/x'])
  assert.deepEqual(calls, ['api graphql', 'api rate_limit', 'api graphql'])
  assert.deepEqual(out.status, { ok: true })
  assert.equal(out.prs[0].number, 7)
})

test('a refusal that repeats with budget left asks for a short wait, not the long one', async () => {
  const { deps, calls } = scripted([REFUSED, budget(4400, NOW / 1000 + 900), REFUSED])
  const out = await readRepo(deps, 'gh', 'o/r', ['feature/x'])
  assert.equal(calls.length, 3)
  assert.deepEqual(out.status, { ok: false, reason: 'rate-limited', retryInSec: 60, soft: true })
})

test('a refusal with the budget spent waits until the real reset and does not retry', async () => {
  const { deps, calls } = scripted([REFUSED, budget(0, NOW / 1000 + 900)])
  const out = await readRepo(deps, 'gh', 'o/r', ['feature/x'])
  assert.deepEqual(calls, ['api graphql', 'api rate_limit'])
  assert.deepEqual(out.status, { ok: false, reason: 'rate-limited', retryInSec: 900 })
})
