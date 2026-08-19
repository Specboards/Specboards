/**
 * Comparing base URLs as endpoints rather than as strings.
 *
 * Shared by the settings card and the server, deliberately. Both sides decide
 * whether a stored API key may be reused for a saved base URL: the server
 * refuses to carry a credential to a different endpoint, and the form has to
 * ask for the key before the user gets there. Two copies of this rule that
 * disagree even slightly would mean a form that promises a save the server then
 * refuses, on the one screen where the failure is a security control firing.
 *
 * Kept free of server-only imports so a client component can use it.
 */

/**
 * True when `a` and `b` name the same server and path, ignoring surrounding
 * whitespace, a trailing slash, and case. `https://API.OpenAI.com/v1/` and
 * `https://api.openai.com/v1` are the same endpoint; a different host, port or
 * path is not.
 *
 * Case is ignored across the whole URL, including the path, which is more
 * lenient than a strict reading of HTTP would be. That is the right side to err
 * on for what this decides: the host is what determines who receives the key,
 * and two paths differing only in case are the same party.
 *
 * A value that will not parse as a URL is compared as a trimmed, lowercased
 * string, so a half-typed endpoint is never accidentally equal to a real one.
 */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}
