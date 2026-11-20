# Activity Monitor 1.2.0: monitor a remote Linux machine over SSH

**Status:** implemented

**Goal:** From the computer that runs Orca, pick an SSH host (for example `devbox`) in Settings and see that machine's CPU, memory, network, disk, GPU and processes in the same panel, with the same health strip and Quit.

**Why:** the worker samples only the machine it runs on (`src/sampler.ts:100-113`: `process.platform`, `os.cpus()`, `statfs`). The plugin service runs only in the desktop Orca. A headless `orca serve` on another machine answers `Plugin service is not available on this runtime`.

**Architecture:** `createLinux(d: Deps, root, home)` (`src/linux.ts:21`) already takes its I/O as `Deps` (`run/read/list/readlink`). A new `src/remote.ts` gives an SSH-backed `Deps` that batches every `read/list/readlink` issued in the same macrotask into one `ssh` exec, over a shared ControlMaster connection. The sampler's two remaining local seams (`cpus`, `space`) and `quit` get remote versions. The worker swaps the whole sampler when the chosen machine changes.

## Outcome / acceptance criteria

1. Settings → **Machine** lists "This computer" plus every concrete `Host` alias from `~/.ssh/config` (no `*`, `?` or `!` patterns). Choosing `devbox` makes all sections show devbox's numbers within one refresh. Choosing "This computer" goes back.
2. With devbox chosen, CPU per core, memory (used/cached/swap/pressure), network, disk space (devbox home) and read/write, GPU (if any) and the process list match `top`/`free`/`df ~` on devbox within normal sampling noise.
3. History graphs restart when the machine changes (new `boot` id); no mixing of two machines' points.
4. Health strip, footer badge and desktop notification follow the chosen machine, and name it when remote (`devbox: …`).
5. Quit (× and drawer) works on devbox for processes the SSH user owns; another user's process gives "Not allowed: another user owns it"; a gone pid gives "Already gone".
6. Cleanup (broom) is hidden while a remote machine is chosen; `cleanup.start` refuses with "Cleanup works on this computer only". "What is this?" still works and tells the agent the process is on the SSH host `devbox`.
7. devbox unreachable (wrong key, host down): the panel shows "Can't reach devbox: <first line of ssh stderr>" instead of numbers, keeps retrying each refresh, and never shows the local computer's numbers labelled as devbox.
8. Remote load stays small: at 1s refresh with the Processes tab open, at most ~4 ssh execs per second on average, all over one master connection.
9. Local behaviour (no host chosen) is unchanged; all existing tests pass.

## Non-goals

- Remote macOS or Windows machines (Linux remotes only; a non-Linux host shows "Only Linux machines are supported").
- Watching several machines at once.
- Password or interactive SSH auth (`BatchMode=yes`; key or agent auth only).
- Parsing `Include` files in `~/.ssh/config` (aliases from included files are not listed).
- Windows as the Orca machine (OpenSSH there has no ControlMaster): the Machine setting is hidden on `win32`.

## Global constraints

- No comments in source (existing convention). Explanations go in commit messages.
- No new runtime dependencies. Node built-ins only (`node:child_process` `spawn`).
- Never pass an unvalidated host to `ssh`: alias must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (blocks `-oProxyCommand=…` injection).
- Commits: conventional.
- Tests: from `plugins/activity-monitor`, `orca plugin test .` (plain `node --test` cannot load `worker.test.mjs`).

## Design

### `src/remote.ts` (new)

```ts
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export type Spawn = (cmd: string, args: string[], input: string, timeoutMs: number) => Promise<{ code: number | null; out: string; err: string }>
export type RemoteDeps = Deps & {
  host: string
  error(): string | null
  close(): Promise<void>
}
export function sshArgs(host: string): string[]
export function sshDeps(host: string, spawn?: Spawn): RemoteDeps
export function sshHosts(configText: string): string[]
export function parseProcStatCpus(text: string): CpuTimes[]
export function parseStatF(text: string): { bsize: number; blocks: number; bfree: number; bavail: number } | null
export function parseKill(out: string | null): QuitResult
```

- `sshArgs(host)`: `-T -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o ControlMaster=auto -o ControlPath=/tmp/orca-am-%C -o ControlPersist=60 <host> sh -s`. Short `/tmp` path because macOS caps socket paths at 104 bytes.
- Script goes on stdin to `sh -s`, so no argument-length limits and no remote shell re-parsing of args. Every path/arg is single-quoted (`'` → `'\''`).
- **Batching:** `read`, `list`, `readlink` push `{ kind, path, resolve }` onto a queue; first push schedules `setImmediate(flush)`. `flush` takes up to 2000 ops, builds one script: per op `printf '\n%s\n' '<MARK><i>'` then `cat -- P 2>/dev/null` / `ls -1A -- P 2>/dev/null` / `readlink -- P 2>/dev/null`, then a final end mark. `MARK` = `@@am:<16 random hex>:` per flush. Parse by locating each mark in order; slice between marks (drop the newline the mark's printf adds before it). Contents may hold `\0` and newlines (`/proc/<pid>/cmdline`). Results: `read` → text or `''`; `list` → non-empty lines; `readlink` → trimmed text or `null`.
- `run(command, args, options)`: one exec, script `exec 'cmd' 'arg'…`. Exit 0 → stdout. Exit 255 → ssh failure → `null` and set error. Other non-zero → stdout if `options.anyExit` else `null` (same contract as `nodeDeps.run`). Timeout 10s.
- Concurrency: at most 4 execs in flight; the first exec (connection warm-up) runs alone so ControlMaster is set up once.
- `error()`: last ssh failure (exit 255 or spawn error), first non-empty stderr line, cleared on the next success.
- `close()`: `ssh -O exit -o ControlPath=/tmp/orca-am-%C <host>`; ignore failure.
- Default `spawn` uses `child_process.spawn` with `stdio: ['pipe','pipe','pipe']`, `windowsHide`, env `LC_ALL=C LANG=C`, kills on timeout, caps stdout at 32 MB.
- `sshHosts(text)`: every token after `Host` (case-insensitive) that has no `*`, `?`, `!`, deduped, in file order, filtered by `HOST_RE`.
- `parseProcStatCpus`: lines `cpuN user nice system idle iowait irq …` (skip the aggregate `cpu ` line), ordered by N → `{ user, nice, sys: system, idle, irq }` (same fields as libuv's `os.cpus()`; iowait and softirq are ignored like libuv does).
- `parseStatF`: output of `stat -f -c '%S %b %f %a' <path>` → `{ bsize, blocks, bfree, bavail }`.
- `parseKill`: output of `kill -s SIG PID 2>&1; echo "rc=$?"` → `rc=0` ok; `No such process` → "Already gone"; `not permitted` → "Not allowed: another user owns it"; else "Could not quit it"; `null` → "Could not reach the machine".

### Remote sampler (`src/remote.ts`, `createRemoteSampler(host, spawn?)`)

- `deps = sshDeps(host)`; `base = createLinux(deps, '', '.')` — disk path `.` resolves to the SSH user's home because `stat -f .` runs in the login directory.
- Provider = `{ ...base, note: async () => null, quit: (pid, force) => deps.run('sh', ['-c', 'kill -s "$1" "$2" 2>&1; echo "rc=$?"', 'sh', force ? 'KILL' : 'TERM', String(pid)], { anyExit: true }).then(parseKill), read: async () => { const raw = await base.read(); if (deps.error()) throw new Error(deps.error()!); return raw } }`. A failed read must throw: `createLinux.read` falls back to `osMemory()` (the local computer's memory) when `/proc/meminfo` is empty.
- `info()` also checks `uname -s` once; not `Linux` → throw `Only Linux machines are supported`.
- `cpus = async () => { const list = parseProcStatCpus(await deps.read('/proc/stat')); if (!list.length) throw new Error(deps.error() ?? 'Could not read CPU counters'); return list }`.
- `space = async (path) => parseStatF((await deps.run('stat', ['-f', '-c', '%S %b %f %a', path])) ?? '')`.
- `createSampler({ provider, cpus, space, selfPids: [] })`; returns `{ sampler, deps }`.

### `src/sampler.ts`

- `SamplerOptions.cpus` becomes `() => CpuTimes[] | Promise<CpuTimes[]>`; `take()` awaits each call (`(await cpus()).length`, etc.).
- `quit()` guard: replace `pid === process.pid || pid === process.ppid` with `selfPids.includes(pid)` (default `selfPids` is still `[process.pid, process.ppid]`, so local behaviour is the same).

### `src/worker.ts`

- `Prefs` gains `host: string` (`''` = this computer). `readPrefs` keeps it only when `HOST_RE` matches and `process.platform !== 'win32'`.
- Replace `const sampler` with a `machine` holder `{ host, sampler, deps: Deps, close }`. `useHost(host)`: no-op if unchanged; else close the old remote deps, build the new one (`seams.sampler()` locally, `seams.remoteSampler(host)` remotely), re-apply `setRecording`, `setCritAt`, `onAlert`; reset `tracker` (`createTracker()`) and `shown` so the badge re-evaluates. Call it after `storage.get('prefs')` and in `prefs.sync`.
- `onAlert` sink: when remote, title becomes `<host>: <title>`. `badge()` tooltip becomes `<host>: <cause>`.
- `stats.read`: wrap `machine.sampler.read`; on throw return `{ error: "Can't reach <host>: <message>", host }`. On success add `host: machine.host || null` to the result.
- New handler `hosts.list` → `{ supported: process.platform !== 'win32', hosts: sshHosts(<~/.ssh/config text or ''>), current: prefs.host }`.
- `cleanup.start` → `{ ok: false, reason: 'Cleanup works on this computer only' }` when remote. The track timer skips when remote (cleanup-only data).
- `process.explain`: `processPath` runs `ps` through `machine.deps.run`; pass `host` to `buildPrompt`.
- `seams` gains `remoteSampler` so tests can inject a fake.
- `deactivate()` closes the remote deps.

### `src/explain.ts`

- `ExplainInput` gains optional `host`; when set (and passes `HOST_RE`), the prompt says the process runs on the remote Linux machine reachable as `ssh <host>`, and asks the agent to inspect it there.

### Panel (`panel/app.js`, `panel/style.css`)

- `prefs.host` (default `''`), persisted like other prefs and sent in `prefs.sync`.
- Settings: new first section **Machine** with a dropdown (native `<select>` styled like the existing controls) of "This computer" + `hosts.list` aliases, fetched when Settings opens. Hidden when `supported` is false. Hint line: "Linux machines in ~/.ssh/config, key login".
- Footer: when remote, a small chip with the host name (title "Showing <host> over SSH"); clicking it opens Settings.
- `stats.read` returning `error`: render one centered message with the error text in place of the sections; keep polling.
- Hide the broom while remote.
- Reset to defaults sets `host` back to `''`.

### Docs and version

- `README.md`: new "Remote machines" section (how to pick one, needs key-based `ssh <alias>` working from the Orca machine, Linux only, cleanup local only, uses one shared SSH connection). Fix "It makes no network connections" → "It makes no network connections, except SSH to a machine you pick under Settings → Machine."
- `orca-plugin.json` version `1.2.0`. Catalog entry is updated at ship time (`orca plugin release-entry`), not in this change.

## Tests (`tests/remote.test.mjs`, plus updates)

- Batching: N parallel `read`s in one tick → exactly one spawn; contents with `\0`, newlines and a fake mark-looking string are returned intact; `list` and `readlink` in the same batch.
- Failure: spawn exit 255 + stderr → reads resolve `''`, `error()` set; next success clears it.
- `run`: exit codes 0 / 1 (with and without `anyExit`) / 255.
- Quoting: a path with `'` survives.
- `sshHosts`, `parseProcStatCpus`, `parseStatF`, `parseKill` fixtures.
- `sshDeps('-oProxyCommand=x')` throws.
- Remote sampler with fake spawn: read succeeds with Linux fixtures; a failed batch makes `read()` reject (no local `osMemory` fallback).
- `sampler.test.mjs`: async `cpus` works.
- `worker.test.mjs`: switching host via `prefs.sync` swaps samplers (fake `seams.remoteSampler`), `stats.read` passes `host`, an error becomes `{ error }`, `cleanup.start` refuses when remote.

## Verification on a real machine

- On a Linux host with key-based `ssh <alias>` (loopback works too): build `createRemoteSampler('<alias>')`, read 5 samples 1s apart with processes and details on, and compare memory, core count, process count and disk total with `free -b`, `nproc`, `ps -e` and `df -B1 ~`. Count ssh spawns per second.
- An unknown alias returns the ssh error text and no numbers.
- In Orca on another computer: load the folder as a development plugin, pick the host in Settings → Machine, and check the All tab, the host chip, the hidden broom, Quit on an own process (ok), on a gone pid ("Already gone") and on a root process ("Not allowed"), and the switch back to This computer (no ssh master left in `/tmp/orca-am-*`).

## Risks

- `ControlMaster=auto` race on first connect: mitigated by the single warm-up exec.
- Very large process tables (>2000 pids) split into several execs per poll; still bounded.
- `stat -f -c` is GNU coreutils; BusyBox `stat` also supports `-f -c` with `%S %b %f %a`.

## Rollback

Single plugin release; reinstall 1.1.2 from the catalog.
