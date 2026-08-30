# Homebrew formula for the Specboards CLI.
#
# The maintained SOURCE of this file is `packaging/homebrew/specboards.rb` in
# Specboards/Specboards. The copy in the tap repo (Specboards/homebrew-tap, as
# `Formula/specboards.rb`) is what `brew install specboards/tap/specboards`
# actually reads. The two must stay byte-identical, so edit the source and copy
# it over; never hand-edit the tap. packaging/homebrew/README.md has the steps.

class Specboards < Formula
  desc "Command-line interface for Specboards (specs, status, GitHub links)"
  homepage "https://specboards.ai"
  url "https://registry.npmjs.org/@specboards/cli/-/cli-0.27.3.tgz"
  # shasum -a 256 of the published tarball. Recompute on every version bump:
  # `npm view @specboards/cli@<version> dist.tarball` then curl | shasum -a 256.
  sha256 "797d0ab5561d679dfda893b33cb3e610ebee774a1b2db7286b0f743bd11054b9"
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
