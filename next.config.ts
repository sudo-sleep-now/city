import type { NextConfig } from "next";

/**
 * SOLHEIM — Next.js configuration.
 *
 * Two build modes:
 * - Default (Node/Bun server): `output: "standalone"` → `bun run build` + `bun run start`
 * - GitHub Pages static export: `NEXT_EXPORT=1` → `bun run build:static`
 *   When the site is served from a repository sub-path (https://<user>.github.io/<repo>/),
 *   set `NEXT_PUBLIC_BASE_PATH` to the repository name (e.g. "/solheim").
 */
const isStaticExport = process.env.NEXT_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, "") || undefined;

const nextConfig: NextConfig = {
  ...(isStaticExport
    ? { output: "export" as const, trailingSlash: true }
    : { output: "standalone" as const }),
  ...(basePath ? { basePath } : {}),

  reactStrictMode: false,
};

export default nextConfig;
