import type { NextConfig } from "next";

/**
 * `npm run export` sets STATIC_EXPORT=1 to produce a plain static folder (`out/`) that any static
 * host can serve, like padel-os's deploy folder. If the site will live under a sub-path
 * (e.g. GitHub Pages https://<user>.github.io/food-discovery), also set BASE_PATH=/food-discovery.
 */
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(isExport ? { output: "export" as const, trailingSlash: true, images: { unoptimized: true } } : {}),
  ...(basePath ? { basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
