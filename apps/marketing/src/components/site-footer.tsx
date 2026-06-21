import { GithubIcon } from "@/components/icons";
import { Logo } from "@/components/logo";
import { APP_URL, GITHUB_URL, SIGN_IN_URL, SIGN_UP_URL, site } from "@/lib/site";

const ARCHITECTURE_URL = `${GITHUB_URL}/blob/main/ARCHITECTURE.md`;
const LICENSE_URL = `${GITHUB_URL}/blob/main/README.md#license`;

export function SiteFooter() {
  return (
    <footer className="border-t border-gray-200 bg-gray-50">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-gray-500">{site.tagline}</p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
          >
            <GithubIcon className="h-4 w-4" />
            Specboards/SpecBoard
          </a>
        </div>

        <FooterCol
          title="Product"
          links={[
            { label: "Features", href: "#features" },
            { label: "How it works", href: "#how-it-works" },
            { label: "Sign in", href: SIGN_IN_URL },
            { label: "Get started", href: SIGN_UP_URL },
          ]}
        />
        <FooterCol
          title="Open source"
          links={[
            { label: "GitHub repo", href: GITHUB_URL, external: true },
            { label: "Architecture", href: ARCHITECTURE_URL, external: true },
            { label: "Self-host", href: `${GITHUB_URL}#self-host`, external: true },
            { label: "License (Apache-2.0)", href: LICENSE_URL, external: true },
          ]}
        />
        <FooterCol
          title="App"
          links={[
            { label: "Open the app", href: APP_URL, external: true },
            { label: "Sign in", href: SIGN_IN_URL },
            { label: "Create account", href: SIGN_UP_URL },
          ]}
        />
      </div>

      <div className="border-t border-gray-200">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-sm text-gray-500 sm:flex-row">
          <p>© {new Date().getFullYear()} SpecBoard. Apache-2.0 open core.</p>
          <p>Spec-driven product management.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
              className="text-gray-500 hover:text-gray-900"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
