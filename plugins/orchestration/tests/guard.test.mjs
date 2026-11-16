import test from 'node:test'
import assert from 'node:assert/strict'
import { matchGuard } from '../src/guard.ts'

const rule = (command) => {
  const hit = matchGuard('Bash', { command })
  return hit ? hit.rule : null
}

const TABLE = [
  ['gh pr merge 4547 --squash', 'merge'],
  ['gh pr merge --auto 12', 'merge'],
  ['cd x && gh pr merge 1', 'merge'],
  ['bash -c "gh pr merge 1"', 'merge'],
  ['GH_TOKEN=x gh pr merge 1', 'merge'],
  ['gh api -X PUT repos/o/r/pulls/1/merge', 'merge'],
  ['gh api --method PUT /repos/o/r/pulls/1/merge', 'merge'],
  ["gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", 'merge'],
  ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'", 'merge'],
  ['ao pr merge 1', 'merge'],
  ['git push --force', 'force-push'],
  ['git push -f origin feat/x', 'force-push'],
  ['git push --force-with-lease', 'force-push'],
  ['git push --force-if-includes origin x', 'force-push'],
  ['git push origin +feat/x', 'force-push'],
  ['git push --mirror', 'force-push'],
  ['git push --all', 'force-push'],
  ['git -C /repo push -f', 'force-push'],
  ['git push origin main', 'push-main'],
  ['git push origin HEAD:main', 'push-main'],
  ['git push origin feat/x:master', 'push-main'],
  ['git push origin :main', 'push-main'],
  ['git push origin feat/x', null],
  ['git push -u origin feat/x', null],
  ['echo "gh pr merge"', null],
  ['gh pr view 1 --json mergeable', null],
  ['gh api repos/o/r/pulls/1/merge', null],
  ['git log --all', null]
]

for (const [command, want] of TABLE) {
  test(`table: ${command} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

test('table: a non-shell tool is never matched', () => {
  assert.equal(matchGuard('Edit', { command: 'gh pr merge 1' }), null)
})

test('table: a shell call without a command is never matched', () => {
  assert.equal(matchGuard('Bash', {}), null)
})

const MESSAGE = "git commit -F - <<'EOF'\nthe repo's rule: never git push origin main\nEOF\n"

const PORTED = [
  ['feature branch pushes are allowed', 'git push', null],
  ['feature branch pushes are allowed', 'git push -u origin feat/thing', null],
  ['feature branch pushes are allowed', 'git push origin HEAD', null],
  ['feature branch pushes are allowed', 'git push origin HEAD:refs/heads/feat/thing', null],
  ['feature branch pushes are allowed', 'git push -o ci.skip origin feat/thing', null],
  ['branch names that only contain main are allowed', 'git push', null],
  ['branch names that only contain main are allowed', 'git push origin maintenance', null],
  ['branch names that only contain main are allowed', 'git push origin fix-main-nav', null],
  ['explicit push to main is denied', 'git push origin main', 'push-main'],
  ['explicit push to main is denied', 'git push origin master', 'push-main'],
  ['explicit push to main is denied', 'git push origin HEAD:main', 'push-main'],
  ['explicit push to main is denied', 'git push origin feat/thing:refs/heads/main', 'push-main'],
  ['explicit push to main is denied', 'git push origin feat/thing main', 'push-main'],
  ['implicit push from main needs the current branch, which a pure matcher cannot see', 'git push', null],
  ['implicit push from main needs the current branch, which a pure matcher cannot see', 'git push -u origin HEAD', null],
  ['implicit push from main needs the current branch, which a pure matcher cannot see', 'git push origin', null],
  ['the directory followed needs the current branch, which a pure matcher cannot see', 'git -C /tmp/on_main push', null],
  ['the directory followed needs the current branch, which a pure matcher cannot see', 'cd /tmp/on_main && git push', null],
  ['the directory followed needs the current branch, which a pure matcher cannot see', 'git -C /tmp/on_feature push', null],
  ['the directory followed needs the current branch, which a pure matcher cannot see', 'cd /tmp/on_feature && git push', null],
  ['force and sweeping pushes are denied', 'git push --force origin feat/thing', 'force-push'],
  ['force and sweeping pushes are denied', 'git push -f', 'force-push'],
  ['force and sweeping pushes are denied', 'git push -uf origin feat/thing', 'force-push'],
  ['force and sweeping pushes are denied', 'git push --force-with-lease origin feat/thing', 'force-push'],
  ['force and sweeping pushes are denied', 'git push origin +feat/thing', 'force-push'],
  ['force and sweeping pushes are denied', 'git push --all origin', 'force-push'],
  ['force and sweeping pushes are denied', 'git push --mirror', 'force-push'],
  ['force and sweeping pushes are denied, a deleted branch counts as a force-push', 'git push origin :feat/thing', 'force-push'],
  ['force and sweeping pushes are denied, a deleted branch counts as a force-push', 'git push --delete origin feat/thing', 'force-push'],
  ['force and sweeping pushes are denied, --prune deletes remote branches', 'git push --prune origin', 'force-push'],
  ['wrappers and chains are seen', 'git add -A && git commit -m x && git push origin main', 'push-main'],
  ['wrappers and chains are seen', 'GIT_TERMINAL_PROMPT=0 git push origin main', 'push-main'],
  ['wrappers and chains are seen', 'command git push origin main', 'push-main'],
  ['wrappers and chains are seen', 'git -c push.default=upstream push origin main', 'push-main'],
  ['wrappers and chains are seen', 'git status\ngit push origin main', 'push-main'],
  ['text that mentions a push is allowed', "git commit -m 'never git push origin main'", null],
  ['text that mentions a push is allowed', "echo 'git push --force'", null],
  ['text that mentions a push is allowed', 'git log --grep push', null],
  ['text that mentions a push is allowed', 'git fetch origin main', null],
  ['text that mentions a push is allowed', 'git merge origin/main', null],
  ['heredoc bodies are not commands', MESSAGE + 'git push origin feat/thing', null],
  ['heredoc bodies are not commands', MESSAGE + 'git push', null],
  ['heredoc bodies are not commands', MESSAGE + 'git push origin main', 'push-main'],
  ['heredoc bodies are not commands, the on-main variant needs the current branch', MESSAGE + 'git push', null],
  ['heredoc bodies are not commands', "cat > notes.md <<EOF\ndon't git push --force\nEOF", null],
  ['unparseable push fails closed', "git push origin main 'unterminated", 'push-main'],
  ['unrelated commands produce no output', 'ls -la', null],
  ['unrelated commands produce no output', 'npm run push-assets', null]
]

for (const [name, command, want] of PORTED) {
  test(`ported, ${name}: ${JSON.stringify(command)} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

const ADVERSARIAL = [
  ['echo "$(gh pr merge 1)"', 'merge'],
  ["echo '$(gh pr merge 1)'", null],
  ['echo `gh pr merge 1`', 'merge'],
  ['X=$(git push --force)', 'force-push'],
  ['eval "gh pr merge 1"', 'merge'],
  ["eval 'git push' '-f'", 'force-push'],
  ['git push \\\n  --force origin feat/x', 'force-push'],
  ['gh pr \\\nmerge 1', 'merge'],
  ['echo 1 | xargs gh pr merge', 'merge'],
  ['echo merge 1 | xargs gh pr', 'merge'],
  ['xargs -n 1 -I{} gh pr merge {} < prs.txt', 'merge'],
  ['git -c user.name=x push -f', 'force-push'],
  ['git -c k=v --no-pager push --force origin feat/x', 'force-push'],
  ['GIT_DIR=/r/.git git push --force', 'force-push'],
  ['FOO=1 BAR=2 git push --force', 'force-push'],
  ['git push -fu origin feat/x', 'force-push'],
  ['git push origin -- +feat/x', 'force-push'],
  ['git push origin main --force', 'force-push'],
  ['git push -f origin main', 'force-push'],
  ['ls && gh pr merge 1', 'merge'],
  ['true || gh pr merge 1', 'merge'],
  ['ls; gh pr merge 1 &', 'merge'],
  ['(cd x; gh pr merge 1)', 'merge'],
  ['{ gh pr merge 1; }', 'merge'],
  ['if true; then gh pr merge 1; fi', 'merge'],
  ['for i in 1 2; do gh pr merge $i; done', 'merge'],
  ['sh -c "git push --force"', 'force-push'],
  ["zsh -c 'git push origin main'", 'push-main'],
  ["bash -lc 'gh pr merge 1'", 'merge'],
  ["bash -o pipefail -c 'gh pr merge 1'", 'merge'],
  ['bash -c "bash -c \'gh pr merge 1\'"', 'merge'],
  ['sudo -u bot gh pr merge 1', 'merge'],
  ['env -i PATH=/bin gh pr merge 1', 'merge'],
  ['env -u HOME gh pr merge 1', 'merge'],
  ["env -S 'gh pr merge 1'", 'merge'],
  ['time -p gh pr merge 1', 'merge'],
  ['nice -n 5 git push --force', 'force-push'],
  ['nohup gh pr merge 1', 'merge'],
  ['timeout 30 gh pr merge 1', 'merge'],
  ['exec git push --force', 'force-push'],
  ['/usr/local/bin/gh pr merge 1', 'merge'],
  ['\\gh pr merge 1', 'merge'],
  ['"gh" "pr" "merge" 1', 'merge'],
  ["g''h pr me\"rge\" 1", 'merge'],
  ['$(echo gh) pr merge 1', 'merge'],
  ['"$(which git)" push --force', 'force-push'],
  ['X=merge; gh pr $X 1', 'merge'],
  ['export M=merge && gh pr "${M}" 1', 'merge'],
  ['P="pr merge"; gh $P 1', 'merge'],
  ['G=git; $G push --force', 'force-push'],
  ['echo "gh pr merge 1" | bash', 'merge'],
  ["printf 'git push --force' | sh -s", 'force-push'],
  ['bash <<EOF\ngh pr merge 1\nEOF', 'merge'],
  ["cat <<'EOF' | sh\ngit push origin main\nEOF", 'push-main'],
  ["bash <<< 'gh pr merge 1'", 'merge'],
  ['bash <(echo gh pr merge 1)', 'merge'],
  ['source <(echo git push --force)', 'force-push'],
  ['diff <(gh pr merge 1) x', 'merge'],
  ['cat <<< EOF\ngit push --force\nEOF', 'force-push'],
  ['echo "<<X"\ngit push --force\nX', 'force-push'],
  ['echo "${X:-$(gh pr merge 1)}"', 'merge'],
  ['find . -name x -exec gh pr merge 1 \\;', 'merge'],
  ["git -c alias.fp='push --force' fp", 'force-push'],
  ["git -c alias.m='!gh pr merge 1' m", 'merge'],
  ["git config alias.pm 'push origin main' && git pm", 'push-main'],
  ["gh alias set mm 'pr merge' && gh mm 1", 'merge'],
  ["alias m='gh pr merge'; m 1", 'merge'],
  ['f() { gh pr merge 1; }; f', 'merge'],
  ['gh -R o/r pr merge 1', 'merge'],
  ['gh pr -R o/r merge 1', 'merge'],
  ['gh pr merge', 'merge'],
  ['gh api repos/o/r/pulls/1/merge -f merge_method=squash', 'merge'],
  ['gh api -XPUT repos/o/r/pulls/1/merge', 'merge'],
  ['gh api --method=put repos/o/r/pulls/1/merge', 'merge'],
  ["gh api 'repos/{owner}/{repo}/pulls/1/merge' -X PUT", 'merge'],
  ['gh api -X POST repos/o/r/merges -f base=main -f head=feat', 'merge'],
  ['gh api -X PATCH repos/o/r/git/refs/heads/main -F sha=abc -F force=true', 'push-main'],
  ['gh api graphql -F query=@q.graphql -f q2="mutation{enqueuePullRequest(input:{}){clientMutationId}}"', 'merge'],
  ['gh api graphql -f query="mutation { mergeBranch(input: {}) { clientMutationId } }"', 'merge'],
  ['curl -X PUT -H "Authorization: token t" api.github.com/repos/o/r/pulls/1/merge', 'merge'],
  ['curl -sS --request=PUT api.github.com/repos/o/r/pulls/1/merge', 'merge'],
  ["curl -d '{\"merge_method\":\"squash\"}' api.github.com/repos/o/r/pulls/1/merge", 'merge'],
  ["curl api.github.com/graphql -d '{\"query\":\"mutation { mergePullRequest(input: {}) { clientMutationId } }\"}'", 'merge'],
  ['glab mr merge 3', 'merge'],
  ['git push --forc origin feat/x', 'force-push'],
  ['git push --mirr', 'force-push'],
  ['git push --del origin feat/x', 'force-push'],
  ['git push --delete origin main', 'push-main'],
  ['git push -d origin master', 'push-main'],
  ['git push origin "+refs/heads/*:refs/heads/*"', 'force-push'],
  ["git push origin 'refs/heads/*:refs/heads/*'", 'push-main'],
  ['git push origin :', 'push-main'],
  ['git push origin +HEAD:main', 'force-push'],
  ['git push origin refs/heads/master', 'push-main'],
  ['git push origin @:main', 'push-main'],
  ['git -c remote.origin.mirror=true push origin', 'force-push'],
  ["git -c 'remote.origin.push=+refs/heads/*:refs/heads/*' push origin", 'force-push'],
  ['git -c push.default=matching push origin', 'push-main'],
  ['git send-pack --force origin feat/x', 'force-push'],
  ['gh pr merge$IFS 1', 'merge'],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0="push -f" git x', 'force-push'],
  ['x=gh; y=pr; $x $y merge 1', 'merge'],
  ['git push origin "$(echo main)"', 'push-main'],
  ['git push origin ma""in', 'push-main'],
  ['git push -- origin main', 'push-main'],
  ['while gh pr merge 1; do :; done', 'merge'],
  ['sudo -E git push -f', 'force-push'],
  ['git push origin feat/x 2>&1 | tail -5', null],
  ['git push origin feat/x >/dev/null 2>&1 && gh pr merge 1', 'merge'],
  ['echo hi #; gh pr merge 1', null],
  ['echo "x" ; gh pr merge 1 # merge it', 'merge']
]

for (const [command, want] of ADVERSARIAL) {
  test(`adversarial: ${JSON.stringify(command)} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

const HARMLESS = [
  'gh pr view 1',
  'gh pr list --state merged',
  'gh pr checks 12 --watch',
  'gh pr create --title "merge the thing" --body "do not gh pr merge"',
  'gh api repos/o/r/pulls/1/merge --method GET',
  'gh api repos/o/r/pulls/1',
  'gh api graphql -f query="query { repository(owner: \\"o\\", name: \\"r\\") { pullRequest(number: 1) { mergeable } } }"',
  'curl api.github.com/repos/o/r/pulls/1/merge',
  'grep -rn "gh pr merge" .',
  "rg 'git push --force' docs",
  'git log --all --oneline',
  'git branch -a',
  'git checkout main',
  'git pull origin main',
  'git push --follow-tags origin feat/x',
  'git push --dry-run origin feat/x',
  'git push --porcelain origin feat/x',
  'git push --recurse-submodules=check origin feat/x',
  'git push -o ci.skip origin feat/x',
  'git push --no-verify origin feat/x',
  'git push --no-force-with-lease origin feat/x',
  'git push origin feat/x:feat/x',
  'git push origin main:feat/x',
  'git push origin feat/main',
  'git push origin mainline',
  'git push origin v1.2.3',
  'git commit -m "gh pr merge 1 && git push --force"',
  "echo 'eval gh pr merge 1'",
  'printf "%s\\n" "git push -f"',
  'cat <<EOF > notes.md\ngh pr merge 1\ngit push --force\nEOF',
  'python3 -c \'print("gh pr merge")\'',
  'command -v gh',
  'which git',
  'npm run merge',
  'make push'
]

for (const command of HARMLESS) {
  test(`harmless: ${JSON.stringify(command)} -> null`, () => {
    assert.equal(rule(command), null)
  })
}

test('other shell tool names are inspected', () => {
  assert.equal(matchGuard('shell', { command: 'gh pr merge 1' })?.rule, 'merge')
  assert.equal(matchGuard('run_shell_command', { command: 'git push -f' })?.rule, 'force-push')
})

test('the hit carries the command that was checked', () => {
  assert.deepEqual(matchGuard('Bash', { command: 'cd x && gh pr merge 1' }), { rule: 'merge', command: 'cd x && gh pr merge 1' })
})

test('odd inputs are never matched and never throw', () => {
  assert.equal(matchGuard('Bash', null), null)
  assert.equal(matchGuard('Bash', 'gh pr merge 1'), null)
  assert.equal(matchGuard('Bash', { command: 42 }), null)
  assert.equal(matchGuard('Bash', { command: '' }), null)
  assert.equal(matchGuard('Edit', null), null)
})

test('an argv array command is inspected', () => {
  assert.equal(matchGuard('shell', { command: ['bash', '-lc', 'gh pr merge 1'] })?.rule, 'merge')
  assert.equal(matchGuard('shell', { command: ['git', 'status'] }), null)
})

test('deep nesting fails safe and fast', () => {
  let nested = 'gh pr merge 1'
  for (let i = 0; i < 40; i++) nested = `echo "$(${nested})"`
  const started = Date.now()
  assert.equal(rule(nested), 'merge')
  let shells = 'git push --force'
  for (let i = 0; i < 12; i++) shells = `bash -c ${JSON.stringify(shells)}`
  assert.equal(rule(shells), 'force-push')
  assert.ok(Date.now() - started < 1000)
})

test('a huge command returns quickly without throwing', () => {
  const big = 'echo ' + 'a'.repeat(50000) + ' && git push origin main'
  const started = Date.now()
  assert.equal(rule(big), 'push-main')
  assert.equal(rule('echo "' + 'x'.repeat(50000)), null)
  assert.equal(rule('$('.repeat(5000) + 'gh pr merge 1'), 'merge')
  assert.ok(Date.now() - started < 1000)
})

const COMMIT = "git commit -m \"$(cat <<'EOF'\nFix the parser. Don't drop rows.\nEOF\n)\""
const CREATE = "gh pr create --title \"x\" --body \"$(cat <<'EOF'\nThis doesn't merge anything.\nEOF\n)\""

const HEREDOCS = [
  [COMMIT + ' && git push -u origin feat/x', null],
  [CREATE, null],
  [COMMIT + ' && git push --force', 'force-push'],
  [CREATE + ' && gh pr merge 1', 'merge'],
  ["git commit -m \"$(cat <<'EOF'\nNotes:\ngit push --force\ngh pr merge 1\nEOF\n)\"", null],
  ["git commit -F - <<'EOF'\nNotes:\ngit push --force\ngh pr merge 1\nEOF", null],
  ['git commit -m "$(cat <<EOF\nWe don\'t push.\nEOF\n)" && git push origin feat/x', null],
  ['git commit -m "$(cat <<"EOF"\nIt\'s fine.\nEOF\n)"', null],
  ["git commit -m \"$(cat <<-'EOF'\n\tIt's fine.\n\tEOF\n)\" && git push origin feat/x", null],
  ["git commit -m \"$(cat <<'EOF'\nIt's fine.\nEOF)\"", null],
  ["git commit -m `cat <<'EOF'\nIt's a ` backtick (and $( paren.\nEOF\n`", null],
  ["git commit -m \"$(cat <<'EOF'\nOdd ' quote, \" quote, ` tick, $( paren and ) close.\nEOF\n)\" && git push origin feat/x", null],
  ["cat <<'EOF' > notes.md\nOdd ' quote, \" quote, ` tick, $( paren.\nEOF", null],
  ['echo "$(cat <<< \'x\')" && gh pr merge 1', 'merge'],
  ['echo $((1 << 2)) && git push origin feat/x', null],
  ['echo "$((1 << 2))" && gh pr merge 1', 'merge'],
  ["bash <<'EOF'\ngh pr merge 1\nEOF", 'merge'],
  ["sh -s <<EOF\ngit push --force\nEOF", 'force-push'],
  ["zsh <<'EOF'\ngit push origin main\nEOF", 'push-main'],
  ["cat <<'EOF' | bash\ngh pr merge 1\nEOF", 'merge'],
  ['git commit -F - <<EOF', null],
  ["git commit -F - <<'EOF'\nIt's a note.", null],
  ['cat <<EOF\ngh pr merge 1', 'merge'],
  ["git commit -m \"$(cat <<'EOF'\ngh pr merge 1\n)\"", 'merge']
]

for (const [command, want] of HEREDOCS) {
  test(`heredoc: ${JSON.stringify(command)} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

const WRAPPERS = [
  ['rtk gh pr merge 1', 'merge'],
  ['op run -- gh pr merge 1', 'merge'],
  ['direnv exec . git push --force', 'force-push'],
  ['doppler run -- gh pr merge 1', 'merge'],
  ['timeout 30 git push -f', 'force-push'],
  ['rtk ao pr merge 1', 'merge'],
  ['G=gh; rtk $G pr merge 1', 'merge'],
  ['echo gh pr merge 1', null],
  ['grep -r "git push --force" .', null],
  ['git commit -m "gh pr merge"', null],
  ["rg 'gh pr merge' docs", null],
  ["printf '%s' \"git push -f\"", null],
  ['man git push', null],
  ['which gh', null],
  ['brew install gh', null],
  ['cat notes-about-git-push.md', null],
  ['rtk git status', null],
  ["python3 x.py --msg \"$(cat <<'EOF'\ngh pr merge 1\nEOF\n)\"", null],
  ['python3 x.py --msg "$(echo gh pr merge 1)"', null]
]

for (const [command, want] of WRAPPERS) {
  test(`wrapper: ${JSON.stringify(command)} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

const ON_MAIN = [
  ['git checkout main && git merge feat/x && git push', 'push-main'],
  ['git switch main && git merge feat/x && git push', 'push-main'],
  ['git checkout master; git merge feat/x; git push origin', 'push-main'],
  ['git switch master && git push origin HEAD', 'push-main'],
  ['git checkout main\ngit merge feat/x\ngit push -u origin HEAD', 'push-main'],
  ['git checkout main && git pull', null],
  ['git checkout -b main-fix && git push -u origin main-fix', null],
  ['git checkout main -- README.md && git push origin feat/x', null],
  ['git checkout main -- README.md && git push', null],
  ['git switch -c feat main && git push', null],
  ['git checkout -b feat origin/main && git push', null],
  ['git checkout main && git checkout feat/x && git push', null],
  ['git checkout main && git checkout -b feat/y main && git push', null],
  ['git checkout main && git switch -c feat/y && git push', null],
  ['git checkout -- main && git push', null],
  ['git checkout main && git checkout -- main && git push', 'push-main'],
  ['git switch -c main && git push', 'push-main'],
  ['git checkout main || git push', null],
  ['git checkout main && git push origin feat/x', null],
  ['git push', null]
]

for (const [command, want] of ON_MAIN) {
  test(`checkout then push: ${JSON.stringify(command)} -> ${want}`, () => {
    assert.equal(rule(command), want)
  })
}

test('a non-shell tool whose name merges a pull request is matched by name', () => {
  assert.deepEqual(matchGuard('mcp__github__merge_pull_request', { pullNumber: 1 }), { rule: 'merge', command: 'mcp__github__merge_pull_request' })
  assert.equal(matchGuard('mcp__gh__MergePullRequest', {})?.rule, 'merge')
  assert.equal(matchGuard('mcp__forge__pr_merge', null)?.rule, 'merge')
  assert.equal(matchGuard('mcp__github__enable_auto_merge', {})?.rule, 'merge')
  for (const tool of ['mcp__github__get_pull_request', 'mcp__github__create_pull_request', 'Edit', 'Read']) {
    assert.equal(matchGuard(tool, { command: 'gh pr merge 1' }), null, tool)
  }
})

test('a 100 KB command with heredocs returns quickly', () => {
  const body = "Don't ' stop `here` $( now.\n".repeat(4000)
  const big = "git commit -m \"$(cat <<'EOF'\n" + body + "EOF\n)\" && git push -u origin feat/x"
  assert.ok(big.length > 100000)
  const started = Date.now()
  assert.equal(rule(big), null)
  assert.equal(rule(big + ' && gh pr merge 1'), 'merge')
  assert.equal(rule('echo "$(' + 'cat <<E '.repeat(13000) + ')"'), null)
  assert.equal(rule('<<'.repeat(50000) + '\ngh pr merge 1'), 'merge')
  const elapsed = Date.now() - started
  console.log(`100 KB heredoc timing: ${elapsed} ms`)
  assert.ok(elapsed < 2000)
})

test('package runners, ssh, docker exec and a substituted bash -c script are inspected', () => {
  const cases = [
    ['npx gh pr merge 1', 'merge'],
    ['npx -y gh pr merge 1', 'merge'],
    ['npx -p gh gh pr merge 1', 'merge'],
    ['npx -c "gh pr merge 1"', 'merge'],
    ['pnpm dlx gh pr merge 1', 'merge'],
    ['bunx gh pr merge 1', 'merge'],
    ['nice nohup exec git push --force', 'force-push'],
    ['ssh h "git push --force"', 'force-push'],
    ['ssh -p 22 -i key user@h git push origin main', 'push-main'],
    ['docker exec c git push -f', 'force-push'],
    ['docker exec -it -w /repo c gh pr merge 1', 'merge'],
    ['docker container exec c git push origin main', 'push-main'],
    ['bash -c "$(echo gh pr merge 1)"', 'merge'],
    ['bash -c "git push $(echo --force)"', 'force-push'],
    ['S="gh pr merge 1"; bash -c "$S"', 'merge'],
    ['bash -c "$(gh pr merge 1)"', 'merge'],
    ['ssh h "git status"', null],
    ['ssh h', null],
    ['docker exec c git log', null],
    ['docker ps', null],
    ['npx prettier --write .', null],
    ['pnpm install', null],
    ['bash -c "$(echo git status)"', null],
    ["bash -c 'echo $1' x y", null]
  ]
  for (const [command, expected] of cases) assert.equal(rule(command), expected, command)
})

const timed = (command) => {
  const started = performance.now()
  const found = rule(command)
  return { found, elapsed: performance.now() - started }
}

const randomWords = (size) => {
  const pool = ['alpha', 'gh', 'git', 'ao', 'zz', 'echo', 'x', 'pr', 'push', 'merge', 'main', '-f', 'rtk', 'op']
  let seed = 7
  let out = ''
  while (out.length < size) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    out += pool[seed % pool.length] + ' '
  }
  return out
}

const SLOW = [
  ['repeated gh after an unknown wrapper', 'zz ' + 'gh '.repeat(30000)],
  ['repeated git after an unknown wrapper', 'zz ' + 'git '.repeat(30000)],
  ['100 KB of random words', randomWords(100000)],
  ['100 KB of separated echo hi', 'echo hi;'.repeat(12500)],
  ['100 KB of nested substitutions', '$('.repeat(50000)]
]

for (const [name, command] of SLOW) {
  test(`linear time: ${name} returns in under 500 ms`, () => {
    assert.ok(command.length >= 90000)
    const { elapsed } = timed(command)
    console.log(`${name}: ${elapsed.toFixed(1)} ms`)
    assert.ok(elapsed < 500, `${elapsed} ms`)
  })
}

test('linear time: a merge behind many repeated gh words is still caught', () => {
  const { found, elapsed } = timed('zz ' + 'gh '.repeat(30000) + 'pr merge 1')
  assert.notEqual(found, null)
  assert.equal(found, 'merge')
  assert.ok(elapsed < 500, `${elapsed} ms`)
})

test('linear time: everyday wrappers and quoted text keep their verdicts', () => {
  const cases = [
    ['rtk gh pr merge 1', 'merge'],
    ['op run -- gh pr merge 1', 'merge'],
    ['timeout 30 git push -f', 'force-push'],
    ['echo gh pr merge 1', null],
    ['grep -r "git push --force" .', null],
    ['git commit -m "gh pr merge"', null],
    [COMMIT + ' && git push -u origin feat/x', null],
    [CREATE, null],
    ['zz a b c d e f g h i gh pr merge 1', 'merge'],
    ['zz gh gh gh gh gh gh gh gh gh gh pr view 1', null]
  ]
  for (const [command, expected] of cases) assert.equal(rule(command), expected, command)
})
