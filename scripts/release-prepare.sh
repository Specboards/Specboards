#!/usr/bin/env bash
# Bump every workspace package in lockstep and scaffold the changelog section.
#
#   scripts/release-prepare.sh 0.27.3
#
# The companion to release-guard.sh. The guard refuses a production deploy that
# skipped the release steps; this makes those steps one command, because a guard
# that blocks people without giving them an easy way through is a guard they
# will find a way around. Eight package.json files edited by hand is exactly the
# kind of chore that gets deferred to "after this deploy" and then forgotten.
#
# It stops short of committing, tagging or pushing. The changelog section it
# writes is a heading and empty groups: what actually shipped has to be written
# by someone who knows, and a commit created here would invite that to be
# skipped too.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release-prepare.sh <major.minor.patch>" >&2
  echo "  e.g. scripts/release-prepare.sh 0.27.3" >&2
  exit 64
fi

current="$(node -p "require('./package.json').version")"
if [ "$version" = "$current" ]; then
  echo "Already at $version. Nothing to bump." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "Refusing: tag v$version already exists, so this version has shipped." >&2
  exit 1
fi

# The version lives in one field per manifest. Rewriting it with a JSON parse
# and re-serialise would reformat files that are otherwise untouched, so this
# replaces only the first "version" line, which is where npm puts it and where
# every manifest here has it.
manifests=(package.json)
for m in apps/*/package.json packages/*/package.json; do
  [ -f "$m" ] && manifests+=("$m")
done

for m in "${manifests[@]}"; do
  before="$(node -p "require('./$m').version")"
  perl -0pi -e 's/("version":\s*")[^"]+(")/${1}'"$version"'${2}/' "$m"
  after="$(node -p "require('./$m').version")"
  [ "$after" = "$version" ] || { echo "Failed to bump $m (still $before)." >&2; exit 1; }
  echo "  $m: $before -> $version"
done

# Insert the new section above the most recent one, so the file stays
# newest-first without needing to know what the previous version was.
if grep -qE "^## \[${version//./\\.}\]" CHANGELOG.md; then
  echo "CHANGELOG.md already has a section for $version; leaving it alone."
else
  today="$(date +%Y-%m-%d)"
  perl -0pi -e "s/^## \[/## [$version] - $today\n\n### Added\n\n- \n\n### Changed\n\n- \n\n### Fixed\n\n- \n\n## [/m" CHANGELOG.md
  echo "  CHANGELOG.md: added a [$version] - $today section (fill it in)"
fi

cat <<EOF

Bumped to $version. Still to do, by hand:
  1. Write the CHANGELOG.md section: what shipped, not what changed in git.
  2. pnpm -w build && pnpm -w typecheck && pnpm -w test
  3. Commit, PR, merge to main. That auto-deploys test; smoke it there.
  4. git tag -a v$version -m "v$version" && git push origin v$version
  5. pnpm deploy:prod

Step 4 is the one that has been skipped before. scripts/release-guard.sh will
refuse step 5 without it.
EOF
