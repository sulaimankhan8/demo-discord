import { defineConfig } from "vitest/config";

// Relay benchmark for the offline mesh (docs/10 C4). Slow, so it's not in `npm run test:mesh`.
export default defineConfig({
  test: {
    include: ["lib/mesh/**/*.bench.test.ts"],
    environment: "node",
  },
});
