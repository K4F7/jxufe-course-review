/**
 * /teachers list is gone: course empty states no longer rescue into a teacher catalog.
 */
import { expect, test, type Page } from "@playwright/test";

async function mockEmptyCourses(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: {
          siteName: "非官方课评@JUFE",
          universityName: "江西财经大学",
          admin: false,
        },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: {
          authenticated: false,
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    }
    if (url.pathname === "/api/courses") {
      return route.fulfill({
        json: {
          items: [],
          page: 1,
          pageSize: 20,
          total: 0,
          pages: 1,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

test("courses empty query does not hint at a teacher catalog @pr-smoke", async ({
  page,
}) => {
  await mockEmptyCourses(page);
  await page.goto("/courses?q=张三");

  await expect(page.getByText("没有找到匹配「张三」的课程")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /教师资料有 \d+ 位匹配/ }),
  ).toHaveCount(0);
});
