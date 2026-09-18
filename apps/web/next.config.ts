import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Points next-intl at src/i18n/request.ts. Without this wrapper the request
// config is never loaded and every server-side getTranslations() call throws
// "Couldn't find next-intl config file" AT REQUEST TIME -- `next build` passes.
// That is what made /login return HTTP 500 in the production image (B12).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Required for the production Docker image — bundles only runtime deps into .next/standalone.
  output: "standalone",
};

export default withNextIntl(nextConfig);
