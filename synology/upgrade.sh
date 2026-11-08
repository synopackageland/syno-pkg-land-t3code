#!/usr/bin/env bash
# One explicit stable tag; no latest guessing, push, image publication or NAS access.
set -euo pipefail
packaging=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$packaging/.." && pwd)
cd "$repo"
[[ $# == 2 && $1 =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'Usage: bash synology/upgrade.sh <[v]X.Y.Z> <increasing-build-number>' >&2; exit 2;
}
[[ $(git rev-parse --show-toplevel) == "$repo" ]] || { echo 'Run inside a source fork.' >&2; exit 2; }
[[ -z $(git status --porcelain --untracked-files=normal) ]] || { echo 'Commit changes before upgrading.' >&2; exit 2; }
git remote get-url upstream >/dev/null
node "$packaging/version.mjs" "$1" "$2" --validate
# Fetch the named remote tag into a private ref: a local tag can never substitute for it.
git fetch --no-tags upstream "+refs/tags/$1:refs/synopkgland/selected-upstream"
commit=$(git rev-parse 'refs/synopkgland/selected-upstream^{commit}')
[[ -z $(git ls-tree "$commit" -- synology) ]] || { echo 'Upstream owns synology/; choose another integration layout.' >&2; exit 2; }
previous=$(git describe --tags --abbrev=0 --match '[0-9]*' --match 'v[0-9]*' HEAD 2>/dev/null || true)
if [[ -f "$packaging/upstream-source.json" ]]; then
  previous=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).commit)' "$packaging/upstream-source.json")
fi
if [[ -n $previous ]]; then
  git merge-base --is-ancestor "$previous" "$commit" || { echo 'Refusing upstream downgrade/divergent history.' >&2; exit 2; }
  [[ -z $(git diff "$previous" HEAD -- . ':(exclude)synology') ]] || { echo 'Wrapper changed upstream files outside synology/.' >&2; exit 2; }
else
  # First adoption must already be based on the selected source tag.
  git merge-base --is-ancestor "$commit" HEAD
  [[ -z $(git diff "$commit" HEAD -- . ':(exclude)synology') ]] || { echo 'Initial fork must preserve upstream source.' >&2; exit 2; }
fi
git merge --no-ff --no-edit "$commit"
[[ -z $(git diff "$commit" HEAD -- . ':(exclude)synology') ]] || { echo 'Upstream files differ after merge; resolve before building.' >&2; exit 2; }
kind=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).kind)' "$packaging/upstream-recipe.json")
if [[ $kind == official-image ]]; then
  node "$packaging/update-image.mjs" "$1"
elif [[ $kind != native-source ]]; then
  echo 'Unknown upstream recipe kind.' >&2; exit 2
fi
node "$packaging/version.mjs" "$1" "$2"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({tag:process.argv[2],commit:process.argv[3],build:Number(process.argv[4])},null,2)+"\n")' "$packaging/upstream-source.json" "$1" "$commit" "$2"
export SPL_UPSTREAM_SOURCE="$repo"
export SPL_UPSTREAM_TAG="$1"
export SPL_UPSTREAM_COMMIT="$commit"
cd "$packaging"
if [[ $kind == native-source ]]; then bash ./build-source.sh; fi
synopkgland check --json
synopkgland build --json
# Review version/provenance and commit synology/ before the next upgrade.
