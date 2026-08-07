#!/usr/bin/env bash
# Deploy the web app to Fly with the running commit baked into the image.
#
#   scripts/deploy.sh test        -> specboard-test  (https://test.specboards.ai)
#   scripts/deploy.sh production  -> specboard       (https://app.specboards.ai)
#
# Use this instead of a bare `fly deploy`. The image needs GIT_SHA as a build
# arg so /legal's "Source code" link resolves to the exact commit running
# (the AGPL section 13 offer); a plain `fly deploy` bakes in nothing and the
# link quietly degrades to the repo root. Three releases shipped that way
# before this script existed, so the sha is passed here rather than by hand.
#
# Everything after the target is forwarded to flyctl, e.g.
#   scripts/deploy.sh test --now
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

target="${1:-}"
shift || true

case "$target" in
  test)
    config="fly.test.toml"
    ;;
  production|prod)
    config="fly.toml"
    ;;
  *)
    echo "usage: scripts/deploy.sh <test|production> [flyctl args...]" >&2
    exit 64
    ;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
sha="$(git rev-parse --short HEAD)"
# Modifications to tracked files are the case that makes the baked sha a lie,
# so they are what the production guard below refuses on. Untracked files also
# reach the image (the build context is the working tree, not the commit), but
# blocking on every stray local file would just get the guard worked around, so
# they only warn.
dirty="$(git status --porcelain --untracked-files=no)"
untracked="$(git ls-files --others --exclude-standard)"

# Production only ever ships what is on main, and only what is committed: the
# sha baked into the image has to name source anyone can actually fetch, so a
# dirty tree or a feature branch would make the /legal link point at code that
# is not what is running.
if [ "$config" = "fly.toml" ]; then
  if [ "$branch" != "main" ]; then
    echo "Refusing to deploy production from '$branch'. Merge to main first." >&2
    exit 1
  fi
  if [ -n "$dirty" ]; then
    echo "Refusing to deploy production from a dirty tree: commit or stash first." >&2
    exit 1
  fi
fi
if [ -n "$dirty" ] || [ -n "$untracked" ]; then
  echo "Warning: the working tree differs from $sha, and the image is built" >&2
  echo "from the tree. The commit /legal points at will not match exactly." >&2
fi

echo "Deploying $config at $sha (branch $branch)…"
exec fly deploy -c "$config" --build-arg GIT_SHA="$sha" "$@"
