/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Start de achtergrond-worker (scheduler + wachtrij) via src/instrumentation.ts.
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@prisma/client", "node-cron"],
  },
};

export default nextConfig;
