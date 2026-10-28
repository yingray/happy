# Shared code for the Codex privacy review hooks of this clone.
#
# Sourced by commit-msg, reference-transaction, and pre-push. The tracked
# copies are in .rayno/git-hooks. Run .rayno/install-git-hooks.sh to copy them
# into .git/hooks.
#
# The review covers only content that is new to the public. A file is skipped
# when its content is the same as upstream/main, or the same as another parent
# of a merge when that parent is public. Public content needs no review. A
# file that matches a parent that is not public yet is reviewed, because the
# approval record of the whole diff must not cover unreviewed content.
#
# A review passes only when Codex prints exactly NO_PRIVACY_FINDINGS. Any
# failure (no login, no model, no network) counts as a failed review.
#
# The commit message is public too, so it gets the same review.
#
# Each reviewed diff is recorded by its patch-id in privacy-review/approved,
# and each reviewed message by "msg:" and the hash of its text. A commit is
# reviewed again only for the part that has no record. A clean cherry-pick
# or rebase keeps both, so it costs no new review. A reworded message costs
# a review of the message only.

PRIVACY_MODEL="gpt-6.1-sol"
PRIVACY_EFFORT="xhigh"
PRIVACY_PASS_TOKEN="NO_PRIVACY_FINDINGS"
PRIVACY_UPSTREAM_REF="upstream/main"
PRIVACY_PUBLIC_REMOTE="origin"
PRIVACY_EMPTY_TREE="$(git hash-object -t tree /dev/null)"

privacy_git_dir="$(git rev-parse --absolute-git-dir)"
privacy_cache="$privacy_git_dir/privacy-review/approved"
privacy_visibility=""

# Return 0 when the repo is public. A failed check counts as public.
privacy_is_public() {
    if [ -z "$privacy_visibility" ]; then
        privacy_visibility="$(gh repo view --json visibility -q .visibility 2>/dev/null || echo UNKNOWN)"
    fi
    [ "$privacy_visibility" = "PUBLIC" ] || [ "$privacy_visibility" = "UNKNOWN" ]
}

# Print the stable patch-id of the diff on stdin, or nothing for an empty diff.
privacy_patch_id() {
    git patch-id --stable | cut -d' ' -f1
}

privacy_is_approved() {
    [ -n "$1" ] && [ -f "$privacy_cache" ] && grep -qxF "$1" "$privacy_cache"
}

privacy_approve() {
    [ -n "$1" ] || return 0
    mkdir -p "$(dirname "$privacy_cache")"
    privacy_is_approved "$1" || echo "$1" >> "$privacy_cache"
}

# Print the cache key of the message text on stdin.
privacy_message_key() {
    echo "msg:$(git hash-object --stdin)"
}

# Print the message of commit $1 exactly as git stores it.
privacy_commit_message() {
    git cat-file commit "$1" | sed '1,/^$/d'
}

# Return 0 when commit $1 is public: reachable from upstream/main or from the
# public remote.
privacy_is_public_commit() {
    local -a public=(--remotes="$PRIVACY_PUBLIC_REMOTE")
    if git rev-parse -q --verify "$PRIVACY_UPSTREAM_REF^{commit}" >/dev/null; then
        public+=("$PRIVACY_UPSTREAM_REF")
    fi
    [ -n "$1" ] && [ -z "$(git rev-list -n 1 "$1" --not "${public[@]}" 2>/dev/null)" ] &&
        git rev-parse -q --verify "$1^{commit}" >/dev/null
}

# Return 0 when blob $1 is the same as the blob of $path at ref $2.
privacy_blob_at_ref_is() {
    local blob="$1" ref="$2" path="$3" ref_blob
    [ -n "$blob" ] || return 1
    git rev-parse -q --verify "$ref^{commit}" >/dev/null || return 1
    ref_blob="$(git rev-parse -q --verify "$ref:$path" 2>/dev/null || true)"
    [ "$blob" = "$ref_blob" ]
}

# Run Codex on a diff, a commit message, or both.
# $1 is the git command that shows the diff, without the path list, or "".
# $2 is the shell command that prints the commit message, or "".
# The other arguments are the files of the diff.
# Return 0 when the review is clean. Print the findings on stderr otherwise.
privacy_run_review() {
    local diff_cmd="$1" message_cmd="$2" result verdict items="" count=""
    shift 2
    if [ -n "$diff_cmd" ] && [ "$#" -gt 0 ]; then
        items="- The changes. Run this command to see them: $diff_cmd -- <each file below>
  Files:
$(printf '  %s\n' "$@")
"
        count="$# file(s)"
    fi
    if [ -n "$message_cmd" ]; then
        items="$items- The commit message. Run this command to see it: $message_cmd
"
        count="${count:+$count and }the commit message"
    fi
    [ -n "$items" ] || return 0

    if ! command -v codex >/dev/null 2>&1; then
        echo "privacy review: codex is not installed." >&2
        return 1
    fi

    result="$(mktemp -t happy-privacy-review)"

    local prompt="This repo is public. Review these items only for privacy leaks:
$items
Check for secrets, tokens, keys, credentials, personal data (names, emails,
phone numbers), local paths such as /Users/<name>, hostnames, Tailscale names
or IPs, internal company names, ticket keys, private repo names, private URLs,
and logs or fixtures with real data. A Co-Authored-By trailer with the
noreply address of an AI tool is not a finding. List each finding with file
(or \"commit message\"), line, and a fix. If there are no findings, your final
message must be exactly
$PRIVACY_PASS_TOKEN and nothing else."

    echo "privacy review: running $PRIVACY_MODEL ($PRIVACY_EFFORT) on $count..." >&2
    if ! codex exec -m "$PRIVACY_MODEL" -c "model_reasoning_effort=\"$PRIVACY_EFFORT\"" \
            -s read-only --ephemeral -o "$result" "$prompt" </dev/null >/dev/null 2>&1; then
        echo "privacy review: codex failed to run." >&2
        rm -f "$result"
        return 1
    fi

    verdict="$(tr -d '[:space:]' < "$result")"
    if [ "$verdict" = "$PRIVACY_PASS_TOKEN" ]; then
        rm -f "$result"
        return 0
    fi
    cat "$result" >&2
    echo >&2
    rm -f "$result"
    return 1
}

# Review one commit against its first parent. Return 0 when it is clean.
privacy_check_commit() {
    local sha="$1" base patch_id message_key path blob parent skip diff_cmd="" message_cmd=""
    local -a parents=() files=()
    read -r -a parents <<< "$(git rev-list --parents -n 1 "$sha" | cut -d' ' -f2-)"
    if [ "${#parents[@]}" -eq 0 ] || [ "${parents[0]}" = "$sha" ]; then
        base="$PRIVACY_EMPTY_TREE"
        parents=()
    else
        base="${parents[0]}"
    fi

    patch_id="$(git diff "$base" "$sha" | privacy_patch_id)"
    message_key="$(privacy_commit_message "$sha" | privacy_message_key)"
    if ! privacy_is_approved "$message_key"; then
        message_cmd="git cat-file commit $sha | sed '1,/^\$/d'"
    fi

    if [ -n "$patch_id" ] && ! privacy_is_approved "$patch_id"; then
        while IFS= read -r -d '' path; do
            blob="$(git rev-parse -q --verify "$sha:$path" 2>/dev/null || true)"
            skip=0
            privacy_blob_at_ref_is "$blob" "$PRIVACY_UPSTREAM_REF" "$path" && skip=1
            if [ "${#parents[@]}" -gt 1 ]; then
                for parent in "${parents[@]:1}"; do
                    privacy_is_public_commit "$parent" &&
                        privacy_blob_at_ref_is "$blob" "$parent" "$path" && skip=1
                done
            fi
            [ "$skip" -eq 1 ] || files+=("$path")
        done < <(git diff --name-only -z --diff-filter=ACMRT "$base" "$sha")
        [ "${#files[@]}" -eq 0 ] || diff_cmd="git diff $base $sha"
    fi

    # Ask GitHub for the visibility only when a review is really needed.
    if { [ -n "$diff_cmd" ] || [ -n "$message_cmd" ]; } && privacy_is_public; then
        echo "privacy review: commit $(git log -1 --format='%h %s' "$sha")" >&2
        privacy_run_review "$diff_cmd" "$message_cmd" "${files[@]}" || return 1
    fi
    privacy_approve "$patch_id"
    privacy_approve "$message_key"
}

# Review every commit reachable from the given revisions that is not public
# yet. Public means reachable from upstream/main or from the public remote.
# Return 0 when every commit is clean.
privacy_check_commits() {
    local sha list
    local -a pending=() public=(--remotes="$PRIVACY_PUBLIC_REMOTE")
    if git rev-parse -q --verify "$PRIVACY_UPSTREAM_REF^{commit}" >/dev/null; then
        public+=("$PRIVACY_UPSTREAM_REF")
    fi
    # A failed rev-list must not count as "nothing to review".
    if ! list="$(git rev-list --reverse "$@" --not "${public[@]}")"; then
        echo "privacy review: cannot list the new commits." >&2
        return 1
    fi
    while IFS= read -r sha; do
        [ -n "$sha" ] && pending+=("$sha")
    done <<< "$list"
    [ "${#pending[@]}" -gt 0 ] || return 0

    for sha in "${pending[@]}"; do
        privacy_check_commit "$sha" || {
            privacy_failed_commit="$sha"
            return 1
        }
    done
}
