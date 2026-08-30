# Homebrew distribution for the Specboards CLI

`specboards.rb` here is the maintained source of the formula. The tap that users
install from lives in a separate repo, `Specboards/homebrew-tap`, as
`Formula/specboards.rb`.

The tap is live, so users install with:

```bash
brew install specboards/tap/specboards
```

(`specboards/tap` is shorthand for the `Specboards/homebrew-tap` repo.)

## On each CLI release

The npm publish happens first (push a `cli-v<version>` tag, which runs
`.github/workflows/cli-release.yml`). Then update the formula:

1. Bump `url` to the new version's npm tarball:
   `https://registry.npmjs.org/@specboards/cli/-/cli-<version>.tgz`
2. Set `sha256` to the tarball's checksum:

   ```bash
   tarball=$(npm view @specboards/cli@<version> dist.tarball)
   curl -sL "$tarball" | shasum -a 256
   ```

3. Copy the updated file into the tap repo as `Formula/specboards.rb`. Keep the
   two byte-identical (`diff` them) so the tap never becomes a second source of
   truth.
4. Verify before pushing. The tap has no CI of its own, and Homebrew no longer
   audits or installs a formula by file path, so point it at a local clone of
   the tap instead. Commit in the tap first, then:

   ```bash
   brew untap specboards/tap 2>/dev/null   # if already tapped
   brew tap specboards/tap /path/to/homebrew-tap
   brew audit --strict --online specboards/tap/specboards
   brew style specboards/tap/specboards
   brew install specboards/tap/specboards
   specboards version                      # expect: specboards <version>
   brew test specboards
   ```

5. Push the tap to `main`, then re-run the install against the real remote:
   `brew uninstall specboards && brew untap specboards/tap && brew install
   specboards/tap/specboards`.

A future improvement is to automate these steps from the release workflow with a
bot commit to the tap; kept manual for now to avoid a cross-repo write token.
