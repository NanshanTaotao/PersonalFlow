import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@personalflow/agent": path.join(root, "packages/agent/src/index.ts"),
      "@personalflow/contracts": path.join(root, "packages/contracts/src/index.ts"),
      "@personalflow/review": path.join(root, "packages/review/src/index.ts"),
      "@personalflow/runtime": path.join(root, "packages/runtime/src/index.ts"),
      "@personalflow/storage": path.join(root, "packages/storage/src/index.ts"),
      "@personalflow/templates": path.join(root, "packages/templates/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx", "tests/e2e/fixtures-regression.spec.ts"],
    globals: false
  }
});
