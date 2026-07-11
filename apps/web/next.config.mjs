/** @type {import('next').NextConfig} */

// Baseline security headers applied to every response. The Content-Security-
// Policy is NOT here: it carries a per-request nonce, so it's emitted from
// middleware.ts instead. `frame-ancestors 'none'` (plus X-Frame-Options)
// blocks clickjacking of the authenticated app.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@specboard/core", "@specboard/db", "@specboard/ui"],
  // Set NEXT_OUTPUT=standalone for the Docker image (infra/web.Dockerfile);
  // plain `next start` doesn't support standalone output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
