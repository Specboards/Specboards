import { ButtonLink } from "@/components/button-link";
import { GithubIcon } from "@/components/icons";
import { Logo } from "@/components/logo";
import { GITHUB_URL, SIGN_IN_URL, SIGN_UP_URL } from "@/lib/site";

/** Sticky, translucent top navigation. */
export function SiteNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-200/70 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#top" aria-label="SpecBoard home">
          <Logo />
        </a>

        <div className="hidden items-center gap-8 text-sm text-gray-600 md:flex">
          <a href="#features" className="hover:text-gray-900">
            Features
          </a>
          <a href="#how-it-works" className="hover:text-gray-900">
            How it works
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-gray-900"
          >
            <GithubIcon className="h-4 w-4" />
            GitHub
          </a>
        </div>

        <div className="flex items-center gap-2">
          <ButtonLink href={SIGN_IN_URL} variant="ghost" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href={SIGN_UP_URL} variant="primary">
            Get started
          </ButtonLink>
        </div>
      </nav>
    </header>
  );
}
