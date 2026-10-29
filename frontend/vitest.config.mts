import { defineConfig } from "vitest/config";

// Unit tests for the offline mesh (lib/mesh). Chat and voice have their own tests in /test.
export default defineConfig({
  test: {
    include: ["lib/mesh/**/*.test.ts"],
    // The relay benchmark is slow; run it with `npm run bench:mesh`.
    exclude: ["**/node_modules/**", "lib/mesh/**/*.bench.test.ts"],
    environment: "node",
  },
});
