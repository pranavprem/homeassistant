#!/usr/bin/env bash
# The "changes" job of .github/workflows/agraharam.yml (architecture §17.5): decides whether a run tests the
# dashboard and whether it may release a bundle. Run from the repository root, after a full-history checkout.
#
# Writes exactly two lines to $GITHUB_OUTPUT, each a literal true or false: dashboard=… and bundle=…. File names
# never leave this script, because pull-request file names are attacker-controlled; they are read NUL-separated and
# only matched against fixed patterns.
#
# Both outputs use the same base: the pull request's base commit, or for a push the commit of the newest release
# tag (vMAJOR.MINOR.PATCH, strict SemVer, highest version by sort -V) when it is an ancestor of the pushed commit,
# else the push's `before`. Other tags starting with v (`v1`, `vacuum-schedule`) are ignored: sort -V would rank them
# above every release. Diffing a push against the last release means a failed or skipped publish ships with the next
# push. Every uncertain case answers true for both, so CI runs rather than being skipped: workflow_dispatch or any
# other event, no release tag yet, shallow history, an all-zero, malformed or unreachable base, and any git error.
#
# Inputs (environment): GITHUB_EVENT_NAME, GITHUB_SHA and GITHUB_OUTPUT (set by Actions), PR_BASE_SHA
# (pull_request) and PUSH_BEFORE (push).

set -euo pipefail

readonly ZERO_SHA=0000000000000000000000000000000000000000
readonly COMMIT_SHA_RE='^[0-9a-f]{40}([0-9a-f]{24})?$'
readonly RELEASE_TAG_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# Writes both outputs and stops. Every exit of this script goes through here.
finish() {
  printf 'dashboard=%s\nbundle=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  printf 'changes: dashboard=%s bundle=%s (%s)\n' "$1" "$2" "$3"
  exit 0
}

# Fail toward testing.
run_everything() {
  finish true true "$1"
}

# Anything the dashboard CI covers.
is_dashboard_path() {
  case $1 in
    frontend/agraharam/* | hacs.json | .github/workflows/agraharam.yml) return 0 ;;
  esac
  return 1
}

# A denylist: any package path not listed here counts as part of the bundle, so a mistake leans toward releasing.
# `case` patterns match across slashes, so the order matters: src and scripts always count, and the other
# exclusions apply to their own directory or to files at the top of the package only.
is_bundle_path() {
  [[ $1 == hacs.json ]] && return 0
  [[ $1 == frontend/agraharam/* ]] || return 1
  local rel=${1#frontend/agraharam/}
  case $rel in
    src/* | scripts/*) return 0 ;;
    docs/* | tests/* | e2e/* | install/*) return 1 ;;
    */*) return 0 ;;
    *.md | harness.html | index.html | playwright.config.ts | vitest.config.ts | vite.harness.config.ts) return 1 ;;
  esac
  return 0
}

[[ ${GITHUB_EVENT_NAME:-} == pull_request || ${GITHUB_EVENT_NAME:-} == push ]] ||
  run_everything "event ${GITHUB_EVENT_NAME:-unknown} always runs everything"
[[ ${GITHUB_SHA:-} =~ $COMMIT_SHA_RE ]] || run_everything 'GITHUB_SHA is not a commit hash'

shallow=$(git rev-parse --is-shallow-repository) || run_everything 'git error reading the clone'
[[ $shallow == false ]] || run_everything 'shallow history'

if [[ $GITHUB_EVENT_NAME == pull_request ]]; then
  base=${PR_BASE_SHA:-}
  base_label='the pull-request base'
else
  tags=$(git tag --list 'v*') || run_everything 'git error listing tags'
  release_tags=$(printf '%s\n' "$tags" | grep -E "$RELEASE_TAG_RE" || true)
  [[ -n $release_tags ]] || run_everything 'no release tag yet'
  newest_tag=$(printf '%s\n' "$release_tags" | sort -V | tail -n 1) || run_everything 'could not order the tags'
  tag_commit=$(git rev-parse --verify --quiet "refs/tags/$newest_tag^{commit}") ||
    run_everything 'git error resolving the newest tag'
  ancestor_status=0
  git merge-base --is-ancestor "$tag_commit" "$GITHUB_SHA" || ancestor_status=$?
  case $ancestor_status in
    0)
      base=$tag_commit
      base_label="release tag $newest_tag"
      ;;
    1)
      base=${PUSH_BEFORE:-}
      base_label="the push's before (release tag $newest_tag is not an ancestor)"
      ;;
    *) run_everything 'git error comparing the newest tag with the pushed commit' ;;
  esac
fi

[[ $base =~ $COMMIT_SHA_RE && $base != "$ZERO_SHA" ]] || run_everything "no usable base: $base_label"
git cat-file -e "$base^{commit}" 2>/dev/null || run_everything "$base_label is not in the fetched history"

changed_list=$(mktemp)
trap 'rm -f -- "$changed_list"' EXIT
git diff --name-only --no-renames -z "$base" "$GITHUB_SHA" >"$changed_list" || run_everything 'git error diffing'

dashboard=false
bundle=false
while IFS= read -r -d '' path; do
  if is_dashboard_path "$path"; then dashboard=true; fi
  if is_bundle_path "$path"; then bundle=true; fi
done <"$changed_list"

finish "$dashboard" "$bundle" "diff against $base_label"
