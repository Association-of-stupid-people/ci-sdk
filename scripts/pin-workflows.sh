#!/usr/bin/env bash
# Copies the reusable workflows of <src dir> (workflows/ of main) into <runner checkout>/.github/workflows/, with
# every ci-sdk action they use (`.../ci-sdk/.github/actions/<name>@runner`) pinned to <actions sha>, a commit of the
# runner branch that holds those actions: `@<sha> # ci-sdk v<version>`. Used by publish.yml, and by hand:
#
#   git worktree add ../ci-sdk-runner origin/runner
#   scripts/pin-workflows.sh workflows ../ci-sdk-runner "$(git rev-parse origin/runner)" "$(node -p "require('./package.json').version")"
#
# then commit .github/workflows there and push it to runner with a token that has the `workflow` scope (GitHub refuses
# a GITHUB_TOKEN push that changes .github/workflows).
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: $0 <src dir> <runner checkout> <actions sha> <version>" >&2
  exit 2
fi
src=$1 dest=$2 sha=$3 version=$4

if ! [[ $sha =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::the actions sha must be a full commit sha (got '$sha')"
  exit 1
fi
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::the version must be X.Y.Z (got '$version')"
  exit 1
fi

shopt -s nullglob
files=("$src"/*.yml)
if [ ${#files[@]} -eq 0 ]; then
  echo "::error::no reusable workflow in $src"
  exit 1
fi

mkdir -p "$dest/.github/workflows"
for f in "${files[@]}"; do
  target="$dest/.github/workflows/$(basename "$f")"
  sed -E "s#(Association-of-stupid-people/ci-sdk/\.github/actions/[a-z0-9-]+)@runner( .*)?\$#\1@${sha} \# ci-sdk v${version}#" \
    "$f" >"$target"
  if grep -nE 'ci-sdk/\.github/actions/[a-z0-9-]+@runner' "$target"; then
    echo "::error::$target still uses an unpinned ci-sdk action"
    exit 1
  fi
  echo "pinned $target to $sha (ci-sdk v$version)"
done
