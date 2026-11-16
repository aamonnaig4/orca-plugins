# Orchestration panel: one chat that manages all the work in Orca

Date: 2026-11-15 (rewritten the same day after the plan review and four design rounds) · Plugin: `plugins/orchestration` (new)

Layout source of truth: `docs/design/orchestration-panel/mockup-decisions.html` (the composition round, confirmed `1A`). `prototype.html` and `mockup-sidebar.html` in the same folder predate these picks; use them only for tokens, icons and spacing.

Reference: `github.com/OrchestratorInc/agent-orchestrator` (Apache-2.0). This plugin is an Orca-centric, simplified version of it.

## Why

Aamon runs many agents across worktrees and projects in Orca. Starting work is easy. What drags is everything after: noticing a red CI run, a review comment, a merge conflict or an agent stuck on a prompt, then telling the right agent, then checking again. The reference app closes that loop, but it is a second app with its own worktrees, database and agents.

This plugin brings the loop into Orca, built on Orca's own CLI and orchestration. The goal, in Aamon's words: **a chat in the panel that acts as my orchestrator to manage all my work.**

## Goals

1. **One chat.** A side panel whose Chat view is a conversation with one orchestrator agent that covers every project.
2. **Every session.** The plugin tracks every agent session in Orca on this computer, with or without a PR, whether the orchestrator started it or Aamon did by hand.
3. **A Board for progress.** A second view sorts sessions into lanes: Needs you, Building, Validating, Needs review, Ready.
4. **Babysitting in plain code.** The plugin checks GitHub on a timer and sends each CI failure, review comment and merge conflict to the session that owns the PR, when that session's agent is idle.
5. **Approvals come to the chat.** When any tracked agent is stuck on a permission prompt, a card appears in the chat with Allow once, Deny and Peek.
6. **A merge guard** that stops the orchestrator and the sessions it started from merging, force-pushing or pushing to `main`.
7. **Agent usage only for real work.** Watching, sorting and routing are plugin code. An agent is woken only when there is something for it to do.

## Non-goals

- The plugin never merges and has no merge button.
- No cloud, no hosted service, no paid API. GitHub goes through the user's `gh` login.
- No planning logic in plugin code. Planning is the orchestrator agent's job.
- **No tabs.** The plugin never opens anything in Orca's main area. The one exit is "PR on GitHub", which opens the browser.
- GitHub only. Sessions in projects that are not on GitHub are tracked without PR data.
- This computer only in v1. Sessions on SSH hosts and paired servers are not tracked.
- No reviewer agents, no browser preview, no mobile app, no automations (all in the reference, all out of v1).

## Anti-goals (a failure even if it works)

- An agent the orchestrator started merges, force-pushes or pushes to `main` while the guard is on.
- The same failure or comment is sent to a session twice.
- Text is typed into an agent that is mid-turn or sitting on a permission prompt.
- An agent loops forever on a failure it cannot fix.
- Agent usage is spent while nothing changed.
- A session shows as Ready when checks are pending, a thread is unresolved or the PR conflicts.
- An agent sits blocked on a prompt and nothing in the panel says so.

## Settled design (Aamon's picks, 2026-11-15)

| Pick | Decision |
|---|---|
| 1B | Every session is tracked, PR or not |
| 2A | One orchestrator chat for every project |
| Chat only | The Chat view holds only the chat. Progress lives in the Board |
| 3F | A red dot on the Board tab when a session needs Aamon |
| 4B′ | Approvals arrive as chat cards; the Board row has the same buttons |
| 8B | Lanes: Needs you, Building, Validating, Needs review, Ready |
| 6A | One "Idle · N sessions" line under the lanes |
| 5B | A status bar count only when something needs Aamon |
| Gear | The settings gear sits in the footer's bottom right corner |

## Constraints (checked against Orca 1.4.259, host API 1.9)

- **Plugin shape:** `execution: "trusted-worker"`. The worker has full Node (`child_process`, `fs`). The panel is plain HTML and JS.
- **The worker must stay alive with the panel closed.** Orca keeps a worker running only for plugins with a status bar item. The plugin declares one (pick 5B), which doubles as the keep-alive.
- **Session list:** `workspace.list({ includeStatus: true })` gives every workspace with its agent status. `orca worktree list --json` gives branch, `comment`, `repoId`, `projectId` (for example `github:owner/repo`), `isMainWorktree` and `path`. The two are joined on `path`.
- **Three id shapes exist** for one workspace (`repoId::path`, an instance id, and the id hooks carry). The plugin keeps every known id per session and looks sessions up by any of them, by path or by terminal.
- **Agent status:** the `agent.status.changed` event reports `working`, `blocked`, `waiting` or `done` per terminal, with `terminalId` and `sessionId`.
- **Reading a terminal:** the host's `terminal.read` returns raw stream output, which is unreadable for agent TUIs. The plugin uses `orca terminal read --screen --json` for anything it shows.
- **Messaging:** `orca orchestration send --to dispatch:<id>` reaches a worker the orchestrator started, whatever its surface, when its turn ends, and reopens a closed one. Any other session is reached by typing into its agent terminal with `terminal.sendText`, which the plugin does only while that agent is idle.
- **A routed fix wakes the orchestrator.** A finished worker treats `send` as a follow-up Task and reports `worker_done` to its coordinator. The orchestrator's instructions tell it to end its turn on those.
- **No surface flag on `worker-start`.** Workers run as a chat or a terminal according to Aamon's own Orca setting. Tool hooks and terminal reads reach terminal agents only.
- **Hooks fail open.** A hook that takes more than 2 seconds or throws is treated as a pass, so the guard handler reads memory only.
- **Merge guard reach:** `agent.tool.before` can deny a tool call only for Claude Code in a terminal. For other terminal agents Orca only reports the call afterwards.
- **`run-list` returns only `id` and `objective`.** It cannot say which Run belongs to the orchestrator, so ownership does not use it.
- **Orca's orchestration guide forbids coordinators polling.** The plugin polls GitHub and Orca; the orchestrator never does.
- **Borrowed text:** any wording taken from the reference carries an Apache-2.0 NOTICE. The plugin's name must not use theirs.
- **Repo rules:** no comments in source, draft PRs, before and after visuals for UI.

## What gets built

### Sessions

A session is one Git worktree workspace on this computer. It is shown when it has an agent (any status) or an open PR. Main worktrees with neither are left out, and so is the orchestrator's own folder.

Each session records: name, project, branch, its agent's state and terminal, whether the orchestrator started it, and its PR once one exists.

**Started by the orchestrator** means either of:
- its worktree `comment` starts with the plugin's marker (`orch:<id>`, passed with `worker-start --comment`), or
- the orchestrator reported its dispatch with `./bin/say track <dispatch_id>`.

Every other session is **yours** and carries no tag. Orchestrator-started sessions use the worker name suffix (default `-oa`), which is how they read on the Board.

### The orchestrator

- **One orchestrator for everything.** It runs as a terminal agent in a plugin-owned folder, `~/.orca-orchestration/home`, added to Orca as a folder project and hidden from the sidebar. It never appears as a tab.
- **Standing instructions live in the folder**, as `AGENTS.md` with a `CLAUDE.md` that points to it, so they survive context compaction and a fresh session. They tell it to:
  - start with `orca skills get orchestration`;
  - read `board.md` for the current state of every session and project instead of polling anything;
  - start workers with `orca orchestration worker-start --repo id:<repoId> --worktree new-top-level --name <short-name><suffix> --comment "<marker>" --agent <workerAgent>`, then run `./bin/say track <dispatch_id>`;
  - post every progress update, question and result with `./bin/say`;
  - message any session with `./bin/tell <session> <text>`, never by typing into a terminal;
  - have workers open draft PRs, never merge, never force-push;
  - end its turn at once on a `worker_done` for a fix the panel routed.
- **`board.md`** is written by the plugin into the home folder whenever the Board changes: every session with its lane, status phrase, project, branch, PR and dispatch id, plus every project's repo id and path.
- **Talking back without a server.** `./bin/say <kind> <text>` and `./bin/tell <session> <text>` are small shell scripts that drop one file each into `outbox/`. The worker reads and deletes them. There is no port and no token, so nothing breaks when the worker or Orca restarts.
- **Permissions:** the folder's `.claude/settings.json` allows `orca`, `gh`, `./bin/say` and `./bin/tell`, so Claude Code does not stop on them. Anything that still stops it surfaces as an approval card like any other session.
- **Resume, not restart:** the plugin stores the orchestrator's session id and resumes it with `agent.resume` when its terminal is gone.

### The Chat view

Only the chat. Header: Chat | Board and **+**. Footer: GitHub status, merge guard status, and the gear at the right.

- **Your messages** go to the orchestrator's terminal when it is idle. While it is working they are held and the view shows "N queued · sends when the orchestrator finishes its turn".
- **Orchestrator messages** are what it posts with `./bin/say`: `text`, `progress`, `result`, and `question` with option buttons. An answer is sent back like any message. An unanswered question counts as needing Aamon: it shows a dot on the Chat tab and adds to the status bar count.
- **Cards** are posted by the plugin, in the same timeline, whenever a session enters Needs you:

  | Card | Text | Buttons |
  |---|---|---|
  | Approval | "Wants to run: `<command>`" or "Waiting on a prompt" | Allow once · Deny · Peek |
  | Fix limit | "CI failing · 3 fix attempts used" | Retry fix · Details |
  | Merge blocked | The command that was stopped | Details |
  | Can't reach | "No agent to message in this session" | Details |

  A card resolves in place when it is answered in either the chat or the Board row.
- **Empty chat:** "What should I take on?" with two starters, "Close out my open PRs" and "What needs me right now?".
- **First run** replaces the chat until an orchestrator agent is picked: installed agents first, a "Not installed (N)" disclosure, and a note that it runs hidden and never opens as a tab.
- Messages and cards are kept in plugin storage (the newest 500), so the chat survives a reload or restart.

### The Board

Lanes in this order, each row showing the session name, PR number or "no PR", a project tag and one status phrase:

| Lane | A session is here when | Status phrases |
|---|---|---|
| **Needs you** | It has an open card (table above) | "Blocked · wants to run `<command>`", "Blocked · waiting on a prompt", "CI failing · N fix attempts used", "Merge blocked", "No agent to message" |
| **Building** | No open PR and its agent is working | "Working · 14m" |
| **Validating** | Open PR and any of: draft, checks pending, checks failing, conflicts | "Draft", "Checks running · 4 of 9", "CI failing", "Fixing CI failures · sent 1m ago", "Merge conflicts", "Resolving conflicts · sent 1m ago" |
| **Needs review** | Open PR, checks green, and any of: unresolved thread, changes requested, a review requested and not in | "Addressing comments · sent 1m ago", "Changes requested", "Commented", "Awaiting review" |
| **Ready** | Open PR that is not a draft, has at least one check, every check passed, no unresolved thread, no changes requested, no pending review request, and mergeable | "Mergeable" |

Under the lanes, one line: "Idle · N sessions", which expands to the sessions with no PR whose agent is not working.

- **Precedence:** Needs you, then (with no PR) Building or Idle, then Validating, Needs review, Ready.
- **Layout:** a grouped list when narrow; the five lanes as columns from about 640px of panel width.
- **Row buttons:** a Needs you row carries the same buttons as its card.
- **Row menu (⋯):** Details · Message · Retry fix · Auto-fix CI on/off · Auto-fix review comments on/off · Stop agent · Remove worktree… (asks first, in the panel: "Its branch and PR stay on GitHub.").
- **Notifications:** one desktop notification when a session enters Needs you, and one when it enters Ready.

### Session details and Peek

Opened from a row, as a panel view with a back arrow.

- **Header:** name, PR, branch, agent, state dot.
- **Status | Terminal | Diff.** *Status* lists checks, open threads, fix attempts used and the last thing sent. *Terminal* is Peek. *Diff* is `gh pr diff`.
- **Peek** shows the agent's rendered screen, refreshed about once a second while open, with a key row under it: Enter, 1, 2, 3, y, n, Esc. It is the fallback for any prompt the buttons cannot answer, including the orchestrator's own.
- **Buttons:** Retry fix, Stop agent, PR on GitHub. A message box sends to the session.

### Approvals

- **Detection:** a session's agent reports `blocked` (`agent.status.changed`), or `workspace.list` reports `permission`.
- **What it wants:** for Claude Code, the last `agent.tool.before` call seen on that terminal (a shell command shows as the command; any other tool as its name). For other agents, "Waiting on a prompt".
- **Allow once / Deny:** offered when the plugin knows the agent's prompt keys. In v1 that is Claude Code in a terminal: Allow once sends `1`, Deny sends Escape. The plugin then checks the agent left `blocked` within 3 seconds; if not, the card says "Answer it in Peek".
- **Every other agent** gets a card with Peek only.
- While an agent is blocked, nothing else is ever typed into it.

### Babysitting

Every interval, for each GitHub repository with at least one tracked session, one GraphQL query reads every open PR: head branch and SHA, base SHA, draft, mergeable, review decision, pending review requests, the check rollup, review threads, reviews and comments, plus `rateLimit`.

A PR belongs to the session whose worktree branch is the PR's head branch in that repository. A worktree on the repository's default branch never matches.

| Event | Sent when | Dedupe key | Message |
|---|---|---|---|
| CI failed | The head SHA has a failed check and no check is still pending, or 10 minutes after the first failure was seen on that SHA | PR + head SHA | Every failed check's name and URL, and the last 80 lines of each failed job's log (at most 3 jobs) |
| Review thread | A thread is unresolved and its newest comment is unsent | comment id | File, line, text, thread URL, and the command that resolves the thread |
| Review body | A review with a body and state changes-requested or commented | review id | The body and its URL |
| PR comment | A top-level comment from a human | comment id | The text and its URL |
| Bot comments | Bot comments, batched | PR + head SHA | All of them in one message |
| Conflict | Mergeable is conflicting | PR + base SHA | "Merge `origin/<base>` into your branch and resolve conflicts, then push." |

- **Agent replies are skipped.** Agents use Aamon's GitHub login, so author cannot tell them apart. Messages tell the agent to resolve a thread after fixing it, and to start any reply it posts with `[agent]`. Comments starting with `[agent]` are never routed.
- **Attempts:** CI sends are counted per PR. The count resets when a head SHA goes fully green. After the limit (default 3) the next failure is not sent: the session moves to Needs you with a Fix limit card. Retry fix resets the count and sends.
- **Auto-fix switches,** per session, as in the reference: "Auto-fix CI" (covers conflicts) and "Auto-fix review comments". Both are on for orchestrator-started sessions. For yours they follow the setting "Auto-fix my own sessions" (default on). With a switch off, the Board still shows the state and nothing is sent.
- **Delivery, in this order:**
  1. An orchestrator-started session with a dispatch: `orca orchestration send --to dispatch:<id>`.
  2. An agent terminal that is idle (`waiting` or `done`): typed with `terminal.sendText`.
  3. An agent terminal that is working or blocked: held in a stored queue and sent when it goes idle.
  4. No terminal but a known session id: `agent.resume`, then as 3.
  5. Otherwise: a Can't reach card.
- **`./bin/tell`** from the orchestrator uses the same delivery, so nothing ever types into a busy agent.

### Merge guard

- **Scope:** the orchestrator and the sessions it started. Aamon's own sessions are untouched: his global `guard_push.py` already covers them, and AGENTS.md §10 lets him approve a merge in-session.
- **Rules:** ported from `~/.claude/hooks/guard_push.py` with its test cases: `gh pr merge`, merge calls through `gh api` (REST or GraphQL, including auto-merge), `git push` with any force flag or a `+` refspec, `--mirror`, `--all`, and any push whose target is `main` or `master`.
- **Claude Code in a terminal** is denied with a reason that says merging is Aamon's. Other terminal agents are reported after the fact and get a Merge blocked card worded "attempted".
- **Footer:** "Merge guard on", "N blocks today", or "Merge guard off" in the danger tone.

### Footer and status bar

- **Footer left:** "Polling GitHub · 60s", "Not watching any PRs", "gh not installed", "gh not signed in" or "GitHub rate limited · retrying in Ns". With status hooks off: "Status hooks off · status may be stale".
- **Footer right:** the gear, which opens Settings as a panel view with a back arrow.
- **Status bar item:** hidden when nothing needs Aamon; otherwise "N need you" in the danger tone.

### Settings

| Setting | Default |
|---|---|
| Orchestrator agent | picked at first run |
| Default worker agent | same as the orchestrator |
| Worker name suffix | `-oa` |
| GitHub check interval | 60 s (30 / 60 / 120 / 300) |
| Fix attempts before asking | 3 (1 / 2 / 3 / 5) |
| Merge guard | on |
| Auto-fix my own sessions | on |

The same settings are declared in the manifest, so they also appear in Orca's Settings → Plugins. The Settings view has one more row, "Peek at the orchestrator".

## How the Orca CLI is used

| Area | Commands | Who |
|---|---|---|
| Sessions | `worktree list`, `workspace.list` (host), `terminal.list` (host) | Plugin |
| Workers | `orchestration worker-start`, `worker-list`, `worker-show`, `worker-read`, `worker-stop` | Orchestrator starts; plugin reads and stops |
| Messaging | `orchestration send`, `reply` | Plugin sends fixes; the orchestrator answers its workers |
| Terminals | `terminal read --screen`, `terminal.sendText` (host) | Plugin: Peek, delivery, approvals |
| Hidden home | `repo add --kind folder`, `repo hide`, `repo list` | Plugin, once |
| Agents | `agent.launch`, `agent.resume` (host), `agent hooks status`, `skills get orchestration` | Plugin launches and resumes; orchestrator loads the guide |
| Cleanup | `worktree rm` (only after a confirm in the panel) | Plugin |

Never used: anything that merges, `orchestration reset`, a consuming `orchestration check`, `terminal switch` or `focus`, `file open`, `agent launch --focus`, `workspace.open`, `editor.open`, `commands.run`.

At startup the worker reads `orca agent-context --json` and uses only the commands this Orca offers.

## Spikes the build runs first

Each result is recorded here under a "Spike results" heading before any module is written. The named fallback applies when a spike fails.

1. **Hidden home.** A folder project added with `repo add --kind folder` and hidden runs an agent launched with `agent.launch` without any tab or sidebar entry appearing. *Fallback: a terminal in an existing workspace that the plugin never focuses.*
2. **`--repo` from the folder.** `worker-start --repo id:<repoId> --worktree new-top-level` from the home folder creates the worktree in that repository.
3. **Mail from outside a terminal.** `orchestration send --to dispatch:<id>` works when run by the worker process, which is in no terminal. *Fallback for send: the terminal route for every session.*
4. **Ids.** Which id `agent.tool.before` and `agent.status.changed` carry, against `workspace.list` ids and `worktree list` ids.
5. **Screen reads.** `orca terminal read --screen --terminal <id>` accepts the host API's terminal id. *Fallback: map through `orca terminal list --json`.*
6. **Approval keys.** In Claude Code, `1` allows once and Escape denies a permission prompt, sent with `terminal.sendText`, and the status leaves `blocked`. Also what the folder-trust prompt needs.
7. **Chat-surface agents.** Whether `agent.status.changed` fires for a chat worker, and whether one can be reached without a dispatch. *Fallback: a Can't reach card.*
8. **Keep-alive.** With a status bar item declared and the panel closed, the worker's timer still fires.
9. **Mail to the orchestrator.** Whether `orchestration send --to run:<id>` or a terminal handle is delivered to an idle coordinator by Orca. If it is, the plugin's own queue for the orchestrator is dropped in favour of it.

## Spike results

These were run on 2026-11-15 against Orca 1.4.259 (host API 1.9), with a throwaway trusted-worker plugin (`local.orch-spike`, loaded with `orca plugin dev load --approve <fingerprint>`). The plugin had a status bar item, the `agent.status.changed` and `workspace.created` events and the `agent.tool.before` hook. In the manifest, hooks are declared as `{"event": "agent.tool.before"}`, which needs `engines.orca >= 1.4.248` and no capability. The plugin unloaded cleanly afterwards. Agent A was a Claude Code terminal started in the hidden home folder with host `agent.launch`. Agent B was a Claude chat started there with `orca agent launch --surface chat`. The worker `spike-oa` was started by Agent A.
- Agent A was closed with host `terminal.close`.
- The worker was stopped, and its worktree and branch were removed.
- Chat B could not be closed directly: every terminal command refuses its handle. `orca terminal close --worktree id:<home> --all` returned `retiredSurfaces: true`, but `orca worktree ps` still lists it as `done` with `subagentObservation: "live"`. Whether chat B is really gone: **needs Aamon's check**.
- Run `run_ea48f930dd52` stays in Orca's run list, because removing it would need the forbidden `reset`.

1. **Hidden home.** `orca repo add --path ~/.orca-orchestration/home --kind folder`, then `orca repo hide --repo id:ed35e1a6-…`. After that, `repo show` reports `hidden: true` and `project.list` reports `hidden: true`. `workspace.list` still lists the folder, with id `ed35e1a6-…::/Users/aamonnaig/.orca-orchestration/home` and `kind: "folder"`.
   - Host `agent.launch({ workspaceId: "<repoId>::<path>", agent: "claude" })` returned `{ terminalId: "term_f4ba9fff-…" }`. `orca terminal list --worktree id:<repoId>::<path>` shows that terminal with `tabId: "pty:<repoId>::<path>@@f02a4b4f"`.
   - No folder-trust prompt appeared.
   - Agent A's own Bash sandbox blocked its first `orca` call (EPERM on Orca's socket). It retried outside the sandbox without asking, because Aamon's global auto mode was on. The folder's `.claude/settings.json` must let `orca` reach the socket from inside the sandbox; allowing the command is not enough.
   - Whether any tab or sidebar entry appeared: **needs Aamon's check**. Everything the CLI shows holds.
2. **`--repo` from the folder.** Agent A ran `orca orchestration worker-start --spec '…' --task-title spike-oa --agent claude --worktree new-top-level --repo id:5e954941-0215-463e-97e1-feb38c4e64ff --name spike-oa --comment orch:spike --json`.
   - The receipt: `dispatchId: ctx_92026b9d61c3`, `runId: run_ea48f930dd52`, `runCreated: true`, `mode: "terminal"`, `terminal: term_c9f2b7b0-…`, `workspace: 5e954941-…::/Users/aamonnaig/Developer/orca-plugins/spike-oa`, `keptOpen: true`.
   - The new worktree was on branch `aamonnaig4/spike-oa`, with `comment: "orch:spike"` and `projectId: github:aamonnaig4/orca-plugins`.
   - **Holds.**
3. **Mail from outside a terminal.** The plugin worker's environment has no `ORCA_*` variables.
   - Run from the worker, `orca orchestration send --to dispatch:ctx_92026b9d61c3 --subject … --body …` fails with `no_active_sender_terminal`: "Pass --from with your own terminal's handle".
   - With `--from term_f4ba9fff-…` (the orchestrator's terminal) added, it returns `{"delivery":"follow_up","followUpOf":"ctx_92026b9d61c3","dispatchId":"ctx_6fc5b45b8c33",…}`. The settled worker took it as a new Task, answered, and sent `worker_done` for the **new** dispatch id to the orchestrator.
   - **Holds, provided** the plugin always passes `--from <orchestrator terminal handle>`. Every follow-up gets a new dispatch id, linked back by `followUpOf`.
4. **Ids.** The same workspace, `spike-oa`, appears under these ids:
   - `worktree list`: `id` is `5e954941-…::/Users/…/spike-oa` (`repoId::path`), `instanceId` is `e4c5b3f5-…`, `identity.key` is `wt2:local:e4c5b3f5-…`, and `projectId` is `github:aamonnaig4/orca-plugins`. For a folder, `projectId` is `repo:<repoId>`.
   - `workspace.list`: `id` is `identity:wt2:local:e4c5b3f5-…`, and `projectId` is the bare `repoId`. The folder is the exception: its `id` is `repoId::path`.
   - `agent.status.changed` carries `workspaceId` = `repoId::path`, `workspaceListId` = `identity:wt2:local:<instanceId>`, an undocumented `worktreeId` = `repoId::path`, `paneKey` = `<uuid>:<uuid>`, `terminalId` = `term_…` (the same string as the CLI handle and host ids), and `sessionId` (the agent's own session UUID).
     - For the hidden-folder terminal, `terminalId` was **absent** from every event. Its `workspaceListId` (`identity:wt2:local:f6ae7416-…`) does **not** equal the folder's `workspace.list` id (`ed35e1a6-…::/…/home`). Its `paneKey` matches nothing in `terminal list`.
     - Look the orchestrator up by `workspaceId` (or `sessionId`), not by terminal.
   - `agent.tool.before` carries `workspaceId` = `repoId::path`, `terminalId` = `term_…` (present even for the hidden folder) and `callId`. It fires for **every** Claude Code terminal on the machine, including sessions the plugin has nothing to do with.
   - The env var `ORCA_WORKSPACE_ID` in an Orca terminal is also `repoId::path`.
   - Real `agent.status.changed`: `{"workspaceId":"5e954941-0215-463e-97e1-feb38c4e64ff::/Users/aamonnaig/Developer/orca-plugins/spike-oa","workspaceListId":"identity:wt2:local:e4c5b3f5-797b-4987-9199-d48dd1796aec","paneKey":"b086b2cc-05e0-4aea-af35-1496325c8df9:a2a6fd60-8294-46e2-a7fc-6a181cb3ff2b","terminalId":"term_c9f2b7b0-fc9f-4f05-89c9-b16bca2fc0a5","title":"Orca spike test task","state":"done","receivedAt":1794778797463,"mainAgent":{"state":"done","stateStartedAt":1794778794944},"sessionId":"1f3f0b82-5376-4c3c-bc0a-348a4953f3e5","worktreeId":"5e954941-0215-463e-97e1-feb38c4e64ff::/Users/aamonnaig/Developer/orca-plugins/spike-oa"}`
   - Real `agent.tool.before`: `{"agent":"claude","workspaceId":"ed35e1a6-a877-4c36-9b9a-c9aa020a5305::/Users/aamonnaig/.orca-orchestration/home","terminalId":"term_f4ba9fff-bef1-4a71-ab9f-566ceb5f778b","tool":"WebFetch","input":{"url":"https://example.com","prompt":"What is the page title? Reply with only the title."},"callId":"toolu_01VW118TAjk5kFGoXcPL9Hj3"}`
   - **Holds.** Every one of these shapes is recorded here and in the fixtures.
5. **Screen reads.** `orca terminal read --screen --terminal term_f4ba9fff-… --json`, using the id host `agent.launch` returned, gave `source: "screen"` and the rendered Claude Code TUI. Host terminal ids and CLI handles are the same `term_…` string. **Holds.**
6. **Approval keys.** Agent A was switched from auto to manual mode by sending Shift+Tab (`"\u001b[Z"`), then asked for two WebFetch calls.
   - At each permission prompt, `agent.status.changed` reported **`waiting`** (never `blocked`), and `workspace.list` reported `permission`.
   - `1` with no Enter allowed the call once: the status went `working`, then `done`.
   - Escape (`"\u001b"`) denied it ("Interrupted · What should Claude do instead?"). After that **no further status event came**. `workspace.list` still said `permission` about a minute later, and it stayed that way until the terminal was closed.
   - Host `terminal.sendText` was refused with `action_failed: "terminal is outside the active worktree"`, even for a terminal this plugin had launched. Every keystroke above went through `orca terminal send --terminal <id> --text <keys> [--enter] --json`, run from the worker process. That works for any terminal.
   - No folder-trust prompt appeared, so its keys are untested.
   - **Fallback in force:** send keys with the `orca terminal send` CLI, not host `terminal.sendText`. Treat `waiting` together with `permission` as blocked. After a deny, confirm the outcome from the screen, not from the status.
7. **Chat-surface agents.** Agent B was started with `orca agent launch --agent claude --worktree id:<home> --surface chat --prompt … --json`. The receipt included `outcome.kind: "structured"` and `sessionId: claude_780deaf0_…`.
   - `agent.status.changed` fires for the chat, with `paneKey: "structured-agent-session-claude_780deaf0_…:<uuid>"`, **no `terminalId`**, and, a moment after it starts, a `sessionId` (`075de865-…`) different from the launch receipt's.
   - `orca terminal read` and `orca terminal send` with the handle `structured-agent-session-…` fail with `terminal_handle_stale`.
   - `orca orchestration send --from <orchestrator handle> --to orca_session_id:claude_780deaf0_a5af_43e1_8867_0eb5272b6ced --subject … --body …`, run from the worker, returned `messageId`. The chat then took a turn (`working`, then `done`, with outcome `success`). `orca worktree ps` shows that its prompt arrived framed as "From: TERM_F4BA9FFF-… (status) Subject: spike 7 …", and its last message was `again`.
   - **Holds:** a chat can be reached without a dispatch through `orca_session_id:<id from the paneKey prefix>`. The Can't reach card stays only for chats whose id is unknown.
   - Whether `agent launch` without `--focus` moved the window: **needs Aamon's check**.
8. **Keep-alive.** The scratch plugin declared a status bar item and **no panel at all**. After `dev load`, it received no requests for 130 s. `orca plugin logs local.orch-spike` showed `tick 1 t=10` through `tick 12 t=120`: 12 lines, 110 s from the first to the last. **Holds.**
9. **Mail to the orchestrator.** A `worker_done` from `spike-oa` woke the idle orchestrator without any help: Orca typed "You have 1 orchestration message. Run orca orchestration check --run run_ea48f930dd52." into its terminal.
   - From the worker, `orca orchestration send --to run:run_ea48f930dd52 --type status --subject … --body …` also needs `--from`. Without it the error is `no_active_sender_terminal`.
   - With `--from term_c9f2b7b0-…` (the worker's handle) it returned `messageId: msg_045ce5b65397`. The idle orchestrator was woken the same way and read the message, but as **from the worker**.
   - **Holds for delivery**, so under this spike's rule the plugin's own queue for the orchestrator is dropped.
   - Open, **needs Aamon's check**: no clean sender identity was found. Using a worker's handle makes the message look like it came from that worker. Two routes were not tried, because the two-agent limit was spent: the orchestrator's own handle as `--from`, and `--to <term handle>`.

The fixtures in `plugins/orchestration/tests/fixtures/` are real output from these runs, trimmed to representative rows:
- `agent-context.json`: the 25 commands the plan names.
- `worktree-list.json`, `worker-list.json`, `repo-list.json`, `workspace-list.json`: captured while `spike-oa` and the hidden home existed.
- `hooks-status.json`.
- `gh-prs.json`: the query in `gh-prs.graphql`, run against the public `stablyai/orca`, because `aamonnaig4/orca-plugins` had no open PRs. It includes failing, green, duplicate-check-name, review-requested and draft-without-checks PRs, with bodies cut to 300 characters. It has no StatusContext row, no `hasNextPage: true`, no `CONFLICTING`, and no non-null `reviewDecision`. Task 4's tests for those cases build their inputs by hand.
- Rows from Aamon's private repositories were removed from every fixture.

## Calls made in this rewrite (for Aamon to check)

1. **Auto-fix defaults to on for your own sessions.** The alternative is off until switched on per session, as the reference does with an explicit claim.
2. **The guard covers only orchestrator-started sessions,** as before.
3. **The Chat | Terminal style setting is gone.** The Chat view is always the chat; the orchestrator's terminal is reached through Peek.
4. **The nightly sweep is gone.** The status bar item keeps the watcher running, and an automation would spend agent usage to do the same thing.
5. **Allow once and Deny are Claude Code only in v1.** Other agents get Peek.
6. **CI failures are sent once per push,** not once per failed check.
7. **Agent replies are marked `[agent]`,** because every PR and comment comes from one GitHub login.
8. **No Orca decision gates.** The orchestrator asks Aamon with `./bin/say question`, which needs no Run id and no extra CLI calls.
9. **"Awaiting review" means a review was requested and has not arrived.** With no request pending and everything green, the session is Ready.

## Open questions

None.
