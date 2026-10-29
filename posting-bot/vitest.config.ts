import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
      STORAGE_DIR: "./storage-test",
      MOCK_FAILURE_RATE: "0",
      MOCK_LATENCY_MS: "0",
      OPENAI_API_KEY: "",
      TIKTOK_CLIENT_KEY: "",
      GOOGLE_CLIENT_ID: "",
      INSTAGRAM_APP_ID: "",
    },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
