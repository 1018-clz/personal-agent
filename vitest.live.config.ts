import { defineConfig } from "vitest/config";

// Calls the real DeepSeek API and spends a little real money, so it is never part of `npm test`.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.ts"],
    testTimeout: 180_000,
    // Printed output is the point of a live check: it shows what the model really did.
    disableConsoleIntercept: true,
  },
});
