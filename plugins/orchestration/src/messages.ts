import type { PrState } from './github.ts'
import type { RouteEvent } from './events.ts'

const CLOSING = 'Fix it, push, and do not merge. Start any reply you post on the PR with [agent].'

function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function finish(lines: string[]): string {
  return [...lines, '', CLOSING].join('\n')
}

export function messageFor(ev: RouteEvent, pr: PrState, extra: { logs?: { check: string; tail: string }[] }): { subject: string; body: string } {
  const n = ev.pr
  switch (ev.kind) {
    case 'ci': {
      const lines = [`CI failed on #${n}: ${pr.url}`, `Head commit: ${ev.sha}`]
      if (ev.checks.length > 0) lines.push('', 'Failed checks:', ...ev.checks.map((c) => `- ${c.name}: ${c.url ?? 'no link'}`))
      for (const log of extra.logs ?? []) {
        const f = fence(log.tail)
        lines.push('', `Log tail for ${log.check}:`, f, log.tail, f)
      }
      return { subject: `CI failed on #${n}`, body: finish(lines) }
    }
    case 'thread': {
      const c = ev.comment
      return {
        subject: `Review comment on #${n}`,
        body: finish([
          `Review comment on #${n}: ${pr.url}`,
          `File: ${c.path ?? 'none'}`,
          `Line: ${c.line ?? 'none'}`,
          `From: ${c.author}`,
          '',
          c.body,
          '',
          `URL: ${c.url}`,
          '',
          `Resolve it when fixed: gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: "${ev.threadId}" }) { thread { isResolved } } }'`
        ])
      }
    }
    case 'review': {
      const r = ev.review
      const verb = r.state === 'CHANGES_REQUESTED' ? 'requested changes' : 'left a review'
      return {
        subject: `Review on #${n}`,
        body: finish([`${r.author} ${verb} on #${n}: ${pr.url}`, '', r.body, '', `URL: ${r.url}`])
      }
    }
    case 'comment': {
      const c = ev.comment
      return {
        subject: `Comment on #${n}`,
        body: finish([`${c.author} commented on #${n}: ${pr.url}`, '', c.body, '', `URL: ${c.url}`])
      }
    }
    case 'bot-batch': {
      const lines = [`${ev.items.length} bot comments on #${n}: ${pr.url}`]
      for (const item of ev.items) lines.push('', `${item.author} (${item.url}):`, item.body)
      return { subject: `Bot comments on #${n}`, body: finish(lines) }
    }
    case 'conflict':
      return {
        subject: `Merge conflict on #${n}`,
        body: finish([
          `PR #${n} has merge conflicts with ${ev.base}: ${pr.url}`,
          '',
          `Bring origin/${ev.base} into this branch with a merge and resolve the conflicts.`,
          '- Start with git status. If a merge is already in progress, continue from it.',
          `- Fetch origin/${ev.base}, then merge it. Do not rebase and do not force-push.`,
          '- If unrelated staged or unstaged changes would be overwritten, stop and say so.',
          '- Resolve each file by reading both sides and the code around them. Do not take ours or theirs wholesale unless that is clearly right.',
          '- Do not run git reset --hard, git checkout ., git restore ., git stash or any abort command.',
          '- Remove every conflict marker, stage each resolved path, then run git merge --continue.',
          '- Run git diff --check and any quick tests or typechecks that cover the files you touched.',
          '- Push the merge commit when it is clean.'
        ])
      }
  }
}
