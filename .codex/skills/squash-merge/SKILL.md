---
name: squash-merge
description: Merge the current PR with a subject-only message through GitHub's policy gate, binding supplied review SHAs, then return to the PR's base branch, fast-forward it, delete the merged branch, sweep merged worktrees, and retire the current worktree
---

# Reviewed Merge (`squash-merge` compatibility)

Merge the open PR for the current branch with a **subject-only** commit
message — no auto-generated body, commit list, or extended message. The subject
is validated against the repository's own commitlint configuration before the
merge runs, and the tool appends the PR reference `(#<pr>)` so the merge
commit ends with it — the same reference GitHub adds for web/default merges but
that `gh pr merge --subject` otherwise suppresses.

Once the PR is confirmed `MERGED`, return to the PR's base branch, fast-forward
it, and delete the merged branch, so a shipped PR leaves no local leftovers.
Linked git worktrees are cleaned up too. A worktree that ran the merge is
removed once its branch is gone. Each merge also sweeps this clone's other
worktrees whose PRs already merged. Agents do not always work in a worktree;
without one, both steps do nothing.

## Arguments

- First argument (optional): the merge commit subject. When omitted, the PR
  title is used. Pass it as a single quoted argument, e.g.
  `"feat(app): add widget"`.
- Second argument (optional): the expected PR head SHA.
- Third argument (optional): the expected PR base SHA. The two SHAs must be
  supplied together. The guarded path requires strict up-to-date policy on the
  base, then uses GitHub's policy-enforcing API when all requirements are already
  clean. Strict policy guards the reviewed base while `--match-head-commit`
  guards the reviewed head. The guarded path never enables delayed auto-merge.
  An unprotected base, non-strict policy, or active merge queue is rejected. A
  moved pair is rejected.
- `--keep-branch` (optional flag, position-independent): skip the post-merge
  cleanup (step 4) and the worktree retirement (step 6), and stay on the
  feature branch. Use when the branch is still needed locally (e.g. to build a
  follow-up PR on top of it).
- `--keep-worktree` (optional flag, position-independent): run the cleanup but
  skip step 6, leaving a linked worktree detached at the base tip. `ship-pr`
  passes it so `reset` can still run in the worktree before `ship-pr` retires
  it.

  **These flags are consumed by this skill and must never reach the tool.** The
  tool takes only the three positionals above — subject, head SHA, base SHA —
  and how a forwarded flag fails depends on where it lands: first, it
  is read as the *subject* and rejected by commitlint; after the positionals
  (the position `ship-pr` forwards), it is **silently ignored**. The silent case
  is the dangerous one — the merge succeeds, the caller believes cleanup was
  skipped, and it ran anyway. Strip the flags from the arguments, let them gate
  steps 4 and 6, and call the tool with the subject and SHA only.

## Prerequisites

- `git`, `gh` (authenticated), POSIX `awk`, `realpath`, and `tar` on `PATH`.
- The `@balebase/agent-tool` package in the PR's base commit. Every tool
  these skills run comes from that base — never from an installation outside
  this repository.
- `node_modules` installed (`bun install`) so repository checks and hooks run.
- An open, mergeable PR on the current branch.

## Setup

Check the branch **before** looking up the PR, so running on the default branch
reports that plainly rather than a confusing "no open PR" error. Resolve the PR
number **before** merging — afterwards the PR is no longer open, so
`gh pr list --state open` will not find it:

```bash
REALPATH_BIN=/usr/bin/realpath
[ -x "$REALPATH_BIN" ] || REALPATH_BIN=/bin/realpath
[ -x "$REALPATH_BIN" ] || {
  echo "Error: trusted system realpath is unavailable" >&2
  exit 1
}
CHECKOUT_ROOT=$("$REALPATH_BIN" .)
while [ ! -e "$CHECKOUT_ROOT/.git" ] && [ "$CHECKOUT_ROOT" != "/" ]; do
  CHECKOUT_ROOT=${CHECKOUT_ROOT%/*}
  [ -n "$CHECKOUT_ROOT" ] || CHECKOUT_ROOT=/
done
[ -e "$CHECKOUT_ROOT/.git" ] || {
  echo "Error: could not find the checkout boundary" >&2
  exit 1
}

resolve_bootstrap_tool() {
  tool_name=${1}
  candidate=$(command -v "$tool_name") || {
    echo "Error: $tool_name is unavailable" >&2
    return 1
  }
  candidate=$("$REALPATH_BIN" "$candidate") || return 1
  case "$candidate" in
    "$CHECKOUT_ROOT" | "$CHECKOUT_ROOT"/*)
      echo "Error: refusing checkout-controlled $tool_name executable" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$candidate"
}

GIT_BIN=$(resolve_bootstrap_tool git) || exit 1
GH_BIN=$(resolve_bootstrap_tool gh) || exit 1
BUN_BIN=$(resolve_bootstrap_tool bun) || exit 1
TAR_BIN=$(resolve_bootstrap_tool tar) || exit 1
PATH="${GIT_BIN%/*}:${GH_BIN%/*}:${BUN_BIN%/*}:${TAR_BIN%/*}:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

# `git worktree remove` deletes ignored files without asking. Only build output
# is known to be disposable; any other ignored file may be the only copy of
# local credentials, Terraform state or variables, or Wrangler's local D1 and
# R2 data, so it keeps the worktree. Names are read NUL-delimited, since git
# quotes unusual ones. Every line is counted rather than stopping at the first,
# so under pipefail an early exit cannot cut the listing short and read as
# clean. A listing git cannot produce, or a count grep cannot make, keeps it.
holds_ignored_state() {
  ignored_kept=$({ git -C "${1}" ls-files -z --others --ignored --exclude-standard ||
    printf 'unlisted\0'; } |
    tr '\0' '\n' |
    grep -cvE '(^|/)(node_modules|\.turbo|dist|\.astro|\.terraform-lint|\.wrangler/tmp)/|\.tsbuildinfo$|(^|/)\.DS_Store$') || :
  [ "$ignored_kept" != 0 ]
}

BRANCH=$(git rev-parse --abbrev-ref HEAD)

# One gh call for both values, split on the space neither a repo slug nor a
# branch name may contain. Guard each: an unauthenticated gh leaves them empty,
# and an empty REPO turns every later lookup into a confusing error.
REPO_INFO=$(gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " " + .defaultBranchRef.name') || { echo "Error: gh repo view failed (authenticated?)" >&2; exit 1; }
REPO=${REPO_INFO%% *}
DEFAULT_BRANCH=${REPO_INFO##* }
[ -n "$REPO" ] || { echo "Error: could not resolve repository" >&2; exit 1; }
[ -n "$DEFAULT_BRANCH" ] || { echo "Error: repository default branch is unavailable" >&2; exit 1; }
[ "$BRANCH" != "$DEFAULT_BRANCH" ] || { echo "Error: on default branch $DEFAULT_BRANCH" >&2; exit 1; }
BASE_REPO_URL=$(gh repo view "$REPO" --json url -q .url) || { echo "Error: could not resolve HTTPS URL for $REPO" >&2; exit 1; }

# Keep the feature branch's push remote separate from the base branch's pull
# remote. On a fork these are different repositories.
FEATURE_REMOTE=$(git config --get "branch.$BRANCH.pushRemote" || git config --get remote.pushDefault || git config --get "branch.$BRANCH.remote" || true)
[ -n "$FEATURE_REMOTE" ] && [ "$FEATURE_REMOTE" != "." ] || { echo "Error: feature branch has no deletion-safe remote" >&2; exit 1; }
FEATURE_REMOTE_URL=$(git remote get-url --push "$FEATURE_REMOTE") || { echo "Error: could not resolve push URL for $FEATURE_REMOTE" >&2; exit 1; }
FEATURE_REPO=$(gh repo view "$FEATURE_REMOTE_URL" --json nameWithOwner -q .nameWithOwner) || { echo "Error: could not resolve GitHub repository for $FEATURE_REMOTE" >&2; exit 1; }
FEATURE_REPO_URL=$(gh repo view "$FEATURE_REPO" --json url -q .url) || { echo "Error: could not resolve HTTPS URL for $FEATURE_REPO" >&2; exit 1; }
PR_LINES=$(gh pr list --head "$BRANCH" --state open --json number,headRepository --template '{{range .}}{{.number}} {{.headRepository.nameWithOwner}}{{"\n"}}{{end}}' -R "$REPO") || { echo "Error: could not list PRs for $BRANCH" >&2; exit 1; }
PR_NUMBER=$(printf '%s\n' "$PR_LINES" | awk -v repository="$FEATURE_REPO" '$(2) == repository { print $(1) }')
[ "$(printf '%s\n' "$PR_NUMBER" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || { echo "Error: expected exactly one open PR from $FEATURE_REPO for branch $BRANCH" >&2; exit 1; }
PR_HEAD_REPO=$(gh pr view "$PR_NUMBER" --json headRepository -q .headRepository.nameWithOwner -R "$REPO")
[ "$PR_HEAD_REPO" = "$FEATURE_REPO" ] || { echo "Error: PR head repository does not match $FEATURE_REMOTE" >&2; exit 1; }

# The branch to return to is the PR's base — NOT necessarily the default branch.
BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName -R "$REPO")
[ -n "$BASE_BRANCH" ] || { echo "Error: could not resolve base branch for PR #$PR_NUMBER" >&2; exit 1; }
PR_BASE_SHA=$(gh pr view "$PR_NUMBER" --json baseRefOid -q .baseRefOid -R "$REPO")
[ -n "$PR_BASE_SHA" ] || { echo "Error: could not resolve PR base SHA" >&2; exit 1; }
git fetch --quiet "$BASE_REPO_URL" "$BASE_BRANCH" || { echo "Error: could not fetch PR base" >&2; exit 1; }
TOOL_BASE_SHA=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || { echo "Error: fetched PR base is unavailable" >&2; exit 1; }
[ "$TOOL_BASE_SHA" = "$PR_BASE_SHA" ] || { echo "Error: PR base moved while resolving the trusted agent-tool; retry" >&2; exit 1; }

git cat-file -e "${TOOL_BASE_SHA}:packages/agent-tool/src/index.ts" 2>/dev/null || { echo "Error: base has no agent-tool; every trusted tool comes from this repository's base" >&2; exit 1; }
TRUSTED_AGENT_TOOL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tearleads-agent-tool.XXXXXX") || exit 1
trap 'rm -rf "$TRUSTED_AGENT_TOOL_TMP"' EXIT
git archive "$TOOL_BASE_SHA" packages/agent-tool | tar -x -C "$TRUSTED_AGENT_TOOL_TMP" || { echo "Error: could not materialize the base agent-tool" >&2; exit 1; }
AGENT_TOOL="$TRUSTED_AGENT_TOOL_TMP/packages/agent-tool/src/index.ts"
[ -f "$AGENT_TOOL" ] || { echo "Error: trusted agent-tool not found at $AGENT_TOOL" >&2; exit 1; }

PR_HEAD_SHA=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid -R "$REPO")
[ -n "$PR_HEAD_SHA" ] || { echo "Error: could not resolve PR head SHA" >&2; exit 1; }
```

Pass `-R "$REPO"` to every `gh` call here, as the tool does internally. On a fork
or multi-remote checkout, an unqualified `gh` can resolve to a different repo than
the one the tool merges into — and in this skill those lookups gate a branch
deletion.

**Return to the PR's base branch, not the repository default.** They coincide for
a PR opened by `open-pr` (which bases on the default), but a stacked PR or a
release-branch PR merges somewhere else. Switching to the default there would
fast-forward a branch that never received the commits and then delete the feature
branch on the strength of a merge that landed elsewhere. The `MERGED` gate does
not catch this — it confirms the PR merged, not that *this* branch contains it.
The `$BRANCH` != `$DEFAULT_BRANCH` preflight above is a separate guard and stays
as-is.

## Workflow

1. **Determine the subject**: If the user supplied a subject, use it verbatim.
   Otherwise the tool falls back to the PR title. Do not compose a body or
   extended message — the squash commit is the subject line only. Do not append
   the `(#<pr>)` reference by hand; the tool adds it (see below).

2. **Run the reviewed merge**:

   ```bash
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" squashMerge 'feat(app): add widget'
   # or, to default to the PR title:
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" squashMerge
   # or, bind the merge to a reviewed head/base pair:
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" squashMerge 'feat(app): add widget' "$REVIEWED_SHA" "$REVIEWED_BASE_SHA"
   ```

   **Quote the subject in single quotes** so the shell does not expand
   `$(...)`, backticks, or `$VAR` before the tool sees it — the subject must
   reach `commitlint`/`gh` only as a literal argv value. If the subject itself
   contains a single quote, escape it (`'\''`) or omit the argument to use the
   PR title.

   The tool:
   - Resolves the open PR for the current branch.
   - Requires the reviewed head and base SHAs together. The guarded form refuses
     to merge when either no longer matches the PR snapshot.
   - Rejects a subject that spans multiple lines (upholds the subject-only
     guarantee).
   - Validates the subject — with any trailing `(#<n>)` stripped first — using
     the trusted tool snapshot's side-effect-free copy of the repository's
     commitlint header policy. It never loads the feature checkout's executable
     `commitlint.config.mts`. Conventional-commit syntax and the 50-character
     header limit are enforced on the human-authored subject; the appended PR
     reference is excluded from that limit, exactly as GitHub's server-side
     suffix is. If validation fails it prints the policy report and exits
     non-zero **without merging**.
   - Appends the PR reference so the subject ends with a space followed by
     `(#<pr>)`, replacing any existing trailing `(#<n>)` (idempotent on
     re-runs), and asserts the suffix is present before merging.
   - With both reviewed SHAs, fetches and ancestry-checks the reviewed base and
     requires a fresh GitHub snapshot to report the same pair. It then inspects
     effective branch policy and requires strict up-to-date checks to guard base
     movement. It then uses GitHub's merge API with
     `--match-head-commit` so the server atomically rechecks current PR state,
     reviews, mergeability, policy, and the reviewed head with the merge. It
     never enables delayed auto-merge. Pending requirements, an unprotected
     base, an active merge queue, and policy without strict checks all stop with
     setup guidance.
   - Without review guards, runs the legacy manual path:
     `gh pr merge --squash --subject <subject-with-#pr> --body ""`.
   - On the unguarded compatibility path, waits up to ten minutes through an
     active merge queue and confirms the PR reached `MERGED`. Exit `2` means the
     merge is still pending and may land later; stop on the feature branch and
     skip every cleanup step.

3. **On a validation failure**: relay commitlint's output, propose a corrected
   subject that satisfies the rules (valid type, ≤50 chars), and re-run with the
   corrected subject once confirmed.

4. **Return to the base branch and delete the merged branch**: skip this entire
   step when `--keep-branch` was given, or when the merge did not succeed.

   **Confirm the merge from GitHub first — this is the safety gate.** Never
   delete a branch on the strength of a zero exit code alone:

   ```bash
   PR_STATE=$(gh pr view "$PR_NUMBER" --json state -q .state -R "$REPO")
   [ "$PR_STATE" = "MERGED" ] || { echo "Error: PR #$PR_NUMBER is $PR_STATE, not MERGED; skipping cleanup" >&2; exit 1; }
   ```

   If the PR is not `MERGED` (queued, blocked, or the head moved off
   `--match-head-commit`), leave the branch and the checkout exactly as they are
   and report that instead.

   **Refuse to switch away from a dirty worktree**, so unrelated in-progress work
   is never carried onto the base branch or stranded:

   ```bash
   [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Error: worktree has uncommitted changes; skipping cleanup" >&2; git status --short; exit 1; }
   ```

   Report the dirty paths and stop; the PR is already merged, so cleanup can be
   re-run by hand once the tree is clean. Untracked files are excluded — they
   follow a `git switch` harmlessly, and the guarded `git pull` below still stops
   if one would be overwritten.

   Then switch, fast-forward, **verify the merge actually arrived**, and only then
   delete — in this order, and **guard every step**, so a failure stops the
   sequence instead of falling through to the delete:

   ```bash
   MERGED_BRANCH="$BRANCH"
   MERGE_COMMIT=$(gh pr view "$PR_NUMBER" --json mergeCommit -q .mergeCommit.oid -R "$REPO")
   # Git checks a branch out in one worktree at a time. When another worktree
   # (usually the primary checkout) holds the base, detach at its tip instead.
   BASE_WORKTREE=$(git worktree list --porcelain | awk -v ref="refs/heads/$BASE_BRANCH" '/^worktree / { path = substr($(0), 10) } $(0) == "branch " ref { print path }')

   git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch "$BASE_REPO_URL" "$BASE_BRANCH" || { echo "Error: could not fetch $REPO:$BASE_BRANCH; skipping delete" >&2; exit 1; }
   if [ -n "$BASE_WORKTREE" ]; then
     git -c core.hooksPath=/dev/null switch --detach FETCH_HEAD || { echo "Error: could not detach at $REPO:$BASE_BRANCH; skipping delete" >&2; exit 1; }
   else
     git -c core.hooksPath=/dev/null switch "$BASE_BRANCH" || { echo "Error: could not switch to $BASE_BRANCH" >&2; exit 1; }
     git -c core.hooksPath=/dev/null merge --ff-only FETCH_HEAD || { echo "Error: $BASE_BRANCH could not fast-forward to $REPO:$BASE_BRANCH; skipping delete" >&2; exit 1; }
   fi

   # The real gate on the delete: prove this branch now contains the squash commit.
   [ -n "$MERGE_COMMIT" ] || { echo "Error: could not resolve merge commit; skipping delete" >&2; exit 1; }
   git merge-base --is-ancestor "$MERGE_COMMIT" HEAD || { echo "Error: $BASE_BRANCH does not contain merge commit $MERGE_COMMIT; skipping delete" >&2; exit 1; }

   REMOTE_BRANCH_LINES=$(git -c credential.helper= -c 'credential.helper=!gh auth git-credential' ls-remote --heads "$FEATURE_REPO_URL" "$MERGED_BRANCH") || { echo "Error: could not inspect $FEATURE_REMOTE/$MERGED_BRANCH; refusing branch deletion" >&2; exit 1; }
   REMOTE_BRANCH_SHA=$(printf '%s\n' "$REMOTE_BRANCH_LINES" | awk 'NR == 1 { print $(1) }')
   if [ -n "$REMOTE_BRANCH_SHA" ]; then
     [ "$REMOTE_BRANCH_SHA" = "$PR_HEAD_SHA" ] || [ "$REMOTE_BRANCH_SHA" = "$MERGE_COMMIT" ] || { echo "Error: $FEATURE_REMOTE/$MERGED_BRANCH moved to $REMOTE_BRANCH_SHA after merge; refusing remote delete" >&2; exit 1; }
     git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --no-verify --force-with-lease="refs/heads/$MERGED_BRANCH:$REMOTE_BRANCH_SHA" "$FEATURE_REPO_URL" ":refs/heads/$MERGED_BRANCH" || { echo "Error: could not lease-delete $FEATURE_REMOTE/$MERGED_BRANCH" >&2; exit 1; }
   fi
   LOCAL_BRANCH_SHA=$(git rev-parse --verify "refs/heads/$MERGED_BRANCH^{commit}") || { echo "Error: could not resolve local branch $MERGED_BRANCH; refusing local delete" >&2; exit 1; }
   [ "$LOCAL_BRANCH_SHA" = "$PR_HEAD_SHA" ] || [ "$LOCAL_BRANCH_SHA" = "$MERGE_COMMIT" ] || { echo "Error: local $MERGED_BRANCH moved after merge; refusing local delete" >&2; exit 1; }
   git branch -D "$MERGED_BRANCH" || { echo "Error: could not delete local $MERGED_BRANCH" >&2; exit 1; }
   ```

   - **Switch before deleting** — git refuses to delete the branch that is
     checked out.
   - **Detach when another worktree holds the base.** In a linked worktree,
     `git switch "$BASE_BRANCH"` fails with "already used by worktree" when the
     primary checkout is on that branch. That used to stop the cleanup and
     strand the worktree on its merged branch. Detaching at the fetched tip
     frees the feature branch for deletion. The ancestry check below still
     gates the delete. The other worktree's base branch is left for its owner
     to fast-forward.
   - **`--ff-only`** — the base branch must never acquire a merge commit here.
     A non-fast-forward means it has diverged locally; stop and report rather
     than reconciling. The guard is what makes that happen: without it the
     sequence would continue and delete the branch anyway.
   - **Verify the merge commit is an ancestor of `HEAD`** before deleting
     anything. This is what makes the delete safe in practice: it proves the
     branch you just pulled genuinely contains the squashed work, catching a pull
     from the wrong remote, a stale fork, or a base that never received the merge
     — none of which the `MERGED` state alone can detect.
   - **Remote deletion uses the feature branch's own remote, never the base
     branch's remote.** Before deletion, its branch SHA must equal the captured
     pre-merge head or GitHub's verified merge commit, and the delete itself
     carries an exact force-with-lease for that SHA. A commit pushed between
     lookup and delete makes the remote reject the deletion. An empty lookup
     means GitHub already deleted the feature branch and is treated as success.
     Local deletion separately requires the branch tip to remain the captured
     pre-merge head.
   - **The delete bypasses hooks.** It pushes no commits, so there is nothing
     for the commit-trust check to verify, and the pre-push hook would
     otherwise run the repository's full check and test with credentials.
   - **`-D`, not `-d`, is required here** — see the note below. The `MERGED` check
     plus the ancestry check above are what make the force safe.

5. **Sweep merged worktrees**: run this whenever the merge landed, even when
   `--keep-branch` or `--keep-worktree` was given or step 4 stopped. Each merge
   then also clears worktrees that earlier runs or other sessions left behind.
   With no linked worktrees, it does nothing.

   ```bash
   SELF_ROOT=$("$REALPATH_BIN" "$(git rev-parse --show-toplevel)") || exit 1
   TAB=$(printf '\t')
   git worktree prune || { echo "Error: git worktree prune failed; skipping the sweep" >&2; exit 1; }
   git worktree list --porcelain | awk -v tab="$TAB" '
     function emit() { if (path != "" && ++n > 1) print path tab head tab branch tab flag }
     /^worktree / { emit(); path = substr($(0), 10); head = "-"; branch = "-"; flag = "-"; next }
     /^HEAD / { head = substr($(0), 6); next }
     /^branch refs\/heads\// { branch = substr($(0), 19); next }
     /^(bare|locked|prunable)/ { flag = $(1); next }
     END { emit() }
   ' | while IFS="$TAB" read -r WT_PATH WT_HEAD WT_BRANCH WT_FLAG; do
     [ "$("$REALPATH_BIN" "$WT_PATH" 2>/dev/null)" != "$SELF_ROOT" ] || continue
     [ "$WT_FLAG" = "-" ] || { echo "Kept $WT_PATH ($WT_FLAG)"; continue; }
     [ "$WT_BRANCH" != "-" ] || { echo "Kept $WT_PATH (detached HEAD)"; continue; }
     MERGED_HEADS=$(gh pr list -R "$REPO" --head "$WT_BRANCH" --state merged --json headRefOid -q '.[].headRefOid') || { echo "Kept $WT_PATH (PR lookup failed)"; continue; }
     printf '%s\n' "$MERGED_HEADS" | grep -qxF "$WT_HEAD" || { echo "Kept $WT_PATH (no merged PR at its tip)"; continue; }
     WT_STATUS=$(git -C "$WT_PATH" status --porcelain --untracked-files=all) && [ -z "$WT_STATUS" ] || { echo "Kept $WT_PATH (uncommitted, untracked, or unreadable)"; continue; }
     if holds_ignored_state "$WT_PATH"; then echo "Kept $WT_PATH (ignored files beyond build output)"; continue; fi
     git worktree remove "$WT_PATH" || { echo "Kept $WT_PATH (git worktree remove refused)"; continue; }
     # Compare-and-delete in one step: a commit landing on the branch after
     # the checks above makes the delete fail instead of losing the commit.
     if git update-ref -d "refs/heads/$WT_BRANCH" "$WT_HEAD" 2>/dev/null; then
       git config --remove-section "branch.$WT_BRANCH" 2>/dev/null || :
       echo "Removed $WT_PATH ($WT_BRANCH)"
     else
       echo "Removed $WT_PATH (kept $WT_BRANCH, which moved)"
     fi
   done
   ```

   - **A worktree is removed only when its work has provably landed.** It must
     be on a named branch, and a merged PR in this repository must have
     exactly that branch tip as its head. That is the state a shipped branch
     is left in when its cleanup could not run. Two kinds of branch survive: a
     fresh one that only sits at the base tip, and one with commits added after
     its PR merged.
   - **It must also be safe to delete.** Removal requires no uncommitted or
     untracked files. `holds_ignored_state` must also find every ignored file
     to be build output: under `node_modules/`, `.turbo/`, `dist/`, `.astro/`,
     `.terraform-lint/`, or `.wrangler/tmp/`, or a `*.tsbuildinfo` or
     `.DS_Store`. `git worktree remove` deletes ignored files without asking,
     and anything else ignored — `.env*`, `.secrets`, Terraform state, plans,
     variables, and overrides, rendered `wrangler.staging.jsonc`, and the
     local D1 databases and R2 uploads in `.wrangler/state/` — may be the only
     copy. An ignore rule added later is protected until it joins that list.
     A `terraform init` or a local Wrangler run therefore keeps a worktree,
     and it is listed for the user. Both checks fail closed: a worktree git
     cannot read is kept.
   - **Detached worktrees are kept and listed.** Nothing ties a detached HEAD
     to a PR, and a session that just ran `git worktree add --detach` looks the
     same as a leftover. Report them so the user can decide.
   - **Nothing is forced.** `git worktree remove` without `--force` refuses a
     worktree with changes or a lock. The branch is deleted with
     `git update-ref -d` against the merged tip, which deletes it only if it
     still points there, in one atomic step. Remote branches are left alone,
     since deleting them belongs to the run that merged them. To keep a
     finished worktree, lock it with `git worktree lock <path>`.
   - **Only this clone's worktrees are in scope.** `git worktree prune` first
     drops records of worktrees whose directories are already gone, and
     touches no files. A worktree whose own repository was deleted no longer
     appears in any `git worktree list`, so the sweep cannot reach it.

6. **Retire this worktree**: skip it when `--keep-branch` or `--keep-worktree`
   was given, when step 4 did not complete, or in the primary checkout. Run it
   last, because it deletes the directory the shell is in.

   ```bash
   GIT_DIR_ABS=$(git rev-parse --path-format=absolute --git-dir) || exit 1
   GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
   if [ "$GIT_DIR_ABS" != "$GIT_COMMON_DIR" ]; then
     SELF_ROOT=$("$REALPATH_BIN" "$(git rev-parse --show-toplevel)") || exit 1
     PRIMARY_WORKTREE=$(git worktree list --porcelain | awk '/^worktree / { print substr($(0), 10); exit }')
     [ -d "$PRIMARY_WORKTREE" ] || { echo "Error: primary checkout not found; keeping $SELF_ROOT" >&2; exit 1; }
     git merge-base --is-ancestor "$MERGE_COMMIT" HEAD || { echo "Error: HEAD does not contain $MERGE_COMMIT; keeping $SELF_ROOT" >&2; exit 1; }
     if git show-ref --verify --quiet "refs/heads/$MERGED_BRANCH"; then echo "Error: $MERGED_BRANCH still exists; keeping $SELF_ROOT" >&2; exit 1; fi
     if holds_ignored_state "$SELF_ROOT"; then echo "Error: ignored files beyond build output; keeping $SELF_ROOT" >&2; exit 1; fi
     cd "$PRIMARY_WORKTREE" || exit 1
     git worktree remove "$SELF_ROOT" || { echo "Error: git worktree remove refused; keeping $SELF_ROOT" >&2; exit 1; }
   fi
   ```

   - **The gates mirror the sweep.** HEAD must contain the merge commit, the
     merged branch must be gone, and `holds_ignored_state` must find nothing
     ignored beyond build output. `git worktree remove` without `--force`
     refuses untracked files. On any refusal the worktree stays detached at the
     base tip; report why.
   - **Leave a harness-managed worktree through the harness.** If this session
     entered the worktree with Claude Code's `EnterWorktree`, call
     `ExitWorktree` with `action: "remove"` instead of the git commands above.
     That returns the session to its starting directory. Fall back to git if
     it refuses.
   - **The shell ends up in the primary checkout.** Run nothing else from the
     removed path. A session launched inside the worktree has to continue from
     the primary checkout, so say so in the report.

7. **Report results**: state the merged PR number, the final merge subject
   (including the `(#<pr>)` reference), and confirm the merge succeeded. Name the
   base branch returned to (or the tip a linked worktree detached at), that it
   was fast-forwarded and verified to contain the merge commit, and that the
   merged branch was deleted (locally, and remotely when it still existed) — or
   why cleanup was skipped. List the worktrees the sweep removed and the ones it
   kept with their reasons. Say whether this worktree was retired, or why it
   was kept.

## Notes

- The commit message is the subject only; no `--body` content is added, and
  multi-line subjects are rejected.
- The final subject always ends with a space followed by `(#<pr>)`; the tool
  appends and asserts it, and the reference is excluded from the 50-char
  commitlint header limit.
- Validation runs before the merge, so an invalid subject never reaches GitHub.
- Always single-quote the subject argument to avoid shell expansion.
- A non-zero exit after `gh pr merge` means the PR did not actually merge (e.g.
  it was queued or blocked); do not report success in that case, and do not clean
  up the branch.
- Cleanup uses `git branch -D` because a squashed feature tip is not an ancestor
  of the new base commit. It remains safe because cleanup is gated on GitHub
  reporting `MERGED` and on the base containing GitHub's merge commit.
- The tool itself does not delete the branch, change the checkout, or touch
  worktrees, and knows nothing of `--keep-branch` or `--keep-worktree`; steps
  4–6 of this skill own all of that. A caller that invokes the tool directly
  gets the merge **without** the cleanup.
- Worktrees are cleaned up as merges land, not in a separate chore. The
  merging worktree retires itself, and the sweep catches worktrees whose
  cleanup never ran. Both only remove a worktree whose branch tip is a merged
  PR's exact head, or whose branch this run just deleted.
