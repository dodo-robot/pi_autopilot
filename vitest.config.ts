import { defineConfig } from "vitest/config";

// `tests/e2e` is excluded from the default suite: it exercises the
// COMPILED CLI and requires `dist/testing/fake-pi.js` to exist, so it
// must run only via `npm run test:e2e` (see vitest.e2e.config.ts), after
// `npm run build`. The default `npm test` (unit + integration) never
// depends on a build.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "**/node_modules/**"],
    environment: "node",
  },
});
