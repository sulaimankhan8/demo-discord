import type { NextConfig } from "next";

// The Capacitor app build (`npm run build:app`) sets BUILD_TARGET=capacitor to produce static
// files in out/. The normal web build (`npm run build` / `npm run dev`) is unaffected.
const isAppBuild = process.env.BUILD_TARGET === "capacitor";

const nextConfig: NextConfig = {
  ...(isAppBuild && {
    output: "export",
    // Emits mesh/index.html etc., so the app's local server can open each route directly.
    trailingSlash: true,
  }),
};

export default nextConfig;
