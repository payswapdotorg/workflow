import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  experimental: {
    /* M6 hang guard: the dev/proxy budget sits ABOVE the 30s route-level
       guard (src/lib/api-guard.ts) so a hung handler produces the guard's
       structured 503 ROUTE_TIMEOUT instead of the proxy's opaque 504. */
    proxyTimeout: 35_000,
  },
};

export default nextConfig;
