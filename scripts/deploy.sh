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

# The build context is uploaded to Fly's REMOTE builder, so anything that
# escapes .dockerignore leaves the machine. Agent worktrees under .claude/ did
# exactly that until they were excluded, and the only reason anyone noticed was
# a security review. Warn about the next one here instead.
#
# Counts files rather than bytes, and prunes the same directory names
# .dockerignore does. Two reasons for a count: `du --exclude` is GNU-only and
# macOS silently ignores it (measuring the whole 8.7 GB tree, which is how this
# check was first written), and per-directory sizing without pruning flags
# `apps/` as 521 MB because node_modules lives inside it - a warning that fires
# on every deploy is one nobody reads.
#
# The real context is ~740 files. With .claude/worktrees included it was ~4000,
# so the threshold catches that class of mistake with room to spare.
context_files="$(
  find . -type d \( \
      -name node_modules -o -name .next -o -name dist -o -name .turbo \
      -o -name .git -o -name .claude -o -name out -o -name test-results \
      -o -name playwright-report \
    \) -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' '
)"
echo "Build context: ~${context_files} files"
if [ "${context_files:-0}" -gt 2000 ]; then
  echo "Warning: that is far more than the ~740 files this context should hold." >&2
  echo "Something large is escaping .dockerignore and will be uploaded to Fly's" >&2
  echo "remote builder. Check for a new top-level or agent/tool state directory." >&2
fi

echo "Deploying $config at $sha (branch $branch)…"
exec fly deploy -c "$config" --build-arg GIT_SHA="$sha" "$@"
