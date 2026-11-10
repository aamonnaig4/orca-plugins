# Activity Monitor: agent cleanup button and chart settings

Date: 2026-11-08 · Plugin: `plugins/activity-monitor` (1.0.0 shipped) · Mockups: `docs/design/activity-monitor/mockup-cleanup.html`, `docs/design/activity-monitor/mockup-chart-settings.html`

## Why

Aamon runs many agents and dev servers from Orca. Stale and runaway processes pile up: orphaned `node`/`bun`/`vite` watchers, old `claude`/`codex` sessions, things pinned at high CPU, things whose memory keeps climbing. These are what push the Mac toward the Critical health level. Today the panel can only quit one process at a time, and the user has to know which processes are safe to quit. The fix is to hand the panel's evidence to an agent that can investigate and propose a cleanup, with the user approving every kill.

Separately, the charts only cover the last 1–15 minutes and always label time relatively. The user wants longer history, real clock times, and a little more control over how charts look.

## Goals

1. A broom button in the panel footer starts a **new agent session** in the active workspace. The session gets the panel's suspect list and **proposes** what to quit. Nothing is quit until the user approves in the agent's chat.
2. The button shows the session's progress, and pressing it again jumps to the running session.
3. Chart history goes up to 24h, with clock-time labels, gridline control, and a line-style choice.

## Non-goals

- The plugin never kills anything on the agent's behalf. The agent does the killing, after the user approves.
- No per-chart span control and no zoom. Spans change in Settings only.
- History does not survive an Orca restart (memory only).
- No change to the existing Quit / Force quit flows, the health ladder, or the notification title. Orca hard-codes the title as `<pluginId>: <title>` (`dispatchPlugin` in Orca's app.asar), and the user chose to leave that as is.

## Anti-goals (would be a failure even if it works)

- **Anything that could quit Orca.** Orca and all of its helper and renderer processes must never be in the suspect list, and the prompt must forbid them explicitly. This is the user's standing hard rule.
- The cleanup agent quitting its own session, the Activity Monitor worker, or the user's other live agent sessions in Orca terminals without the user approving them by name.
- A footer label that clips mid-word at any panel width.
- A background cost that is noticeable when nothing is wrong.

## Cleanup button

### Look (settled, mockup-cleanup.html)

- **Place:** a broom icon (lucide `brush-cleaning`) in the footer's right cluster, between the refresh stepper and the pause button. It is always visible. It uses the same `.ib` 20×20 button style as pause and gear. Tooltip at rest: "Ask your agent to clean up stale processes".
- **Progress (2B):** while a cleanup session exists, the icon becomes a pill:
  - agent working → spinner + "Cleaning…"
  - agent waiting for the user → amber broom + "Review N" (amber text and border)
  - agent done → green check + "N quit"
- **Narrow (under 300px):** the stepper always stays. The pill falls back to icon states instead: a spinner in place of the broom while working, an amber dot on the broom while waiting, a green dot when done. The words move to the tooltip.
- After "done", the pill returns to the resting broom when the user clicks it (which opens the session), or after 10 minutes. *(builder's call: the exact timeout.)*
- **Fix shipped with this:** at narrow widths the health strip's Quit button drops the app name ("Quit" instead of "Quit Chrome"). Today it clips to "Quit Chro…".

### Behavior

1. **Press with no session running** → the worker:
   1. resolves the focused workspace. `workspace.readContext` has no id, so match it against `workspace.list` (by name, branch and its terminals). Only workspaces on this computer count (`hostId` null or `local`), because the suspect list is this machine's processes. If nothing local is focused, or the match is ambiguous, it falls back to the first local workspace whose path exists, since cleanup is machine-wide (changed in 1.1.2; the focused workspace used to be a hard requirement). If there is none, it shows "No Orca workspace on this computer", "Add a project to Orca first" when Orca has no workspaces, or "Could not read your Orca workspaces", and stops.
   2. builds the suspect list (below) and the prompt.
   3. calls `agent.launch({ workspaceId, agent, prompt })` and stores the returned `terminalId` as the cleanup session.
   4. if Settings → "Open cleanup terminal" is on, brings that terminal to the front (see Spikes).
2. **Press while a session exists** (any state, including done but not dismissed) → it jumps to that terminal and does not start a new one.
3. **Session ends** (terminal closed or gone) → the button returns to rest.

### Which agent

The user wants Orca's own Default Agent (Settings → Agents → Default Agent). The plugin API has no way to read it. **Spike first:** call `agent.launch` with `agent: "auto"` and confirm it starts the Default Agent. If that works, there is no plugin setting. If it doesn't, add Settings → Cleanup → "Cleanup agent" (Claude / Codex / Grok, default Claude). It appears only in that fallback case.

### Suspect list

The worker collects suspects in four categories. Thresholds are the builder's call, as long as they are conservative (few false positives) and documented:

- **Orphaned dev processes:** dev tooling (`node`, `bun`, `deno`, `vite`, `tsc`, `esbuild`, `webpack`, `next`, `python -m http.server` and similar) whose parent is gone (ppid 1 / reparented to launchd), or whose working directory no longer exists (for example, a deleted worktree).
- **Old agent sessions:** `claude`, `codex`, `grok`, `gemini`, `cursor-agent` and similar CLIs that are **orphaned**: parent gone or reparented, or their Orca terminal no longer exists. **Never** flag an agent process that still descends from Orca, even if it has been idle for hours (the user's decision). This needs a per-OS ancestry walk. Where an OS can't provide one, skip the category on that OS.
- **CPU hogs:** sustained high CPU (for example, above 80% of a core averaged over 5 minutes).
- **Memory leakers:** resident memory that keeps rising across samples (for example, +500 MB and +50% over 10 minutes).

Detecting hogs and leakers needs per-process history. The worker lists processes **every 15s while "Record in background" is on** (the user's decision) and keeps a rolling per-pid record (pid, start time, cpu, mem) covering at least 10 minutes. With the toggle off, it records only while the panel is open, so hogs and leakers are found only after the panel has been open about 10 minutes. The panel's process list still refreshes no faster than 1s.

**Prefs the worker needs** (Record in background, Open cleanup terminal, Cleanup agent) live today in the panel's `localStorage` (`activity-monitor:prefs`), which the worker can't read. Move those to `orca.storage` (or plugin settings), and have the panel read and write them there. *(my call)*

**Always excluded:** Orca and every helper or renderer (reuse `isOrca` and the guard in `src/health.ts`), system processes (reuse `protectedNames`), the Activity Monitor worker (`selfPids`), and the shell and agent processes of the cleanup session itself.

If the list is empty, the button still launches the session, with a prompt saying the panel found nothing and asking the agent for a quick look of its own. *(my call: this keeps the button predictable; flag if you'd rather it say "Nothing to clean" and not launch.)*

### Prompt

Built in the worker, reusing the fencing and sanitizing in `src/explain.ts` (`safe()`, the `<<<PROCESS-DATA … PROCESS-DATA>>>` fence). Process names and paths are untrusted text. It contains:

- the OS, plus one row per suspect: pid, name, sanitized command or path, cpu, mem, memory trend, age, parent pid, working directory if known, and why it was flagged.
- instructions: verify each suspect is really stale or runaway; **propose** a kill list with a one-line reason per pid; **wait for the user's approval** before quitting anything; quit politely first (SIGTERM / plain `taskkill`) and force only if that fails and the user agrees; **never** touch Orca or its helpers, system processes, or this session.
- a request to end the proposal with a line `Proposed: N` (used for the "Review N" count).

### Progress tracking

- **State:** from `agent.status.changed` events and `agents.list`, matched on the stored `terminalId`. CLI agents report `done` when a turn ends, so `done` alone can't separate "proposal ready" from "finished". The rule *(my call)*:
  - `working` → "Cleaning…"
  - idle (`waiting`, `blocked` or `done`) and **no** suspect pid has disappeared yet → "Review N"
  - idle and **at least one** suspect pid has disappeared → "N quit"
  - back to `working` after Review (the user approved and kills are running) → "Cleaning…" again
- **N in "Review N":** parsed from the last `Proposed: N` line via `terminal.read`. If it can't be read, the pill shows "Review" with no number.
- **N in "N quit":** the number of suspect pids (matched by pid and start time) that no longer exist when the session reaches done.
- `agents.list` only covers the focused workspace. If the user switches away, the button keeps its last known state until events or a return to that workspace update it. (Builder: confirm whether `agent.status.changed` fires for unfocused workspaces, and use it if so.)

## Chart settings

### History and recording

- Settings → Graphs → History: **1m · 5m · 15m · 1h · 6h · 24h**. Default stays at today's 1m (`DEFAULTS.hist = 60` in `panel/app.js`), so nothing changes for current users.
- **Record in background** (toggle, default on): the worker keeps sampling system stats on its existing 3s health pulse while the panel is closed, so long spans are full when the panel opens. With it off, long spans show only what was recorded while the panel was open.
- History is memory only and starts fresh when Orca restarts.
- **Structural change:** today history is a fixed count of samples (`HISTORY = 900` in `src/sampler.ts`, `span()` in `panel/app.js:896`), so the time covered depends on the refresh rate. At 100ms it covers only 90 seconds. History must become **time-based**: full-resolution points for recent data, and time buckets for older data (for example, 1s for the last 15m, 10s to 6h, 60s to 24h) so 24h stays small. The exact tiers are the builder's call. The rule: any span renders roughly the same number of points, and memory stays bounded (a few MB at most).

### Look (settled, mockup-chart-settings.html)

- **Line style** (new, Smooth graphs only; Pixel keeps its braille look): **Line + fill** (default, today's look) · **Line** · **Bars**.
  - Bars in **Heat** color: each bar takes its value's heat color (green under 50%, amber under 80%, red above), using the same palette as today.
  - Bars in **Theme** color: the theme color, brighter for higher values (alpha ramps from about 0.35 to 1.0).
- **Time labels** (new): **Relative** (today: "−15m · −7.5m · now") or **Clock**. Clock shows round times at their true positions, which slide left as time passes: 14:20 · 14:25 · 14:30 for 15m, and 18:00 · 00:00 · 06:00 · 12:00 for 24h. Tick spacing per span is the builder's call (aim for 3–4 labels). Use the system's 12h/24h preference.
- **Gridlines** (new, default on): on = dashed lines at 25/50/75% plus the "100%" and "50%" value labels. Off = no lines and no value labels. The span label and the time row stay either way.
- These apply to every chart that has axes today: the All page hero and tiles, and each section page. The per-core sparklines stay line + fill.

### Settings layout (5A)

Graphs group, in order: Graph style · Line style · Color · Gridlines · History · Time labels · Record in background · Refresh.
New **Cleanup** group after Graphs: Open cleanup terminal (toggle, default on; "Switch to the agent when cleanup starts"), then "Cleanup agent" only if the auto spike fails.
"Reset to defaults" covers the new prefs.

## Spikes (done 2026-11-08, results)

1. **`agent: "auto"` → rejected** (`invalid_params: agent: unknown agent`). Orca doesn't expose the Default Agent to plugins or the CLI (`orca agent launch` also requires `--agent`). → **Settings → Cleanup → "Cleanup agent" (Claude / Codex / Grok, default Claude) ships.**
2. **Prompt delivery:** `agent.launch` with a `prompt` starts the agent, but the prompt is lost (`agent_launch_terminal_not_running_agent`, logged only, no error returned). → Launch **without** a prompt, wait for the first `agent.status.changed` for the returned `terminalId` (it fires when the agent is idle, about 10s for Claude; time out after 45s), then send the prompt with host `terminal.sendText` (`enter: true`). Fall back to the Orca CLI (`orca terminal send --terminal <id> --text <prompt> --enter`), which works across workspaces.
3. **Bringing the terminal to the front:** `orca terminal switch --terminal <id>` takes the same `term_…` handle that `agent.launch` returns. It was not run live during the spike (it would have pulled the user's window away); confirm in the final live check. The worker finds the CLI on `PATH`, then at `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS.
4. **`agent.status.changed`** arrives for terminals in unfocused workspaces. It needs `contributes.events: [{ "on": "agent.status.changed" }]` in the manifest. The payload has `terminalId`, `state` and `mainAgent.state`.
5. **Capabilities** added: `workspace:read` (readContext/list), `agent:launch`, `terminal:read`. `workspace.readContext` gives `{ branch, displayName, terminals }`; matching `workspace.list` by `name === displayName` works (branch can be `""` vs `null`).

## Constraints

- No comments in source (AGENTS.md §1; `hooks/check_source_comments.py`).
- Cross-platform: per-OS readers in `src/mac.ts`, `linux.ts`, `windows.ts`. Orphan and cwd detection need a reader per OS. Where an OS can't provide a field, skip that check rather than guess.
- Capabilities already granted: `agent:read`, `terminal:send`, `notifications:show`. `agent.launch` and `terminal.read` may need extra capabilities in `orca-plugin.json`. Check with `orca plugin validate`.
- Draft PR only. UI work needs labeled before/after stills and a short motion clip before review (AGENTS.md §3–§5). The motion clip should show the button going ready → Cleaning… → Review → quit.
- Bump to 1.1.0 and add a catalog release entry (merge commit, not squash; release entries pin a SHA).

## Left to the builder

Thresholds for each suspect category; history bucket tiers; tick spacing for clock labels; the "done" pill timeout; the exact prompt wording within the rules above; test layout (follow the existing `tests/` with fakes per OS).
