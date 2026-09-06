/**
 * Browser coverage for /profile 个人主页 and the header 消息 dropdown
 * (frontend for issues #459 / #460). Backend endpoints are mocked; the pages
 * must degrade to a normal load-error alert when they 404.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type MockState = {
  authenticated: boolean;
  profile: unknown;
  profileStatus: number;
  avatarFailsRemaining: number;
  avatarError: string;
  notifications: unknown;
  notificationsStatus: number;
  unreadCount: number | null;
  readCalls: number;
};

function state(overrides: Partial<MockState> = {}): MockState {
  return {
    authenticated: true,
    profile: {
      public_code: 1,
      handle: "匿名用户#000001",
      avatar_key: 0,
      reviews: [
        {
          id: 101,
          course_id: 8,
          course_name: "中国传统文化导论",
          teacher_id: 9,
          teacher_name: "测试教师",
          headline: "收获很大的一门课",
          comment: "这是一条足够长的补充说明摘要，用于个人主页展示。",
          created_at: "2026-08-01 02:00:00",
          status: "approved",
        },
        {
          id: 102,
          course_id: 10,
          course_name: "高等数学",
          teacher_id: 11,
          teacher_name: "数学老师",
          headline: "",
          comment: "等待审核的点评摘要。",
          created_at: "2026-08-20 02:00:00",
          status: "pending",
        },
      ],
      follows: [
        {
          course_id: 8,
          course_name: "中国传统文化导论",
          teacher_id: 9,
          teacher_name: "测试教师",
        },
      ],
      review_count: 2,
      follow_count: 1,
      following_user_count: 1,
      follower_count: 3,
    },
    profileStatus: 200,
    avatarFailsRemaining: 0,
    avatarError: "头像保存失败",
    notifications: [
      {
        id: "n1",
        type: "followed_relation_review",
        text: "你关注的「中国传统文化导论」有了新点评",
        href: "/courses/8?teacher=9#review-101",
        created_at: "2026-08-21 10:00:00",
        read: false,
      },
      {
        id: "n2",
        type: "review_endorsed",
        text: "你的点评获得了一次认可",
        href: "/courses/8?teacher=9#review-101",
        created_at: "2026-08-20 08:00:00",
        read: true,
      },
    ],
    notificationsStatus: 200,
    unreadCount: 2,
    readCalls: 0,
    ...overrides,
  };
}

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, json });
}

async function mockApi(page: Page, mock: MockState) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/config")
      return fulfillJson(route, {
        siteName: "非官方课评@JUFE",
        universityName: "江西财经大学",
        admin: false,
      });
    if (url.pathname === "/api/user/session") {
      const profile = mock.profile as {
        handle?: string;
        avatar_key?: number;
      };
      return fulfillJson(route, {
        authenticated: mock.authenticated,
        csrfToken: mock.authenticated ? "csrf-user" : undefined,
        loginPath: "/login",
        logoutPath: "/logout",
        ...(mock.authenticated
          ? {
              handle: profile.handle ?? "匿名用户#000001",
              avatar_key: profile.avatar_key ?? 0,
            }
          : {}),
      });
    }
    if (url.pathname === "/api/user/profile")
      return fulfillJson(route, mock.profile, mock.profileStatus);
    if (url.pathname === "/api/user/profile/avatar") {
      if (mock.avatarFailsRemaining > 0) {
        mock.avatarFailsRemaining -= 1;
        return fulfillJson(route, { error: mock.avatarError }, 500);
      }
      const profile = mock.profile as {
        avatar_key?: number;
        public_code?: number;
        handle?: string;
      };
      profile.avatar_key = 2;
      return fulfillJson(route, {
        ok: true,
        avatar_key: 2,
        public_code: profile.public_code,
        handle: profile.handle,
      });
    }
    if (url.pathname === "/api/user/notifications" && request.method() === "GET")
      return fulfillJson(route, mock.notifications, mock.notificationsStatus);
    if (
      url.pathname === "/api/user/notifications/read" &&
      request.method() === "POST"
    ) {
      mock.readCalls += 1;
      return fulfillJson(route, { ok: true });
    }
    if (url.pathname === "/api/user/notifications/unread-count") {
      if (mock.unreadCount === null)
        return fulfillJson(route, { error: "not mocked" }, 404);
      return fulfillJson(route, { unreadCount: mock.unreadCount });
    }
    if (url.pathname === "/api/courses")
      return fulfillJson(route, {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        pages: 1,
      });
    return fulfillJson(route, { error: "not mocked" }, 404);
  });
}

test("guests are redirected from /profile to login and /notices is gone", async ({
  page,
}) => {
  await mockApi(page, state({ authenticated: false, unreadCount: null }));

  await page.goto("/notices");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全部消息" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回页面图集" })).toHaveCount(0);

  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login\?from=%2Fprofile$/);
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
});

test("profile page renders own reviews, follows and stats", async ({
  page,
}) => {
  await mockApi(page, state());
  await page.goto("/profile");
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;

  const account = page.getByRole("button", { name: "账号" });
  await expect(account).toContainText("匿名用户#000001");
  await expect(account.locator("img")).toHaveCount(0);

  if (mobile) {
    await expect(
      page.getByRole("tab", { name: "点评（2 门）" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "关注（1 门）" }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", { name: "点评（2 门）" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "关注（1 门）" }),
    ).toBeVisible();
  }

  const approved = page.getByRole("link", {
    name: "中国传统文化导论（测试教师）",
  });
  await expect(approved.first()).toHaveAttribute(
    "href",
    "/courses/8?teacher=9",
  );
  await expect(page.getByText("收获很大的一门课")).toBeVisible();
  await expect(page.getByText("2026-08-01")).toBeVisible();

  // 未过审点评带状态 Chip。
  await expect(page.getByText("待审核", { exact: true })).toBeVisible();
  await expect(page.getByText("等待审核的点评摘要。")).toBeVisible();

  // 侧栏官方头像 + 公开编号；不出现邮箱、学号等标识，也不再导向账号删除。
  await expect(
    page.getByRole("heading", { name: "匿名用户#000001" }),
  ).toBeVisible();
  const profileCard = page.getByRole("article", { name: "匿名用户#000001" });
  const avatar = profileCard.getByRole("button", { name: "更换官方头像" });
  const handle = profileCard.getByRole("heading", { name: "匿名用户#000001" });
  const firstStat = mobile
    ? profileCard.locator("dt", { hasText: /^关注$/ })
    : profileCard.getByText("关注了", { exact: true }).first();
  const [avatarBox, handleBox, firstStatBox] = await Promise.all([
    avatar.boundingBox(),
    handle.boundingBox(),
    firstStat.boundingBox(),
  ]);
  expect(avatarBox).toBeTruthy();
  expect(handleBox).toBeTruthy();
  expect(firstStatBox).toBeTruthy();
  if (mobile) {
    expect(Math.abs(avatarBox!.y - handleBox!.y)).toBeLessThan(16);
    expect(avatarBox!.x).toBeLessThan(handleBox!.x);
    expect(handleBox!.y + handleBox!.height).toBeLessThan(firstStatBox!.y);
    await expect(profileCard.getByText("点评", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("2", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("关注课", { exact: true })).toBeVisible();
  } else {
    expect(avatarBox!.y + avatarBox!.height).toBeLessThanOrEqual(handleBox!.y);
    expect(handleBox!.y + handleBox!.height).toBeLessThan(firstStatBox!.y);
  }
  await expect(
    page.getByRole("radio", { name: "选择官方头像 1" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "更换官方头像" }).click();
  await expect(
    page.getByRole("heading", { name: "选择官方头像" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("radio", { name: "选择官方头像 1" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "选择官方头像 3" }).click();
  await expect(
    page.getByRole("radio", { name: "选择官方头像 3" }),
  ).toHaveCount(0);
  await expect(account).toContainText("匿名用户#000001");
  await expect(account.locator("img")).toHaveCount(0);
  if (mobile) {
    await expect(profileCard.getByText("关注", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("1", { exact: true }).first()).toBeVisible();
    await expect(profileCard.getByText("被关注", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("3", { exact: true })).toBeVisible();
  } else {
    await expect(profileCard.getByText("关注了", { exact: true }).first()).toBeVisible();
    await expect(profileCard.getByText("1 人", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("被关注", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("3 人", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("1 门课程", { exact: true })).toBeVisible();
    await expect(profileCard.getByText("2 门课程", { exact: true })).toBeVisible();
  }
  await expect(profileCard.getByRole("button", { name: "关注" })).toHaveCount(0);
  await expect(
    page.getByText("公开编号只用于识别作者，不是学号或内部身份。"),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "账号管理" })).toHaveCount(0);
});

test("profile page degrades gracefully when the API is missing", async ({
  page,
}) => {
  await mockApi(
    page,
    state({ profile: { error: "not found" }, profileStatus: 404 }),
  );
  await page.goto("/profile");

  await expect(page.getByText("个人主页暂时加载不了")).toBeVisible();
  await expect(page.getByText("请稍后再试。")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "我的主页" }),
  ).toBeVisible();
  const identity = page.getByRole("article", { name: "我的主页" });
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  if (mobile) {
    await expect(identity.locator("dd").first()).toHaveText("—");
  } else {
    await expect(identity.getByText("— 人", { exact: true }).first()).toBeVisible();
  }
});

test("avatar save failure shows a retryable alert", async ({
  page,
}) => {
  await mockApi(page, state({ avatarFailsRemaining: 1 }));
  await page.goto("/profile");

  await page.getByRole("button", { name: "更换官方头像" }).click();
  await page.getByRole("radio", { name: "选择官方头像 3" }).click();
  await expect(page.getByText("头像未能保存")).toBeVisible();
  await expect(page.getByText("头像保存失败")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "更换官方头像" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("头像未能保存")).toHaveCount(0);
});

test("opening the header inbox lists messages and marks all as read", async ({
  page,
}) => {
  const mock = state();
  await mockApi(page, mock);
  await page.goto("/courses");

  await expect(page.getByLabel("2 条未读消息")).toBeVisible();
  await page.getByRole("button", { name: "消息" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "你关注的「中国传统文化导论」有了新点评",
    "你的点评获得了一次认可",
  ]);
  await expect.poll(() => mock.readCalls).toBe(1);
  await expect(page.getByLabel("2 条未读消息")).toHaveCount(0);
});

test("header inbox shows the empty state and survives a missing API", async ({
  page,
}) => {
  const mock = state({ notifications: [], unreadCount: 0 });
  await mockApi(page, mock);
  await page.goto("/courses");
  await page.getByRole("button", { name: "消息" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["还没有消息哦！"]);
  await expect.poll(() => mock.readCalls).toBe(1);

  const missing = state({
    notifications: { error: "not found" },
    notificationsStatus: 404,
    unreadCount: 1,
  });
  await mockApi(page, missing);
  await page.goto("/latest");
  await expect(page.getByLabel("1 条未读消息")).toBeVisible();
  await page.getByRole("button", { name: "消息" }).click();
  await expect(
    page.getByRole("menuitem", { name: "消息暂时加载不了" }),
  ).toBeVisible();
  await expect.poll(() => missing.readCalls).toBe(0);
});

test("account cluster links to 主页 and 消息 with an unread badge", async ({
  page,
}) => {
  await mockApi(page, state({ unreadCount: 3 }));
  await page.goto("/courses");

  await expect(page.getByLabel("3 条未读消息")).toBeVisible();
  await expect(page.getByRole("button", { name: "消息" })).toBeVisible();
  await page.getByRole("button", { name: "账号" }).click();
  await expect(
    page.getByRole("menuitem", { name: "主页" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /消息/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "账号管理" }),
  ).toHaveCount(0);

  await page.getByRole("menuitem", { name: "主页" }).click();
  await expect(page).toHaveURL(/\/profile$/);

  await page.getByRole("button", { name: "消息" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "你关注的「中国传统文化导论」有了新点评",
    "你的点评获得了一次认可",
  ]);
  await expect(
    page.getByRole("menu", { name: /消息/ }).getByRole("separator"),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "查看全部" })).toHaveCount(0);
  await page
    .getByRole("menuitem", {
      name: "你关注的「中国传统文化导论」有了新点评",
    })
    .click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=9#review-101/);
});

test("account cluster hides the badge when unread-count is unavailable", async ({
  page,
}) => {
  await mockApi(page, state({ unreadCount: null }));
  await page.goto("/courses");

  await expect(page.getByRole("button", { name: "账号" })).toBeVisible();
  await expect(page.getByRole("button", { name: "消息" })).toBeVisible();
  await expect(page.getByLabel(/条未读消息/)).toHaveCount(0);
  await page.getByRole("button", { name: "账号" }).click();
  await expect(
    page.getByRole("menuitem", { name: "消息", exact: true }),
  ).toHaveCount(0);
});

test("notices preview=filled shows a numeric unread badge on the header icon", async ({
  page,
}) => {
  await mockApi(page, state({ authenticated: false, unreadCount: null }));
  await page.goto("/courses?preview=filled");

  await expect(page.getByRole("button", { name: "消息" })).toBeVisible();
  await expect(page.getByLabel("2 条未读消息")).toBeVisible();
  await page.getByRole("button", { name: "账号" }).click();
  await expect(page.getByRole("menuitem", { name: /消息/ })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "消息" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "你关注的 中级财务会计（林晓雯） 有新点评",
    "匿名用户#000002 发布了新任课评价",
    "匿名用户#000002 关注了你",
    "有人认可了你对 货币金融学 的点评",
  ]);
  await expect(
    page.getByRole("menu", { name: /消息/ }).getByRole("separator"),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "查看全部" })).toHaveCount(0);

  await page
    .getByRole("menuitem", { name: "匿名用户#000002 发布了新任课评价" })
    .click();
  await expect(page).toHaveURL(/\/courses\/8\?teacher=2#review-102/);

  await page.goto("/courses?preview=filled");
  await page.getByRole("button", { name: "消息" }).click();
  await page
    .getByRole("menuitem", { name: "有人认可了你对 货币金融学 的点评" })
    .click();
  await expect(page).toHaveURL(/\/courses\/9\?teacher=3#review-201/);

  await page.goto("/courses?preview=filled");
  await page.getByRole("button", { name: "消息" }).click();
  await page
    .getByRole("menuitem", { name: "匿名用户#000002 关注了你" })
    .click();
  await expect(page).toHaveURL(/\/u\/000002/);
});

test("notices preview=notices-error shows the header inbox error", async ({
  page,
}) => {
  await mockApi(page, state({ authenticated: false, unreadCount: null }));
  await page.goto("/courses?preview=notices-error&atlas=1");

  await expect(page.getByRole("button", { name: "消息" })).toBeVisible();
  await expect(page.getByLabel(/条未读消息/)).toHaveCount(0);
  await page.getByRole("button", { name: "消息" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["消息暂时加载不了"]);
});
