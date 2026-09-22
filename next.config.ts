import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "playwright", "embedded-postgres"],
};

export default nextConfig;
