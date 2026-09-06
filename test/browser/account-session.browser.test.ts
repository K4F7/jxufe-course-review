/**
 * Browser coverage for ordinary-user session, logout and account-to-profile
 * routing (issue #139 / #325). `/api/user/session` is the only viewer-state source.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type MockState = {
  authenticated: boolean;
  sessionFails: boolean;
  logoutFails: boolean;
  endorsement401: boolean;
  logoutCalls: number;
  deleteCalls: number;
};

const ENDORSABLE_REVIEW = {
  id: "review:101",
  course_id: 8,
  teacher_id: 9,
  course_name: "中国传统文化导论",
  course_code: "GEN0108",
  teacher_name: "测试教师",
  comment: "这是一条可认可的任课评价补充说明，内容足够长，用于验证认可入口。",
  endorsement_count: 0,
  endorsable: true,
};

function state(overrides: Partial<MockState> = {}): MockState {
  return {
    authenticated: false,
    sessionFails: false,
    logoutFails: false,
    endorsement401: false,
    logoutCalls: 0,
    deleteCalls: 0,
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
      if (mock.sessionFails)
        return fulfillJson(route, { error: "boom" }, 500);
      return fulfillJson(route, {
        authenticated: mock.authenticated,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
        ...(mock.authenticated
          ? { handle: "匿名用户#000001", avatar_key: 0 }
          : {}),
      });
    }
    if (url.pathname === "/api/user/logout" && request.method() === "POST") {
      mock.logoutCalls += 1;
      if (mock.logoutFails)
        return fulfillJson(route, { error: "boom" }, 500);
      mock.authenticated = false;
      return fulfillJson(route, {
        ok: true,
        authenticated: false,
        loginPath: "/login",
        logoutPath: "/logout",
      });
    }
    if (url.pathname === "/api/user/profile")
      return fulfillJson(route, { reviews: [], follows: [], review_count: 0, follow_count: 0 });
    if (url.pathname === "/api/user/account" && request.method() === "DELETE") {
      mock.deleteCalls += 1;
      if (!mock.authenticated)
        return fulfillJson(route, { error: "请先登录" }, 401);
      mock.authenticated = false;
      return fulfillJson(route, {
        ok: true,
        status: "pending_deletion",
        recoveryDays: 30,
      });
    }
    if (url.pathname === "/api/courses")
      return fulfillJson(route, {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        pages: 1,
      });
    if (url.pathname === "/api/courses/8")
      return fulfillJson(route, {
        course: {
          id: 8,
          code: "GEN0108",
          name: "中国传统文化导论",
          category: "general",
          department: "人文学院",
          teachers: [{ id: 9, name: "测试教师", review_count: 1 }],
        },
        reviewCount: 1,
      });
    if (url.pathname === "/api/courses/8/reviews")
      return fulfillJson(route, {
        items: [ENDORSABLE_REVIEW],
        nextCursor: null,
      });
    const endorsement = /\/api\/reviews\/([^/]+)\/endorsement$/.exec(
      url.pathname,
    );
    if (endorsement && request.method() === "PUT") {
      if (mock.endorsement401)
        return fulfillJson(route, { error: "请先登录后再认可" }, 401);
      return fulfillJson(route, {
        endorsementCount: 1,
        viewerEndorsed: true,
        challengeCount: 0,
        viewerChallenged: false,
      });
    }
    return fulfillJson(route, { error: "not mocked" }, 404);
  });
}

test("guest nav shows a login link into the CAS form @mobile-smoke", async ({
  page,
}) => {
  await mockApi(page, state());
  await page.goto("/courses");
  const login = page.getByRole("link", { name: "登录" });
  await expect(login).toBeVisible();
  await expect(page.getByText("登录未开放")).toHaveCount(0);
  await login.click();
  await expect(page).toHaveURL(/\/login\?from=%2Fcourses$/);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByLabel("学号")).toBeVisible();
  await expect(page.getByLabel("校园密码")).toBeVisible();
  await expect(page.getByRole("button", { name: "使用校学生邮箱验证" })).toHaveCount(
    0,
  );
});

test("signed-in viewer sees the account menu and leaves /login for the prior page", async ({
  page,
}) => {
  await mockApi(page, state({ authenticated: true }));
  await page.goto("/courses");
  const account = page.getByRole("button", { name: "账号" });
  await expect(account).toBeVisible();
  await expect(account).toContainText("匿名用户#000001");
  await expect(account.locator("img")).toHaveCount(0);
  await expect(account).not.toHaveText(/^账号$/);
  await expect(page.getByRole("link", { name: "登录" })).toHaveCount(0);

  await page.goto("/login");
  await expect(page.getByText("已登录", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送验证信" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/courses$/);
});

test("logout from the account menu stays on the page and confirms in a dialog", async ({
  page,
}) => {
  const mock = state({ authenticated: true });
  await mockApi(page, mock);
  await page.goto("/courses");

  await page.getByRole("button", { name: "账号" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/courses$/);
  const dialog = page.getByRole("alertdialog", { name: "确认退出登录？" });
  await expect(dialog).toBeVisible();
  expect(mock.logoutCalls).toBe(0);

  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "账号" })).toBeVisible();
  expect(mock.logoutCalls).toBe(0);

  await page.getByRole("button", { name: "账号" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "确认退出" }).click();
  await expect(page).toHaveURL(/\/courses$/);
  expect(mock.logoutCalls).toBe(1);
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByText("登录未开放")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("logout failure offers a retry that recovers", async ({ page }) => {
  const mock = state({ authenticated: true, logoutFails: true });
  await mockApi(page, mock);
  await page.goto("/courses");
  await page.getByRole("button", { name: "账号" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "确认退出" }).click();
  await expect(page.getByText("退出失败")).toBeVisible();
  await expect(
    page.getByText("网络或服务暂时不可用，退出没有完成，请重试。"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByRole("button", { name: "账号" })).toBeVisible();

  mock.logoutFails = false;
  await page.getByRole("button", { name: "重试退出" }).click();
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
  expect(mock.logoutCalls).toBe(2);
  await expect(page).toHaveURL(/\/courses$/);
});

test("a 401 on a write clears the viewer state without a vote login prompt", async ({
  page,
}) => {
  await mockApi(
    page,
    state({ authenticated: true, endorsement401: true }),
  );
  await page.goto("/courses/8?teacher=9");
  await expect(page.getByRole("button", { name: "账号" })).toBeVisible();

  await page
    .getByRole("button", { name: "认可这条评价，还没有人认可" })
    .click();
  await expect(page.getByRole("alert")).toContainText("认可失败");
  await expect(page.getByText("后才可互动")).toHaveCount(0);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "登录", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "账号", exact: true }),
  ).toHaveCount(0);
});

test("session outage degrades to guest browsing without blocking pages", async ({
  page,
}) => {
  await mockApi(page, state({ sessionFails: true }));
  await page.goto("/courses/8?teacher=9");
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "登录" })).toBeVisible();
  await expect(page.getByText("登录未开放")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "认可这条评价，还没有人认可" }),
  ).toBeEnabled();
});

test("signed-in account page goes to the personal homepage", async ({
  page,
}) => {
  await mockApi(page, state({ authenticated: true }));
  await page.goto("/account");
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("button", { name: "删除账号" })).toHaveCount(0);
});

test("account page guides guests to login instead of showing account data", async ({
  page,
}) => {
  await mockApi(page, state());
  await page.goto("/account");
  await expect(page.getByText("当前未登录")).toBeVisible();
  await page.getByRole("link", { name: "前往登录" }).click();
  await expect(page).toHaveURL(/\/login\?from=%2Faccount$/);
});

test("keyboard reaches the account menu and logout confirm", async ({
  page,
}) => {
  const mock = state({ authenticated: true });
  await mockApi(page, mock);
  await page.goto("/courses");

  const account = page.getByRole("button", { name: "账号" });
  await account.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Keyboard open focuses the first item (主页); one ArrowDown
  // reaches 退出登录.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/courses$/);
  const confirmLogout = page.getByRole("button", { name: "确认退出" });
  await expect(confirmLogout).toBeVisible();
  await confirmLogout.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/courses$/);
});
