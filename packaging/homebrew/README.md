# Homebrew distribution for the Specboards CLI

Users install the CLI with:

```bash
brew install specboards/tap/specboards
```

(`specboards/tap` is shorthand for the `Specboards/homebrew-tap` repo.)

## The formula does not live here

It lives in the tap, at
[`Formula/specboards.rb`](https://github.com/Specboards/homebrew-tap/blob/main/Formula/specboards.rb),
and that is the only copy. This directory used to hold a second one that had to
be kept byte-identical and copied across on every release.

That arrangement stopped making sense once the bump was automated. The formula's
`url` and `sha256` are now written by a job in the tap, so a copy here would be
out of date within hours of every release, and two files that must agree but
cannot are worse than one.

## Releasing the CLI no longer involves this directory

Push a `cli-v<version>` tag. `.github/workflows/cli-release.yml` publishes to
npm. Within six hours the tap's own
[`bump-formula.yml`](https://github.com/Specboards/homebrew-tap/blob/main/.github/workflows/bump-formula.yml)
notices the new version, downloads that exact tarball, computes the checksum
from the bytes it fetched, installs and runs the result on a macOS runner, and
commits only if all of that passed.

To skip the wait after a release:

```bash
gh workflow run bump-formula.yml -R Specboards/homebrew-tap
```

## Why the tap updates itself rather than being pushed to

The obvious design is for `cli-release.yml` to write the formula straight after
publishing. It would need a credential in this repo that can write to the tap,
sitting next to the npm publish token, so one leaked secret would get an
attacker both the package and the formula that vouches for it.

Pulling costs some latency and buys away that whole category of problem: the
tap's job uses its own `GITHUB_TOKEN`, which cannot write anywhere else, and
this repo holds no credential for the tap at all.
