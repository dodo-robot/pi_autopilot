import { defineConfig } from "vitest/config";

// Dedicated config for the acceptance suite, which exercises the compiled
// CLI (`dist/testing/fake-pi.js`) and therefore requires `npm run build`
// to have already run. Kept separate from vitest.config.ts so the default
// `npm test` never accidentally picks up tests/e2e before a build exists.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
  },
});
