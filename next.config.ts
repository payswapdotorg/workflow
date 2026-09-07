import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Hermetic e2e (e2e/run-all.mjs) overrides the build directory so its dev
     server never contends for .next/dev/lock with a live operator instance
     of the same worktree (the :3005 preview). Everything else — build,
     production start, the operator's own dev server — uses .next. */
  distDir: process.env.TEACHCAST_E2E_DIST || ".next",
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
