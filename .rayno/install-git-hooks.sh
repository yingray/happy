#!/usr/bin/env bash
#
# Install the Codex privacy review hooks into this clone.
#
# The fork is public. These hooks block a commit, a branch move (cherry-pick,
# rebase, merge, `commit --no-verify`), or a push until Codex reviews the new
# diffs and commit messages and finds no privacy leak. See
# .rayno/git-hooks/privacy-review-lib.sh for the rules.
#
# Git does not install hooks on clone. Run this script once after a clone,
# and again after a change to .rayno/git-hooks. It copies the hooks into
# .git/hooks, so they stay active on every branch, also on `main`.
#
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
src="$repo_root/.rayno/git-hooks"
dest="$(cd "$repo_root" && git rev-parse --absolute-git-dir)/hooks"
hooks=(commit-msg reference-transaction pre-push privacy-review-lib.sh)

if [ -n "$(git config --get core.hooksPath || true)" ]; then
    echo "error: core.hooksPath is set, so git does not read $dest." >&2
    echo "Unset it with: git config --unset core.hooksPath" >&2
    exit 1
fi

mkdir -p "$dest"
for hook in "${hooks[@]}"; do
    install -m 755 "$src/$hook" "$dest/$hook"
    echo "installed $hook"
done

# An earlier version of these hooks used pre-commit. commit-msg replaces it.
if [ -f "$dest/pre-commit" ] && grep -q "Codex privacy review" "$dest/pre-commit"; then
    rm "$dest/pre-commit"
    echo "removed the old privacy pre-commit hook"
fi

warn=0
for tool in codex gh; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "warning: $tool is not installed. Every review fails until it is." >&2
        warn=1
    fi
done
if ! git rev-parse -q --verify "refs/remotes/upstream/main" >/dev/null; then
    echo "warning: upstream/main is missing, so upstream content is reviewed too. Add it with:" >&2
    echo "  git remote add upstream https://github.com/slopus/happy.git" >&2
    echo "  git remote set-url --push upstream DISABLE" >&2
    echo "  git fetch upstream main" >&2
    warn=1
fi

[ "$warn" -eq 0 ] && echo "done: the privacy review hooks are active." || echo "done, with warnings." >&2
