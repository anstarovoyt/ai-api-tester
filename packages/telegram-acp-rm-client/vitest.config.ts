import { defineConfig } from "vitest/config";

// Local Vitest config so `npm test` works when executed from this workspace directory.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "*.test.ts"],
  },
});

