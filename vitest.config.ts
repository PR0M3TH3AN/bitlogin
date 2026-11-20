import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    testTimeout: 20000
  }
});
