/**
 * Browser coverage for /latest：全站最新公开课评流。
 */
import { expect, test, type Page } from "@playwright/test";
import {
  REVIEW_FOLD_LABEL,
  REVIEW_PUBLIC_FOLD_EXPAND_LABEL,
} from "../../src/lib/recognition";
import { collectModuleLoadFailures } from "./module-load-failures";

const LATEST = [
  {
    id: "review:12",
    course_id: 8,
    teacher_id: 9,
    course_name: "中国传统文化导论",
    course_code: "GEN0108",
    teacher_name: "测试教师",
    comment: "这门课讲得很清楚，作业量适中。",
    headline: "讲得清楚，作业适中",
    created_at: "2026-08-20 12:00:00",
    author_public_code: 0,
    author_avatar_key: 0,
  },
  {
    id: "historical:abc",
    course_id: 11,
    teacher_id: 12,
    course_name: "篮球",
    course_code: "PE0101",
    teacher_name: "体育教师",
    comment: "课堂气氛好，考试不难。",
    created_at: "2026-08-11 02:00:00",
  },
  {
    id: "review:91",
    course_id: 8,
    teacher_id: 9,
    course_name: "中国茶文化和茶艺",
    course_code: "GEN0201",
    teacher_name: "艾晓玉",
    comment: "折叠正文仍应出现在课评流。",
    headline: "折叠演示：不受欢迎",
    created_at: "2026-08-10 00:00:00",
  },
];

async function mockShellApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
      });
    if (url.pathname === "/api/reviews/latest") {
      const cursor = url.searchParams.get("cursor");
      if (cursor) {
        return route.fulfill({
          json: { items: [LATEST[1]], nextCursor: null },
        });
      }
      return route.fulfill({
        json: { items: [LATEST[0], LATEST[2]], nextCursor: "next-latest" },
      });
    }
    if (url.pathname === "/api/courses" || url.pathname === "/api/teachers")
      return route.fulfill({
        json: { items: [], page: 1, pageSize: 20, total: 0, pages: 1 },
      });
    if (url.pathname === "/api/courses/8")
      return route.fulfill({
        json: {
          course: {
            id: 8,
            code: "GEN0108",
            name: "中国传统文化导论",
            category: "general",
            department: "人文学院",
            teachers: [{ id: 9, name: "测试教师", review_count: 1, rating: 4.6 }],
          },
          reviewCount: 1,
        },
      });
    if (url.pathname === "/api/courses/8/reviews")
      return route.fulfill({
        json: {
          items: [
            {
              id: "review:12",
              course_id: 8,
              teacher_id: 9,
              comment: "这门课讲得很清楚，作业量适中。",
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

function firstLatestArticle(page: Page) {
  return page
    .locator("article")
    .filter({ has: page.getByRole("link", { name: "匿名用户#000000" }) })
    .first();
}

async function expectFooterOutOfInitialViewport(page: Page) {
  const viewport = page.viewportSize();
  const isMobile = (viewport?.width ?? 1280) < 640;
  const footer = page.getByRole("contentinfo");
  if (isMobile) {
    const mounted = page.locator("[data-site-footer]");
    if ((await footer.count()) === 0) {
      if ((await mounted.count()) > 0) {
        await expect(mounted).toBeHidden();
        expect(await mounted.boundingBox()).toBeNull();
      }
      return;
    }
    await expect(footer).toBeHidden();
    return;
  }
  await expect(footer).toHaveCount(1);
  const box = await footer.boundingBox();
  expect(box).toBeTruthy();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual(viewport?.height ?? 0);
}

test("latest page lists newest public reviews and deep-links to the course @mobile-smoke", async ({
  page,
}) => {
  const moduleFailures = collectModuleLoadFailures(page);
  const feedRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/reviews/latest")
      feedRequests.push(request.url());
  });

  await mockShellApi(page);
  await page.goto("/latest", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();
  const article = firstLatestArticle(page);
  const author = article.getByRole("link", { name: "匿名用户#000000" });
  await expect(author).toBeVisible();
  await expect(author).toContainText("匿");
  expect(await page.getByText("点评了").count()).toBeGreaterThanOrEqual(1);
  await expect(
    article.getByRole("link", { name: "中国传统文化导论（测试教师）" }),
  ).toBeVisible();
  await expect(article.getByText("2026-08-20")).toBeVisible();
  await expect(article).not.toHaveClass(/min-h-\[22rem\]/);
  await expect(article).not.toHaveClass(/min-h-\[12rem\]/);
  // 有 headline 的条目优先展示 headline 作为摘要，不再显示正文。
  await expect(article.getByText("讲得清楚，作业适中")).toBeVisible();
  await expect(
    article.getByText("这门课讲得很清楚，作业量适中。"),
  ).toHaveCount(0);
  expect(feedRequests.length).toBeGreaterThan(0);

  await article.getByRole("link", { name: "查看全文" }).click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=9/);
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "点评" })).toBeVisible();
  await expect(
    page.getByText("这门课讲得很清楚，作业量适中。"),
  ).toBeVisible();
  expect(moduleFailures()).toEqual([]);
});

test("latest feed shows threshold-folded reviews without 收起 chrome", async ({
  page,
}) => {
  await mockShellApi(page);
  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();
  await expect(page.getByText("折叠演示：不受欢迎")).toBeVisible();
  await expect(page.getByText(REVIEW_FOLD_LABEL)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: REVIEW_PUBLIC_FOLD_EXPAND_LABEL }),
  ).toHaveCount(0);
});

test("latest empty state keeps the official Card composition", async ({ page }) => {
  await mockShellApi(page);
  await page.route("**/api/reviews/latest*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/latest", { waitUntil: "domcontentloaded" });

  const emptyState = page.getByRole("status").filter({ hasText: "暂时还没有公开课评" });
  await expect(emptyState).toHaveAttribute("data-slot", "card");
  await expect(emptyState).toContainText("暂时还没有公开课评");
});

test("latest feed falls back to comment text when headline is empty", async ({
  page,
}) => {
  await mockShellApi(page);
  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("讲得清楚，作业适中").first()).toBeVisible();

  // 历史行没有 headline（服务端投影为空串），哨兵在视口内时自动取下一页。
  await expect(page.getByText("课堂气氛好，考试不难。")).toBeVisible();
});

test("latest reserves review space while the first page is loading", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
      });
    }
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({ json: { desktopHtml: "", mobileHtml: "", updatedAt: null } });
    }
    if (url.pathname === "/api/reviews/latest") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return route.fulfill({
        json: {
          items: Array.from({ length: 20 }, (_, index) => ({
            ...LATEST[0],
            id: LATEST[0].id + index,
          })),
          nextCursor: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  const loading = page.getByRole("status", { name: "正在加载最新课评" });
  await expect(loading).toBeVisible();
  const isMobile = (page.viewportSize()?.width ?? 1280) < 640;
  const skeletonRows = loading.locator("article");
  await expect(skeletonRows).toHaveCount(isMobile ? 6 : 20);
  await expect(loading.locator('[data-loading-skeleton="true"]')).toHaveCount(
    isMobile ? 6 : 20,
  );
  await expect(skeletonRows.first()).toBeVisible();
  await expect(skeletonRows.first()).toHaveClass(/min-h-\[12rem\]/);
  await expectFooterOutOfInitialViewport(page);
  await expect(page.getByText("讲得清楚，作业适中").first()).toBeVisible();
  await expect
    .poll(async () =>
      page.locator("main > section article:not([aria-hidden='true'])").count(),
    )
    .toBe(20);
  const loadedRows = await page
    .locator("main > section article:not([aria-hidden='true'])")
    .evaluateAll((els) => els.map((element) => element.getBoundingClientRect().height));
  expect(loadedRows).toHaveLength(20);
  expect(Math.max(...loadedRows)).toBeLessThan(240);
  expect(Math.min(...loadedRows)).toBeGreaterThan(80);
  if (!isMobile) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByRole("contentinfo")).toBeVisible();
  } else {
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
  }
});

test("latest uses a smaller loading shell on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({ json: { desktopHtml: "", mobileHtml: "", updatedAt: null } });
    }
    if (url.pathname === "/api/reviews/latest") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  const loading = page.getByRole("status", { name: "正在加载最新课评" });
  await expect(loading).toBeVisible();
  const firstSkeleton = loading.locator("article").first();
  await expect(firstSkeleton).toHaveClass(/min-h-\[12rem\]/);
  await expect(loading.locator("article")).toHaveCount(6);
});

test("latest preserves the reserved shell when the first page has fewer reviews", async ({
  page,
}) => {
  let releaseReviews!: () => void;
  const reviewsGate = new Promise<void>((resolve) => {
    releaseReviews = resolve;
  });
  await page.setViewportSize({ width: 375, height: 720 });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({ json: { desktopHtml: "", mobileHtml: "", updatedAt: null } });
    }
    if (url.pathname === "/api/reviews/latest") {
      await reviewsGate;
      return route.fulfill({ json: { items: LATEST, nextCursor: null } });
    }
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  releaseReviews();
  await expect(page.getByText("讲得清楚，作业适中").first()).toBeVisible();
  await expect(page.locator("main > section article")).toHaveCount(20);
});

test("latest content renders while the viewer session is still pending", async ({ page }) => {
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await mockShellApi(page);
  await page.route("**/api/user/session", async (route) => {
    await sessionGate;
    return route.fulfill({
      json: { authenticated: false, loginPath: "/login", logoutPath: "/logout" },
    });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "登录" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /切换到(暗色|亮色)模式/ }),
  ).toBeVisible();
  await expect(page.getByText("讲得清楚，作业适中")).toBeVisible();
  releaseSession();
});

test("latest does not load the table chunk or eagerly load the status iframe", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await mockShellApi(page);
  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();
  expect(requests.some((url) => url.includes("table-"))).toBe(false);
  expect(requests.some((url) => url.includes("scroll-shadow-"))).toBe(false);
  expect(requests.some((url) => url.includes("heroui-deferred"))).toBe(false);
  expect(requests.some((url) => url.includes("purify"))).toBe(false);
  expect(requests.some((url) => url.includes("search-field-"))).toBe(false);
  expect(requests.some((url) => url.includes("ShellCourseSearch-"))).toBe(false);
  await expect(page.locator("header .search-field__group")).toBeVisible();
  await expect(page.locator('header [data-slot="search-field"]')).toHaveCount(0);
  const latestRequests = requests.filter(
    (url) => new URL(url).pathname === "/api/reviews/latest",
  );
  expect(latestRequests.some((url) => new URL(url).searchParams.get("pageSize") === "10")).toBe(true);
  expect(latestRequests.length).toBeGreaterThanOrEqual(1);
  expect(latestRequests.length).toBeLessThanOrEqual(2);
  // Guest header paints login without the account-menu chunk.
  expect(requests.some((url) => /AccountNavControl/i.test(url))).toBe(false);
  expect(requests.some((url) => /alert-dialog/i.test(url))).toBe(false);
  await expect(page.getByTitle("系统运行状态")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if ((page.viewportSize()?.width ?? 1280) < 640) {
    await expect(page.getByTitle("系统运行状态")).toHaveCount(0);
  } else {
    await expect(page.getByTitle("系统运行状态")).toBeVisible();
  }

  await page.getByRole("searchbox", { name: "搜索课程" }).focus();
  await expect(page.locator("header .search-field__group")).toBeVisible();
  await expect(page.locator('header [data-slot="search-field"]')).toBeAttached();
});

test("latest reuses the HTML-bootstrap banner request", async ({ page }) => {
  let bannerRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/site/banner") {
      bannerRequests += 1;
    }
  });
  await mockShellApi(page);
  await page.route("**/api/site/banner", (route) =>
    route.fulfill({
      json: {
        desktopHtml: "<p>桌面公告</p>",
        mobileHtml: "<p>移动公告</p>",
        updatedAt: "2026-08-30 00:00:00",
      },
    }),
  );

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "全站公告" })).toBeVisible();
  expect(bannerRequests).toBe(1);
});

test("latest keeps the main column stable while a non-empty banner loads", async ({
  page,
}) => {
  let releaseBanner!: () => void;
  const bannerGate = new Promise<void>((resolve) => {
    releaseBanner = resolve;
  });
  await mockShellApi(page);
  await page.route("**/api/site/banner", async (route) => {
    await bannerGate;
    return route.fulfill({
      json: {
        desktopHtml: "<p>桌面公告</p>",
        mobileHtml: "<p>移动公告</p>",
        updatedAt: "2026-08-30 00:00:00",
      },
    });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("讲得清楚，作业适中")).toBeVisible();
  await expect(page.locator("[data-site-banner-placeholder]")).toHaveClass(
    /min-h-\[60px\]/,
  );
  const mainBefore = await page.locator("main").boundingBox();
  const isMobile = (page.viewportSize()?.width ?? 1280) < 640;
  const footerBefore = isMobile ? null : await page.getByRole("contentinfo").boundingBox();
  expect(mainBefore).toBeTruthy();
  if (!isMobile) expect(footerBefore).toBeTruthy();

  releaseBanner();
  await expect(page.getByRole("region", { name: "全站公告" })).toBeVisible();
  const mainAfter = await page.locator("main").boundingBox();
  const footerAfter = isMobile ? null : await page.getByRole("contentinfo").boundingBox();
  expect(mainAfter?.y).toBe(mainBefore?.y);
  if (!isMobile) expect(footerAfter?.y).toBe(footerBefore?.y);
});

test("latest feed keeps 继续加载 as a retry after an auto-load error", async ({
  page,
}) => {
  let cursorCalls = 0;
  await mockShellApi(page);
  await page.route("**/api/reviews/latest*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/reviews/latest") return route.fallback();
    const cursor = url.searchParams.get("cursor");
    if (!cursor) {
      return route.fulfill({
        json: { items: [LATEST[0]], nextCursor: "next-latest" },
      });
    }
    cursorCalls += 1;
    if (cursorCalls === 1) {
      return route.fulfill({ status: 500, json: { error: "继续加载失败" } });
    }
    return route.fulfill({
      json: { items: [LATEST[1]], nextCursor: null },
    });
  });

  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("继续加载失败");
  await expect.poll(() => cursorCalls).toBe(1);
  expect(cursorCalls).toBe(1);

  await page.getByRole("button", { name: "继续加载" }).click();
  await expect(page.getByText("课堂气氛好，考试不难。")).toBeVisible();
  expect(cursorCalls).toBe(2);
});

test("latest feed shows a back-to-top button after scrolling @mobile-smoke", async ({
  page,
}) => {
  await mockShellApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/latest", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "最新课评" })).toBeVisible();

  const backToTop = page.getByRole("button", { name: "回到顶部" });
  await expect(backToTop).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(
    await page.evaluate(() => window.innerHeight - 1),
  );
  await expect(backToTop).toBeVisible();
  await expect(backToTop).toHaveCSS("position", "fixed");

  await backToTop.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(8);
  await expect(backToTop).toHaveCount(0);
});
