import { expect, test, type Page } from "@playwright/test";

async function mockShellApi(
  page: Page,
  options: {
    siteName?: string;
    showScheduleNav?: boolean;
    authenticated?: boolean;
  } = {},
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: {
          siteName: options.siteName ?? "非官方课评@JUFE",
          universityName: "江西财经大学",
          admin: false,
          showScheduleNav: options.showScheduleNav === true,
        },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: options.authenticated
          ? {
              authenticated: true,
              csrfToken: "csrf-user",
              loginPath: "/login",
              logoutPath: "/logout",
              handle: "匿名用户#000001",
              avatar_key: 0,
            }
          : {
              authenticated: false,
              loginPath: "/login",
              logoutPath: "/logout",
            },
      });
    }
    if (url.pathname === "/api/user/profile") {
      return route.fulfill({
        json: {
          public_code: 1,
          handle: "匿名用户#000001",
          avatar_key: 0,
          reviews: [],
          follows: [],
          review_count: 0,
          follow_count: 0,
          following_user_count: 0,
          follower_count: 0,
        },
      });
    }
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({
        json: { desktopHtml: "", mobileHtml: "", updatedAt: null },
      });
    }
    if (url.pathname === "/api/reviews/latest") {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (url.pathname === "/api/courses" || url.pathname === "/api/teachers") {
      return route.fulfill({
        json: { items: [], page: 1, pageSize: 20, total: 0, pages: 1 },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

function isDesktopNav(page: Page) {
  return (page.viewportSize()?.width ?? 0) >= 1280;
}

function browseNav(page: Page) {
  return page.getByRole("navigation", { name: "主导航" });
}

/** Both shell variants expose semantic navigation links. */
function browseNavItem(page: Page, name: string) {
  return browseNav(page).getByRole("link", { name, exact: true });
}

async function expectBrowseItemCurrent(page: Page, name: string, current: boolean) {
  const item = browseNavItem(page, name);
  if (current) await expect(item).toHaveAttribute("aria-current", "page");
  else await expect(item).not.toHaveAttribute("aria-current", "page");
}

test("non-latest entry pages do not preload the latest route chunk", async ({ page }) => {
  const latestChunkRequests: string[] = [];
  page.on("request", (request) => {
    if (/LatestPage/i.test(request.url())) latestChunkRequests.push(request.url());
  });

  await mockShellApi(page);
  await page.goto("/courses");
  await expect(browseNavItem(page, "课程")).toHaveAttribute("aria-current", "page");
  expect(latestChunkRequests).toEqual([]);
});

test("main nav is 课评/课程 on mobile, plus 导师 on desktop, with a center course search @mobile-smoke", async ({
  page,
}) => {
  const renderWarnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning" && msg.text().includes("Unexpected DOM element")) {
      renderWarnings.push(msg.text());
    }
  });

  await mockShellApi(page);
  await page.goto("/courses");

  const nav = browseNav(page);
  const courseItem = browseNavItem(page, "课程");
  const latestItem = browseNavItem(page, "课评");
  const mentorLink = nav.getByRole("link", { name: "导师" });
  const isXl = isDesktopNav(page);

  await expect(courseItem).toBeVisible();
  await expect(latestItem).toBeVisible();
  // DEV 与生产一样：没有 API showScheduleNav 就不挂排课入口。
  await expect(browseNavItem(page, "排课模拟")).toHaveCount(0);
  // 教师 / 写评价 导航项已下线：写评价只从课程页「写点评」进入。
  await expect(browseNavItem(page, "教师")).toHaveCount(0);
  await expect(browseNavItem(page, "写评价")).toHaveCount(0);
  if (isXl) {
    const navLinks = nav.getByRole("link");
  await expect(mentorLink).toBeVisible();
    await expect(navLinks).toHaveCount(3);
    await expect(navLinks.nth(0)).toHaveText("课评");
    await expect(navLinks.nth(1)).toHaveText("课程");
    await expect(navLinks.nth(2)).toHaveText("导师");
    await expect(mentorLink).toHaveAttribute(
      "href",
      "https://pi-review.com/universities/661",
    );
    await expect(mentorLink).toHaveAttribute("target", "_blank");
    await expect(mentorLink).toHaveAttribute("rel", /noreferrer/);
  } else {
    // 浏览页窄屏只挂课评 / 课程。个人面（/profile /account /submit）另测。
    const navLinks = nav.getByRole("link");
    await expect(mentorLink).toHaveCount(0);
    await expect(navLinks).toHaveCount(2);
    await expect(navLinks.nth(0)).toHaveText("课评");
    await expect(navLinks.nth(1)).toHaveText("课程");
  }
  await expect(nav.getByRole("button")).toHaveCount(0);
  await expect(nav.locator("a button")).toHaveCount(0);

  await expectBrowseItemCurrent(page, "课程", true);
  await expectBrowseItemCurrent(page, "课评", false);

  // 居中搜索提交到 /courses?q=...。
  const search = page.getByRole("searchbox", { name: "搜索课程" });
  await expect(search).toBeVisible();
  await search.fill("高等数学");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await search.press("Enter");
  await expect(page).toHaveURL(/\/courses\?q=/);
  await expect(search).toHaveValue("高等数学");

  // 课评 → /latest；进入后课评高亮、课程不再高亮。
  await latestItem.click();
  await expect(page).toHaveURL(/\/latest$/);
  await expect(
    page.getByRole("heading", { name: "最新课评" }),
  ).toBeVisible();
  await expectBrowseItemCurrent(page, "课评", true);
  await expectBrowseItemCurrent(page, "课程", false);
  expect(renderWarnings).toEqual([]);
});

test("schedule nav appears only when config.showScheduleNav is true", async ({
  page,
}) => {
  await mockShellApi(page, { showScheduleNav: true });
  await page.goto("/courses");

  const nav = browseNav(page);
  const scheduleItem = browseNavItem(page, "排课模拟");
  const isXl = isDesktopNav(page);
  await expect(scheduleItem).toBeVisible();
  // 窄屏不挂导师外链：课评 / 课程 / 排课模拟。桌面再加导师。
  if (isXl) {
    await expect(nav.getByRole("link")).toHaveCount(4);
  } else {
    await expect(nav.getByRole("link")).toHaveCount(3);
  }
  await scheduleItem.click();
  await expect(page).toHaveURL(/\/schedule$/);
  const desktopNotice = page.getByRole("alertdialog", { name: "本功能只支持电脑端" });
  if (await desktopNotice.isVisible()) {
    await desktopNotice.getByRole("button", { name: "知道了" }).click();
  }
  await expect(page.getByRole("heading", { name: "排课模拟" })).toBeVisible();
  await expectBrowseItemCurrent(page, "排课模拟", true);
});

test("mobile header hides 课评/课程 tabs on personal account surfaces", async ({
  page,
}) => {
  const isXl = isDesktopNav(page);

  await mockShellApi(page, { authenticated: true });
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/profile$/);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "非官方课评@JUFE" }),
  ).toHaveAttribute("href", "/latest");
  await expect(page.getByRole("searchbox", { name: "搜索课程" })).toBeVisible();

  if (isXl) {
    await expect(browseNavItem(page, "课评")).toBeVisible();
    await expect(browseNavItem(page, "课程")).toBeVisible();
    await expect(browseNav(page).getByRole("link", { name: "导师" })).toBeVisible();
    return;
  }

  await expect(browseNav(page)).toHaveCount(0);

  await page.goto("/account");
  await expect(page).toHaveURL(/\/profile$/);
  await expect(browseNav(page)).toHaveCount(0);

  await page.goto("/submit");
  await expect(page).toHaveURL(/\/submit$/);
  await expect(browseNav(page)).toHaveCount(0);

  await mockShellApi(page, { authenticated: false });
  await page.goto("/account");
  await expect(page).toHaveURL(/\/account$/);
  await expect(browseNav(page)).toHaveCount(0);

  await page.goto("/latest");
  await expect(browseNavItem(page, "课评")).toBeVisible();
  await expect(browseNavItem(page, "课程")).toBeVisible();
});

test("brand link uses the site name and goes to /latest", async ({ page }) => {
  await mockShellApi(page);
  await page.goto("/courses");

  const brand = page.getByRole("banner").getByRole("link", { name: "非官方课评@JUFE" });
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute("href", "/latest");
  await brand.click();
  await expect(page).toHaveURL(/\/latest$/);
  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();
});

test("root path opens the latest feed", async ({ page }) => {
  await mockShellApi(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/latest$/);
  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();
  await expectBrowseItemCurrent(page, "课评", true);
});

test("guests see login and theme toggle immediately on latest @mobile-smoke", async ({
  page,
}) => {
  await mockShellApi(page);
  await page.goto("/latest", { waitUntil: "domcontentloaded" });

  const login = page.getByRole("link", { name: "登录" });
  const toggle = page.getByRole("button", { name: /切换到(暗色|亮色)模式/ });
  await expect(login).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(
    page.locator("header span.inline-block.size-8.shrink-0[aria-hidden]"),
  ).toHaveCount(0);
  await expect(page.locator("header span.inline-block.h-8.w-12[aria-hidden]")).toHaveCount(0);

  const before = await toggle.getAttribute("aria-label");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-label", before ?? "");
});

test("guests get a real login link outside the nav", async ({ page }) => {
  await mockShellApi(page);
  await page.goto("/courses");

  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("link", { name: "登录" })).toHaveCount(0);
  const login = page.getByRole("link", { name: "登录" });
  await expect(login).toBeVisible();
  await login.click();
  await expect(page).toHaveURL(/\/login\?from=%2Fcourses$/);
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
});
