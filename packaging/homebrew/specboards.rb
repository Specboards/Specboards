# Homebrew formula for the Specboards CLI.
#
# This is the maintained SOURCE of the formula. On each CLI release, copy it to
# the tap repo `Specboards/homebrew-tap` as `Formula/specboards.rb` with `url`
# and `sha256` updated for the new version (see packaging/homebrew/README.md),
# so `brew install specboards/tap/specboards` picks it up.
require "language/node"

class Specboards < Formula
  desc "Command-line interface for Specboards (specs, status, GitHub links)"
  homepage "https://specboards.ai"
  url "https://registry.npmjs.org/@specboards/cli/-/cli-0.21.0.tgz"
  # Replace after `npm publish`: shasum -a 256 of the published tarball
  # (`npm view @specboards/cli@0.21.0 dist.tarball` then curl | shasum -a 256).
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  # The CLI is the deliberate Apache-2.0 exception to the AGPL codebase, so you
  # can script against it freely. See LICENSING.md and apps/cli/LICENSE; this
  # must stay in step with `license` in apps/cli/package.json.
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "specboards", shell_output("#{bin}/specboards version")
  end
end
