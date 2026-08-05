import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@cpp/client"],
  serverExternalPackages: ["@stellar/stellar-sdk"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
