export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness probe for Fly health checks: confirms the process is up and serving
 * HTTP. Deliberately does NOT touch Postgres - a transient DB blip should not
 * make Fly kill and restart otherwise-healthy machines, which would flap and
 * drop in-flight MCP requests (the very disconnects we are hardening against).
 * Readiness/DB health belongs in separate alerting, not in the restart loop.
 */
export function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
