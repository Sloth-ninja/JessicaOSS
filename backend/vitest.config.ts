import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `scripts/` holds operator tools that are never compiled into dist/, but
    // one of them carries a safety rail (scripts/readOnlyDb.ts) whose guarantee
    // must survive refactors — so its tests run with everything else.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
