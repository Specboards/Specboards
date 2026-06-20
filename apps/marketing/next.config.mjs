/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Set NEXT_OUTPUT=standalone for the Docker image (infra/marketing.Dockerfile);
  // plain `next start` doesn't support standalone output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
};

export default nextConfig;
