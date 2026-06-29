#!/usr/bin/env bash
# Point this repo's Git hooks at the versioned .githooks/ directory.
# Run once per clone: scripts/specboard/install-hooks.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
git -C "$root" config core.hooksPath .githooks
chmod +x "$root"/.githooks/* 2>/dev/null || true

echo "Installed SpecBoard Git hooks (core.hooksPath=.githooks)."
echo "The pre-push hook only acts when the 'specboard' CLI is installed and"
echo "logged in. Set it up with:"
echo "  pnpm --filter @specboard/cli build && pnpm --filter @specboard/cli exec npm link"
echo "  specboard auth login --url https://app.specboard.ai"
