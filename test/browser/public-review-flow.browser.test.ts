/**
 * Browser coverage for the Issue #402 course detail page: 始终按 课程×教师
 * 关系展示（默认落到点评数最多的关系），右栏切换其他老师 / 这位老师的其他课，
 * 点评区带排序与认可，写点评入口进 /submit 预设关系。
 *
 * 后端 descope（#410 的缺口不在 #402 实现）：目录走 /api/courses 前端展开
 * 关系行；点评条目没有逐条 overall/term/created_at（无星级、无学期、
 * 无学期/评分筛选）；四维档位用 #373 的 dimensionLabels 走 FourDimLine，
 * 旧快照显示维度均分 Chip；有 overall 时星级旁侧用投稿页 overallCaption。
 */
import { expect, test, type Page } from "@playwright/test";
import { collectModuleLoadFailures } from "./module-load-failures";

const teacherNineReviews = Array.from({ length: 21 }, (_, index) => ({
  id: `historical:review-${String(index + 1).padStart(2, "0")}`,
  course_id: 8,
  teacher_id: 9,
  course_name: "中国传统文化导论",
  course_code: "GEN0108",
  teacher_name: "测试教师",
  comment: `匿名评价 ${index + 1}，正文包含足够长的内容用于验证窄屏布局不会溢出或覆盖目录上下文。`,
  overall: index === 0 ? 5 : null,
  created_at: "2026-08-11 02:00:00",
  endorsement_count: 0,
  endorsable: true,
}));

const teacherTenReviews = [1, 2].map((index) => ({
  id: `historical:other-${index}`,
  course_id: 8,
  teacher_id: 10,
  course_name: "中国传统文化导论",
  course_code: "GEN0108",
  teacher_name: "另一位教师",
  comment: `另一位教师的评价 ${index}，用于验证同课切换教师时的对照与缓存恢复。`,
  endorsement_count: 0,
  endorsable: true,
}));

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config")
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    if (url.pathname === "/api/user/session")
      return route.fulfill({
        json: {
          authenticated: false,
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/courses" && !url.pathname.includes("/reviews")) {
      // 目录：课程级行，前端按 teacher_refs 展开成 课程×教师 关系行。
      const items = [
        {
          id: 8,
          code: "GEN0108",
          name: "中国传统文化导论",
          category: "general",
          department: "人文学院",
          review_count: 23,
          rating: null,
          teacher_refs: "9:测试教师,10:另一位教师",
        },
        {
          id: 10,
          code: "EMPTY",
          name: "暂无文字评价课程",
          category: "general",
          department: "测试学院",
          review_count: 0,
          rating: null,
        },
      ];
      const searched = url.searchParams.has("q") && url.searchParams.get("q") !== "";
      return route.fulfill({
        json: {
          items: searched ? [items[1], items[0]] : items,
          page: 1,
          pageSize: 20,
          total: 2,
          pages: 1,
        },
      });
    }
    if (url.pathname === "/api/courses/8")
      return route.fulfill({
        json: {
          course: {
            id: 8,
            code: "GEN0108",
            name: "中国传统文化导论",
            category: "general",
            department: "人文学院",
            credits: 3,
            enrollment_category: "通识选修",
            teaching_type: "理论课",
            course_level: "哲学、思维与语言",
            teachers: [
              {
                id: 9,
                name: "测试教师",
                department: "人文学院",
                review_count: 21,
                rating: 4.6,
                dimensionLabels: [
                  { id: "difficulty", label: "课程难度", option: "中等" },
                  { id: "homework", label: "作业多少", option: "不多" },
                  { id: "grading", label: "给分好坏", option: "一般" },
                  { id: "gain", label: "收获多少", option: "很多" },
                ],
                follow_count: 0,
                recommend_count: 0,
                not_recommend_count: 0,
              },
              {
                id: 10,
                name: "另一位教师",
                department: "信息学院",
                review_count: 2,
                rating: null,
                dimensionLabels: null,
                follow_count: 0,
                recommend_count: 0,
                not_recommend_count: 0,
              },
            ],
          },
          reviewCount: 23,
        },
      });
    if (url.pathname === "/api/courses/8/reviews") {
      const teacherId = url.searchParams.get("teacherId");
      if (teacherId === "9") {
        if (url.searchParams.has("cursor"))
          return route.fulfill({
            json: { items: teacherNineReviews.slice(20), nextCursor: null, total: 21 },
          });
        return route.fulfill({
          json: {
            items: teacherNineReviews.slice(0, 20),
            nextCursor: "next-page",
            total: 21,
          },
        });
      }
      if (teacherId === "10") {
        return route.fulfill({
          json: { items: teacherTenReviews, nextCursor: null, total: 2 },
        });
      }
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (url.pathname === "/api/courses/10")
      return route.fulfill({
        json: {
          course: {
            id: 10,
            code: "EMPTY",
            name: "暂无文字评价课程",
            category: "general",
            department: "测试学院",
            teachers: [],
          },
          reviewCount: 0,
        },
      });
    if (url.pathname === "/api/teachers/9")
      return route.fulfill({
        json: {
          teacher: {
            id: 9,
            name: "测试教师",
            department: "人文学院",
            title: "讲师",
            rating: 4.6,
          },
          courses: [
            {
              id: 8,
              code: "GEN0108",
              name: "中国传统文化导论",
              category: "general",
              department: "人文学院",
              review_count: 21,
              rating: 4.6,
            },
            {
              id: 12,
              code: "GEN0201",
              name: "写作与沟通",
              category: "general",
              department: "人文学院",
              review_count: 3,
              rating: 4.2,
            },
            {
              id: 13,
              code: "MARX1001",
              name: "毛泽东思想和中国特色社会主义理论体系概论",
              category: "general",
              department: "马克思主义学院",
              review_count: 2,
              rating: 4.1,
            },
          ],
          reviews: [],
          reviewCount: 21,
          nextReviewCursor: null,
        },
      });
    if (url.pathname === "/api/teachers/10")
      return route.fulfill({
        json: {
          teacher: { id: 10, name: "另一位教师", department: "信息学院", title: "讲师" },
          courses: [
            {
              id: 8,
              code: "GEN0108",
              name: "中国传统文化导论",
              category: "general",
              department: "人文学院",
              review_count: 2,
              rating: null,
            },
          ],
          reviews: [],
          reviewCount: 2,
          nextReviewCursor: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

test.beforeEach(async ({ page }) => mockApi(page));

function reviewItems(page: Page) {
  return page.getByRole("list", { name: "评价列表" }).getByRole("listitem");
}

test("course detail defaults to the most-reviewed relation", async ({
  page,
}) => {
  const reviewRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/courses/8/reviews")
      reviewRequests.push(url.search);
  });

  await page.goto("/courses/8");

  // 未带 teacher 参数：落到点评数最多的 测试教师 关系。
  const heading = page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ });
  await expect(heading).toBeVisible();
  const teacherInTitle = heading.getByRole("link", { name: "测试教师" });
  await expect(teacherInTitle).toHaveAttribute("href", "/teachers/9");
  await expect(page.getByText("4.6", { exact: true })).toBeVisible();
  await expect(page.getByText("（21 人评价）")).toBeVisible();
  await expect(page.getByText("课程号：GEN0108")).toBeVisible();
  await expect(page.getByText("课程难度：中等")).toBeVisible();
  await expect(page.getByText("学期 2026 春 2025 秋")).toHaveCount(0);
  await expect(page.getByText("选课类别：")).toBeVisible();
  await expect(page.getByText("通识").first()).toBeVisible();
  await expect(page.getByText("开课单位：")).toBeVisible();
  await expect(page.getByText("人文学院").first()).toBeVisible();
  await expect(page.getByText("学分：")).toBeVisible();
  await expect(page.getByText("3.0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "关注" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关注" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "推荐", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "不推荐" })).toBeVisible();
  // AI 总结占位块与免责声明（该关系未生成总结时）。
  await expect(
    page.getByRole("heading", { name: "AI 总结" }),
  ).toBeVisible();
  await expect(
    page.getByText("AI 总结为根据点评内容自动生成，仅供参考"),
  ).toBeVisible();

  await expect(page.getByRole("heading", { name: "点评" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "写点评" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /排序：从新到旧/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /学期/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /评分/ })).toBeVisible();
  await expect(page.getByText("21 条点评")).toBeVisible();
  await expect(reviewItems(page)).toHaveCount(20);
  expect(
    reviewRequests.filter((search) => search.includes("teacherId=9")),
  ).toHaveLength(1);

  // 条目：匿名用户 + 正文；历史行也有认可 / 评论 / 分享。
  const first = reviewItems(page).first();
  await expect(first).toContainText("匿名用户");
  await expect(first.getByText("必选")).toBeVisible();
  await expect(first.getByText("2026 春")).toHaveCount(0);
  await expect(first).toContainText("2026-08-11");
  await expect(first).toContainText("匿名评价 1");
  await expect(
    first.getByRole("button", { name: /认可/ }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: /评论/ }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "分享" }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "学过" }),
  ).toHaveCount(0);

  // 右栏：老师卡 + 其他老师 + 这位老师的其他课。
  const aside = page.locator("aside");
  await expect(aside.getByText("测试教师", { exact: true })).toBeVisible();
  await expect(aside.getByText("教师主页：")).toHaveCount(0);
  await expect(aside.getByRole("link", { name: /教师主页/ })).toHaveCount(0);
  await expect(
    aside.locator("img[src*='heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/']"),
  ).toHaveCount(1);
  const otherTeachersCard = aside
    .locator("[data-slot='card']")
    .filter({ hasText: "其他老师的这门课" });
  const otherTeacherLink = otherTeachersCard.getByRole("link", {
    name: "另一位教师",
  });
  const otherTeacherCount = otherTeachersCard.getByText("（2）");
  await expect(otherTeacherLink).toBeVisible();
  await expect(otherTeacherCount).toBeVisible();
  await expect(otherTeacherCount).toHaveText("（2）");
  await expect(otherTeachersCard.getByText("4.6")).toHaveCount(0);

  const otherCoursesCard = aside
    .locator("[data-slot='card']")
    .filter({ hasText: "这位老师的其他课" });
  const otherCourseLink = otherCoursesCard.getByRole("link", {
    name: "写作与沟通",
  });
  const otherCourseStats = otherCoursesCard.getByText("4.2（3）");
  await expect(otherCourseLink).toBeVisible();
  await expect(otherCourseStats).toBeVisible();
  await expect(otherCourseStats).toHaveText("4.2（3）");
  await expect(otherCoursesCard.getByText("GEN0201")).toBeVisible();
  await expect(otherCoursesCard.getByText("4.1（2）")).toBeVisible();
  await expect(otherCoursesCard.getByText("MARX1001")).toBeVisible();
  const longCourseName = "毛泽东思想和中国特色社会主义理论体系概论";
  const longCourseLink = aside.getByRole("link", { name: longCourseName });
  await expect(longCourseLink).toBeVisible();
  const longCourseBox = await longCourseLink.evaluate((el) => {
    const card = el.closest("[data-slot='card']");
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const cardRect = card?.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const lineRects = [...range.getClientRects()];
    const lastLine = lineRects.at(-1);
    const statsRect = el.nextElementSibling?.getBoundingClientRect();
    return {
      text: el.textContent?.replace(/\s+/g, "") ?? "",
      whiteSpace: style.whiteSpace,
      display: style.display,
      right: rect.right,
      cardRight: cardRect?.right ?? 0,
      lastLineRight: lastLine?.right ?? 0,
      lastLineBottom: lastLine?.bottom ?? 0,
      statsLeft: statsRect?.left ?? 0,
      statsBottom: statsRect?.bottom ?? 0,
    };
  });
  expect(longCourseBox.text).toBe(longCourseName);
  expect(longCourseBox.whiteSpace).not.toBe("nowrap");
  expect(longCourseBox.display).toBe("inline");
  expect(longCourseBox.right).toBeLessThanOrEqual(longCourseBox.cardRight + 1);
  expect(longCourseBox.statsLeft - longCourseBox.lastLineRight).toBeLessThan(16);
  expect(
    longCourseBox.statsLeft - longCourseBox.lastLineRight,
  ).toBeGreaterThan(-2);
  expect(
    Math.abs(longCourseBox.statsBottom - longCourseBox.lastLineBottom),
  ).toBeLessThan(6);
  await expect(
    aside.getByRole("link", { name: "← 返回课程目录" }),
  ).toHaveAttribute("href", "/courses");
});

test("sidebar switches teachers and the session cache restores loaded pages", async ({
  page,
}) => {
  const reviewRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/courses/8/reviews")
      reviewRequests.push(url.search);
  });

  await page.goto("/courses/8");
  await expect(reviewItems(page)).toHaveCount(20);
  await page.getByRole("button", { name: "继续加载" }).click();
  await expect(reviewItems(page)).toHaveCount(21);

  // 切到另一位教师：2 条；切回：21 条全部从缓存恢复，不重拉。
  await page
    .locator("aside")
    .getByRole("link", { name: "另一位教师" })
    .click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=10/);
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（另一位教师）/ }),
  ).toBeVisible();
  await expect(reviewItems(page)).toHaveCount(2);
  // 无评分关系：头部灰星 + 人数，不发明评分数字（右栏其他老师仍带真实分）。
  await expect(page.getByText("（2 人评价）")).toBeVisible();
  await expect(
    page.locator("header.mt-3").getByText("4.6", { exact: true }),
  ).toHaveCount(0);

  await page
    .locator("aside")
    .getByRole("link", { name: "测试教师" })
    .click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=9/);
  await expect(reviewItems(page)).toHaveCount(21);
  await expect(page.getByRole("button", { name: "继续加载" })).toHaveCount(0);
  expect(
    reviewRequests.filter((search) => search.includes("teacherId=9")),
  ).toHaveLength(2);
  expect(
    reviewRequests.filter((search) => !search.includes("teacherId")),
  ).toHaveLength(0);
});

test("write-review entry presets the relation on /submit", async ({ page }) => {
  await page.goto("/courses/8?teacher=9");
  await page.getByRole("button", { name: "写点评" }).click();
  // 访客进表单前先过登录门；from 带回写评价地址。
  await expect(page).toHaveURL(
    /\/login\?from=%2Fsubmit%3FcourseId%3D8%26teacherId%3D9/,
  );
});

test("course without teachers keeps an honest header and no write entry", async ({
  page,
}) => {
  await page.goto("/courses/10");
  await expect(
    page.getByRole("heading", { name: "暂无文字评价课程" }),
  ).toBeVisible();
  await expect(page.getByText("暂无评价").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "写点评" }),
  ).toHaveCount(0);
  await expect(page.getByText("教师主页：")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "暂无评价" }),
  ).toBeVisible();
});

test("invalid teacher query is replaced with a valid relation", async ({
  page,
}) => {
  await page.goto("/courses/8?teacher=999");
  await expect(page).toHaveURL(/\/courses\/8\?teacher=9$/);
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
  await expect(reviewItems(page)).toHaveCount(20);
});

test("invalid teacher query on a course with no teachers is dropped", async ({
  page,
}) => {
  await page.goto("/courses/10?teacher=999");
  await expect(page).toHaveURL(/\/courses\/10$/);
  await expect(
    page.getByRole("heading", { name: "暂无文字评价课程" }),
  ).toBeVisible();
});

test("review hash auto-loads pages until the anchored review is found", async ({
  page,
}) => {
  const reviewRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/courses/8/reviews")
      reviewRequests.push(url.search);
  });

  await page.goto("/courses/8?teacher=9#historical-review-21");
  const target = page.locator("#historical-review-21");
  await expect(target).toBeVisible();
  await expect(target).toContainText("匿名评价 21");
  expect(reviewRequests.some((search) => search.includes("cursor="))).toBe(
    true,
  );
});

test("unknown review hash stops after the last page", async ({ page }) => {
  await page.goto("/courses/8?teacher=9#does-not-exist");
  await expect(reviewItems(page)).toHaveCount(21);
  await expect(page.getByRole("button", { name: "继续加载" })).toHaveCount(0);
});

test("catalog relation rows link into the matching course×teacher page", async ({
  page,
}) => {
  await page.goto("/courses");
  await page
    .getByRole("link", { name: /中国传统文化导论（另一位教师）/ })
    .click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=10/);
  await expect(reviewItems(page)).toHaveCount(2);

  // 面包屑返回课程目录。
  await page
    .getByRole("navigation", { name: "面包屑" })
    .getByRole("link", { name: "课程目录" })
    .click();
  await expect(page).toHaveURL(/\/courses$/);
});

test("review controls reload the complete server-side sort and filters", async ({
  page,
}) => {
  const queries: string[] = [];
  await page.route("**/api/courses/8/reviews**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teacherId") !== "9") return route.fallback();
    queries.push(url.search);
    const sort = url.searchParams.get("sort");
    const rating = url.searchParams.get("rating");
    const all = [
      {
        id: "review:1",
        course_id: 8,
        teacher_id: 9,
        comment: "低分旧点评，补充说明足够长。",
        overall: 2,
        created_at: "2025-09-01 00:00:00",
        endorsement_count: 2,
        endorsable: true,
      },
      {
        id: "review:3",
        course_id: 8,
        teacher_id: 9,
        comment: "四点五星点评，补充说明足够长。",
        overall: 4.5,
        created_at: "2025-12-01 00:00:00",
        endorsement_count: 4,
        endorsable: true,
      },
      {
        id: "review:2",
        course_id: 8,
        teacher_id: 9,
        comment: "高分新点评，补充说明足够长。",
        overall: 5,
        created_at: "2026-03-01 00:00:00",
        endorsement_count: 9,
        endorsable: true,
      },
    ];
    const stars = rating
      ? rating.split(",").map(Number).filter((star) => star >= 1 && star <= 5)
      : [];
    const allowed = stars.flatMap((star) =>
      star === 5 ? [5] : [star, star + 0.5],
    );
    const filtered = all.filter(
      (review) => !stars.length || allowed.includes(review.overall),
    );
    const items =
      sort === "oldest" ? filtered : [...filtered].reverse();
    return route.fulfill({
      json: { items, nextCursor: null, total: items.length },
    });
  });

  await page.goto("/courses/8?teacher=9");
  await expect(reviewItems(page)).toHaveCount(3);
  await expect(reviewItems(page).first()).toContainText("高分新点评");
  expect(queries.at(-1)).toContain("sort=latest");

  await page.getByRole("button", { name: /排序/ }).click();
  await page.getByRole("option", { name: "从旧到新" }).click();
  await expect(reviewItems(page).first()).toContainText("低分旧点评");
  expect(queries.at(-1)).toContain("sort=oldest");

  await page.getByRole("button", { name: /评分/ }).click();
  await page.getByRole("option", { name: "4 星" }).click();
  await expect(reviewItems(page)).toHaveCount(1);
  await expect(reviewItems(page).first()).toContainText("四点五星点评");
  await expect(page.getByText("1 条点评")).toBeVisible();
  expect(queries.at(-1)).toContain("rating=4");

  const fiveStar = page.getByRole("option", { name: "5 星" });
  if (await fiveStar.isVisible()) {
    await fiveStar.click();
  } else {
    await page.getByRole("button", { name: /评分/ }).click();
    await fiveStar.click();
  }
  await expect(reviewItems(page)).toHaveCount(2);
  await expect(page.getByText("2 条点评")).toBeVisible();
  expect(queries.at(-1)).not.toContain("term=");
  expect(decodeURIComponent(queries.at(-1) ?? "")).toMatch(/rating=(?:4,5|5,4)/);
});

test("rich-text notes render sanitized markup, plain notes stay plain", async ({
  page,
}) => {
  await page.route("**/api/courses/8/reviews**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teacherId") !== "9") return route.fallback();
    return route.fulfill({
      json: {
        items: [
          {
            id: "review:rich",
            course_id: 8,
            teacher_id: 9,
            // 服务端已消毒；即使混入 script / 事件属性，展示侧也不渲染。
            comment:
              '<p>富文本<strong>加粗内容</strong></p><ul><li>列表项</li></ul><script>alert(1)</script><p onclick="alert(2)">结尾</p><a href="javascript:alert(3)">坏链接</a>',
            comment_format: "html",
            endorsement_count: 0,
            endorsable: false,
          },
          {
            id: "historical:plain",
            course_id: 8,
            teacher_id: 9,
            comment: "旧纯文本 <strong>不渲染</strong> 成加粗",
            endorsement_count: 0,
            endorsable: false,
          },
        ],
        nextCursor: null,
      },
    });
  });

  await page.goto("/courses/8?teacher=9");
  // 富文本条目内的 <ul><li> 也带 listitem 角色，只取评价流的直接子项。
  const items = page
    .getByRole("list", { name: "评价列表" })
    .locator(":scope > [role='listitem']");
  await expect(items).toHaveCount(2);

  const rich = items.nth(0);
  await expect(rich.locator("strong")).toHaveText("加粗内容");
  await expect(rich.locator("ul li")).toHaveText("列表项");
  await expect(rich.locator("script")).toHaveCount(0);
  await expect(rich.getByText("结尾")).toBeVisible();
  await expect(rich.locator("[onclick]")).toHaveCount(0);
  // javascript: 协议的 href 被剥掉，只留下没有地址的锚文本。
  const badLink = rich.locator("a", { hasText: "坏链接" });
  await expect(badLink).toHaveCount(1);
  await expect(badLink).not.toHaveAttribute("href", /.*/);

  const plain = items.nth(1);
  await expect(plain).toContainText("旧纯文本 <strong>不渲染</strong> 成加粗");
  await expect(plain.locator("strong")).toHaveCount(0);
});

test("scheme snapshot reviews show one dimension-average chip", async ({
  page,
}) => {
  await page.route("**/api/courses/8/reviews**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teacherId") !== "9") return route.fallback();
    return route.fulfill({
      json: {
        items: [
          {
            id: "review:1",
            course_id: 8,
            teacher_id: 9,
            comment: "有规则快照的补充说明",
            endorsement_count: 0,
            endorsable: false,
            dimensionAverage: 3.5,
          },
          {
            id: "historical:old",
            course_id: 8,
            teacher_id: 9,
            comment: "没有规则版本的历史评价",
            endorsement_count: 0,
            endorsable: false,
          },
        ],
        nextCursor: null,
      },
    });
  });

  await page.goto("/courses/8?teacher=9");
  const items = reviewItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByText("维度均分 3.5")).toBeVisible();
  await expect(items.nth(1).getByText("维度均分")).toHaveCount(0);
  // 没有快照的历史行不再渲染四维占位行。
  await expect(items.nth(1).getByText("课程难度")).toHaveCount(0);
  await expect(page.getByText("上课表现")).toHaveCount(0);
  await expect(page.getByText("点名频率")).toHaveCount(0);
});

test("teacher detail omits the review stream", async ({ page }) => {
  await page.route("**/api/teachers**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/teachers/9")
      return route.fulfill({
        json: {
          teacher: {
            id: 9,
            name: "测试教师",
            department: "人文学院",
            title: "讲师",
            rating: 4.6,
          },
          courses: [
            {
              id: 8,
              code: "GEN0108",
              name: "中国传统文化导论",
              category: "general",
              department: "人文学院",
            },
          ],
          reviews: teacherNineReviews.slice(0, 20),
          reviewCount: 21,
          nextReviewCursor: "next-page",
        },
      });
    if (url.pathname === "/api/teachers/9/reviews")
      return route.fulfill({
        json: { items: teacherNineReviews.slice(20), nextCursor: null },
      });
    return route.fallback();
  });

  await page.goto("/teachers/9");
  await expect(page.getByRole("navigation", { name: "面包屑" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "教师目录" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "评价" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "评价列表" })).toHaveCount(0);
  await expect(reviewItems(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "课程（共 1 门）" })).toBeVisible();
  const profile = page.getByLabel("教师资料");
  await expect(profile.getByText("得到的评价")).toBeVisible();
  await expect(profile.getByText("21 条")).toBeVisible();
  await expect(profile.getByText("平均分", { exact: true })).toBeVisible();
  await expect(profile.getByText("4.6", { exact: true })).toBeVisible();
  await expect(profile.getByText("归一化平均分", { exact: true })).toBeVisible();
  await expect(profile.getByText("-", { exact: true })).toBeVisible();
  await expect(page.getByText("公开评价")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /中国传统文化导论/ }),
  ).toBeVisible();
});

test("empty and mobile states remain accessible without overflow @mobile-smoke", async ({
  page,
}) => {
  const moduleFailures = collectModuleLoadFailures(page);
  await page.goto("/courses/10");
  await expect(
    page.getByRole("status").filter({ hasText: "暂无评价" }),
  ).toBeVisible();

  await page.goto("/courses/8?teacher=9");
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "点评" })).toBeVisible();
  await expect(reviewItems(page)).toHaveCount(20);
  await expect(reviewItems(page).first()).toContainText("匿名评价 1");
  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
  expect(moduleFailures()).toEqual([]);
});

test("review items render grade and FourDimLine without a title line", async ({
  page,
}) => {
  await page.route("**/api/courses/8/reviews**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teacherId") !== "9") return route.fallback();
    return route.fulfill({
      json: {
        items: [
          {
            id: "review:h1",
            course_id: 8,
            teacher_id: 9,
            comment: "正文详细评价内容，足够长的一段文字用于占位。",
            headline: "一句话总结：值得选",
            grade: "A",
            overall: 5,
            created_at: "2026-08-20 12:00:00",
            // 条目四维与课程页头部同一套 FourDimLine；考勤不进这行。
            dimensionLabels: [
              { id: "difficulty", label: "课程难度", option: "简单" },
              { id: "homework", label: "作业多少", option: "不多" },
              { id: "grading", label: "给分好坏", option: "超好" },
              { id: "gain", label: "收获多少", option: "很多" },
              { id: "attendance", label: "考勤松紧", option: "宽松" },
            ],
            endorsement_count: 0,
            endorsable: false,
          },
          {
            id: "historical:old",
            course_id: 8,
            teacher_id: 9,
            comment: "没有一句话总结的历史评价",
            endorsement_count: 0,
            endorsable: false,
          },
        ],
        nextCursor: null,
        total: 2,
      },
    });
  });

  await page.goto("/courses/8?teacher=9");
  const items = reviewItems(page);
  await expect(items).toHaveCount(2);
  await expect(
    page.getByRole("list", { name: "评价列表" }).getByRole("separator"),
  ).toHaveCount(1);

  const withGrade = items.nth(0);
  // 正文按纯文本展示；一句话总结不再单独加粗成行；成绩单独一行在正文后。
  await expect(
    withGrade.getByText("正文详细评价内容，足够长的一段文字用于占位。"),
  ).toBeVisible();
  await expect(withGrade.getByText("一句话总结：值得选")).toHaveCount(0);
  await expect(withGrade.locator("p.font-semibold")).toHaveCount(0);
  await expect(withGrade.getByText("2026 春")).toHaveCount(0);
  await expect(
    withGrade.getByText("成绩：A", { exact: true }),
  ).toBeVisible();
  await expect(withGrade.getByText("必选", { exact: true })).toBeVisible();
  await expect(withGrade.getByText("考勤松紧 宽松")).toHaveCount(0);
  await expect(
    withGrade.getByText("课程难度：简单", { exact: true }),
  ).toBeVisible();
  await expect(withGrade.getByText("课程难度 简单", { exact: true })).toHaveCount(
    0,
  );

  // 历史行：无标题行、无成绩。
  const legacy = items.nth(1);
  await expect(legacy.locator("p.font-semibold")).toHaveCount(0);
  await expect(legacy.getByText(/成绩/)).toHaveCount(0);
});

test("four-tier snapshot reviews show FourDimLine text and no average", async ({
  page,
}) => {
  await page.route("**/api/courses/8/reviews**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teacherId") !== "9") return route.fallback();
    return route.fulfill({
      json: {
        items: [
          {
            id: "review:2",
            course_id: 8,
            teacher_id: 9,
            comment: "带新四维快照的补充说明",
            overall: 3.5,
            dimensionLabels: [
              { id: "difficulty", label: "课程难度", option: "简单" },
              { id: "homework", label: "作业多少", option: "中等" },
              { id: "grading", label: "给分好坏", option: "杀手" },
              { id: "gain", label: "收获多少", option: "一般" },
            ],
            endorsement_count: 0,
            endorsable: false,
          },
          {
            id: "review:3",
            course_id: 8,
            teacher_id: 9,
            comment: "旧 1–5 快照的补充说明",
            dimensionAverage: 3.5,
            endorsement_count: 0,
            endorsable: false,
          },
        ],
        nextCursor: null,
      },
    });
  });

  await page.goto("/courses/8?teacher=9");
  const items = reviewItems(page);
  await expect(items).toHaveCount(2);
  const tiered = items.nth(0);
  await expect(tiered.getByText("很推荐")).toBeVisible();
  await expect(tiered.getByText("课程难度：简单", { exact: true })).toBeVisible();
  await expect(tiered.getByText("作业多少：中等", { exact: true })).toBeVisible();
  await expect(tiered.getByText("给分好坏：杀手", { exact: true })).toBeVisible();
  await expect(tiered.getByText("收获多少：一般", { exact: true })).toBeVisible();
  await expect(tiered.getByText("课程难度 简单", { exact: true })).toHaveCount(0);
  await expect(tiered.getByText("维度均分")).toHaveCount(0);
  const legacy = items.nth(1);
  await expect(legacy.getByText("维度均分 3.5")).toBeVisible();
  await expect(legacy.getByText("很推荐")).toHaveCount(0);
  await expect(legacy.getByText("课程难度")).toHaveCount(0);
});

test("course review page shows a back-to-top button after scrolling @mobile-smoke", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/courses/8?teacher=9");
  await expect(reviewItems(page)).toHaveCount(20);

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
