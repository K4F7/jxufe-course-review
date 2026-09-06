import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);

const REVIEW = {
  id: "review:101",
  course_id: 8,
  teacher_id: 2,
  course_name: "中级财务会计",
  course_code: "ACC2101",
  teacher_name: "林晓雯",
  comment: "例题扎实，作业量适中。",
  headline: "例题扎实值得选",
  overall: 5,
  term: "2024-2025-1",
  created_at: "2025-09-12 10:00:00",
  endorsement_count: 0,
  endorsable: false,
  author_public_code: 3,
  author_avatar_key: 2,
};

async function mockCoursePage(page: Page, adminAuthed: boolean) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: {
          authenticated: adminAuthed,
          csrfToken: adminAuthed ? "csrf-user" : undefined,
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    }
    if (url.pathname === "/api/admin/session") {
      if (!adminAuthed) {
        return route.fulfill({
          status: 401,
          json: { error: "请先用已绑定的学号登录" },
        });
      }
      return route.fulfill({
        json: { ok: true, kind: "admin", source: "student", csrfToken: "csrf-admin" },
      });
    }
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({ json: { desktopHtml: "", mobileHtml: "", updatedAt: null } });
    }
    if (url.pathname === "/api/user/notifications/unread-count") {
      return route.fulfill({ json: { count: 0 } });
    }
    if (url.pathname === "/api/courses/8") {
      return route.fulfill({
        json: {
          course: {
            id: 8,
            code: "ACC2101",
            name: "中级财务会计",
            category: "general",
            department: "会计学院",
            teachers: [
              {
                id: 2,
                name: "林晓雯",
                department: "会计学院",
                review_count: 1,
                follow_count: 0,
                recommend_count: 0,
                not_recommend_count: 0,
                terms: ["2024-2025-1"],
              },
            ],
          },
          reviewCount: 1,
        },
      });
    }
    if (url.pathname === "/api/courses/8/reviews") {
      return route.fulfill({
        json: { items: [REVIEW], nextCursor: null, total: 1 },
      });
    }
    if (url.pathname === "/api/teachers/2") {
      return route.fulfill({
        json: {
          teacher: { id: 2, name: "林晓雯", department: "会计学院" },
          courses: [],
          reviews: [],
          reviewCount: 1,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

test("guests never see the admin dock or per-review admin actions", async ({
  page,
}) => {
  await mockCoursePage(page, false);
  await page.goto("/courses/8?teacher=2", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /中级财务会计（林晓雯）/ })).toBeVisible();
  await expect(page.locator("[data-review-admin-dock]")).toHaveCount(0);
  await expect(page.locator("[data-review-admin]")).toHaveCount(0);
  await expect(page.getByText("管理动作（仅管理员可见）")).toHaveCount(0);
});

test("admin dock switch hides review actions until turned on", async ({
  page,
}) => {
  await mockCoursePage(page, true);
  await page.goto("/courses/8?teacher=2", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /中级财务会计（林晓雯）/ })).toBeVisible();
  await expect(page.locator("[data-review-admin-dock]")).toBeVisible();
  await expect(page.getByText("管理动作（仅管理员可见）")).toHaveCount(0);
  await expect(page.locator("[data-review-admin]")).toHaveCount(0);

  await page.getByRole("button", { name: "管理动作" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "管理动作" })).toBeVisible();
  const chromeSwitch = drawer.getByRole("switch");
  await expect(chromeSwitch).not.toBeChecked();
  await drawer.locator("[data-slot='switch-control']").click();
  await expect(chromeSwitch).toBeChecked();

  await drawer.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByText("管理动作（仅管理员可见）")).toBeVisible();
  await expect(page.locator("[data-review-admin]")).toBeVisible();
  await expect(page.getByRole("button", { name: "屏蔽" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查询作者资料" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除" })).toBeVisible();
});

test("admin dock switch hides comment delete and leaves 公告 alone", async ({
  page,
}) => {
  await mockCoursePage(page, true);
  await page.goto("/courses/8?atlas=1&preview=review-comments&teacher=2", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: /中级财务会计（林晓雯）/ })).toBeVisible();
  await expect(page.locator("[data-review-admin-dock]")).toBeVisible();
  await expect(page.getByRole("button", { name: "设置公告" })).toBeVisible();

  await page.getByRole("button", { name: /评论，当前 2 条回复/ }).first().click();
  await expect(page.getByRole("button", { name: "回复 匿名用户#000001" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除 匿名用户#000001 的回复" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "屏蔽" })).toHaveCount(0);

  await page.getByRole("button", { name: "管理动作" }).click();
  const drawer = page.getByRole("dialog");
  const chromeSwitch = drawer.getByRole("switch");
  await expect(chromeSwitch).not.toBeChecked();
  await drawer.locator("[data-slot='switch-control']").click();
  await expect(chromeSwitch).toBeChecked();
  await drawer.getByRole("button", { name: "关闭" }).click();

  await expect(
    page.getByRole("button", { name: "删除 匿名用户#000001 的回复" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "回复 匿名用户#000001" })).toBeVisible();
  await expect(page.getByRole("button", { name: "设置公告" })).toBeVisible();
});

test("preview=admin does not force course 公告 editor or review chrome on", async ({
  page,
}) => {
  await mockCoursePage(page, false);
  await page.goto("/courses/8?preview=admin&teacher=2", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: /中级财务会计（林晓雯）/ })).toBeVisible();
  await expect(page.locator("[data-review-admin-dock]")).toBeVisible();
  await expect(page.getByRole("button", { name: "设置公告" })).toHaveCount(0);
  await expect(page.getByText("管理动作（仅管理员可见）")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "屏蔽" })).toHaveCount(0);
});
