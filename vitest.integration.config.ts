import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Integration tests talk to the live local Postgres (docker compose). Load the
// repo .env so DATABASE_URL and friends are available without extra wiring.
loadEnv();

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
    globals: false,
    // Tenant-isolation tests mutate shared rows; keep them serial within a file
    // and avoid cross-file parallelism against the same database.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000
  }
});
