/**
 * Browser coverage for 公开编号 surfaces (#493): /u/000000 学长学姐页、
 * 点评条目上的匿名用户#xxxxxx 链接。
 */
import { expect, test, type Page } from "@playwright/test";

async function mockShell(page: Page, extra: (url: URL) => unknown | null) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const custom = extra(url);
    if (custom) return route.fulfill({ json: custom });
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
      });
    if (url.pathname === "/api/courses")
      return route.fulfill({
        json: { items: [], page: 1, pageSize: 20, total: 0, pages: 1 },
      });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

test("reserved handle page shows 学长学姐 copy and follow plus course count", async ({
  page,
}) => {
  await mockShell(page, (url) => {
    if (url.pathname === "/api/u/000000") {
      return {
        public_code: 0,
        handle: "匿名用户#000000",
        avatar_key: 0,
        reserved: true,
        followable: false,
        viewer_followed: false,
        viewer_is_self: false,
        note: "来自以前的学长学姐的评价",
        review_count: 3,
        following_count: 0,
        follower_count: 0,
        reviews: Array.from({ length: 50 }, (_, index) => ({
          id: `review:${index + 1}`,
          course_id: 8,
          teacher_id: 9,
          course_name: "中国传统文化导论",
          course_code: "GEN0108",
          teacher_name: "测试教师",
          comment: index === 0 ? "以前的评价" : `以前的评价 ${index}`,
          created_at: "2024-01-01 00:00:00",
          author_public_code: 0,
          author_avatar_key: 0,
        })),
      };
    }
    return null;
  });

  await page.goto("/u/000000");
  await expect(
    page.getByRole("heading", { level: 1, name: "匿名用户#000000" }),
  ).toBeVisible();
  const profileCard = page.locator('[aria-label="公开编号"]');
  const courseCount = (page.viewportSize()?.width ?? 1280) < 768 ? "3" : "3 门课程";
  await expect(profileCard.getByText(courseCount, { exact: true })).toBeVisible();
  await expect(page.getByText("来自以前的学长学姐的评价").first()).toBeVisible();
  await expect(
    profileCard.getByText("来自以前的学长学姐的评价"),
  ).toHaveCount(0);
  await expect(profileCard.getByText("50 门课程")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "关注" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "中国传统文化导论（测试教师）" }).first(),
  ).toBeVisible();
});

test("reserved handle page can follow when logged in", async ({ page }) => {
  let followed = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/u/000000" && request.method() === "GET")
      return route.fulfill({
        json: {
          public_code: 0,
          handle: "匿名用户#000000",
          avatar_key: 0,
          reserved: true,
          followable: true,
          viewer_followed: followed,
          viewer_is_self: false,
          note: "来自以前的学长学姐的评价",
          review_count: 3,
          following_count: 0,
          follower_count: followed ? 1 : 0,
          reviews: [],
        },
      });
    if (url.pathname === "/api/u/000000/follow") {
      followed = request.method() === "PUT";
      return route.fulfill({ json: { viewer_followed: followed } });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/u/000000");
  await expect(
    page.getByRole("heading", { level: 1, name: "匿名用户#000000" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关注" }).click();
  await expect(page.getByRole("button", { name: "取消关注" })).toBeVisible();
});

test("follow error stays on the loaded profile", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/u/000002" && request.method() === "GET")
      return route.fulfill({
        json: {
          public_code: 2,
          handle: "匿名用户#000002",
          avatar_key: 2,
          reserved: false,
          followable: true,
          viewer_followed: false,
          viewer_is_self: false,
          note: null,
          review_count: 0,
          following_count: 0,
          follower_count: 0,
          reviews: [],
        },
      });
    if (url.pathname === "/api/u/000002/follow") {
      return route.fulfill({
        status: 500,
        json: { error: "暂时无法关注" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/u/000002");
  await expect(
    page.getByRole("heading", { level: 1, name: "匿名用户#000002" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关注" }).click();
  await expect(page.getByText("关注失败")).toBeVisible();
  await expect(page.getByText("暂时无法关注")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "匿名用户#000002" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "关注" })).toBeVisible();
  await expect(page.getByText("公开主页加载失败")).toHaveCount(0);
});

test("self profile hides the follow button", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/u/000002" && route.request().method() === "GET")
      return route.fulfill({
        json: {
          public_code: 2,
          handle: "匿名用户#000002",
          avatar_key: 2,
          reserved: false,
          followable: false,
          viewer_followed: false,
          viewer_is_self: true,
          note: null,
          review_count: 0,
          following_count: 0,
          follower_count: 0,
          reviews: [],
        },
      });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/u/000002");
  await expect(
    page.getByRole("heading", { level: 1, name: "匿名用户#000002" }),
  ).toBeVisible();
  await expect(page.locator('[aria-label="公开编号"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "关注" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消关注" })).toHaveCount(0);
});
