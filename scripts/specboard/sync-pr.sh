#!/usr/bin/env bash
# Drive SpecBoard work-item status from a pull request, via the CLI.
#   PR opened / updated  -> set each touched spec in_progress + link the PR
#   PR merged            -> set each touched spec done
#
# Best-effort: an individual status change that the workflow state machine
# rejects (e.g. in_progress from backlog) is logged and skipped, never fatal.
# Expects the env the CI workflow provides (SPECBOARD_URL/TOKEN, BASE_SHA,
# HEAD_SHA, PR_NUMBER, PR_BODY, ACTION, MERGED).
set -uo pipefail

if [ -z "${SPECBOARD_URL:-}" ] || [ -z "${SPECBOARD_TOKEN:-}" ]; then
  echo "SpecBoard secrets not set; skipping sync."
  exit 0
fi

here="$(cd "$(dirname "$0")" && pwd)"
cli=(node apps/cli/dist/index.js)

ids="$(PR_BODY="${PR_BODY:-}" bash "$here/resolve-spec-ids.sh" "${BASE_SHA:-origin/main}" "${HEAD_SHA:-HEAD}")"
if [ -z "$ids" ]; then
  echo "No spec ids resolved for this PR; nothing to sync."
  exit 0
fi

while IFS= read -r id; do
  [ -n "$id" ] || continue
  if [ "${ACTION:-}" = "closed" ] && [ "${MERGED:-}" = "true" ]; then
    echo "==> $id: done"
    "${cli[@]}" status "$id" done || echo "  (skip: 'done' not allowed from current status)"
  else
    echo "==> $id: in_progress + link PR #${PR_NUMBER:-?}"
    "${cli[@]}" status "$id" in_progress || echo "  (skip: 'in_progress' not allowed from current status)"
    if [ -n "${PR_NUMBER:-}" ]; then
      "${cli[@]}" link "$id" --pr "$PR_NUMBER" || echo "  (skip: link failed, maybe already linked)"
    fi
  fi
done <<EOF
$ids
EOF
