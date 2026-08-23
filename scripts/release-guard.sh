#!/usr/bin/env bash
# Refuse a production deploy of a version that was never actually released.
#
#   scripts/release-guard.sh
#
# VERSIONING.md has described the release checklist since early on: bump all
# eight package.json files in lockstep, write the CHANGELOG section, tag the
# merged commit, then deploy production. Nothing enforced it, and the record
# shows what that is worth. Versions 0.22.0 through 0.25.2 shipped to
# app.specboards.ai with the repo still reading 0.21.0 and tagging stopped at
# v0.19.0; after the changelog gained a notice saying so, 0.27.0 and 0.27.2
# shipped the same way. A checklist that has been skipped eight times is not a
# checklist, it is a wish.
#
# So the rule moves to where the release actually happens. A production deploy
# is the one moment every skipped step becomes visible at once, and it is the
# step nobody forgets to run, which makes it the only reliable place to ask
# whether the other six happened.
#
# Three things must agree before production ships:
#
#   1. Every workspace package carries the same version (the lockstep rule).
#   2. CHANGELOG.md has a section for that version.
#   3. A tag vX.Y.Z exists and points at the commit being deployed.
#
# Together they mean a deployed build can always be named, read about, and
# fetched. Any one of them alone can be satisfied while the release is still a
# fiction: a bump with no tag leaves nothing to check out, a tag with no
# changelog leaves nobody able to say what shipped.
#
# This is deliberately not run for test deploys. Test exists to look at work in
# progress, most of which will never carry a version of its own, and a guard
# that blocked that would be routed around within a week.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

fail() {
  echo "release-guard: $1" >&2
  echo >&2
  echo "See VERSIONING.md, 'The increment rule'. To release properly:" >&2
  echo "  pnpm release:prepare <version>   # lockstep bump + changelog scaffold" >&2
  echo "  # commit, open a PR, merge to main, then:" >&2
  echo "  git tag -a v<version> -m 'v<version>' && git push origin v<version>" >&2
  exit 1
}

version="$(node -p "require('./package.json').version")"
[ -n "$version" ] || fail "could not read a version from the root package.json."

# 1. Lockstep. A partial bump is worse than none: `specboards --version` and the
#    deployed web app would disagree about what is running.
mismatched=""
for manifest in package.json apps/*/package.json packages/*/package.json; do
  [ -f "$manifest" ] || continue
  other="$(node -p "require('./$manifest').version" 2>/dev/null || echo "")"
  if [ "$other" != "$version" ]; then
    mismatched="${mismatched}  $manifest: ${other:-<unreadable>} (expected $version)"$'\n'
  fi
done
if [ -n "$mismatched" ]; then
  fail "workspace versions are not in lockstep at $version:"$'\n'"$mismatched"
fi

# 2. The changelog section. Matches the "## [0.27.3]" heading style the file
#    already uses; the trailing context is left open so a date, or the absence
#    of one, does not decide whether a release is allowed to ship.
if ! grep -qE "^## \[${version//./\\.}\]" CHANGELOG.md; then
  fail "CHANGELOG.md has no '## [$version]' section. Nothing tells a reader what this release changed."
fi

# 3. The tag, on this exact commit. `git tag --points-at HEAD` rather than
#    `rev-parse v$version` on purpose: the tag existing somewhere in history
#    would be satisfied by a tag on an older commit, which is precisely the
#    shape of the mistake this is meant to catch.
sha="$(git rev-parse --short HEAD)"
if ! git tag --points-at HEAD | grep -qx "v$version"; then
  found="$(git tag --points-at HEAD | tr '\n' ' ')"
  fail "no tag 'v$version' on the commit being deployed ($sha).${found:+ Tags here: $found}
Tag the merged commit and push it before deploying production."
fi

echo "release-guard: v$version, changelog present, tagged at $sha."
