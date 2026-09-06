import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: ["global-search.browser.test.ts", "review-recognition.browser.test.ts"],
  testIgnore: [],
  projects: baseConfig.projects!.map((project) => ({ ...project, testIgnore: [] })),
});
