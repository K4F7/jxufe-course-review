/**
 * Browser coverage for production review recognition (issue #78).
 *
 * Asserts observable labels, counts, aria-pressed, pending disablement,
 * failure rollback, guest votes without a login gate, fold copy, and
 * historical plus current text-review eligibility. Write requests go to
 * the mocked endorsement / challenge APIs.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type Store = {
  authenticated: boolean;
  counts: Record<string, number>;
  endorsed: Record<string, boolean>;
  challengeCounts: Record<string, number>;
  challenged: Record<string, boolean>;
};

const course = {
  id: 8,
  code: "GEN0108",
  name: "中国传统文化导论",
  category: "general",
  department: "人文学院",
  teachers: [{ id: 9, name: "测试教师" }],
};

function review(
  id: string,
  comment: string,
  extras: {
    endorsement_count?: number;
    challenge_count?: number;
    endorsable?: boolean;
    viewer_endorsed?: boolean;
    viewer_challenged?: boolean;
    created_at?: string;
  } = {},
) {
  return {
    id,
    course_id: 8,
    teacher_id: 9,
    course_name: course.name,
    course_code: course.code,
    teacher_name: "测试教师",
    comment,
    created_at: extras.created_at,
    endorsement_count: extras.endorsement_count ?? 0,
    challenge_count: extras.challenge_count ?? 0,
    endorsable: extras.endorsable ?? id.startsWith("review:"),
    viewer_endorsed: extras.viewer_endorsed,
    viewer_challenged: extras.viewer_challenged,
  };
}

function liveReviews(store: Store) {
  return [
    review("review:301", "零计数当前文字评价。", {
      endorsement_count: store.counts["review:301"],
      challenge_count: store.challengeCounts["review:301"],
      viewer_endorsed: store.endorsed["review:301"],
      viewer_challenged: store.challenged["review:301"],
      created_at: "2026-08-17 08:00:00",
    }),
    review("review:302", "非零计数当前文字评价。", {
      endorsement_count: store.counts["review:302"],
      challenge_count: store.challengeCounts["review:302"],
      viewer_endorsed: store.endorsed["review:302"],
      viewer_challenged: store.challenged["review:302"],
    }),
    review("review:303", "我已认可的当前文字评价。", {
      endorsement_count: store.counts["review:303"],
      challenge_count: store.challengeCounts["review:303"],
      viewer_endorsed: store.endorsed["review:303"],
      viewer_challenged: store.challenged["review:303"],
    }),
    review("review:305", "建立总会失败的当前文字评价。", {
      endorsement_count: store.counts["review:305"],
      challenge_count: store.challengeCounts["review:305"],
      viewer_endorsed: store.endorsed["review:305"],
      viewer_challenged: store.challenged["review:305"],
    }),
    review("review:306", "慢网络建立中的当前文字评价。", {
      endorsement_count: store.counts["review:306"],
      challenge_count: store.challengeCounts["review:306"],
      viewer_endorsed: store.endorsed["review:306"],
      viewer_challenged: store.challenged["review:306"],
    }),
    review("review:307", "质疑较多应收起的正文。", {
      endorsement_count: store.counts["review:307"],
      challenge_count: store.challengeCounts["review:307"],
      viewer_endorsed: store.endorsed["review:307"],
      viewer_challenged: store.challenged["review:307"],
      created_at: "2026-08-20 12:00:00",
    }),
    review("review:308", "再一票就会过线的正文。", {
      endorsement_count: store.counts["review:308"],
      challenge_count: store.challengeCounts["review:308"],
      viewer_endorsed: store.endorsed["review:308"],
      viewer_challenged: store.challenged["review:308"],
      created_at: "2026-08-19 09:00:00",
    }),
    review("historical:hist-1", "历史评价可以认可。", {
      endorsable: true,
      challenge_count: store.challengeCounts["historical:hist-1"],
      viewer_challenged: store.challenged["historical:hist-1"],
    }),
  ];
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, json });
}

async function mockApi(page: Page, store: Store) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/config") {
      return fulfillJson(route, {
        siteName: "非官方课评@JUFE",
        universityName: "江西财经大学",
        admin: false,
      });
    }
    if (url.pathname === "/api/user/session") {
      return fulfillJson(route, {
        authenticated: store.authenticated,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      });
    }
    if (url.pathname === "/api/courses/8") {
      return fulfillJson(route, {
        course: {
          ...course,
          teachers: [
            { id: 9, name: "测试教师", review_count: 6, rating: 4.6 },
          ],
        },
        reviewCount: 6,
      });
    }
    if (/\/api\/reviews\/[^/]+\/comments$/.test(url.pathname) && request.method() === "GET") {
      return fulfillJson(route, { items: [] });
    }
    if (url.pathname === "/api/courses/8/reviews") {
      if (url.searchParams.get("teacherId") !== "9") {
        return fulfillJson(
          route,
          { error: "课程评价需先指定任课教师（teacherId）" },
          400,
        );
      }
      return fulfillJson(route, {
        items: liveReviews(store),
        nextCursor: null,
      });
    }
    const stance =
      /\/api\/reviews\/([^/]+)\/(endorsement|challenge)$/.exec(url.pathname);
    if (stance) {
      const id = decodeURIComponent(stance[1]);
      const side = stance[2];
      if (id === "review:305" && request.method() === "PUT") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fulfillJson(
          route,
          { error: side === "challenge" ? "质疑失败" : "认可失败" },
          500,
        );
      }
      if (id === "review:306") {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fulfillJson(route, { error: "timeout" }, 504);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (side === "endorsement") {
        if (request.method() === "PUT") {
          if (!store.endorsed[id]) {
            store.endorsed[id] = true;
            store.counts[id] += 1;
          }
          if (store.challenged[id]) {
            store.challenged[id] = false;
            store.challengeCounts[id] = Math.max(
              0,
              (store.challengeCounts[id] ?? 0) - 1,
            );
          }
        } else if (request.method() === "DELETE" && store.endorsed[id]) {
          store.endorsed[id] = false;
          store.counts[id] -= 1;
        }
      } else if (request.method() === "PUT") {
        if (!store.challenged[id]) {
          store.challenged[id] = true;
          store.challengeCounts[id] = (store.challengeCounts[id] ?? 0) + 1;
        }
        if (store.endorsed[id]) {
          store.endorsed[id] = false;
          store.counts[id] = Math.max(0, store.counts[id] - 1);
        }
      } else if (request.method() === "DELETE" && store.challenged[id]) {
        store.challenged[id] = false;
        store.challengeCounts[id] = Math.max(
          0,
          (store.challengeCounts[id] ?? 0) - 1,
        );
      }
      return fulfillJson(route, {
        endorsementCount: store.counts[id] ?? 0,
        viewerEndorsed: store.endorsed[id] ?? false,
        challengeCount: store.challengeCounts[id] ?? 0,
        viewerChallenged: store.challenged[id] ?? false,
      });
    }
    return fulfillJson(route, { error: "not mocked" }, 404);
  });
}

function entry(page: Page, comment: string) {
  return page.locator("article").filter({ hasText: comment });
}

function actionBar(page: Page, comment: string) {
  return entry(page, comment)
    .getByRole("toolbar", { name: "评价动作" })
    .first();
}

function guestStore(): Store {
  return {
    authenticated: false,
    counts: {
      "review:301": 0,
      "review:302": 3,
      "review:303": 5,
      "review:305": 2,
      "review:306": 1,
      "review:307": 1,
      "review:308": 0,
    },
    endorsed: {
      "review:301": false,
      "review:302": false,
      "review:303": false,
      "review:305": false,
      "review:306": false,
      "review:307": false,
      "review:308": false,
      "historical:hist-1": false,
    },
    challengeCounts: {
      "review:301": 0,
      "review:302": 0,
      "review:303": 0,
      "review:305": 0,
      "review:306": 0,
      "review:307": 3,
      "review:308": 2,
      "historical:hist-1": 0,
    },
    challenged: {
      "review:301": false,
      "review:302": false,
      "review:303": false,
      "review:305": false,
      "review:306": false,
      "review:307": false,
      "review:308": false,
      "historical:hist-1": false,
    },
  };
}

function userStore(): Store {
  const store = guestStore();
  store.authenticated = true;
  store.endorsed = { ...store.endorsed, "review:303": true };
  return store;
}

test("guest can vote without a login prompt and still needs login to comment", async ({
  page,
}) => {
  await mockApi(page, guestStore());
  await page.goto("/courses/8?teacher=9");
  const zeroEntry = entry(page, "零计数当前文字评价。");
  await expect(
    zeroEntry.getByRole("button", {
      name: "认可这条评价，还没有人认可",
    }),
  ).toBeEnabled();
  await expect(zeroEntry.locator("header time")).toHaveText("2026-08-17");
  await expect(
    actionBar(page, "零计数当前文字评价。").locator("time"),
  ).toHaveCount(0);

  const zero = entry(page, "零计数当前文字评价。").getByRole("button", {
    name: "认可这条评价，还没有人认可",
  });
  await expect(zero).toBeVisible();
  await expect(zero).toHaveAttribute("aria-pressed", "false");

  await expect(
    entry(page, "非零计数当前文字评价。").getByRole("button", {
      name: "认可这条评价，当前 3 人认可",
    }),
  ).toBeVisible();
  await expect(
    entry(page, "我已认可的当前文字评价。").getByRole("button", {
      name: "认可这条评价，当前 5 人认可",
    }),
  ).toHaveAttribute("aria-pressed", "false");

  await expect(
    entry(page, "历史评价可以认可。").getByRole("button", {
      name: "认可这条评价，还没有人认可",
    }),
  ).toBeVisible();

  await expect(
    actionBar(page, "零计数当前文字评价。").getByRole("button", {
      name: "质疑这条评价，还没有人质疑",
    }),
  ).toBeVisible();
  await expect(
    actionBar(page, "历史评价可以认可。").getByRole("button", {
      name: "质疑这条评价，还没有人质疑",
    }),
  ).toBeVisible();
  await expect(page.getByText("不认可", { exact: true })).toHaveCount(0);
  await expect(page.getByText("踩", { exact: true })).toHaveCount(0);

  await zero.click();
  await expect(
    entry(page, "零计数当前文字评价。").getByRole("button", {
      name: "已认可，按下可撤回我的认可，当前 1 人认可",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("后才可互动")).toHaveCount(0);

  await actionBar(page, "零计数当前文字评价。")
    .getByRole("button", { name: "评论，还没有回复" })
    .click();
  const commentPanel = entry(page, "零计数当前文字评价。");
  await expect(commentPanel.getByText("说说你的看法")).toBeVisible();
  await expect(
    commentPanel.getByRole("link", { name: "登录" }),
  ).toHaveAttribute("href", "/login?from=%2Fcourses%2F8%3Fteacher%3D9");
});

test("public fold hides the entire card chrome", async ({ page }) => {
  await mockApi(page, guestStore());
  await page.goto("/courses/8?teacher=9");
  const folded = page.locator("article").filter({
    has: page.getByText("该评价因不受欢迎被折叠"),
  });
  await expect(folded.getByText("该评价因不受欢迎被折叠")).toBeVisible();
  await expect(page.getByText("质疑较多应收起的正文。")).toHaveCount(0);
  await expect(folded.getByRole("link", { name: /匿名用户/ })).toHaveCount(0);
  await expect(folded.locator("time")).toHaveCount(0);
  await expect(folded.getByRole("toolbar", { name: "评价动作" })).toHaveCount(0);
  await expect(
    folded.getByRole("button", { name: "质疑这条评价，当前 3 人质疑" }),
  ).toHaveCount(0);
  await expect(folded.getByRole("button", { name: "展开" })).toHaveCount(0);
  await expect(folded.getByRole("button", { name: "让我看看" })).toBeVisible();

  await folded.getByRole("button", { name: "让我看看" }).click();
  await expect(folded.getByText("质疑较多应收起的正文。")).toBeVisible();
  await expect(folded.getByRole("link", { name: /匿名用户/ })).toBeVisible();
  await expect(folded.locator("header time")).toHaveText("2026-08-20");
  await expect(folded.getByRole("toolbar", { name: "评价动作" })).toBeVisible();
  await expect(
    folded.getByRole("button", { name: "质疑这条评价，当前 3 人质疑" }),
  ).toBeVisible();
  await expect(folded.getByText("该评价因不受欢迎被折叠")).toBeVisible();
  await expect(folded.getByRole("button", { name: "收起" })).toHaveCount(0);
  await expect(folded.getByRole("button", { name: "让我看看" })).toHaveCount(0);

  await page.reload();
  const foldedAgain = page.locator("article").filter({
    has: page.getByText("该评价因不受欢迎被折叠"),
  });
  await expect(page.getByText("质疑较多应收起的正文。")).toHaveCount(0);
  await expect(foldedAgain.getByRole("button", { name: "让我看看" })).toBeVisible();
  await foldedAgain.getByRole("button", { name: "让我看看" }).click();
  await expect(foldedAgain.getByText("质疑较多应收起的正文。")).toBeVisible();
});

test("crossing the public fold threshold keeps the open card", async ({
  page,
}) => {
  await mockApi(page, guestStore());
  await page.goto("/courses/8?teacher=9");
  const card = page.locator("#review-308");
  await expect(card.getByText("再一票就会过线的正文。")).toBeVisible();
  await card
    .getByRole("button", { name: "质疑这条评价，当前 2 人质疑" })
    .click();
  await expect(card.getByText("再一票就会过线的正文。")).toBeVisible();
  await expect(card.getByText("该评价因不受欢迎被折叠")).toBeVisible();
  await expect(card.getByRole("button", { name: "收起" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "让我看看" })).toHaveCount(0);
  await expect(card.getByRole("toolbar", { name: "评价动作" })).toBeVisible();
  await expect(card.locator("header time")).toHaveText("2026-08-19");
});

test("self challenge keeps avatar username and body visible", async ({
  page,
}) => {
  await mockApi(page, guestStore());
  await page.goto("/courses/8?teacher=9");
  const self = entry(page, "非零计数当前文字评价。");
  await actionBar(page, "非零计数当前文字评价。")
    .getByRole("button", { name: "质疑这条评价，还没有人质疑" })
    .click();
  await expect(
    self.getByRole("button", {
      name: "已质疑，按下可撤回我的质疑，当前 1 人质疑",
    }),
  ).toBeVisible();
  await expect(self.getByText("非零计数当前文字评价。")).toBeVisible();
  await expect(self.getByRole("link", { name: /匿名用户/ })).toBeVisible();
  await expect(self.getByText("已折叠")).toHaveCount(0);
  await expect(self.getByText("该评价因不受欢迎被折叠")).toHaveCount(0);
  await expect(self.getByRole("button", { name: "让我看看" })).toHaveCount(0);
  await expect(self.getByRole("button", { name: "收起" })).toHaveCount(0);

  await self
    .getByRole("button", {
      name: "已质疑，按下可撤回我的质疑，当前 1 人质疑",
    })
    .click();
  await expect(self.getByText("非零计数当前文字评价。")).toBeVisible();
  await expect(self.getByRole("link", { name: /匿名用户/ })).toBeVisible();
});

test("signed-in user can endorse with Enter and withdraw with pending and selected state", async ({
  page,
}) => {
  await mockApi(page, userStore());
  await page.goto("/courses/8?teacher=9");
  await expect(
    entry(page, "我已认可的当前文字评价。").getByRole("button", {
      name: "已认可，按下可撤回我的认可，当前 5 人认可",
    }),
  ).toBeVisible();
  const demo = entry(page, "非零计数当前文字评价。");
  await expect(
    demo.getByRole("button", { name: "认可这条评价，当前 3 人认可" }),
  ).toBeEnabled();

  await demo.getByRole("button", { name: "认可这条评价，当前 3 人认可" }).press("Enter");
  await expect(
    demo.getByRole("button", { name: "正在建立认可，当前 4 人认可" }),
  ).toBeDisabled();
  const endorsed = demo.getByRole("button", {
    name: "已认可，按下可撤回我的认可，当前 4 人认可",
  });
  await expect(endorsed).toBeVisible();
  await expect(endorsed).toHaveAttribute("aria-pressed", "true");

  await endorsed.click();
  await expect(
    demo.getByRole("button", { name: "正在撤回认可，当前 3 人认可" }),
  ).toBeDisabled();
  await expect(
    demo.getByRole("button", { name: "认可这条评价，当前 3 人认可" }),
  ).toBeVisible();
});

test("failure rolls back to the server-confirmed count", async ({ page }) => {
  await mockApi(page, userStore());
  await page.goto("/courses/8?teacher=9");
  await expect(
    entry(page, "我已认可的当前文字评价。").getByRole("button", {
      name: "已认可，按下可撤回我的认可，当前 5 人认可",
    }),
  ).toBeVisible();
  const demo = entry(page, "建立总会失败的当前文字评价。");
  await demo.getByRole("button", { name: "认可这条评价，当前 2 人认可" }).click();
  await expect(demo.getByRole("alert")).toContainText(
    "认可失败，已恢复服务器确认的计数",
  );
  const restored = demo.getByRole("button", {
    name: "认可这条评价，当前 2 人认可",
  });
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute("aria-pressed", "false");
});

test("slow network keeps pending and blocks repeat activation", async ({ page }) => {
  await mockApi(page, userStore());
  await page.goto("/courses/8?teacher=9");
  await expect(
    entry(page, "我已认可的当前文字评价。").getByRole("button", {
      name: "已认可，按下可撤回我的认可，当前 5 人认可",
    }),
  ).toBeVisible();
  const demo = entry(page, "慢网络建立中的当前文字评价。");
  await expect(
    demo.getByRole("button", { name: "认可这条评价，当前 1 人认可" }),
  ).toBeEnabled();
  await demo.getByRole("button", { name: "认可这条评价，当前 1 人认可" }).click();
  const pending = demo.getByRole("button", {
    name: "正在建立认可，当前 2 人认可",
  });
  await expect(pending).toBeDisabled();
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();
});

test("signed-in user can challenge, switch away from recognition, and withdraw", async ({
  page,
}) => {
  await mockApi(page, userStore());
  await page.goto("/courses/8?teacher=9");
  const demoArticle = () =>
    page.locator("article").filter({
      has: page.getByRole("button", {
        name: /当前 [34] 人认可/,
      }),
    });
  const demo = () =>
    demoArticle().getByRole("toolbar", { name: "评价动作" }).first();
  await demo()
    .getByRole("button", { name: "质疑这条评价，还没有人质疑" })
    .click();
  const challenged = demo().getByRole("button", {
    name: "已质疑，按下可撤回我的质疑，当前 1 人质疑",
  });
  await expect(challenged).toBeVisible();
  await expect(challenged).toHaveAttribute("aria-pressed", "true");
  await expect(
    demo().getByRole("button", { name: "认可这条评价，当前 3 人认可" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(demoArticle().getByText("非零计数当前文字评价。")).toBeVisible();
  await expect(demoArticle().getByText("已折叠")).toHaveCount(0);

  await demo().getByRole("button", { name: "认可这条评价，当前 3 人认可" }).click();
  await expect(
    demo().getByRole("button", {
      name: "已认可，按下可撤回我的认可，当前 4 人认可",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    demo().getByRole("button", { name: "质疑这条评价，还没有人质疑" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("非零计数当前文字评价。")).toBeVisible();

  await actionBar(page, "历史评价可以认可。")
    .getByRole("button", { name: "质疑这条评价，还没有人质疑" })
    .click();
  await expect(
    page
      .locator("article")
      .filter({
        has: page.getByRole("button", {
          name: "已质疑，按下可撤回我的质疑，当前 1 人质疑",
        }),
      })
      .getByRole("button", {
        name: "已质疑，按下可撤回我的质疑，当前 1 人质疑",
      }),
  ).toBeVisible();
});
