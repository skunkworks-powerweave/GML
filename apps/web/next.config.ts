import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the production Docker image — bundles only runtime deps into .next/standalone.
  output: "standalone",
};

export default nextConfig;
