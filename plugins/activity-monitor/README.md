# Activity Monitor

A live system monitor in Orca's right sidebar: CPU cores, memory, network, disk, GPU and processes.

![The All, CPU and Processes tabs](media/screens.png)

- **All** shows every section in one scroll. Each section also has its own tab, where its graphs fill the whole panel.
- **CPU** shows a bar per core on All and a graph per core on its page. Apple silicon and hybrid Intel cores are labeled P and E.
- **Processes** can be filtered and sorted, and loads more rows as you scroll, so you can reach every process. To quit one, hover its row and press ×. It asks first, and it refuses Orca itself and system processes.
- **What is this?** (right-click a process) sends a question about that process to one of your running agents, so it can explain what the process is.
- **Settings** (the gear) groups everything below. **Reset to defaults** puts them all back.

## Lock-up warnings

The strip at the bottom of the panel shows one word on a five-step scale, with a pip per step: **Idle · Healthy · Busy · Strained · Critical**. Click it (or press Enter on it) to open a drawer that grows up from the footer with the cause and the five most likely culprits: by memory, or by CPU when Busy. Each has a **Quit** button; if an app ignores it for 3 seconds, the button becomes **Force quit**. Apps are grouped with their helper processes. Processes that share a name, like many `node`, are listed one by one so each Quit hits exactly one process. Orca and system processes are listed without a button.

- **Idle**: CPU under 10% and memory under 60%.
- **Healthy**: normal use.
- **Busy**: CPU averaging 70% or more over 10 seconds. CPU alone never raises an alert.
- **Strained**: memory pressure, memory over 90%, or swap growing. The strip turns amber.
- **Critical**: memory use at or above the percent in Settings → Health → Critical at (95% by default). The strip turns red, a toast appears in the panel, a "Critical" badge shows in Orca's footer, and a **Quit ‹app›** button names the app using the most memory, with its helper processes counted in. If memory stays at that percent and pressure is critical or swap is growing fast, a desktop notification follows, so it reaches you even when Orca is in the background. Pressure or swap trouble below that percent stays on Strained and does not raise the footer warning.
- After each toast or notification it stays quiet for 10 minutes.
- It never offers to quit Orca, its helpers, or system processes. If Orca itself is the biggest user, or several unrelated processes share one name, no Quit button appears.

The badge keeps the worker running while the sidebar is closed, so warnings still fire. It's hidden until memory reaches the Critical at percent. Windows has no pressure or swap reading, so the footer warning there follows that percent, and the desktop notification follows a few points higher.

## Clean up

The broom in the footer starts a cleanup. It launches your chosen agent (Claude, Codex or Grok, set in Settings) in the workspace you have focused (or, if none is, in any workspace on this computer; process cleanup is machine-wide), and hands it the list of suspect processes below. The agent checks each one and proposes a kill list with a reason per process. Nothing is quit until you approve it in the agent's terminal. It never touches Orca, its helpers, or agents still running in Orca.

While it works the broom shows **Cleaning…**, then **Review** with a count when the agent has a list for you, then how many were quit. Click it at any point to jump to the agent's terminal.

## Cleanup suspects

The cleanup session gets a list of processes that look stale or runaway. The thresholds are conservative on purpose:

- **Orphaned dev process**: `node`, `bun`, `deno`, `vite`, `tsc`, `esbuild`, `webpack`, `next`, `turbo`, `nodemon`, `tsx` or `python`, or a command line running `vite`, `next dev`, `webpack`, `tsc --watch` or `http.server`, whose parent is gone (parent PID 1) or whose working directory no longer exists.
- **Orphaned agent**: `claude`, `codex`, `grok`, `gemini`, `cursor-agent`, `aider` or `opencode` (also when run through `node`) with a gone parent or working directory. An agent that still runs under Orca is never flagged, however long it has been idle.
- **CPU hog**: 80% of a core or more, averaged over 5 minutes.
- **Memory leak**: resident memory up at least 500 MB and at least 50% over 10 minutes.

Hogs and leaks need about 5 and 10 minutes of samples. Orca and its helpers, system processes and the Activity Monitor worker are never flagged. Windows gives no parent PID, so agents are skipped there and dev processes are flagged only by a missing folder, CPU or memory.

## Settings

- **Graphs**: style (Smooth or Pixel), line style (Line + fill, Line or Bars, for Smooth graphs), color (Heat, or Theme to recolor everything, including the health strip, from your theme's primary color to its destructive color), gridlines on or off, history (1m, 5m, 15m, 1h, 6h or 24h), time labels (Relative, like "5m ago", or Clock, like "14:05"), record in background (keeps long history filling while the panel is closed), and refresh (a stepper from 100ms to 10s, also in the footer). Pixel draws every graph, bar and the health level blocks as braille dots. Fast refresh uses more CPU.
- **Cleanup**: open cleanup terminal (switch to the agent's terminal when a cleanup starts), and the cleanup agent (Claude, Codex or Grok).
- **Health**: the health strip on or off (it still shows at Strained or Critical), the memory alert on or off, and **Critical at**, the memory percent that puts the Critical warning in Orca's footer. It defaults to 95% and can be set from 70% to 99%. The memory alert only hides the pop-up inside the panel; the macOS notification still appears once memory is at that percent and pressure or swap says it is getting worse.
- **Processes**: default sort (CPU, Memory or Name), and pulse on change, which flashes numbers that jump.
- **General**: what the panel opens on (Last, All or Processes), text size (Small, Default or Large), and table rows (Compact, Default or Comfortable).

## Permissions

It runs as a trusted worker because it reads system counters and lists processes, so Orca asks you to approve it on install. It asks for these capabilities:

- **Show notifications** (`notifications:show`): sends the desktop notification when memory stays critical, so it reaches you when Orca is in the background.
- **Read agents** (`agent:read`): lists your running agents so **What is this?** can pick one to ask, and so a cleanup can tell when its agent is working or waiting for you.
- **Send to terminals** (`terminal:send`): types the **What is this?** question, or the cleanup request, into the agent's terminal. It only does this when you choose it.
- **Read your workspace** (`workspace:read`): finds the workspace you have focused, so the cleanup agent starts there, or another workspace on this computer when nothing local is focused.
- **Start agents** (`agent:launch`): starts the cleanup agent you picked in Settings when you click the broom.
- **Read terminal output** (`terminal:read`): reads the cleanup agent's terminal to see its "Proposed: N" line and whether that terminal is still open.
- **Own storage** (`storage:own`): saves your settings in the plugin's own storage folder.

It also listens for one event, **agent status changes** (`agent.status.changed`), to know when the cleanup agent has started and when it is working, waiting or done.

It makes no network connections and keeps its settings only in your copy of Orca.

## What each system shows

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CPU per core | yes, P/E labels | yes, P/E on hybrid Intel | yes |
| Memory | app, wired, compressed, cached, swap, pressure | used, cached, swap, pressure | used |
| Network | default interface | default interface | all interfaces |
| Disk | space and read/write | space and read/write | space |
| GPU | Apple GPU | NVIDIA (`nvidia-smi`) or AMD | not shown |
| Processes | yes | yes | yes, through PowerShell |
| Energy and battery | energy impact, sleep blockers, battery | battery | battery |
| Packets and disk operations | yes | yes | packets only |

## Process columns

Click **+** next to the search box, or right-click the column headers, to add or remove columns. Drag a header to move its column. Columns that do not fit hide from the end of the order and come back when the panel is wider. Click a process to select it and hold the list in place; double-click it to see every field. Click it again or press Escape to deselect.

| Column | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CPU time, threads, user | yes | yes | CPU time and threads |
| Idle wake ups, ports, energy impact, preventing sleep | yes | – | – |
| % GPU, GPU time | yes | – | – |
| Bytes read and written | – | your own processes | yes |
| Sent and received bytes | yes | – | – |

12 hr power, App Nap and Kind need admin rights on macOS and are not shown.

Sections a system cannot report are left out.

## Develop

```sh
orca plugin validate .
orca plugin dev watch .
node --test tests/*.test.mjs
```
