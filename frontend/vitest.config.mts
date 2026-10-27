import { defineConfig } from "vitest/config";

// Unit tests for the offline mesh (lib/mesh). Chat and voice have their own tests in /test.
export default defineConfig({
  test: {
    include: ["lib/mesh/**/*.test.ts"],
    environment: "node",
  },
});
