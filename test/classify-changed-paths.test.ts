import { describe, expect, it } from "vitest";
import { classifyChangedPaths } from "../scripts/ci/classify-changed-paths.mjs";
import bindAdminWorkflow from "../.github/workflows/bind-admin-students.yml?raw";
import ctaSyncWorkflow from "../.github/workflows/cta-sync.yml?raw";
import ctaSyncApplyWorkflow from "../.github/workflows/cta-sync-apply.yml?raw";
import teacherDepartmentBackfillWorkflow from "../.github/workflows/teacher-department-backfill.yml?raw";
import ciWorkflow from "../.github/workflows/ci.yml?raw";
import playwrightConfig from "../playwright.config.ts?raw";
import deployWorkflow from "../.github/workflows/deploy.yml?raw";
import migrateWorkflow from "../.github/workflows/migrate.yml?raw";
import packageJsonRaw from "../package.json?raw";
import pnpmLock from "../pnpm-lock.yaml?raw";

const packageScripts = (JSON.parse(packageJsonRaw) as { scripts: Record<string, string> }).scripts;

describe("classifyChangedPaths", () => {
  it("treats an empty change set as web so CI stays conservative", () => {
    expect(classifyChangedPaths([])).toEqual({ web: true });
  });

  it("skips web CI for documentation and markdown-only changes", () => {
    expect(
      classifyChangedPaths(["docs/adr/0001-legacy-review-tiered-moderation.md", "README.md", "AGENTS.md"]),
    ).toEqual({ web: false });
  });

  it("skips web CI for agent docs", () => {
    expect(classifyChangedPaths([".agents/skills/heroui-react/SKILL.md"])).toEqual({
      web: false,
    });
  });

  it("runs full web CI for changes outside the documented skip paths", () => {
    expect(classifyChangedPaths([".grok/workflows/ustc-aligned-review-v1.rhai"])).toEqual({
      web: true,
    });
    expect(classifyChangedPaths(["src/pages/CoursesPage.tsx"])).toEqual({ web: true });
    expect(classifyChangedPaths([".github/workflows/ci.yml"])).toEqual({ web: true });
    expect(classifyChangedPaths(["package.json", ".grok/workflows/ustc-aligned-review-v1.rhai"])).toEqual({
      web: true,
    });
  });

  it("splits full web CI across static, Workers, and browser jobs", () => {
    expect(ciWorkflow).not.toContain("offline");
    expect(ciWorkflow.match(/^  web_static:/gm)).toHaveLength(1);
    expect(ciWorkflow).toContain("pnpm run check:static");
    expect(packageScripts["check:static"]).toBe(
      "wrangler types && tsc --noEmit && pnpm run test:static && vite build && wrangler deploy --dry-run --env=\"\"",
    );
    expect(packageScripts["test:static"]).toBe(
      "vitest run --config vitest.node.config.ts --exclude test/page-atlas.node.test.ts && vitest run --config vitest.secrets.config.ts",
    );
    expect(ciWorkflow.match(/shard: \["1\/2", "2\/2"\]/g)).toHaveLength(2);
    expect(ciWorkflow).toContain(
      "pnpm exec vitest run --no-file-parallelism --exclude test/global-search-prototype.test.ts --exclude test/prototype-local-seed.test.ts --shard=${{ matrix.shard }}",
    );
    expect(ciWorkflow.match(/fail-fast: true/g)).toHaveLength(2);

    expect(ciWorkflow).toContain(
      "pnpm exec playwright test --project=chromium --shard=${{ matrix.shard }}",
    );
    expect(ciWorkflow).toContain(
      "pnpm exec playwright test --project=chromium --grep @pr-smoke --shard=${{ matrix.shard }}",
    );
    expect(ciWorkflow).toContain('"${{ github.event_name }}" == "merge_group"');
    expect(ciWorkflow).toContain(
      "pnpm exec playwright test --project=mobile-chromium --grep @mobile-smoke --shard=${{ matrix.shard }}",
    );
    expect(ciWorkflow).not.toContain("matrix.project");
    expect(playwrightConfig).toContain('name: "mobile-chromium"');
    expect(playwrightConfig).toContain('"admin*.browser.test.ts"');
  });

  it("requires every selected CI matrix to complete successfully", () => {
    expect(ciWorkflow).toContain("needs: [changes, web_static, vitest_workers, browser]");
    expect(ciWorkflow).toContain("if: always()");
    expect(ciWorkflow).toContain('if [[ "$web_required" == "true" ]]');
    expect(ciWorkflow).toContain('expected="success"');
    expect(ciWorkflow).toContain('elif [[ "$web_required" == "false" ]]');
    expect(ciWorkflow).toContain('expected="skipped"');
    expect(ciWorkflow).toMatch(/elif \[\[ "\$web_required" == "false" \]\][\s\S]*else\s+exit 1/);
    expect(ciWorkflow).toContain('if [[ "$result" != "$expected" ]]');
  });

  it("uses a preinstalled browser matching the locked Playwright package", () => {
    const image = ciWorkflow.match(/image: mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/);
    const lockedVersion = pnpmLock.match(/'@playwright\/test':\s+specifier: [^\n]+\s+version: ([\d.]+)/);
    expect(image).not.toBeNull();
    expect(lockedVersion).not.toBeNull();
    expect(image?.[1]).toBe(lockedVersion?.[1]);
    expect(ciWorkflow).not.toMatch(/playwright install/);
  });

  it("keeps deploy gated on web changes and ignores offline trees", () => {
    expect(deployWorkflow).toContain("if: needs.changes.outputs.web == 'true'");
    expect(deployWorkflow).toContain(".grok/**");
    expect(deployWorkflow).not.toContain("scripts/legacy_ocr/**");
    expect(deployWorkflow).not.toContain("scripts/legacy_evidence/**");
  });

  it("keeps production deploy to build and wrangler deploy only", () => {
    expect(deployWorkflow).toContain("pnpm run build");
    expect(deployWorkflow).toContain("wrangler deploy");
    expect(deployWorkflow).toContain("wrangler deploy --env preview");
    expect(deployWorkflow).not.toContain("playwright");
    expect(deployWorkflow).not.toContain("pnpm run check");
    expect(deployWorkflow).not.toContain("ensure-remote");
    expect(deployWorkflow).not.toContain("migrations list");
    expect(deployWorkflow).not.toContain("migrations apply");
  });

  it("queues production deploys and D1 migrations in separate concurrency groups", () => {
    expect(deployWorkflow).toContain("group: production-deploy");
    expect(migrateWorkflow).toContain("group: production-migrate");
    expect(deployWorkflow).not.toContain("group: production-migrate");
    expect(migrateWorkflow).not.toContain("group: production-deploy");
    expect(deployWorkflow).not.toContain("production-release");
    expect(migrateWorkflow).not.toContain("production-release");
    expect(deployWorkflow).toContain("cancel-in-progress: false");
    expect(migrateWorkflow).toContain("cancel-in-progress: false");
  });

  it("validates workflow syntax inside the existing static runner", () => {
    expect(ciWorkflow).toContain("uses: docker://rhysd/actionlint:");
  });

  it("applies remote D1 migrations from a separate workflow, not deploy", () => {
    expect(migrateWorkflow).toContain("workflow_dispatch");
    expect(migrateWorkflow).toContain("push:");
    expect(migrateWorkflow).toContain("migrations/**");
    expect(migrateWorkflow).toContain("group: production-migrate");
    expect(migrateWorkflow).toContain("wrangler d1 migrations list jufexk --remote");
    expect(migrateWorkflow).toContain("wrangler d1 migrations apply jufexk --remote");
    expect(migrateWorkflow).toContain(
      "wrangler d1 migrations list jufexk-preview --env preview --remote",
    );
    expect(migrateWorkflow).toContain(
      "wrangler d1 migrations apply jufexk-preview --env preview --remote",
    );
    expect(deployWorkflow).not.toContain("migrations apply");
  });

  it("binds admin student IDs only from an on-demand workflow using the identity secret", () => {
    expect(bindAdminWorkflow).toContain("workflow_dispatch");
    expect(bindAdminWorkflow).not.toContain("push:");
    expect(bindAdminWorkflow).toContain("production-admin-student-bind");
    expect(bindAdminWorkflow).toContain("secrets.CAMPUS_IDENTITY_SECRET");
    expect(bindAdminWorkflow).toContain("JUFEXK_ADMIN_STUDENT_IDS");
    expect(bindAdminWorkflow).toContain(
      "scripts/admin/bind-student-ids.ts --remote --apply",
    );
  });

  it("writes CTA homepages from production GHA, not from a schedule", () => {
    expect(ctaSyncWorkflow).toContain("workflow_dispatch");
    expect(ctaSyncWorkflow).toContain("migrations/0046_teacher_cta_homepage.sql");
    expect(ctaSyncWorkflow).not.toContain("schedule:");
    expect(ctaSyncWorkflow).toContain("production-cta-sync");
    expect(ctaSyncWorkflow).toContain("environment: production");
    expect(ctaSyncWorkflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(ctaSyncWorkflow).toContain("pnpm cta-sync");
    expect(ctaSyncWorkflow).toContain(
      "scripts/cta-sync/apply-remote.ts --remote --apply",
    );
  });

  it("applies a local CTA artifact from a draft release without fetching photos on GHA", () => {
    expect(ctaSyncApplyWorkflow).toContain("workflow_dispatch");
    expect(ctaSyncApplyWorkflow).toContain("release_tag");
    expect(ctaSyncApplyWorkflow).not.toContain("schedule:");
    expect(ctaSyncApplyWorkflow).not.toContain("pnpm cta-sync");
    expect(ctaSyncApplyWorkflow).toContain("production-cta-sync");
    expect(ctaSyncApplyWorkflow).toContain("environment: production");
    expect(ctaSyncApplyWorkflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(ctaSyncApplyWorkflow).toContain("releases/assets/");
    expect(ctaSyncApplyWorkflow).toContain("application/octet-stream");
    expect(ctaSyncApplyWorkflow).toContain("cta-sync.tar.gz");
    expect(ctaSyncApplyWorkflow).not.toContain("gh release download");
    expect(ctaSyncApplyWorkflow).toContain(
      "scripts/cta-sync/apply-remote.ts --remote --apply",
    );
  });

  it("backfills teacher departments from production GHA, not from a schedule", () => {
    expect(teacherDepartmentBackfillWorkflow).toContain("workflow_dispatch");
    expect(teacherDepartmentBackfillWorkflow).not.toContain("schedule:");
    expect(teacherDepartmentBackfillWorkflow).toContain(
      "production-teacher-department-backfill",
    );
    expect(teacherDepartmentBackfillWorkflow).toContain("environment: production");
    expect(teacherDepartmentBackfillWorkflow).toContain(
      "secrets.CLOUDFLARE_API_TOKEN",
    );
    expect(teacherDepartmentBackfillWorkflow).toContain(
      "pnpm teacher-dept-backfill",
    );
    expect(teacherDepartmentBackfillWorkflow).toContain(
      "scripts/teacher-department-backfill/apply-remote.ts --remote --apply",
    );
  });

});
