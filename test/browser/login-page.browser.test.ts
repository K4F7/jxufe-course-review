import { expect, test, type Page } from "@playwright/test";

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
  comment_count: 0,
};

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
          csrfToken: "csrf-guest",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/auth/cas")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/auth/dev")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/user/profile")
      return route.fulfill({
        json: { reviews: [], follows: [], review_count: 0, follow_count: 0 },
      });
    if (url.pathname === "/api/auth/cas/mfa")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/auth/cas/qr")
      return route.fulfill({
        json: {
          challenge: "qr".repeat(16),
          image:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        },
      });
    if (url.pathname === "/api/auth/cas/qr/status")
      return route.fulfill({ json: { status: "pending" } });
    if (url.pathname === "/api/auth/email")
      return route.fulfill({ json: { ok: true } });
    if (url.pathname === "/api/auth/verify")
      return route.fulfill({
        json: {
          authenticated: true,
          csrfToken: "csrf-user",
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    if (url.pathname === "/api/courses")
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
            teachers: [{ id: 9, name: "测试教师", review_count: 1 }],
          },
          reviewCount: 1,
        },
      });
    if (url.pathname === "/api/courses/8/reviews")
      return route.fulfill({
        json: { items: [ENDORSABLE_REVIEW], nextCursor: null },
      });
    if (
      url.pathname === "/api/reviews/review:101/comments" &&
      route.request().method() === "GET"
    )
      return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/reviews/review:101/endorsement")
      return route.fulfill({
        json: {
          endorsementCount: 1,
          viewerEndorsed: true,
          challengeCount: 0,
          viewerChallenged: false,
        },
      });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

test.beforeEach(async ({ page }) => mockApi(page));

test("direct visit shows the CAS form without extra copy or a back link", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "账号密码" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "扫码登录" })).toBeVisible();
  await expect(page.getByLabel("学号")).toBeVisible();
  await expect(page.getByLabel("校园密码")).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "本地测试登录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用校学生邮箱验证" })).toHaveCount(0);
  await expect(page.getByText("也可以改用校学生邮箱验证")).toHaveCount(0);
  await expect(page.getByText("校园 JWT 登录尚未开放")).toHaveCount(0);
  await expect(page.getByText("大多数访问者是游客")).toHaveCount(0);
  await expect(page.getByText("本站不保存校园口令")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回继续浏览" })).toHaveCount(0);
});

test("password form reset clears credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.getByLabel("学号")).toHaveValue("");
  await expect(page.getByLabel("校园密码")).toHaveValue("");
});

test("an authenticated site session can revalidate campus SSO and return to schedule", async ({
  page,
}) => {
  await page.route("**/api/user/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-existing",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    }),
  );
  await page.goto(
    "/login?reauth=campus&from=%2Fschedule%3Fehall%3Dretry",
  );
  await expect(
    page.getByRole("heading", { name: "重新验证校园身份" }),
  ).toBeVisible();
  await expect(page.getByLabel("学号")).toBeVisible();
  await expect(page.getByText("已登录", { exact: true })).toHaveCount(0);
  await page.getByLabel("学号").fill("2202100099");
  await page.getByLabel("校园密码").fill("campus-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/schedule\?ehall=retry$/);
});

test("hides the school-email login entry on the ordinary-user card", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "使用校学生邮箱验证" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("textbox", { name: /校学生邮箱/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送验证信" })).toHaveCount(0);
});

test("MFA step drops a leftover password error and names 企业微信", async ({
  page,
}) => {
  let casCount = 0;
  let mfaPayload = "";
  await page.route("**/api/auth/cas", async (route) => {
    casCount += 1;
    if (casCount === 1) {
      return route.fulfill({
        status: 401,
        json: { error: "学号或密码不正确" },
      });
    }
    return route.fulfill({
      json: {
        needsMfa: true,
        challenge: "ab".repeat(16),
        maskedPhone: "135****5634",
      },
    });
  });
  await page.route("**/api/auth/cas/mfa", async (route) => {
    mfaPayload = route.request().postData() || "";
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("学号或密码不正确")).toBeVisible();

  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("学号或密码不正确")).toHaveCount(0);
  await expect(page.getByText("验证码", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "扫码登录" })).toHaveCount(0);
  await expect(page.getByText("输入发送到企业微信的四位验证码")).toBeVisible();
  await expect(page.getByRole("button", { name: "验证" })).toBeVisible();
  await expect(page.getByText("已发送到企业微信")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "完成登录" })).toHaveCount(0);
  await expect(page.getByText("短信验证码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用校学生邮箱验证" })).toHaveCount(
    0,
  );

  await page.getByLabel("验证码").fill("8765");
  await expect(page).toHaveURL(/\/courses$/);
  expect(mfaPayload).toContain("8765");
  expect(mfaPayload).toContain("secret-pass");
});

test("post-OTP password failure returns to the credential form", async ({
  page,
}) => {
  await page.route("**/api/auth/cas", async (route) => {
    return route.fulfill({
      json: {
        needsMfa: true,
        challenge: "cd".repeat(16),
        maskedPhone: "135****5634",
      },
    });
  });
  await page.route("**/api/auth/cas/mfa", async (route) => {
    return route.fulfill({
      status: 401,
      json: {
        error: "验证码已核销，但学号或密码未通过。请确认后重新登录。",
      },
    });
  });

  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("验证码").fill("8765");
  await expect(page.getByLabel("学号")).toBeVisible();
  await expect(page.getByLabel("校园密码")).toBeVisible();
  await expect(page.getByText("请确认后重新登录")).toBeVisible();
  await expect(page.getByLabel("验证码")).toHaveCount(0);
});

test("submitting campus credentials shows the CAS login control", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "本地测试登录" })).toBeVisible();
});

test("session bootstrap shows a loading status before the form", async ({
  page,
}) => {
  let releaseSession!: () => void;
  const sessionHeld = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route("**/api/user/session", async (route) => {
    await sessionHeld;
    return route.fulfill({
      json: {
        authenticated: false,
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login");
  await expect(page.getByText("正在读取登录状态…")).toBeVisible();
  await expect(page.getByLabel("学号")).toHaveCount(0);
  releaseSession();
  await expect(page.getByLabel("学号")).toBeVisible();
});

test("CAS submit shows a pending button while waiting", async ({
  page,
}) => {
  let releaseCas!: () => void;
  const casHeld = new Promise<void>((resolve) => {
    releaseCas = resolve;
  });
  await page.route("**/api/auth/cas", async (route) => {
    await casHeld;
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page.getByText("通常只要几秒。")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "正在登录…" })).toBeVisible();
  await expect(page.getByLabel("学号")).toBeDisabled();
  await expect(page.getByLabel("校园密码")).toBeDisabled();
  await expect(
    page
      .locator("[data-slot='textfield']")
      .filter({ has: page.getByLabel("校园密码") })
      .locator("[data-slot='spinner']"),
  ).toHaveCount(0);

  releaseCas();
  await expect(page).toHaveURL(/\/courses$/);
});

test("MFA submit shows a pending button while the code is checked", async ({
  page,
}) => {
  let releaseMfa!: () => void;
  const mfaHeld = new Promise<void>((resolve) => {
    releaseMfa = resolve;
  });
  await page.route("**/api/auth/cas", async (route) => {
    return route.fulfill({
      json: {
        needsMfa: true,
        challenge: "ef".repeat(16),
        maskedPhone: "135****5634",
      },
    });
  });
  await page.route("**/api/auth/cas/mfa", async (route) => {
    await mfaHeld;
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("验证码").fill("8765");

  await expect(page.getByRole("button", { name: "正在验证…" })).toBeVisible();
  await expect(page.getByLabel("验证码")).toBeDisabled();

  releaseMfa();
  await expect(page).toHaveURL(/\/courses$/);
});

test("school CAS tips appear on the login card", async ({ page }) => {
  await page.route("**/api/auth/cas", async (route) => {
    return route.fulfill({
      status: 401,
      json: { error: "账号已被锁定，请稍后再试" },
    });
  });

  await page.goto("/login");
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  const fieldError = page.locator("#password-error");
  await expect(fieldError).toHaveText("账号已被锁定，请稍后再试");
  await expect(fieldError).toHaveAttribute("data-visible", "true");
  await expect(page.getByText("账号暂时无法登录")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("学号")).toBeVisible();
});

test("email magic-link redeeming uses the official progress alert", async ({
  page,
}) => {
  let releaseVerify!: () => void;
  const verifyHeld = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });
  await page.route("**/api/auth/verify", async (route) => {
    await verifyHeld;
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login?token=magic-link-token");
  await expect(page.getByText("正在完成登录")).toBeVisible();
  await expect(page.getByText("马上就好。")).toBeVisible();
  await expect(page.getByLabel("学号")).toHaveCount(0);

  releaseVerify();
  await expect(page).toHaveURL(/\/courses$/);
});

async function submitCampusLogin(page: Page) {
  await page.getByLabel("学号").fill("2202100001");
  await page.getByLabel("校园密码").fill("secret-pass");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("returns to the internal source page given by from", async ({ page }) => {
  await page.goto("/login?from=/courses/8");
  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses\/8$/);
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
});

test("external or looping from values fall back to the catalog", async ({
  page,
}) => {
  await page.goto("/login?from=https://evil.example/phish");
  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses$/);

  await page.goto("/login?from=//evil.example");
  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses$/);

  await page.goto("/login?from=/login");
  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses$/);

  await page.goto("/login?from=/login/");
  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses$/);
});

test("guest comment login prompt reaches login and returns to the source page", async ({
  page,
}) => {
  await page.goto("/courses/8?teacher=9");
  await page.getByRole("button", { name: "评论，还没有回复" }).click();
  const loginLink = page
    .locator("p")
    .filter({ hasText: "说说你的看法" })
    .getByRole("link", { name: "登录" });
  await expect(loginLink).toBeVisible();
  await loginLink.click();
  await expect(page).toHaveURL(/\/login\?from=%2Fcourses%2F8%3Fteacher%3D9$/);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();

  await submitCampusLogin(page);
  await expect(page).toHaveURL(/\/courses\/8\?teacher=9$/);
  await expect(
    page.getByRole("button", { name: "认可这条评价，还没有人认可" }),
  ).toBeVisible();
});

test("dev-only local login goes to the personal homepage", async ({ page }) => {
  let sessionCalls = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/user/session") sessionCalls += 1;
  });
  await page.goto("/login");
  await expect.poll(() => sessionCalls).toBeGreaterThan(0);
  const initialSessionCalls = sessionCalls;
  await page.getByRole("button", { name: "本地测试登录" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText("我的主页")).toBeVisible();
  expect(sessionCalls).toBe(initialSessionCalls);
});

const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("QR tab shows the official image without a hint Alert @mobile-smoke", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("tab", { name: "扫码登录" }).click();
  const qr = page.getByRole("img", { name: "微信或企业微信登录二维码" });
  await expect(qr).toBeVisible();
  await expect(page.getByText("使用微信或企业微信扫一扫登录")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("expired QR shows official copy and refresh requests a new challenge", async ({
  page,
}) => {
  let qrStarts = 0;
  await page.route("**/api/auth/cas/qr", async (route) => {
    qrStarts += 1;
    return route.fulfill({
      json: {
        challenge: `c${qrStarts}`.padEnd(32, "0"),
        image: QR_DATA_URL,
      },
    });
  });
  await page.route("**/api/auth/cas/qr/status", async (route) => {
    return route.fulfill({ json: { status: "expired" } });
  });

  await page.goto("/login");
  await page.getByRole("tab", { name: "扫码登录" }).click();
  await expect(page.getByText("二维码已失效")).toBeVisible();
  await expect(page.getByRole("img", { name: "微信或企业微信登录二维码" })).toBeVisible();
  const refresh = page.getByRole("button", { name: "刷新二维码" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect.poll(() => qrStarts).toBe(2);
  await expect(page.getByText("二维码已失效")).toBeVisible();
});

test("authorized QR login navigates away", async ({ page }) => {
  let polls = 0;
  await page.route("**/api/auth/cas/qr/status", async (route) => {
    polls += 1;
    if (polls < 4) return route.fulfill({ json: { status: "scanned" } });
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: "csrf-user",
        loginPath: "/login",
        logoutPath: "/logout",
      },
    });
  });

  await page.goto("/login");
  await page.getByRole("tab", { name: "扫码登录" }).click();
  await expect(page.getByRole("img", { name: "微信或企业微信登录二维码" })).toBeVisible();
  await expect(page.getByText("扫码成功，请在手机上确认")).toBeVisible();
  await expect(page).toHaveURL(/\/courses$/);
});

test("leaving the QR tab and coming back starts a new challenge", async ({
  page,
}) => {
  let qrStarts = 0;
  await page.route("**/api/auth/cas/qr", async (route) => {
    qrStarts += 1;
    return route.fulfill({
      json: {
        challenge: `d${qrStarts}`.padEnd(32, "0"),
        image: QR_DATA_URL,
      },
    });
  });

  await page.goto("/login");
  await page.getByRole("tab", { name: "扫码登录" }).click();
  await expect(page.getByRole("img", { name: "微信或企业微信登录二维码" })).toBeVisible();
  await expect.poll(() => qrStarts).toBe(1);
  await page.getByRole("tab", { name: "账号密码" }).click();
  await expect(page.getByLabel("学号")).toBeVisible();
  await page.getByRole("tab", { name: "扫码登录" }).click();
  await expect.poll(() => qrStarts).toBe(2);
});

test("dev-only local login honors a safe from target", async ({ page }) => {
  await page.goto("/login?from=/courses/8");
  await page.getByRole("button", { name: "本地测试登录" }).click();
  await expect(page).toHaveURL(/\/courses\/8$/);
  await expect(
    page.getByRole("heading", { name: /中国传统文化导论（测试教师）/ }),
  ).toBeVisible();
});
