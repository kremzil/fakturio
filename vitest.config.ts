import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // Integration tests require a live database/services and are run via the
    // dedicated `vitest.integration.config.ts` (npm run test:integration).
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    globals: false
  }
});
