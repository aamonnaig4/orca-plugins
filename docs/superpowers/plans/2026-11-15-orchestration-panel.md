# Orchestration panel 1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Orca plugin, `plugins/orchestration`: a side panel with one orchestrator chat for every project, a Board of every agent session on this computer, PR babysitting that routes CI failures, review comments and conflicts to the owning session, approval cards in the chat, and a merge guard. It never opens a tab and never merges.

**Architecture:**
- **Pure logic** lives in small, test-covered modules: session joining, GitHub parsing, lanes, event diffing, guard rules, message text.
- **I/O goes through injected deps:** `run` for the `orca` and `gh` CLIs, a small `fs` seam for the orchestrator's home folder, and the host API.
- **`src/watcher.ts`** runs one tick on a timer and builds the view model. **`src/worker.ts`** wires modules to Orca: host calls, events, hooks, the status bar item and panel request handlers.
- **The panel** is plain JS in `panel/`. Each view is a pure function from the view model to an HTML string.

**Tech Stack:**
- A TypeScript trusted worker, run by Orca with Node type-stripping.
- A plain-JS HTML panel.
- Tests with `node:test` plus `orca/testing` (`mockHost`, `mountWorker`), run with `orca plugin test .` from `plugins/orchestration`.
- The `gh` CLI for GitHub. The `orca` CLI for orchestration.

**Spec:** `docs/superpowers/specs/2026-11-15-orchestration-panel-design.md`. Layout and copy: `docs/design/orchestration-panel/mockup-decisions.html`. Tokens and icons: `docs/design/orchestration-panel/prototype.html`.

## Global Constraints

- **No comments of any kind in source** (AGENTS.md §1; `hooks/check_source_comments.py`).
- **No tabs.** The plugin never calls `workspace.open`, `terminal.focus`, `editor.open`, `commands.run`, `orca terminal switch|focus`, `orca file open|diff|open-changed`, or `orca agent launch --focus`. The only way out of the panel is `shell.openExternal` for "PR on GitHub".
- **Never merge.** No merge button and no merge call. Never `orca orchestration reset`, never a consuming `orca orchestration check`. `orca worktree rm` runs only with `confirmed: true` from the panel.
- **Never type into a busy agent.** Text reaches a terminal only through the CLI: `cli.json(['terminal','send','--terminal',id,'--text',text,'--enter'])` for a message (Orca bracket-pastes it, so multi-line is safe), and the same without `'--enter'` for keys (bytes go verbatim, so `1`, `\u001b` and `\r` work). Host `terminal.sendText` is never called: Orca refuses it (spike 6). A failure is a thrown `CliError`. A message goes only to an agent whose effective state (`effectiveState`, Task 3) is `waiting` or `done`, re-read from `workspace.list` just before sending. The one exception is an approval key or a Peek key, sent to an agent whose effective state is `blocked`.
- **GitHub goes only through `gh`,** with the user's login.
- **This computer only.** Workspaces whose `hostId` is not `local` are ignored.
- **Agent ids** (Orca's catalog): `claude`, `codex`, `grok`, `gemini`, `antigravity` (cmd `agy`), `cursor` (cmd `cursor-agent`), `copilot`, `opencode`, `opencode2`, `aider`, `goose`, `kimi`, `droid`, `pi`, `omp`, `qwen`, `amp`, `cline`, `devin`, `hermes`.
- **Defaults:**

  | Setting | Key | Default |
  |---|---|---|
  | Orchestrator agent | `orchestratorAgent` | `""` until first run |
  | Default worker agent | `workerAgent` | `""` (means: same as orchestrator) |
  | Worker name suffix | `suffix` | `-oa` |
  | GitHub check interval | `intervalSec` | `60` (choices 30/60/120/300) |
  | Fix attempts before asking | `attempts` | `3` (choices 1/2/3/5) |
  | Merge guard | `guard` | `true` |
  | Auto-fix my own sessions | `autoFixYours` | `true` |

- **Fixed values:** home folder `~/.orca-orchestration/home`; marker prefix `orch:`; chat log cap 500; outbox message cap 16384 bytes; log tail 80 lines, at most 3 jobs; CI grace 600 s; approval check 3 s; kanban from panel width ≥ `640px`.
- **Lane names:** "Needs you", "Building", "Validating", "Needs review", "Ready", then "Idle · N sessions".
- **Manifest:** `execution: "trusted-worker"`, `engines.orca: ">=1.4.259"`, `pluginApi: 1`, id `orchestration`.
- **Test command,** from `plugins/orchestration`: `orca plugin test .`. Expected output: `N test file(s) passed (node).`
- **Branch** `aamonnaig4/orchestration`. One commit per task, pushed. Draft PR only. End each commit message with the attribution lines the session provides.

## Review Focus

1. **`gh` is missing, signed out or rate-limited.** The footer says so, nothing is sent, the Board keeps its last PR data marked stale, and nothing crashes. *(Task 4, Task 12)*
2. **The orchestrator's terminal is closed or lost to an Orca restart.** The next message resumes it by session id. Queued messages and the chat survive. *(Task 9)*
3. **A session vanishes mid-flight:** its worktree is removed, or its PR merges or closes, while a message for it sits in the queue. The message is dropped, never typed into another terminal, and the row leaves its lane. *(Task 7, Task 12)*
4. **Hostile text reaches the panel:** an outbox file, PR comment, branch name or command containing HTML. It is stored raw and escaped in every view. *(Task 8, Task 14)*
5. **A branch name matches the wrong PR:** a worktree on the default branch, or the same branch name in two repositories. A PR attaches only to a session in the same repository, never to a default-branch worktree. *(Task 3, Task 4)*

## File Structure

```
plugins/orchestration/
  orca-plugin.json  README.md  LICENSE
  src/
    deps.ts          run/fs/now seams, Settings, bin resolution
    orcacli.ts       orca --json wrapper, command availability
    agents.ts        agent catalog, installed detection
    sessions.ts      join workspaces + worktrees + workers into Session[]
    github.ts        one GraphQL read per repo, log tail, diff
    board.ts         lane and status phrase per session
    events.ts        PR state -> routed events, ledger, attempts
    messages.ts      text sent to agents
    deliver.ts       route + idle-gated stored queue
    home.ts          home folder files, outbox reader, board.md
    instructions.ts  AGENTS.md text, board.md text
    orchestrator.ts  launch hidden, resume, record
    needs.ts         Needs-you cards, approval answers
    guard.ts         merge/force-push/push-main matcher
    watcher.ts       the tick, the view model
    worker.ts        wiring
  panel/
    index.html  style.css  esc.js  app.js  chat.js  board.js  detail.js  settings.js
  tests/
    *.test.mjs  fixtures/
```

---

### Task 0: Spikes (results go in the spec before any module is written)

Done on 2026-11-15; results are in the spec's Spike results section and the fixtures.

Run the nine spikes in the spec's "Spikes the build runs first", in order, with throwaway code loaded by `orca plugin dev load`. Nothing is committed except the spec edit and the fixtures.

- [ ] **Step 1:** Run spikes 1 and 2 (hidden home, `--repo` from the folder). Record what was visible in Orca, the `terminalId` shape, and where the worktree landed.
- [ ] **Step 2:** Run spikes 3 and 9 (dispatch mail from outside a terminal; mail to the orchestrator). Record the exact commands and receipts.
- [ ] **Step 3:** Run spikes 4, 5 and 7 (ids, screen reads, chat-surface agents). Record one real payload of `agent.status.changed` and `agent.tool.before` next to the `workspace.list` and `worktree list` rows for the same workspace.
- [ ] **Step 4:** Run spike 6 (approval keys) against a Claude Code permission prompt and a folder-trust prompt. Record the keys that worked.
- [ ] **Step 5:** Run spike 8 (keep-alive): a scratch plugin with a status bar item logs once every 10 s; close the panel for 2 minutes; `orca plugin logs` must show 12 lines.
- [ ] **Step 6:** Save real output to `plugins/orchestration/tests/fixtures/`:
  - `agent-context.json` (trimmed to the commands this plan uses);
  - `worktree-list.json`, `worker-list.json`, `repo-list.json`, `hooks-status.json`;
  - `workspace-list.json` (the host call's result);
  - `gh-prs.json` (Task 4's query against one repository with at least one failing and one green PR).
- [ ] **Step 7:** Write a "Spike results" section in the spec: one line per spike with the observation and "holds" or the fallback now in force. Where a fallback changes a later task, edit that task in this plan in the same commit.
- [ ] **Step 8:** Commit: "Record orchestration spikes and CLI fixtures".

### Task 1: Scaffold, deps and the `orca` CLI wrapper

**Files:**
- Create: `plugins/orchestration/orca-plugin.json`, `README.md` (one paragraph), `LICENSE` (copy MIT from `plugins/now-playing`), `src/deps.ts`, `src/orcacli.ts`, `src/worker.ts` (an `activate` that registers nothing yet), `panel/index.html` (empty shell)
- Test: `tests/deps.test.mjs`, `tests/orcacli.test.mjs`, `tests/worker.test.mjs`

**Interfaces:**
- Produces, in `src/deps.ts`:
  ```ts
  type RunResult = { code: number; stdout: string; stderr: string; missing: boolean }
  type Fs = { read(path: string): Promise<string | null>; write(path: string, text: string, mode?: number): Promise<void>; list(dir: string): Promise<string[]>; remove(path: string): Promise<void>; mkdir(dir: string): Promise<void> }
  type Deps = { run(cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number; cwd?: string }): Promise<RunResult>; now(): number; home(): string; env(name: string): string | undefined; fs: Fs }
  const nodeDeps: Deps
  type Bins = { orca: string; gh: string | null }
  function resolveBins(deps: Deps): Promise<Bins>
  type Settings = { orchestratorAgent: string; workerAgent: string; suffix: string; intervalSec: number; attempts: number; guard: boolean; autoFixYours: boolean }
  const DEFAULT_SETTINGS: Settings
  function readSettings(raw: Record<string, unknown>): Settings
  ```
- Produces, in `src/orcacli.ts`:
  ```ts
  class CliError extends Error { code: string; retryable: boolean }
  function createCli(deps: Deps, bin: string): { json<T>(args: string[]): Promise<T>; has(command: string): boolean; load(): Promise<void> }
  ```
- Manifest:
  - panel `{ "id": "orchestration", "title": "Orchestration", "icon": "agent", "entry": "panel/index.html" }`;
  - status bar item `{ "id": "needs", "text": "1 needs you", "icon": "agent", "tone": "danger" }`;
  - events `agent.status.changed`, `workspace.created`, `workspace.removed`;
  - hooks as objects: `[{ "event": "agent.tool.before" }, { "event": "agent.tool.after" }]` (needs `engines.orca >= 1.4.248`, no capability);
  - settings: the seven keys in Global Constraints with their defaults;
  - capabilities `storage:own`, `settings:own`, `notifications:show`, `agent:read`, `agent:launch`, `terminal:read`, `terminal:send`, `workspace:read`, plus each capability `orca plugin validate .` names as missing.

- [ ] **Step 1: Failing tests.**
  - `run` on a command that does not exist resolves `{ missing: true, code: 127 }` and does not reject.
  - `resolveBins` makes one `run('/bin/zsh', ['-lc', …])` call. With stdout `orca=/a/orca\ngh=/b/gh` it returns `{ orca: '/a/orca', gh: '/b/gh' }`. With no `gh=` line, `gh` is `null`. With `env('ORCA_CLI_COMMAND') === '/x/orca'`, `orca` is `/x/orca`.
  - `readSettings({})` equals `DEFAULT_SETTINGS`. `readSettings({ intervalSec: 7, attempts: 'x' })` keeps the defaults `60` and `3`.
  - `json(['worktree','list'])` calls `run(bin, ['worktree','list','--json'])` and returns the parsed `result`. Passing `--json` already does not double it.
  - `{ ok:false, error:{ code:'runtime_unavailable' } }` rejects with `CliError`, `code === 'runtime_unavailable'`, `retryable === true`. `missing: true` rejects with `code === 'orca_missing'`.
  - `load()` runs `agent-context --json` and reads its output as is: it has no `{ ok, result }` envelope, only `schemaVersion`, `commandCount` and `commands`, and `has` matches on `commands[].command`. After `load()` on `agent-context.json`, `has('orchestration worker-start')` and `has('terminal send')` are `true` and `has('nope')` is `false`. `json()` unwraps `result` (as in `worker-list.json`); `load()` does not look for one.
  - `mountWorker(main)` leaves `worker.refusals` equal to `[]`.
- [ ] **Step 2:** Run `orca plugin test .`. The new tests FAIL.
- [ ] **Step 3:** Implement. `nodeDeps.run` uses `execFile` with a 20 s default timeout and a 32 MiB buffer, and maps `ENOENT` to `missing`.
- [ ] **Step 4:** Run `orca plugin test .`. PASS. Run `orca plugin validate .` and add capabilities until it prints no errors.
- [ ] **Step 5:** Commit: "Scaffold the orchestration plugin and its orca CLI wrapper".

### Task 2: Agent catalog and installed-agent detection

**Files:**
- Create: `src/agents.ts`
- Test: `tests/agents.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  type AgentEntry = { id: string; label: string; cmd: string; installed: boolean }
  const AGENT_CATALOG: { id: string; label: string; cmd: string }[]
  function detectAgents(deps: Deps): Promise<AgentEntry[]>
  ```
  `AGENT_CATALOG` holds the Global Constraints ids in that order. `cmd` equals `id` except where stated there.

- [ ] **Step 1: Failing tests.**
  - With a fake `run` whose stdout is `ok claude\nok agy`, `detectAgents` returns `claude` then `antigravity` first, both `installed: true`, then every other entry in catalog order with `installed: false`.
  - It makes exactly one `run` call, `/bin/zsh -lc` with a script that runs `command -v` for every catalog command.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Detect installed Orca agents from the catalog".

### Task 3: Sessions

**Files:**
- Create: `src/sessions.ts`
- Test: `tests/sessions.test.mjs` (uses the Task 0 fixtures)

**Interfaces:**
- Produces:
  ```ts
  type AgentState = 'working' | 'blocked' | 'waiting' | 'done' | 'none'
  type AgentInfo = { state: AgentState; terminalId: string | null; sessionId: string | null; chatId: string | null; kind: string | null; since: number; permissionMasked: boolean }
  type StatusEvent = { state: 'working' | 'blocked' | 'waiting' | 'done'; terminalId?: string; sessionId?: string; paneKey?: string; receivedAt: number }
  type Session = { key: string; ids: string[]; path: string; name: string; project: string; repoId: string; repo: string | null; branch: string | null; isMain: boolean; agent: AgentInfo; dispatchId: string | null; started: 'orchestrator' | 'you' }
  function buildSessions(input: { workspaces: unknown; worktrees: unknown; workers: unknown; agents: Record<string, AgentInfo>; tracked: string[]; marker: string; homePath: string }): Session[]
  function createIndex(sessions: Session[]): { byKey(key: string): Session | null; byAnyId(id: string | null | undefined): Session | null; byTerminal(terminalId: string | null | undefined): Session | null }
  function agentFromStatus(prev: AgentInfo | undefined, ev: StatusEvent, kind: string | null): AgentInfo
  function listStateOf(workspaces: unknown, path: string): string | null
  function effectiveState(agent: AgentInfo | undefined, listState: string | null): AgentState
  ```
- Real shapes (fixtures `workspace-list.json`, `worktree-list.json`, `worker-list.json`):
  - `workspace.list` returns `{ workspaces: [...] }`. Each row's `status` is an **object**; its state is `status.state`. Its `id` is `identity:wt2:local:<instanceId>`, except a folder, whose `id` is `repoId::path`. Its `projectId` is the bare `repoId`, and `branch` is the short name (`null` for a folder).
  - `worktree list` rows have `id` = `repoId::path`, `instanceId`, `repoId`, `projectId` (`github:owner/name`, or `repo:<repoId>` for a folder), `branch` (`refs/heads/…`, or `""` for a folder), `comment`, `hostId`, `isMainWorktree`.
  - `worker-list` rows have `dispatchId` (no `id`), `workspace` (= `repoId::path`), optional `terminal`, and no timestamp.
- Rules:
  - `key` is the worktree `path`. `ids` holds the `workspace.list` id, the `worktree list` `id` and its `instanceId`, in that order.
  - `repo` is `owner/name` when the `worktree list` `projectId` starts with `github:` (the last two path segments), else `null`.
  - `branch` comes from `worktree list`: drop a leading `refs/heads/`; an empty string becomes `null`.
  - `listStateOf` returns `status.state` of the `workspace.list` row whose `path` equals `path`, else `null`.
  - `effectiveState` is the one definition of an agent's state that every later task uses:
    - with no `agent` entry, map the list state: `working` → `working`, `permission` → `blocked`, `done` → `done`, `active` → `waiting`, `inactive` or `null` → `none`;
    - `agent.state === 'blocked'` → `blocked`;
    - `agent.state === 'waiting'` and `listState === 'permission'` and `!agent.permissionMasked` → `blocked` (a Claude Code permission prompt reports `waiting` in events and `permission` only in `workspace.list`, spike 6);
    - otherwise `agent.state`.
  - `agents` is keyed by path. Each session's `agent` is the stored entry (or, with none, an `AgentInfo` with every id `null`, `kind: null`, `since: 0`, `permissionMasked: false`) with `state` replaced by `effectiveState(entry, listStateOf(workspaces, path))`.
  - A row is dropped when `hostId` is not `local`, when `path === homePath`, or when it appears in only one of the two lists.
  - `started` is `'orchestrator'` when `comment` starts with `marker`, or any `workers` row whose `workspace` is in `ids` has its `dispatchId` in `tracked`. For an orchestrator-started session, `dispatchId` is the `dispatchId` of the **first** `workers` row in list order whose `workspace` is in `ids` (Orca lists the newest first; a follow-up's new id comes first), else `null`. A `'you'` session has `dispatchId: null`.
  - `agentFromStatus` keeps the previous `sessionId`, `terminalId` and `chatId` when the event has none. When `paneKey` starts with `structured-agent-session-`, `chatId` is the text after that prefix up to the first `:` (a chat agent; it has no `terminalId`, spike 7). `permissionMasked` is always `false` in the result: any new status event clears the mask.

- [ ] **Step 1: Failing tests.**
  - The fixtures yield one `Session` per local worktree outside `homePath`, keyed by path, with `repo === 'aamonnaig4/orca-plugins'` for the `github:` project. A hand-built folder row (`projectId: 'repo:x'`, `branch: ''`) gives `repo: null` and `branch: null`. The `spike-oa` session has `branch === 'aamonnaig4/spike-oa'`.
  - A worktree whose `comment` is `orch:abc` is `started: 'orchestrator'`. With `marker: 'orch:x'` (so the fixture's `orch:spike` comment does not match) and `tracked: ['ctx_92026b9d61c3']`, the `spike-oa` session is `started: 'orchestrator'` with `dispatchId === 'ctx_6fc5b45b8c33'` (the first row). With `tracked: []` it is `started: 'you'` and `dispatchId: null`.
  - A row with `hostId: 'ssh:x'` is dropped. The row at `homePath` is dropped.
  - `byAnyId` finds the same session by each of its three ids. `byTerminal('t1')` finds the session whose `agent.terminalId` is `t1`. All three lookups return `null` for `undefined` and for `null`.
  - `effectiveState`: `undefined` with `'permission'` → `blocked`; `{ state: 'waiting' }` with `'permission'` → `blocked`; the same with `permissionMasked: true` → `waiting`; `{ state: 'waiting' }` with `'active'` → `waiting`; `{ state: 'blocked' }` with `null` → `blocked`. A session built with no `agents` entry from the home fixture row (copied to another path) has state `blocked`.
  - `agentFromStatus` keeps the previous `sessionId` and `terminalId` when the event has none, sets `since` to `receivedAt` only when `state` changes, and clears `permissionMasked`. With `paneKey: 'structured-agent-session-claude_780deaf0_x:uuid'` and no `terminalId`, `chatId === 'claude_780deaf0_x'` and `terminalId` is `null`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Join Orca workspaces, worktrees and workers into sessions".

### Task 4: GitHub reader

**Files:**
- Create: `src/github.ts`
- Test: `tests/github.test.mjs`, fixture `tests/fixtures/gh-prs.json`

**Interfaces:**
- Produces the types:
  ```ts
  type Check = { name: string; state: 'pass' | 'fail' | 'pending'; jobId: string | null; url: string | null }
  type Comment = { id: string; author: string; isBot: boolean; body: string; url: string; path: string | null; line: number | null }
  type Thread = { id: string; resolved: boolean; comments: Comment[] }
  type Review = { id: string; state: 'CHANGES_REQUESTED' | 'COMMENTED' | 'APPROVED' | 'OTHER'; author: string; isBot: boolean; body: string; url: string }
  type PrState = { repo: string; number: number; url: string; branch: string; base: string; headSha: string; baseSha: string; isDraft: boolean; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; reviewDecision: 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | null; reviewRequested: boolean; checks: Check[]; checksTruncated: boolean; threads: Thread[]; reviews: Review[]; comments: Comment[] }
  type GhStatus = { ok: true } | { ok: false; reason: 'missing' | 'signed-out' | 'rate-limited' | 'error'; retryInSec?: number }
  ```
- Produces the functions:
  ```ts
  function readRepo(deps: Deps, gh: string | null, repo: string): Promise<{ status: GhStatus; defaultBranch: string | null; prs: PrState[] }>
  function prFor(prs: PrState[], session: { repo: string | null; branch: string | null }, defaultBranch: string | null): PrState | null
  function failedLogTail(deps: Deps, gh: string, repo: string, jobId: string, lines: number): Promise<string>
  function prDiff(deps: Deps, gh: string, repo: string, pr: number): Promise<string>
  ```
- `readRepo` makes one call, `gh api graphql -f query=<Q> -f owner=<owner> -f name=<name>`, where `Q` is the text of `tests/fixtures/gh-prs.graphql` **verbatim** (a test asserts the query string equals that file). The response is `{ data: { rateLimit, repository } }`.
- Field mapping per PR node: `headRefName` → `branch`, `baseRefName` → `base`, `headRefOid` → `headSha`, `baseRefOid` → `baseSha`, `reviewRequests.totalCount > 0` → `reviewRequested`.
- Checks come from `commits.nodes[0].commit.statusCheckRollup`. That rollup is `null` for a PR with no checks (PR 6404 in the fixture): `checks: []`, `checksTruncated: false`. Otherwise read `contexts.nodes` and `contexts.pageInfo.hasNextPage`.
  - A CheckRun (`__typename === 'CheckRun'`): `pending` when `status !== 'COMPLETED'`; else map `conclusion` (rules in Step 1). `jobId` is `String(databaseId)` (`databaseId` is a number), `url` is `detailsUrl`.
  - A StatusContext: `name` is `context`, `url` is `targetUrl`, `jobId: null`; `state` `SUCCESS` → `pass`, `FAILURE` or `ERROR` → `fail`, anything else → `pending`.
- Bots are authors with `__typename === 'Bot'` or a login ending in `[bot]`.

- [ ] **Step 1: Failing tests.**
  - The fixture parses to the expected `PrState[]`: PR 42783 has three `fail` checks, PR 42710 is all `pass` and `MERGEABLE`, and draft PR 6404 (rollup `null`) has `checks: []`. Every CheckRun `jobId` is a string. For a completed CheckRun, FAILURE, TIMED_OUT, ERROR and STARTUP_FAILURE map to `fail`; SUCCESS, NEUTRAL and SKIPPED map to `pass`; CANCELLED and anything else map to `pending`. A CheckRun with `status: 'IN_PROGRESS'` and `conclusion: null` is `pending`.
  - The fixture has no StatusContext, no `hasNextPage: true`, no `CONFLICTING` and no non-null `reviewDecision`; build those inputs by hand.
  - Two check runs with the same name keep only the one with the later `startedAt`.
  - `contexts.pageInfo.hasNextPage === true` sets `checksTruncated: true`.
  - **Review Focus 1:** `gh === null` gives `{ ok:false, reason:'missing' }` with no `run` call. Exit 4, or stderr containing "authentication", gives `'signed-out'`. A response whose `rateLimit.remaining` is `0`, or stderr containing "rate limit", gives `'rate-limited'` with `retryInSec` computed from `resetAt` (at least 60 when unknown). Any other non-zero exit gives `'error'`. In every failing case `prs` is `[]`.
  - **Review Focus 5:** `prFor` returns the PR whose `branch` and `repo` both match. It returns `null` when `session.branch === defaultBranch`, when `repo` is `null`, and when the branch matches a PR in a different repository.
  - `failedLogTail(…, 80)` runs `gh run view --job <jobId> --log-failed -R <repo>` and returns at most the last 80 lines. A non-zero exit returns `''`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Read every open PR of a repository through gh".

### Task 5: Lanes and status phrases

**Files:**
- Create: `src/board.ts`
- Test: `tests/board.test.mjs`

**Interfaces:**
- Consumes `Session` (Task 3) and `PrState` (Task 4).
- Produces:
  ```ts
  type Lane = 'needs' | 'building' | 'validating' | 'review' | 'ready' | 'idle'
  type Tone = 'bad' | 'build' | 'warn' | 'info' | 'ok'
  type NeedKind = 'approval' | 'attempts' | 'merge-blocked' | 'unreachable'
  type Fixing = { kind: 'ci' | 'review' | 'conflict'; sha: string; at: number } | null
  function isReady(pr: PrState): boolean
  function ago(fromMs: number, nowMs: number): string
  function place(input: { session: Session; pr: PrState | null; need: { kind: NeedKind; detail: string } | null; fixing: Fixing; now: number }): { lane: Lane; phrase: string; tone: Tone } | null
  ```
- `place` rules, in order:
  1. `need` set → `needs`, tone `bad`. Phrases: approval → `Blocked · <detail>`; attempts → `CI failing · <detail>`; merge-blocked → `Merge blocked`; unreachable → `No agent to message`.
  2. No `pr`: agent `working` → `building`, `Working · <ago>`, tone `build`. Agent `none` and `session.isMain` → `null`. Otherwise → `idle`, `Idle · last active <ago> ago`, tone `info`.
  3. `pr.isDraft` → `validating`, `Draft`, tone `info`.
  4. `pr.mergeable === 'CONFLICTING'` → `validating`, tone `warn`: `Resolving conflicts · sent <ago> ago` when `fixing.kind === 'conflict'`, else `Merge conflicts`.
  5. Any check `fail` → `validating`, tone `warn`: `Fixing CI failures · sent <ago> ago` when `fixing.kind === 'ci'` and `fixing.sha === pr.headSha`, else `CI failing`.
  6. Any check `pending`, zero checks, or `checksTruncated` → `validating`, `Checks running · <passed> of <total>` (zero checks: `Waiting for checks`), tone `info`.
  7. Any unresolved thread → `review`, tone `warn`: `Addressing comments · sent <ago> ago` when `fixing.kind === 'review'`, else `Commented`.
  8. `reviewDecision === 'CHANGES_REQUESTED'` → `review`, `Changes requested`, tone `warn`.
  9. `reviewRequested` → `review`, `Awaiting review`, tone `info`.
  10. `mergeable !== 'MERGEABLE'` → `validating`, `Checking mergeability`, tone `info`.
  11. Otherwise → `ready`, `Mergeable`, tone `ok`.
- `ago` returns `45s`, `14m`, `2h` or `3d`.

- [ ] **Step 1: Failing tests.**
  - `isReady` is true only when all hold: not a draft, at least one check, every check `pass`, not `checksTruncated`, no thread with `resolved === false`, `reviewDecision !== 'CHANGES_REQUESTED'`, `reviewRequested === false`, `mergeable === 'MERGEABLE'`. It is false for each single violation.
  - `place(...).lane === 'ready'` exactly when `isReady(pr)` and `need` is `null`.
  - One test per rule 1 to 11 asserts lane, phrase and tone, using the exact phrases above.
  - A `need` outranks everything: a green PR with an `approval` need is `needs`.
  - A main worktree with no agent and no PR returns `null`; the same worktree with a PR returns a lane.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Place each session in a lane with a status phrase".

### Task 6: Events, ledger, attempts and message text

**Files:**
- Create: `src/events.ts`, `src/messages.ts`
- Test: `tests/events.test.mjs`, `tests/messages.test.mjs`

**Interfaces:**
- Consumes `PrState`, `Check`, `Thread`, `Comment`, `Review` (Task 4).
- Produces in `src/events.ts`:
  ```ts
  type RouteEvent =
    | { kind: 'ci'; pr: number; sha: string; checks: Check[]; key: string }
    | { kind: 'thread'; pr: number; threadId: string; comment: Comment; key: string }
    | { kind: 'review'; pr: number; review: Review; key: string }
    | { kind: 'comment'; pr: number; comment: Comment; key: string }
    | { kind: 'bot-batch'; pr: number; sha: string; items: Comment[]; key: string }
    | { kind: 'conflict'; pr: number; base: string; baseSha: string; key: string }
  type Ledger = { sent: Record<string, number>; ciSends: Record<string, number>; firstFail: Record<string, number>; last: Record<string, { kind: 'ci' | 'review' | 'conflict'; sha: string; at: number }> }
  const EMPTY_LEDGER: Ledger
  function diffEvents(pr: PrState, ledger: Ledger, o: { now: number; maxAttempts: number; ci: boolean; review: boolean }): { events: RouteEvent[]; ledger: Ledger; limitHit: boolean }
  function recordSent(ledger: Ledger, pr: PrState, ev: RouteEvent, now: number): Ledger
  function resetAttempts(ledger: Ledger, pr: PrState): Ledger
  function fixingFor(ledger: Ledger, pr: PrState): { kind: 'ci' | 'review' | 'conflict'; sha: string; at: number } | null
  ```
- Every per-PR ledger key uses `` `${repo}#${number}` ``. Dedupe keys:
  - ci: `` `ci:${repo}#${number}:${headSha}` ``;
  - thread: `` `c:${comment.id}` `` for the newest comment of an unresolved thread;
  - review: `` `r:${review.id}` ``;
  - comment: `` `c:${comment.id}` ``;
  - bot batch: `` `bot:${repo}#${number}:${headSha}` ``;
  - conflict: `` `conflict:${repo}#${number}:${baseSha}` ``.
- `diffEvents` rules:
  - It returns `firstFail` updated: the first time a head SHA shows a failed check, `firstFail[ciKey] = now`.
  - A `ci` event is emitted when `o.ci`, a check is `fail`, the key is unsent, and either no check is `pending` or `now - firstFail[ciKey] >= 600000`. Its `checks` are the failed ones.
  - When `ciSends[prKey] >= maxAttempts` and a `ci` event would be emitted, it is withheld and `limitHit` is `true`.
  - When the head SHA has checks, none `fail` and none `pending`, the returned ledger has `ciSends[prKey]` removed.
  - `conflict` is emitted when `o.ci` and `mergeable === 'CONFLICTING'`.
  - `thread`, `review`, `comment` and `bot-batch` are emitted when `o.review`. A comment or review body starting with `[agent]` is never emitted. Human top-level comments are `comment` events; bot top-level comments and bot review bodies go into one `bot-batch`.
  - `review` is emitted for a review with a non-empty body and state `CHANGES_REQUESTED` or `COMMENTED`.
- `recordSent` sets `sent[ev.key] = now`. A `ci` event adds 1 to `ciSends[prKey]`. `ci`, `conflict`, and `thread`/`review`/`comment`/`bot-batch` (as `review`) set `last[prKey]` with `pr.headSha`.
- `fixingFor` returns `last[prKey]` when its `sha === pr.headSha`, else `null`.
- Produces in `src/messages.ts`:
  ```ts
  function messageFor(ev: RouteEvent, pr: PrState, extra: { logs?: { check: string; tail: string }[] }): { subject: string; body: string }
  ```
  - Every body ends with: `Fix it, push, and do not merge. Start any reply you post on the PR with [agent].`
  - ci: subject `CI failed on #<n>`; body lists each failed check's name and URL, then each log tail in a fenced block.
  - thread: subject `Review comment on #<n>`; body has path, line, text, URL, and `Resolve it when fixed: gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: "<threadId>" }) { thread { isResolved } } }'`.
  - conflict: body starts `Merge origin/<base> into your branch and resolve conflicts, then push.`

- [ ] **Step 1: Failing tests.**
  - Calling `diffEvents`, `recordSent` for each event, then `diffEvents` again on the same `PrState` emits nothing the second time.
  - Three failed checks on one SHA with none pending emit one `ci` event with three checks. With one check still `pending` and `now - firstFail < 600000` nothing is emitted; at `600000` it is.
  - A new head SHA with a failure emits a new `ci` event and `ciSends` becomes 2.
  - With `maxAttempts = 3` and `ciSends = 3`, a failing new SHA emits no `ci` event and `limitHit === true`. After `resetAttempts` it emits again.
  - A fully green SHA removes `ciSends` for that PR, so a later failure starts at 1.
  - With `o.ci === false` no `ci` or `conflict` event is emitted, and `limitHit` is `false`. With `o.review === false` no `thread`, `review`, `comment` or `bot-batch` is emitted.
  - A resolved thread emits nothing. A new comment in an already-sent unresolved thread emits one `thread` event for the new comment. A newest comment starting with `[agent]` emits nothing.
  - Three bot comments on one SHA produce one `bot-batch` with three items.
  - `fixingFor` returns the last send for the current head SHA and `null` after the SHA changes.
  - `messageFor` snapshot for each kind, including the fixed closing line.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Diff PR state into routed events with dedupe and a fix limit".

### Task 7: Delivery

**Files:**
- Create: `src/deliver.ts`
- Test: `tests/deliver.test.mjs`

**Interfaces:**
- Consumes `Session`, `createIndex`, `effectiveState`, `listStateOf` (Task 3), `createCli`, `CliError` (Task 1), `HostApi<'worker'>`, `StorageApi`.
- Produces:
  ```ts
  type Outgoing = { id: string; key: string; subject: string; body: string; at: number }
  type SendResult = 'sent' | 'queued' | 'unreachable'
  function createDelivery(o: { host: HostApi<'worker'>; cli: ReturnType<typeof createCli>; store: StorageApi; now(): number; id(): string; fromHandle(): string | null; track(dispatchId: string): void }): {
    load(): Promise<void>
    send(session: Session, subject: string, body: string): Promise<SendResult>
    flush(session: Session): Promise<number>
    prune(liveKeys: string[]): Promise<number>
    queued(key: string): Outgoing[]
  }
  ```
- `fromHandle()` returns the orchestrator's `terminalId` (a `term_…` string) or `null`; `track(id)` adds a dispatch id to the watcher's `tracked`. Both are late-bound callbacks (Task 13 wires them), because the orchestrator and watcher are created after delivery. Every `orchestration send` from the worker process needs `--from`: without it Orca answers `no_active_sender_terminal` (spike 3).
- **Live state.** Before any send to a terminal or chat, delivery re-reads `host.call('workspace.list', { includeStatus: true })` and uses `effectiveState(session.agent, listStateOf(result, session.path))` as the state, because a status event arrives before the next tick's poll and a permission prompt shows only there as `permission`.
- Route, in this order:
  1. `session.started === 'orchestrator'`, `dispatchId` set and `fromHandle()` not `null` → `cli.json(['orchestration','send','--from',fromHandle(),'--to','dispatch:'+dispatchId,'--subject',subject,'--body',body])`; the receipt's `dispatchId` (a new id for every follow-up, linked by `followUpOf`) goes to `track(...)` → `'sent'`. With `fromHandle()` `null` the route is skipped. A `CliError`, including one for a closed `--from` terminal (unproven in spike 3), falls through to 2: the spec's fallback, the terminal route.
  2. `agent.terminalId` and live state `waiting` or `done` → `cli.json(['terminal','send','--terminal',terminalId,'--text',subject + '\n\n' + body,'--enter'])` → `'sent'`. A `CliError` appends the item to the queue → `'queued'`.
  3. `agent.terminalId` and live state `working` or `blocked` → append to the stored queue → `'queued'`.
  4. No `terminalId` but `agent.chatId` (a chat agent; `agent.resume` would start a duplicate):
     - live state `waiting` or `done` and `fromHandle()` not `null` → `cli.json(['orchestration','send','--from',fromHandle(),'--to','orca_session_id:'+chatId,'--subject',subject,'--body',body])` → `'sent'`; a `CliError` → `'unreachable'`;
     - live state `working` or `blocked` → append to the queue → `'queued'`;
     - `fromHandle()` `null` → `'unreachable'`.
  5. No `terminalId`, no `chatId`, but `agent.sessionId` and `agent.kind` → `host.call('agent.resume', { workspaceId: session.ids[0], agent: kind, sessionId })`, append to the queue → `'queued'`.
  6. Otherwise → `'unreachable'`.
- The queue is stored under the key `queue` as `Outgoing[]`. `flush` re-reads the live state as above and sends a session's queued items oldest first, by route 2's command (terminal) or route 4's (chat), only when the live state is `waiting` or `done`, and returns how many it sent. It stops at the first `CliError` and leaves that item at the head. `prune` deletes items whose `key` is not in `liveKeys`.

- [ ] **Step 1: Failing tests,** with `mockHost` and a fake `cli`.
  - Each of the six routes: the expected call and result, and no other `cli` or host call besides the `workspace.list` re-read.
  - Route 1 passes `--from` with `fromHandle()`'s value and calls `track` with the receipt's `dispatchId`. With `fromHandle()` returning `null`, no `orchestration send` runs and route 2 is used.
  - A session with `chatId`, no `terminalId`, `sessionId` and `kind` set, in state `waiting`, gets `orchestration send … --to orca_session_id:<chatId>` and never `agent.resume`.
  - A session whose `agent.state` is `waiting` but whose fresh `workspace.list` row says `permission` gets no `terminal send` from `send` or `flush`; the item is queued. A session in state `blocked` is never sent a message by `send` or `flush`.
  - Two items queued for one session flush in order when its live state becomes `waiting`, one `terminal send … --enter` each. A second `flush` sends nothing.
  - The queue survives `createDelivery` re-creation followed by `load()`.
  - **Review Focus 3:** `prune(['a'])` with items queued for `a` and `b` removes `b`'s, returns 1, and a later `flush` for a session keyed `b` sends nothing.
  - A fake `cli` that rejects `terminal send` with a `CliError` leaves the item at the head of the queue during `flush`, and makes `send` return `'queued'`.
  - No host `terminal.sendText` call is ever made.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Deliver messages by dispatch mail, chat mail or an idle terminal, with a stored queue".

### Task 8: The home folder, the outbox and the standing instructions

**Files:**
- Create: `src/home.ts`, `src/instructions.ts`
- Test: `tests/home.test.mjs`, `tests/instructions.test.mjs`

**Interfaces:**
- Consumes `Deps`, `Settings` (Task 1).
- Produces in `src/instructions.ts`:
  ```ts
  type BoardLine = { name: string; key: string; project: string; lane: string; phrase: string; branch: string | null; pr: number | null; dispatchId: string | null; started: 'orchestrator' | 'you' }
  type ProjectLine = { name: string; repoId: string; path: string }
  function standingInstructions(o: { marker: string; workerAgent: string; suffix: string }): string
  function boardMarkdown(rows: BoardLine[], projects: ProjectLine[], now: number): string
  ```
- Produces in `src/home.ts`:
  ```ts
  type OutMsg =
    | { kind: 'text' | 'progress' | 'result'; text: string }
    | { kind: 'question'; text: string; options: string[] }
    | { kind: 'track'; dispatchId: string }
    | { kind: 'tell'; target: string; text: string }
  function homePath(deps: Deps): string
  function ensureHome(deps: Deps, o: { marker: string; workerAgent: string; suffix: string }): Promise<string>
  function readOutbox(deps: Deps, home: string): Promise<OutMsg[]>
  function writeBoard(deps: Deps, home: string, markdown: string): Promise<boolean>
  ```
- `ensureHome` writes, under `~/.orca-orchestration/home`:
  - `AGENTS.md` = `standingInstructions(...)`;
  - `CLAUDE.md` = `@AGENTS.md`;
  - `.claude/settings.json` = `{ "permissions": { "allow": ["Bash(orca:*)", "Bash(gh:*)", "Bash(./bin/say:*)", "Bash(./bin/tell:*)", "Read(board.md)"] }, "sandbox": { "excludedCommands": ["orca"] } }`. The `sandbox` key lets `orca` out of Claude Code's Bash sandbox, which otherwise blocks Orca's socket with EPERM (spike 1); allowing the command alone is not enough. This exact key is unproven: Task 17 (c) proves it, and if it fails there the fix goes here;
  - `bin/say` and `bin/tell`, mode `0o755`;
  - `outbox/` (empty directory).
  It rewrites a file only when its text differs.
- Outbox file format, written by the scripts as `outbox/<epoch-ms>-<pid>.msg`: line 1 is the kind; line 2 is the options joined with `|` (question), the dispatch id (track), the target (tell), or empty; the rest is the text.
  - `bin/say <kind> [--options "A|B"] <text…>` writes kinds `text`, `progress`, `result`, `question`, `track` (`say track <dispatch_id>`).
  - `bin/tell <session-name-or-key> <text…>` writes kind `tell`.
  - Both use only `printf`, `date` and `$$`, and write to a temp name then `mv`, so a half-written file is never read.
- `readOutbox` lists `outbox/`, reads `*.msg` in name order, removes each file it read, and returns the parsed messages. A file over 16384 bytes is cut to 16384. A file with an unknown kind, an empty text (for kinds that need one), or a `track` without an id is removed and skipped.
- `writeBoard` writes `board.md` only when the text changed, and returns whether it wrote.

- [ ] **Step 1: Failing tests,** with an in-memory `Fs`.
  - `ensureHome` writes the six paths above; `bin/say` and `bin/tell` get mode `0o755`. A second call with the same inputs makes no `write`.
  - `readOutbox` returns messages in file-name order, removes each file, and parses each kind. `question` with line 2 `Yes|No` has `options: ['Yes','No']`.
  - **Review Focus 4:** a `text` file containing `<img src=x onerror=1>` comes back with that text unchanged. A 20000-byte file comes back with 16384 bytes. A file with kind `rm -rf` is removed and skipped. A `.tmp` file is left alone.
  - `ensureHome`'s `.claude/settings.json` parses to an object whose `sandbox.excludedCommands` is `['orca']`.
  - `standingInstructions` contains each of:
    - `orca skills get orchestration`
    - `board.md`
    - the full start line `orca orchestration worker-start --spec "<task>" --agent <agent> --worktree new-top-level --repo id:<repoId> --name <short-name><suffix> --comment "<marker>" --json`, with `<agent>` replaced by the given `workerAgent` (Task 9 passes `workerAgent || orchestratorAgent`), and the given suffix and marker substituted (`worker-start` refuses a call without `--spec` or `--task`, and without `--agent`)
    - `--worktree new-top-level --repo id:<repoId>`
    - `--name <short-name><suffix>` with the given suffix substituted
    - `--comment "<marker>"` with the given marker substituted
    - `./bin/say track <dispatch_id>`
    - `./bin/say question --options`
    - `./bin/tell`
    - "never merge"
    - "never poll"
    - "draft"
    - "end your turn"
  - `boardMarkdown` puts one line per row under a heading per lane in Board order, and one line per project with its `repoId`. Two calls with the same rows and a different `now` differ only in the first line.
  - A real-shell test: run the generated `bin/say question --options "Yes|No" "Ship it?"` in a temp directory with `execFile`, then `readOutbox` with `nodeDeps` returns `{ kind: 'question', text: 'Ship it?', options: ['Yes','No'] }`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement. Any wording borrowed from the reference's prompts goes in with a `NOTICE` file (Apache-2.0); original wording needs none.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Give the orchestrator a home folder, standing instructions and an outbox".

### Task 9: Orchestrator lifecycle

**Files:**
- Create: `src/orchestrator.ts`
- Test: `tests/orchestrator.test.mjs`

**Interfaces:**
- Consumes `createCli` (Task 1), `Session`, `AgentInfo`, `agentFromStatus`, `effectiveState` (Task 3), `createDelivery` (Task 7), `ensureHome`, `homePath` (Task 8).
- Produces:
  ```ts
  type OrchRecord = { marker: string; repoId: string; workspaceId: string; home: string; agentKind: string; agent: AgentInfo }
  function createOrchestrator(o: { host: HostApi<'worker'>; cli: ReturnType<typeof createCli>; deps: Deps; store: StorageApi; delivery: ReturnType<typeof createDelivery>; settings(): Settings; id(): string }): {
    load(): Promise<void>
    record(): OrchRecord | null
    session(): Session | null
    ensure(): Promise<OrchRecord>
    say(text: string): Promise<'sent' | 'queued'>
    onStatus(ev: PluginEvents['agent.status.changed']): Promise<boolean>
    setListState(state: string | null): void
    maskPermission(): Promise<void>
  }
  ```
- Spike 1's visual check (no tab, sidebar row or badge) is Aamon's and is confirmed in Task 17 (a). Build the hidden home as below; if Aamon reports a visible tab or row, the spec's fallback (a terminal in an existing workspace the plugin never focuses) replaces it in a follow-up.
- Spike 9 (mail to the orchestrator through `run:<id>`) is unproven: it needs a Run that exists only after the first worker, shows the wrong sender and costs a `check` turn. Keep the terminal route and the plugin's own queue for the orchestrator, as below.
- `ensure`, the first time (no stored record):
  1. `marker = 'orch:' + id()`; `ensureHome(deps, { marker, workerAgent: settings().workerAgent || settings().orchestratorAgent, suffix })`.
  2. `cli.json(['repo','list'])` and look in `result.repos` for the row whose `path === home`. When found, reuse its `id` as `repoId`, and run `cli.json(['repo','hide','--repo','id:'+repoId])` only when the row has no `hiddenAt`. When absent, `cli.json(['repo','add','--path',home,'--kind','folder'])`, then `repo hide`. (The spike left this folder added and hidden, so the first real run takes the reuse path.)
  3. `workspaceId = repoId + '::' + home`, which is the folder's `workspace.list` id and the `workspaceId` its status events carry.
  4. `host.call('agent.launch', { workspaceId, agent: settings().orchestratorAgent })` with no prompt. It returns `{ terminalId }`; store it in `agent.terminalId`. This is the only source of the orchestrator's `terminalId`: status events for the hidden folder carry none.
  5. Store the record under the key `orch`.
- `ensure`, later: rewrite the home files (settings may have changed). The terminal is alive when `cli.json(['terminal','list','--worktree','id:'+workspaceId])` lists an entry whose `handle` equals `agent.terminalId` (host `terminal.list` on the hidden folder is unproven, so it is not used). Step 1 saves the real output as `tests/fixtures/terminal-list.json` first; if the field is not `handle`, use the field that fixture shows and say so in the commit. When the terminal is not listed, call `host.call('agent.resume', { workspaceId, agent, sessionId })` with the stored `sessionId` when there is one, else `agent.launch`; store the returned `terminalId`.
- `session()` returns the orchestrator as a `Session` with `key: 'orchestrator'`, `path: home`, `ids: [workspaceId]`, `started: 'you'`, `dispatchId: null`, so `delivery` types to it only when idle, and its `workspace.list` re-read finds the home row. Its `agent.state` is `effectiveState(record.agent, listState)`, where `listState` is the home row's `status.state` last given to `setListState`.
- `setListState(state)` stores the home row's `status.state`; the watcher calls it every tick (Task 12). `maskPermission()` sets the record's `agent.permissionMasked = true` and stores it.
- `say(text)` calls `ensure()`, then `delivery.send(session(), 'From Aamon', text)`.
- `onStatus` returns `true` when the event's `workspaceId` equals the record's `workspaceId`, or its `sessionId` equals `agent.sessionId`. It never matches on `terminalId` or `workspaceListId`: the hidden folder's events carry no `terminalId`, and their `workspaceListId` never equals the folder's id. It sets the record's `agent` to `agentFromStatus(record.agent, ev, agentKind)`, which keeps the launched `terminalId`, and then calls `delivery.flush(session())` when the new state is `waiting` or `done`.

- [ ] **Step 1: Failing tests,** with `mockHost`, a fake `cli` and an in-memory `Fs`. First save `orca terminal list --worktree id:<home workspaceId> --json` as `tests/fixtures/terminal-list.json`.
  - With `repo list` returning `repo-list.json` (the home folder present with `hiddenAt`), first `ensure` makes no `repo add` and no `repo hide`, uses `workspaceId === 'ed35e1a6-a877-4c36-9b9a-c9aa020a5305::' + home`, calls `agent.launch`, and stores a record whose `marker` starts with `orch:` and whose `agent.terminalId` is the launch result's.
  - With `repo list` returning no matching row, first `ensure` calls `repo add`, then `repo hide`, then `agent.launch`, in that order.
  - It never calls `workspace.open`, `terminal.focus`, `editor.open`, `commands.run` or `terminal.sendText`: `host.callsOf(name).length === 0` for each.
  - `say` while the state is `working` returns `'queued'` and runs no `terminal send`. `onStatus` with `state: 'waiting'`, the home `workspaceId` and **no** `terminalId` returns `true`, keeps the stored `terminalId`, and sends the queued text once with `terminal send --terminal <that id> … --enter`.
  - `onStatus` with `state: 'waiting'` while the mocked `workspace.list` home row is `permission` and `setListState('permission')` was given sends nothing; `session().agent.state === 'blocked'`. After `maskPermission()` the same state reads `waiting`.
  - **Review Focus 2:** with a stored record whose `terminalId` is missing from `terminal list`, `say` calls `agent.resume({ workspaceId, agent, sessionId })`, stores the new `terminalId`, queues the text, and sends it on the next `waiting`. With no stored `sessionId` it calls `agent.launch` instead.
  - The record and the queue survive `createOrchestrator` re-creation followed by `load()`.
  - `onStatus` for another workspace and session id returns `false` and changes nothing.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Run one hidden orchestrator and resume it when its terminal is gone".

### Task 10: Needs-you cards and approval answers

**Files:**
- Create: `src/needs.ts`
- Test: `tests/needs.test.mjs`

**Interfaces:**
- Consumes `Session`, `AgentState` (Task 3), `NeedKind` (Task 5), `createCli` (Task 1).
- Produces:
  ```ts
  type CardAction = 'allow' | 'deny' | 'peek' | 'retry' | 'details'
  type NeedCard = { id: string; key: string; kind: NeedKind; title: string; detail: string; actions: CardAction[]; at: number; resolved: string | null }
  type ToolCall = { tool: string; input: unknown; at: number }
  function describeTool(call: ToolCall | undefined): string
  function approvalCard(session: Session, call: ToolCall | undefined, now: number): NeedCard
  function reconcile(open: NeedCard[], wanted: NeedCard[], now: number): { open: NeedCard[]; added: NeedCard[]; closed: NeedCard[] }
  function isPermissionPrompt(lines: string[]): boolean
  function readScreen(cli: ReturnType<typeof createCli>, terminalId: string): Promise<string[]>
  function answerApproval(o: { cli: ReturnType<typeof createCli>; session: Session; choice: 'allow' | 'deny'; stateOf(): AgentState; wait(ms: number): Promise<void>; mask(): Promise<void> }): Promise<'answered' | 'use-peek'>
  const PEEK_KEYS: Record<'enter' | 'esc' | '1' | '2' | '3' | 'y' | 'n', string>
  ```
- Keys go through `cli.json(['terminal','send','--terminal',terminalId,'--text',key])` with **no** `'--enter'`, so the bytes reach the PTY verbatim (Global Constraints). Host `terminal.sendText` is refused by Orca.
- `readScreen` runs `cli.json(['terminal','read','--screen','--terminal',terminalId])` and returns `result.terminal.tail` (an array of lines; `result.terminal.source` is `"screen"`).
- `stateOf()` returns the effective state (`effectiveState`, Task 3) of the latest stored agent entry and the last polled list state; status events update the entry while `answerApproval` waits.
- Folder-trust prompt keys are unproven (spike 6 never saw one), so those prompts get Peek only; Allow once and Deny are for Claude Code permission prompts.
- Card `id` is `` `${kind}:${key}` ``, so one session has at most one card per kind.
- `describeTool`: a shell tool (`Bash`, `shell`, `run_shell_command`) with a string `input.command` → `wants to run: <command>` cut to 120 characters; any other tool → `wants to use: <tool>`; `undefined` or older than 120 s → `waiting on a prompt`.
- `approvalCard.actions` is `['allow','deny','peek']` when `session.agent.kind === 'claude'` and `terminalId` is set, else `['peek']`.
- `isPermissionPrompt(lines)` is true when the screen shows a Claude Code permission prompt. It matches the prompt's question line and its numbered `1.` option exactly as they appear in the saved fixture `terminal-read-prompt.json` (Step 1), and is false for `terminal-read-denied.json`.
- `answerApproval` (keys from spike 6):
  - It sends nothing and returns `'use-peek'` when `stateOf()` is not `blocked` at the start, or the session has no `terminalId`.
  - `allow` sends `'1'`, then waits 3000 ms in 250 ms steps and returns `'answered'` as soon as `stateOf() !== 'blocked'`, else `'use-peek'`. (After Allow, a status event comes: `working`, then `done`.)
  - `deny` sends `'\u001b'`. After a deny **no status event comes** and `workspace.list` stays `permission` until the terminal closes, so the state is not checked. It waits 1000 ms, then `readScreen`: when `isPermissionPrompt` is false it calls `mask()` (which sets that agent's `permissionMasked` until its next status event) and returns `'answered'`; otherwise it returns `'use-peek'`.
- `reconcile` keeps an open card whose `id` is still wanted (keeping its original `at`), adds wanted cards that are new, and closes open cards no longer wanted with `resolved: 'cleared'`.

- [ ] **Step 1: Failing tests.** First save two real screens with `orca terminal read --screen --terminal <id> --json` from a Claude Code terminal in manual mode (Shift+Tab, `"\u001b[Z"`, switches it, as in spike 6): one at a WebFetch permission prompt as `tests/fixtures/terminal-read-prompt.json`, and one right after Escape as `tests/fixtures/terminal-read-denied.json` (it shows "Interrupted · What should Claude do instead?").
  - `describeTool` for `Bash` with `pnpm install`, for `Edit`, for `undefined`, and for a call 121 s old.
  - `approvalCard` for a Claude terminal session has three actions; for `codex`, and for Claude with no terminal (a chat), only `peek`.
  - `reconcile` across three ticks: a card is added once, kept with its first `at`, then closed when no longer wanted.
  - `isPermissionPrompt` is true for the prompt fixture's `result.terminal.tail` and false for the denied fixture's.
  - `answerApproval('allow')` runs `terminal send --terminal <id> --text 1` once, with no `--enter`, and returns `'answered'` when `stateOf` turns `working` on the second step. When it stays `blocked` it returns `'use-peek'` after 3000 ms of `wait`. When the effective state starts as `waiting` (no `permission` in `workspace.list`) it sends nothing.
  - `answerApproval('deny')` sends `'\u001b'` with no `--enter`, never polls `stateOf` after sending, and with the denied screen calls `mask()` once and returns `'answered'`. With the prompt screen it does not call `mask()` and returns `'use-peek'`.
  - `PEEK_KEYS.esc === '\u001b'` and `PEEK_KEYS.enter === '\r'`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Build Needs-you cards and answer Claude Code approvals".

### Task 11: Merge guard

**Files:**
- Create: `src/guard.ts`
- Test: `tests/guard.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  type GuardHit = { rule: 'merge' | 'force-push' | 'push-main'; command: string }
  function matchGuard(tool: string, input: unknown): GuardHit | null
  ```
- Read `~/.claude/hooks/guard_push.py` and `~/.claude/hooks/test_guard_push.py` first. Port every push rule and every test case of theirs to this module and its test, then add the merge rules below. Where this list and that file disagree on a push, that file wins.
- It inspects shell tools only (`Bash`, `shell`, `run_shell_command`) with a string `input.command`. It splits the command on `&&`, `||`, `;`, `|` and newlines outside quotes, strips leading `env` assignments, `command`, `sudo` and `time`, and unwraps `bash -c '…'`, `sh -c '…'` and `zsh -c '…'` one level.

- [ ] **Step 1: Failing tests.** Each row is one assertion.

  | Command | Result |
  |---|---|
  | `gh pr merge 4547 --squash` | `merge` |
  | `gh pr merge --auto 12` | `merge` |
  | `cd x && gh pr merge 1` | `merge` |
  | `bash -c "gh pr merge 1"` | `merge` |
  | `GH_TOKEN=x gh pr merge 1` | `merge` |
  | `gh api -X PUT repos/o/r/pulls/1/merge` | `merge` |
  | `gh api --method PUT /repos/o/r/pulls/1/merge` | `merge` |
  | `gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'` | `merge` |
  | `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'` | `merge` |
  | `ao pr merge 1` | `merge` |
  | `git push --force` | `force-push` |
  | `git push -f origin feat/x` | `force-push` |
  | `git push --force-with-lease` | `force-push` |
  | `git push --force-if-includes origin x` | `force-push` |
  | `git push origin +feat/x` | `force-push` |
  | `git push --mirror` | `force-push` |
  | `git push --all` | `force-push` |
  | `git -C /repo push -f` | `force-push` |
  | `git push origin main` | `push-main` |
  | `git push origin HEAD:main` | `push-main` |
  | `git push origin feat/x:master` | `push-main` |
  | `git push origin :main` | `push-main` |
  | `git push origin feat/x` | `null` |
  | `git push -u origin feat/x` | `null` |
  | `echo "gh pr merge"` | `null` |
  | `gh pr view 1 --json mergeable` | `null` |
  | `gh api repos/o/r/pulls/1/merge` (a GET) | `null` |
  | `git log --all` | `null` |

  Also: `matchGuard('Edit', { command: 'gh pr merge 1' })` is `null`, and `matchGuard('Bash', {})` is `null`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Match merges, force-pushes and pushes to main".

### Task 12: The watcher tick and the view model

**Files:**
- Create: `src/watcher.ts`
- Test: `tests/watcher.test.mjs`

**Interfaces:**
- Consumes Tasks 1 to 10.
- Produces:
  ```ts
  type ChatItem = { id: string; at: number; from: 'you' | 'orchestrator' | 'panel'; kind: 'text' | 'progress' | 'question' | 'result' | 'card'; text: string; options?: string[]; answered?: string; card?: NeedCard }
  type Row = { key: string; name: string; project: string; branch: string | null; agentKind: string | null; started: 'orchestrator' | 'you'; pr: number | null; prUrl: string | null; lane: Lane; phrase: string; tone: Tone; card: NeedCard | null; autoFix: { ci: boolean; review: boolean }; queued: number; stale: boolean }
  type ViewModel = { rev: number; firstRun: boolean; orch: { state: AgentState; agentKind: string } | null; chat: ChatItem[]; queued: number; rows: Row[]; idle: Row[]; needs: number; asks: number; gh: GhStatus; watching: number; intervalSec: number; hooksOff: boolean; guard: { on: boolean; blocksToday: number } }
  function appendChat(log: ChatItem[], item: ChatItem): ChatItem[]
  function createWatcher(o: { deps: Deps; bins: Bins; cli: ReturnType<typeof createCli>; host: HostApi<'worker'>; store: StorageApi; orchestrator: ReturnType<typeof createOrchestrator>; delivery: ReturnType<typeof createDelivery>; settings(): Settings; onChange(view: ViewModel): void }): {
    load(): Promise<void>
    tick(): Promise<void>
    start(): void
    stop(): void
    view(): ViewModel
    index(): ReturnType<typeof createIndex>
    agents(): Record<string, AgentInfo>
    setAgent(path: string, info: AgentInfo): void
    listState(path: string): string | null
    maskPermission(key: string): Promise<void>
    track(dispatchId: string): void
    noteTool(terminalId: string, call: ToolCall): void
    noteGuard(key: string, hit: GuardHit, blocked: boolean): void
    guarded(): Set<string>
    addChat(item: ChatItem): Promise<void>
    resolveCard(id: string, how: string): Promise<void>
    setAutoFix(key: string, which: 'ci' | 'review', on: boolean): Promise<void>
    retry(key: string): Promise<void>
    pr(key: string): PrState | null
  }
  ```
- `appendChat` caps the log at 500, dropping the oldest.
- Stored keys: `chat` (ChatItem[]), `ledgers` (Record<prKey, Ledger>), `cards` (NeedCard[]), `autofix` (Record<sessionKey, { ci?: boolean; review?: boolean }>), `tracked` (string[]), `guardlog` ({ day: string; blocks: number }), `agents` (Record<path, AgentInfo>). `agents` is persisted because `workspace.list` carries no terminal ids: without it, after a worker restart every hand-started session would be `unreachable` until its next status event. `setAgent` and `maskPermission` write it.
- `listState(path)` returns the last polled `workspace.list` `status.state` for that path (`listStateOf`, Task 3). `maskPermission(key)` sets `permissionMasked: true` on `agents[key]` (when absent, creating it from the session's current `agent` with `state: 'waiting'`, since the session's copy already holds the effective `blocked`) and stores it; for `key === 'orchestrator'` it calls `orchestrator.maskPermission()`. `track(id)` adds to `tracked` and stores it; Task 13 passes it to `createDelivery` as its `track` callback.
- `noteTool` keeps only the newest call per `terminalId`, and at most 200 terminals, dropping the least recently noted: `agent.tool.before` fires for every Claude Code terminal on the computer.
- `tick` does, in order:
  1. **Outbox.** `readOutbox`. `text`/`progress`/`result`/`question` become chat items `from: 'orchestrator'`. `track` adds to `tracked`. `tell` resolves its target by session name or key and calls `delivery.send(session, 'From the orchestrator', text)`; an unknown target becomes a chat item `from: 'panel'`: `Could not find a session named "<target>".`
  2. **Sessions.** `host.call('workspace.list', { includeStatus: true })`, `cli.json(['worktree','list'])`, `cli.json(['orchestration','worker-list','--limit','100'])`. First `orchestrator.setListState(listStateOf(workspaces, home))`, because `buildSessions` drops the home row. Then `buildSessions` with the stored `agents` and `tracked`, the orchestrator's `marker` and `home`.
  3. **GitHub.** For each distinct non-null `repo`, `readRepo`. When a repo's status is not ok, its sessions keep the previous tick's `PrState` and their rows get `stale: true`. `view().gh` is the first failing status, else `{ ok: true }`. On `rate-limited` no repo is read again before `retryInSec` has passed.
  4. **Events.** For each session with a PR: `diffEvents` with `ci` and `review` from its auto-fix switches (stored override, else `true` for orchestrator-started, else `settings().autoFixYours`). For each event: fetch log tails for a `ci` event (at most 3 failed checks with a `jobId`, 80 lines each), `messageFor`, `delivery.send`, and `recordSent` unless the result is `'unreachable'`.
  5. **Needs.** Wanted cards: an `approval` card for each session whose `agent.state` is `blocked` (already the effective state from `buildSessions`: an event `blocked`, or `waiting` while `workspace.list` says `permission`), and for the orchestrator when `orchestrator.session().agent.state` is `blocked`, using the `ToolCall` noted for its `terminalId`; an `attempts` card (`detail`: `N fix attempts used`) when `limitHit`; an `unreachable` card when a send returned `'unreachable'`; `merge-blocked` cards are added by `noteGuard` and stay until dismissed. Then `reconcile`. Each added card becomes a chat item `kind: 'card'` and one `notifications.show`. Each closed card updates its chat item's `card.resolved`.
  6. **Rows.** `needs` is the number of open cards; `asks` is the number of `question` chat items with no `answered`. `place` per session; rows with lane `idle` go to `view().idle`, `null` are dropped. One `notifications.show` per transition into `ready`.
  7. **Housekeeping.** `delivery.prune(live session keys plus 'orchestrator')`. Drop ledgers and auto-fix overrides of PRs and sessions that are gone. `writeBoard(boardMarkdown(...))`. Once a minute `cli.json(['agent','hooks','status'])` sets `hooksOff`.
  8. Bump `rev` and call `onChange` when the view model changed.
- `guarded()` returns every id in `ids` of each orchestrator-started session, plus the orchestrator's workspace id. It is rebuilt at the end of each tick and read synchronously by the hook.
- `retry(key)`: `resetAttempts`, clear that PR's `sent` entry for the current head's `ci` key, close its `attempts` card with `resolved: 'retry'`, then run a tick.
- `start()` runs `tick` every `intervalSec` seconds, never overlapping. `watching` is the number of sessions with a PR.

- [ ] **Step 1: Failing tests,** with fakes for `cli`, `run`, `Fs` and `mockHost`.
  - One session with a PR whose only check failed and none pending: one `delivery.send` to that session, and its row is `validating` with phrase starting `Fixing CI failures`. A second `tick` with the same data sends nothing.
  - **Review Focus 1:** with `gh` rate-limited, `view().gh.reason === 'rate-limited'`, nothing is sent, rows keep their previous lane with `stale: true`, and a `tick` before `retryInSec` makes no `gh` call.
  - **Review Focus 3:** a session queued a message, then its worktree is absent from the next `worktree list`: the queue for its key is empty, its row is gone, and its ledger is dropped. A PR missing from the next `readRepo` moves its session to `building` or `idle` and sends nothing.
  - An all-green, non-draft, mergeable PR gives lane `ready` and one `notifications.show` across two ticks.
  - A session whose stored agent is `waiting` and whose `workspace.list` row has `status: { state: 'permission' }` gets one `approval` card, one chat item of kind `card`, one notification, and lane `needs`. The same session with `status: { state: 'active' }` gets no card. When the agent leaves `blocked` the card is closed and the chat item's `card.resolved === 'cleared'`. After `maskPermission(key)` with the row still `permission`, the card closes on the next tick.
  - The orchestrator gets an `approval` card when its event state is `waiting` and the home row (`workspace-list.json`) says `permission`, though `buildSessions` drops that row.
  - `agents` set with `setAgent` (including a `terminalId`) survive `createWatcher` re-creation followed by `load()`, and the next tick's session has that `terminalId`.
  - After 201 `noteTool` calls on distinct terminals, the first terminal's call is gone.
  - Reaching the fix limit adds an `attempts` card with `detail === '3 fix attempts used'`; `retry` closes it and sends once.
  - A hand-started session with `autoFixYours: false` shows `CI failing` and receives nothing. `setAutoFix(key, 'ci', true)` then sends on the next tick.
  - Outbox: a `question` file becomes a chat item with its options; a `track` file makes that dispatch's session `started: 'orchestrator'` on the same tick; a `tell` for a known session name calls `delivery.send`; an unknown name adds the "Could not find" item.
  - `guarded()` contains the ids of orchestrator-started sessions and the orchestrator's workspace id, and none of a hand-started session.
  - `board.md` is written on the first tick and not rewritten when nothing changed.
  - The 501st `appendChat` leaves length 500 with the first item gone.
  - `onChange` is not called by a tick that changes nothing.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit: "Watch every session and PR, route fixes and build the view model".

### Task 13: Worker wiring: events, hooks, status bar and panel requests

**Files:**
- Modify: `src/worker.ts`
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Consumes Tasks 1 to 12.
- `activate` order: `resolveBins`, `createCli(...).load()`, create delivery, orchestrator and watcher and `load()` each, register handlers, then `watcher.start()` when `settings.orchestratorAgent !== ''`. Delivery's `fromHandle` is `() => orchestrator.record()?.agent.terminalId ?? null` and its `track` is `(id) => watcher.track(id)`; both close over the orchestrator and watcher created after it.
- Manifest hooks stay objects, `{ "event": "agent.tool.before" }` and `{ "event": "agent.tool.after" }` (Task 1).
- Events:
  - `agent.status.changed` → `orchestrator.onStatus(ev)`; when it returns `false`, find the session with `index().byTerminal(ev.terminalId)`, else `byAnyId(ev.workspaceListId)`, else `byAnyId(ev.workspaceId)` (any of these may be absent or `null`); `info = agentFromStatus(watcher.agents()[path], { state, terminalId, sessionId, paneKey, receivedAt }, kind)`; `setAgent(path, info)`; `delivery.flush({ ...session, agent: info })` on `waiting` or `done` (delivery re-reads `workspace.list` itself, Task 7); then a tick, at most once per 2 s.
  - `workspace.created`, `workspace.removed` → a tick.
- Hooks, both synchronous over memory:
  - `agent.tool.before` → `watcher.noteTool(terminalId, { tool, input, at })` (it fires for every Claude Code terminal on the computer; `noteTool` caps what it keeps, Task 12). Then, when `settings().guard` and the event's session is in `guarded()` (looked up by `terminalId`, then `workspaceId`, either of which may be `null`): `matchGuard`; on a hit `noteGuard(key, hit, true)` and return `{ deny: 'Merging, force-pushing and pushing to main are Aamon\'s alone. Leave the PR open and report that it is ready.' }`. Otherwise return nothing.
  - `agent.tool.after` → for a guarded session whose `agent` is not `claude`, on a `matchGuard` hit call `noteGuard(key, hit, false)`.
- Status bar: on each `onChange`, `statusBar.update({ id: 'needs', visible: n > 0, text: n === 1 ? '1 needs you' : n + ' need you' })` with `n = needs + asks`. At activation it is set to `visible: false`.
- Push: on each `onChange`, `orca.panels.post('view', { rev })`.
- Panel requests (`orca.panels.handle`):

  | Request | Input → result |
  |---|---|
  | `view.read` | → `ViewModel` |
  | `agents.list` | → `AgentEntry[]` |
  | `firstrun.save` | `{ agent }` → saves `orchestratorAgent`, `orchestrator.ensure()`, `watcher.start()` |
  | `chat.send` | `{ text }` → adds a `you` chat item, `orchestrator.say(text)` → `'sent' \| 'queued'` |
  | `chat.answer` | `{ id, option }` → marks the question `answered`, `orchestrator.say(option)` |
  | `card.act` | `{ id, action }` → see below |
  | `row.act` | `{ key, action: 'message' \| 'retry' \| 'stop' \| 'remove' \| 'autofix-ci' \| 'autofix-review', text?, on?, confirmed? }` |
  | `row.detail` | `{ key, tab: 'status' \| 'terminal' \| 'diff' }` → `{ status?, lines?, diff? }` |
  | `peek.key` | `{ key, name }` → `cli.json(['terminal','send','--terminal',terminalId,'--text',PEEK_KEYS[name]])`, no `--enter`; a session with no `terminalId` rejects with `conflict` |
  | `settings.save` | `Partial<Settings>` |
  | `pr.url` | `{ key }` → `{ url }` (the panel calls `shell.openExternal`) |
  | `dev.seed` | a `ViewModel` → `view.read` returns it until the worker restarts; used for stills only |

- `card.act`: `allow`/`deny` → `answerApproval({ cli, session, choice, stateOf: () => effectiveState(watcher.agents()[path], watcher.listState(path)), wait, mask: () => watcher.maskPermission(key) })` (for the orchestrator, `stateOf` is `orchestrator.session().agent.state`); `'answered'` resolves the card, `'use-peek'` sets the card's `detail` to `Answer it in Peek`. `retry` → `watcher.retry(key)`. `details` and `peek` return `{ open: key }` for the panel to navigate.
- `row.act`: `message` → `delivery.send(session, 'From Aamon', text)`. `stop` → `orchestration worker-stop --dispatch <id>` when the session has a dispatch, else `terminal.close` when the plugin opened the terminal, else an error `conflict`. `remove` → `cli.json(['worktree','rm','--worktree','id:'+session.ids[1]])` only with `confirmed: true`, else an error `invalid_params`.
- `row.detail`: `status` → `{ status: { checks, threads, attempts, lastSent } }` from `watcher.pr(key)` and the ledger. `terminal` → `cli.json(['terminal','read','--screen','--terminal',terminalId])` → `{ lines: result.terminal.tail }` (`readScreen`, Task 10). With no `terminalId` (a chat agent: terminal commands refuse its handle) and a dispatch, `cli.json(['orchestration','worker-read','--dispatch',id,'--source','auto'])` and its output as `lines`; with neither, `{ lines: ['This session is a chat. It has no terminal to show.'] }`. `diff` → `prDiff`.
- `peek.key` and `row.detail` accept `key: 'orchestrator'`.

- [ ] **Step 1: Failing tests,** with `mountWorker(main)` and fakes injected through a module-level `setTestDeps`.
  - `mountWorker(main)` reports no refusals and `view.read` resolves with `firstRun: true`.
  - `agent.tool.before` returns `{ deny }` for `gh pr merge 1` from a guarded workspace, passes for the same call from a hand-started session, and passes with `guard: false`. The deny path makes no `run` and no host call.
  - `agent.tool.after` from a guarded `codex` session with `git push -f` adds a `merge-blocked` card whose detail contains "attempted".
  - `agent.status.changed` with `state: 'waiting'` for a session with a queued message sends it once, by `terminal send … --enter`. With the session's `workspace.list` row at `permission` it sends nothing.
  - `agent.status.changed` with no `terminalId` and `workspaceId: null` but a matching `workspaceListId` updates that session and keeps its stored `terminalId`. One with `paneKey: 'structured-agent-session-claude_x:uuid'` records `chatId: 'claude_x'`.
  - `row.detail` `terminal` returns the fake `terminal read` result's `result.terminal.tail` as `lines`. For a chat session with no dispatch it returns the fixed chat line.
  - `statusBar.update` is called with `visible: false` when `needs + asks` is 0 and with `text: '2 need you'` when one card and one unanswered question are open.
  - `row.act` `remove` without `confirmed: true` rejects with `invalid_params` and runs no `worktree rm`.
  - `card.act` `allow` on an approval card whose agent then leaves `blocked` resolves the card; when it stays `blocked` the card's detail becomes `Answer it in Peek`.
  - `card.act` `deny` on an approval card for a session that is `waiting` with its row at `permission`: with a fake `terminal read` returning the denied screen fixture, the card is resolved, no status event is needed, and the next tick adds no new approval card for that session.
  - `peek.key` with a name outside `PEEK_KEYS` rejects with `invalid_params`. `peek.key` `esc` runs `terminal send --terminal <id> --text \u001b` with no `--enter`.
  - No call to a forbidden method (Global Constraints) and no `terminal.sendText` appears in `worker.host.calls` after every request above has run.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. PASS. Run `orca plugin validate .`: no errors.
- [ ] **Step 5:** Commit: "Wire the watcher, guard, status bar and panel requests".

### Task 14: Panel shell, first run and the Chat view

**Files:**
- Create: `panel/index.html` (icons from the prototype's `<symbol>` set), `panel/style.css` (Orca's `--orca-*` tokens, as `plugins/now-playing/src/panel-css.ts` uses them), `panel/esc.js`, `panel/app.js`, `panel/chat.js`
- Test: `tests/panel-esc.test.mjs`, `tests/panel-chat.test.mjs`

**Interfaces:**
- Consumes the Task 13 requests and `ViewModel` (Task 12).
- Produces `window.OrchEsc.html(s: string): string`, `window.OrchViews.chrome(vm, view)` (header and footer), `window.OrchViews.chat(vm)`, `window.OrchViews.firstRun(agents)` and `window.OrchViews.card(card)`. Each returns an HTML string. `app.js` owns state, event delegation through `data-act` attributes, and re-renders on the `view` panel event plus a 5 s fallback poll while visible.
- Header: `Chat | Board` and **+**; a red dot on Board when `vm.needs > 0`, and one on Chat when `vm.asks > 0`. **+** switches to Chat and focuses the box.
- Footer left: the first that applies of `gh not installed`, `gh not signed in`, `GitHub rate limited · retrying in {n}s`, `Status hooks off · status may be stale`, `Not watching any PRs`, `Polling GitHub · {n}s`. Then `Merge guard on`, `{n} block(s) today`, or `Merge guard off` in the danger tone. Footer right: the gear.

- [ ] **Step 1: Failing tests.** Load each panel script in node with `vm.runInNewContext` and a `window` stub.
  - `OrchEsc.html('<img src=x onerror=1>&"')` returns `&lt;img src=x onerror=1&gt;&amp;&quot;`.
  - **Review Focus 4:** `OrchViews.chat` given a view model whose every string field (chat text, options, card title and detail) is `<img src=x onerror=1>` returns HTML with no `<img`.
  - A `question` item renders one button per option with `data-act="answer"`; an answered one renders none and shows the answer.
  - An approval card with actions `['allow','deny','peek']` renders three buttons labelled `Allow once`, `Deny`, `Peek`; a resolved card renders none.
  - `vm.queued === 2` renders `2 queued · sends when the orchestrator finishes its turn`.
  - An empty `vm.chat` renders `What should I take on?` and the two starters `Close out my open PRs` and `What needs me right now?`.
  - `OrchViews.chrome` renders the gear inside the footer and not inside the header, the Board dot only when `needs > 0`, and the Chat dot only when `asks > 0`.
  - `OrchViews.firstRun` lists installed agents first and puts the rest under `Not installed (N)`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement to match the composition's "Chat · approval waiting" and "Chat · empty" screens. Every interpolated string goes through `OrchEsc.html`.
- [ ] **Step 4:** Run the tests. PASS. Then `orca plugin dev load .` and `orca plugin shot orchestration` for first run, Chat empty and Chat with a card (seed with `orca plugin dev request orchestration dev.seed`, passing a `ViewModel` as input; the handler makes `view.read` return that value until the worker restarts, and touches nothing else). Compare by eye with the mockup.
- [ ] **Step 5:** Commit: "Add the panel shell, first run and the Chat view".

### Task 15: The Board

**Files:**
- Create: `panel/board.js`
- Modify: `panel/app.js`, `panel/style.css`
- Test: `tests/panel-board.test.mjs`

**Interfaces:**
- Produces `window.OrchViews.board(vm, ui)` where `ui` is `{ idleOpen: boolean; menuKey: string | null; confirmRemove: string | null }`.

- [ ] **Step 1: Failing tests.**
  - Lanes render in the order Needs you, Building, Validating, Needs review, Ready, each with its count, and a lane with no rows is omitted.
  - A row shows its name, `#<pr>` or `no PR`, the project tag and the phrase. A `stale` row carries the class `stale`.
  - A Needs you row with an approval card renders the same three buttons as the chat card, with the same `data-act` and card id.
  - `Idle · 3 sessions` renders as one line; with `ui.idleOpen` the three rows follow it. With no idle sessions the line is absent.
  - The ⋯ menu for a session with a PR lists: Details, Message, Retry fix, Auto-fix CI, Auto-fix review comments, Stop agent, Remove worktree…. For a session with no PR, Retry fix and the two Auto-fix items are absent.
  - With `ui.confirmRemove === key` the row shows `Its branch and PR stay on GitHub.` and a Remove button with `data-confirmed="true"`.
  - **Review Focus 4:** a row whose name, project, branch and phrase are `<img src=x onerror=1>` renders no `<img`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement to match the composition's "Board" screen. A `@container (min-width: 640px)` rule turns the five lanes into columns.
- [ ] **Step 4:** Run the tests. PASS. Take `orca plugin shot` stills at 400px and 760px against the seeded fixtures and compare by eye with the mockup.
- [ ] **Step 5:** Commit: "Add the Board with lanes, row actions and the idle line".

### Task 16: Session details, Peek and Settings

**Files:**
- Create: `panel/detail.js`, `panel/settings.js`
- Modify: `panel/app.js`
- Test: `tests/panel-detail.test.mjs`

**Interfaces:**
- Produces `window.OrchViews.detail(vm, key, tab, data)` and `window.OrchViews.settings(vm, agents, settings)`.

- [ ] **Step 1: Failing tests.**
  - `detail` renders a back arrow, the name, `#<pr> · <branch> · <agent>` and a Status | Terminal | Diff switch.
  - The Status tab lists each check with its state, each unresolved thread, `2 of 3 fix attempts used`, and the last thing sent.
  - The Terminal tab renders `data.lines` in a `<pre>` and the key row `Enter 1 2 3 y n Esc`, each a button with `data-act="peek-key"`.
  - The Diff tab renders `data.diff` in a `<pre>`; with no PR it renders `No PR yet`.
  - `key === 'orchestrator'` renders the Terminal tab only.
  - `settings` renders the seven settings with their current values and a row `Peek at the orchestrator`.
  - **Review Focus 4:** terminal lines and a diff containing `<img src=x onerror=1>` render no `<img`.
- [ ] **Step 2:** Run the tests. They FAIL.
- [ ] **Step 3:** Implement. The Terminal tab asks `row.detail` again every second while it is open. "PR on GitHub" calls `window.orca.call('shell.openExternal', { url })` from the click.
- [ ] **Step 4:** Run the tests. PASS. Take `orca plugin shot` stills at 400px for each tab and Settings. Confirm Orca's main area has the same tabs as before.
- [ ] **Step 5:** Commit: "Add session details, Peek and in-panel settings".

### Task 17: End-to-end proof, catalog release and draft PR

**Files:**
- Modify: `orca-catalog.json`, `plugins/orchestration/README.md`
- Create: `plugins/orchestration/media/cover.png`, `media/screens.png`

- [ ] **Step 1: Real run.** Load the plugin in Orca and pick Claude. Confirm each of these and note the result in the PR body:
  - (a) no new tab, sidebar entry or unread badge for the orchestrator (spike 1's open check; Aamon confirms it);
  - (b) a hand-started session with an open PR appears on the Board with no setup;
  - (c) "Close out PR #<a small open PR>" in the chat starts a worker named `…-oa`, which appears on the Board. The orchestrator's `orca` calls run inside Claude Code's Bash sandbox without an EPERM and without a retry outside it; this proves Task 8's `sandbox.excludedCommands` key, and if it fails, fix that key in Task 8's `ensureHome` before going on;
  - (d) a red CI run is sent to its session once, and the row reads `Fixing CI failures`;
  - (e) an agent stopped on a permission prompt produces a chat card, and Allow once clears it;
  - (f) a `gh pr merge` by the worker is blocked with a card;
  - (g) a PR reaches Ready only when green, non-draft, threadless and mergeable;
  - (h) with the panel closed for 3 minutes, `board.md` still updates.
- [ ] **Step 2:** Write the README: what it does, install from the catalog, the settings, the "never merges" note, and the requirements (`gh` signed in, Orca ≥ 1.4.259, this computer only).
- [ ] **Step 3:** Run `orca plugin release-entry plugins/orchestration`, add the entry first in `orca-catalog.json` with id `aamonnaig4.orchestration`, then `orca plugin validate orca-catalog.json`. No errors.
- [ ] **Step 4:** Open a **draft** PR following the repo's PR rules (Orca-style template; attach proof media, never commit it; `scripts/check_pr_screenshots.sh`). The body includes:
  - Before and After stills at desktop and phone width, and a GIF of first run → a task → a card → the Board → details (AGENTS.md §3, §5, §6);
  - an "Autonomous decisions" list (AGENTS.md §9), starting from the spec's "Calls made in this rewrite".
- [ ] **Step 5:** Get the required checks green, then mark the PR ready (AGENTS.md §4). Never merge.
