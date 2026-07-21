---
id: 7c4e9b1a-5d2f-4c8e-a3b6-91d0e7f2c455
title: Repo Spec Import
kind: feature
---

# Repo Spec Import

Connect a GitHub repository and import every spec matched by
`.specboards/config.yml` into the board, injecting stable `id` frontmatter
where it is missing.

## Problem

Teams adopting Specboards already have specs in their repo. Onboarding must not
require renaming files or hand-editing frontmatter across dozens of specs.

## Requirements

- Scan the repo for files matching `specGlobs` on first connect.
- Create a `features` row plus `spec_index` cache entry per spec.
- Inject a generated UUID `id` via a single, batched commit when absent.
- Surface import progress and parse errors in the UI.

## Out of Scope

- Non-GitHub providers (GitLab, Bitbucket).
