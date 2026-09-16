import { headers } from "next/headers";

/**
 * This deployment's own origin, e.g. `https://test.specboards.ai`.
 *
 * Configured wins over the request. A self-host behind a proxy can be reached
 * on an internal hostname that is correct for the request and wrong for
 * anything we hand out - a GitHub webhook URL, an MCP endpoint somebody pastes
 * into their agent - so `APP_URL` is the operator's answer and is taken when
 * they gave one. The request headers are the fallback for a deployment that
 * has not set it.
 *
 * Extracted from the Integrations page when the MCP endpoint moved to Agents
 * and both pages needed it: Integrations for the GitHub setup flow, Agents for
 * the MCP endpoint. Two copies of "where am I" is how they come to disagree.
 */
export async function appOrigin(): Promise<string> {
  const configured = (
    process.env.APP_URL ?? process.env.BETTER_AUTH_URL
  )?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}`;
}
