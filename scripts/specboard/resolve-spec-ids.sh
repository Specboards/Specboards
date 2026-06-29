#!/usr/bin/env bash
# Resolve the SpecBoard spec ids a change touches.
#
# Usage: resolve-spec-ids.sh [BASE] [HEAD]
#   BASE / HEAD default to origin/main and HEAD.
#
# Prints unique spec ids (one per line), drawn from:
#   1. the frontmatter `id:` of any changed `specs/**/spec.md`, and
#   2. any `Spec: <id>` lines in the PR_BODY env var (for code-only PRs that
#      don't edit a spec file).
set -uo pipefail

base="${1:-origin/main}"
head="${2:-HEAD}"

emit_id_from_spec() {
  # First `id:` line of a spec's YAML frontmatter, unquoted and trimmed.
  grep -m1 '^id:' "$1" 2>/dev/null \
    | sed 's/^id:[[:space:]]*//; s/"//g; s/'\''//g; s/[[:space:]]*$//'
}

ids=""

if changed=$(git diff --name-only "$base" "$head" 2>/dev/null); then
  while IFS= read -r f; do
    case "$f" in
      specs/*/spec.md)
        [ -f "$f" ] || continue
        id=$(emit_id_from_spec "$f")
        [ -n "$id" ] && ids="$ids$id"$'\n'
        ;;
    esac
  done <<EOF
$changed
EOF
fi

# Explicit `Spec: <id>` trailers from a PR body.
if [ -n "${PR_BODY:-}" ]; then
  while IFS= read -r id; do
    id=$(printf '%s' "$id" | tr -d '\r' | sed 's/[[:space:]]*$//')
    [ -n "$id" ] && ids="$ids$id"$'\n'
  done < <(printf '%s\n' "$PR_BODY" | sed -n 's/^[Ss]pec:[[:space:]]*//p')
fi

printf '%s' "$ids" | sed '/^$/d' | sort -u
