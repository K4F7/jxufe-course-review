import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    define: { TEST_D1_MIGRATIONS: JSON.stringify(migrations) },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          d1Databases: [
            "MIGRATION_DB",
            "MIGRATION_CONFLICT_DB",
            "CATEGORY_MIGRATION_DB",
            "CATEGORY_CONFLICT_DB",
            "BASELINE_PUBLISH_DB_1",
            "BASELINE_PUBLISH_DB_2",
            "BASELINE_PUBLISH_DB_3",
            "BASELINE_PUBLISH_DB_4",
            "BASELINE_PUBLISH_DB_5",
            "BASELINE_PUBLISH_DB_6",
            "BASELINE_PUBLISH_DB_7",
            "BASELINE_PUBLISH_DB_8",
            "BASELINE_PUBLISH_DB_9",
            "BASELINE_PUBLISH_DB_10",
            "COURSE_EXCLUSION_MIGRATION_DB",
            "PE_MAPPING_MIGRATION_DB",
            "PE_QUEUE_CLOSEOUT_MIGRATION_DB",
            "PE_DIRECT_SKILL_BACKFILL_DB",
            "COURSE_EXCLUSION_CONFLICT_DB",
            "FTS_MIGRATION_DB",
          ],
          bindings: {
            PUBLIC_SURFACE: "production",
            ALLOW_DEV_LOGIN: "1",
            ISSUE111_RELATION_MANIFEST_SHA256: "manifest",
            V5_IMPORT_ARTIFACT_SHA256: "manifest",
            V5_IMPORT_MANIFEST_SHA256: "manifest",
            IP_HASH_SECRET: "test-ip-hash-secret",
            ORDINARY_USER_TEST_AUTH_SECRET: "test-ordinary-user-auth",
            CAMPUS_IDENTITY_SECRET: "test-campus-identity",
            TURNSTILE_SECRET: "",
            TURNSTILE_SITE_KEY: "",
            MAIL_DELIVERY_URL: "https://mail.example.test/emails",
            MAIL_FROM: "\"非官方课评@JUFE\" <noreply@sein.moe>",
            MAIL_DELIVERY_TOKEN: "test-mail-token",
            REVIEW_AUTHOR_LOOKUP_TO: "admin@example.test",
            CAS_CHALLENGE_SECRET: "test-cas-challenge",
            EHALL_SESSION_SECRET: "test-ehall-session",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      exclude: [
        "test/browser/**",
        "test/**/*.node.test.ts",
      ],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
