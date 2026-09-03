/**
 * The long-form render harness, kept out of the suite everyone runs.
 *
 * `vitest.config.ts` includes `server/**` only, so `npm test` never picks these up. They render real
 * video at production LENGTH — minutes of CPU per run — which is the right cost for a deliberate
 * check and the wrong cost for every commit.
 *
 *     npx vitest run --config vitest.longform.config.ts
 *     TARGET_MIN=3 npx vitest run --config vitest.longform.config.ts
 *
 * Nothing here is skipped, mocked or conditionally disabled. It is a second entry point, not a
 * second standard.
 */
import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.spec.ts"],
    /** One render at a time: these are CPU-bound and parallel ffmpeg would only measure contention. */
    fileParallelism: false,
    testTimeout: 45 * 60_000,
    hookTimeout: 45 * 60_000,
  },
});
