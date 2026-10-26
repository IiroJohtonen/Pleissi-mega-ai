import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    // Sovellustestit odottavat näkymän latautumista jopa 5 s (hidas CI-kone). Oletusraja 5 s katkaisi
    // tällaisen testin kesken, ja sen keskeneräinen haku kaatoi seuraavan testin.
    testTimeout: 20_000
  }
});
