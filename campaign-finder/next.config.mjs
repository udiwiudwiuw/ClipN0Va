/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Start de achtergrondtaken (periodiek zoeken) via src/instrumentation.ts.
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@prisma/client", "node-cron"],
  },
};

export default nextConfig;
