import { defineConfig } from "vitest/config";

// unit tests of the pure frontend logic (no DOM, no Tauri); UI tests live in tests/ui (Playwright)
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
