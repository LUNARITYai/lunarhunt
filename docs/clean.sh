#!/bin/sh
# One-off cleanup of stale worktrees, run by Krzysztof. Without arguments it only lists; "go" removes.
# Removes a worktree only when: it is a review-*/sentinel-* branch or its branch has a merged PR and no open PR,
# the tree is clean, and no live hc terminal sits in it. Everything else is kept and listed.
MODE="${1:-list}"
ROOT=/Users/lunarity/Projects/LUNARITY/lunarhunt
KEEP_A="$ROOT/.claude/worktrees/agent-ac844804111c2504d"
KEEP_B="$ROOT/.claude/worktrees/106-overseer-hc-launch"
cd "$ROOT" || exit 1
LIVE="$(hc ls 2>/dev/null)"
removed=0
kept=0
git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch /{sub("refs/heads/","",$2); print p" "$2}' | while read -r path branch; do
  [ "$path" = "$ROOT" ] && continue
  [ "$path" = "$KEEP_A" ] && continue
  [ "$path" = "$KEEP_B" ] && continue
  name="$(basename "$path")"
  throwaway=no
  case "$branch" in review-*|sentinel-*|worktree-agent-*) throwaway=yes ;; esac
  if [ "$throwaway" = no ]; then
    merged="$(gh pr list --head "$branch" --state merged --json number --jq length 2>/dev/null)"
    open="$(gh pr list --head "$branch" --state open --json number --jq length 2>/dev/null)"
    if [ "${merged:-0}" = 0 ] || [ "${open:-0}" != 0 ]; then
      echo "KEEP  $name ($branch): no merged PR, or a PR is still open"
      continue
    fi
  fi
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    echo "KEEP  $name ($branch): uncommitted changes"
    continue
  fi
  if printf '%s' "$LIVE" | grep -q "\"cwd\":\"$path\""; then
    echo "KEEP  $name ($branch): a live hc terminal is in it"
    continue
  fi
  if [ "$MODE" = go ]; then
    git worktree unlock "$path" 2>/dev/null
    if git worktree remove "$path"; then
      [ "$throwaway" = yes ] && git branch -q -D "$branch"
      echo "GONE  $name ($branch)"
    else
      echo "KEEP  $name ($branch): git refused"
    fi
  else
    echo "WOULD REMOVE  $name ($branch)"
  fi
done
[ "$MODE" = go ] && git worktree prune
echo "DONE ($MODE)"
