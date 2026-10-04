import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/*.test.ts"],
    pool: "forks",
    isolate: true,
    restoreMocks: true,
    // Preserve the node:test default; explicit per-test deadlines still apply.
    testTimeout: 0,
  },
});
