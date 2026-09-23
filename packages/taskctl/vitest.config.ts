import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@codexboard/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    ...(process.platform === "win32"
      ? { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 }
      : {}),
  },
});
