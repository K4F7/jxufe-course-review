import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import adminRoutes from "../src/routes/admin";
import authRoutes from "../src/routes/auth";
import biRoutes from "../src/routes/bi";
import importRoutes from "../src/routes/imports";
import ordinaryUserRoutes from "../src/routes/ordinary-user";
import programPlanRoutes from "../src/routes/program-plan";
import publicCatalogRoutes from "../src/routes/public-catalog";
import scheduleOfferingRoutes from "../src/routes/schedule-offerings";
import { adminAuth, adminHeaders as sessionHeaders } from "./admin-session";
import {
  ordinaryWriteHeaders,
  ordinaryWriteSession,
  WRITE_ORIGIN,
} from "./ordinary-write-session";

const routeKey = (route: { method: string; path: string }) =>
  `${route.method} ${route.path}`;

async function adminHeaders() {
  return sessionHeaders(await adminAuth(), WRITE_ORIGIN);
}

describe("domain route composition", () => {
  it("assembles every domain router and keeps the admin guard before import routes", () => {
    const appKeys = app.routes.map(routeKey);
    const domainRoutes = [
      biRoutes,
      publicCatalogRoutes,
      scheduleOfferingRoutes,
      programPlanRoutes,
      authRoutes,
      ordinaryUserRoutes,
      adminRoutes,
      importRoutes,
    ].flatMap((router) => router.routes.map(routeKey));

    expect(appKeys).toEqual(["ALL /assets/*", "ALL /api/*", ...domainRoutes]);
    const adminGuard = appKeys.indexOf("ALL /api/admin/*");
    expect(adminGuard).toBeGreaterThan(-1);
    for (const route of importRoutes.routes) {
      expect(appKeys.indexOf(routeKey(route))).toBeGreaterThan(adminGuard);
    }
  });

  it("keeps representative routes in their owning domains", () => {
    expect(biRoutes.routes.map(routeKey)).toContain("POST /api/bi/beacon");
    expect(adminRoutes.routes.map(routeKey)).toContain("GET /api/admin/bi");
    expect(publicCatalogRoutes.routes.map(routeKey)).toContain(
      "GET /api/courses",
    );
    expect(scheduleOfferingRoutes.routes.map(routeKey)).toContain(
      "GET /api/schedule-offerings",
    );
    expect(programPlanRoutes.routes.map(routeKey)).toContain(
      "GET /api/program-plan",
    );
    expect(importRoutes.routes.map(routeKey)).toContain(
      "POST /api/admin/import/program-plan",
    );
    expect(authRoutes.routes.map(routeKey)).toContain("POST /api/auth/cas");
    expect(authRoutes.routes.map(routeKey)).toContain("POST /api/auth/dev");
    expect(authRoutes.routes.map(routeKey)).toEqual(
      expect.arrayContaining([
        "GET /api/ehall/session",
        "DELETE /api/ehall/session",
        "POST /api/ehall/launch",
      ]),
    );
    expect(ordinaryUserRoutes.routes.map(routeKey)).toContain(
      "POST /api/reviews",
    );
    expect(ordinaryUserRoutes.routes.map(routeKey)).toEqual(
      expect.arrayContaining([
        "GET /api/user/notifications",
        "GET /api/user/notifications/unread-count",
        "POST /api/user/notifications/read",
      ]),
    );
    expect(adminRoutes.routes.map(routeKey)).toContain(
      "PATCH /api/admin/reviews/:id",
    );
    expect(adminRoutes.routes.map(routeKey)).toContain(
      "POST /api/admin/student-bindings",
    );
    expect(adminRoutes.routes.map(routeKey)).toContain(
      "GET /api/admin/summaries/qualifying",
    );
    expect(adminRoutes.routes.map(routeKey)).toContain(
      "POST /api/admin/summaries/recompute",
    );
    expect(importRoutes.routes.map(routeKey)).toContain(
      "POST /api/admin/catalog-baseline/uploads",
    );
    expect(importRoutes.routes.map(routeKey)).toContain(
      "POST /api/admin/historical-review-packages/:package/imports",
    );
  });

  it("applies the admin guard to the separately composed import router", async () => {
    const response = await SELF.fetch(
      `${WRITE_ORIGIN}/api/admin/catalog-baseline/status`,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("学号"),
    });
  });
});

describe("request schemas", () => {
  it("rejects structurally invalid ordinary-user bodies without writing", async () => {
    const session = await ordinaryWriteSession("route-schema-invalid");
    const beforeReviews = await env.DB.prepare(
      "SELECT COUNT(*) count FROM reviews",
    ).first<{
      count: number;
    }>();
    const review = await SELF.fetch(`${WRITE_ORIGIN}/api/reviews`, {
      method: "POST",
      headers: ordinaryWriteHeaders(session),
      body: "[]",
    });
    expect(review.status).toBe(400);

    const beforeRequests = await env.DB.prepare(
      "SELECT COUNT(*) count FROM catalog_requests",
    ).first<{ count: number }>();
    const catalogRequest = await SELF.fetch(
      `${WRITE_ORIGIN}/api/catalog-requests`,
      {
        method: "POST",
        headers: ordinaryWriteHeaders(session),
        body: JSON.stringify({
          kind: "course",
          courseCode: "SCHEMA101",
          courseName: "Schema 测试课",
          category: "general",
          teacherSourceLabel: "Schema 教师",
          review: [],
        }),
      },
    );
    expect(catalogRequest.status).toBe(400);
    expect(await catalogRequest.json()).toMatchObject({
      error: "随附评价格式无效",
    });

    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM reviews").first(),
    ).toMatchObject(beforeReviews ?? {});
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM catalog_requests",
      ).first(),
    ).toMatchObject(beforeRequests ?? {});
  });

  it("rejects invalid admin arrays and import envelopes at the HTTP boundary", async () => {
    const headers = await adminHeaders();
    const offering = await SELF.fetch(`${WRITE_ORIGIN}/api/admin/offerings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        courseId: 1,
        term: "2026-2027-1",
        section: "A01",
        teacherIds: [1, "bad"],
      }),
    });
    expect(offering.status).toBe(400);
    expect(await offering.json()).toMatchObject({ error: "任课教师列表无效" });

    const relationImport = await SELF.fetch(
      `${WRITE_ORIGIN}/api/admin/import/relations/preview`,
      { method: "POST", headers, body: "[]" },
    );
    expect(relationImport.status).toBe(422);
    expect(await relationImport.json()).toMatchObject({
      error: expect.stringContaining("补充包"),
    });

    const chunk = await SELF.fetch(
      `${WRITE_ORIGIN}/api/admin/catalog-baseline/uploads/schema/chunks/-1`,
      { method: "PUT", headers, body: "{}" },
    );
    expect(chunk.status).toBe(400);
    expect(await chunk.json()).toMatchObject({ error: "上传分块路径无效" });

    const preview = await SELF.fetch(
      `${WRITE_ORIGIN}/api/admin/catalog-baseline/uploads/schema/preview?page=not-a-page`,
      { headers },
    );
    expect(preview.status).toBe(400);
    expect(await preview.json()).toMatchObject({ error: "预览参数无效" });
  });
});
