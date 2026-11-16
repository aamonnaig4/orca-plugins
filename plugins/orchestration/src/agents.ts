import type { Deps } from './deps.ts'

export type AgentEntry = { id: string; label: string; cmd: string; installed: boolean }

export const AGENT_CATALOG: { id: string; label: string; cmd: string }[] = [
  { id: 'claude', label: 'Claude', cmd: 'claude' },
  { id: 'codex', label: 'Codex', cmd: 'codex' },
  { id: 'grok', label: 'Grok', cmd: 'grok' },
  { id: 'gemini', label: 'Gemini', cmd: 'gemini' },
  { id: 'antigravity', label: 'Antigravity', cmd: 'agy' },
  { id: 'cursor', label: 'Cursor', cmd: 'cursor-agent' },
  { id: 'copilot', label: 'Copilot', cmd: 'copilot' },
  { id: 'opencode', label: 'OpenCode', cmd: 'opencode' },
  { id: 'opencode2', label: 'OpenCode 2', cmd: 'opencode2' },
  { id: 'aider', label: 'Aider', cmd: 'aider' },
  { id: 'goose', label: 'Goose', cmd: 'goose' },
  { id: 'kimi', label: 'Kimi', cmd: 'kimi' },
  { id: 'droid', label: 'Droid', cmd: 'droid' },
  { id: 'pi', label: 'Pi', cmd: 'pi' },
  { id: 'omp', label: 'Oh My Pi', cmd: 'omp' },
  { id: 'qwen', label: 'Qwen', cmd: 'qwen' },
  { id: 'amp', label: 'Amp', cmd: 'amp' },
  { id: 'cline', label: 'Cline', cmd: 'cline' },
  { id: 'devin', label: 'Devin', cmd: 'devin' },
  { id: 'hermes', label: 'Hermes', cmd: 'hermes' }
]

export async function detectAgents(deps: Deps): Promise<AgentEntry[]> {
  const script = AGENT_CATALOG.map((a) => `command -v ${a.cmd} >/dev/null 2>&1 && echo "ok ${a.cmd}"`).join('\n')
  const res = await deps.run('/bin/zsh', ['-lc', script])
  const found = new Set<string>()
  for (const line of res.stdout.split('\n')) {
    const m = /^ok (\S+)\s*$/.exec(line)
    if (m) found.add(m[1])
  }
  const entries = AGENT_CATALOG.map((a) => ({ ...a, installed: found.has(a.cmd) }))
  return [...entries.filter((e) => e.installed), ...entries.filter((e) => !e.installed)]
}
