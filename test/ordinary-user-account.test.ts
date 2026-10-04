import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  hmacHex,
  ordinaryUserTestHeaders,
} from "../src/ordinary-user-authentication";
import { ORDINARY_USER_CSRF_COOKIE } from "../src/ordinary-user-write-authorization";
import { PUBLIC_CATALOG_CACHE_TAG } from "../src/lib/public-catalog-cache";
import { adminAuth } from "./admin-session";

const origin = "https://example.com";
const testAuthSecret = "test-ordinary-user-auth";
const deletionPath = `${origin}/api/user/deletion`;
const restorePath = `${origin}/api/user/deletion/restore`;

type SessionBody = {
  authenticated: boolean;
  accountStatus?: string;
  restoreUntil?: string;
  csrfToken?: string;
  loginPath?: string;
  logoutPath?: string;
};

async function authedUser(userId: string) {
  const auth = await ordinaryUserTestHeaders(userId, testAuthSecret);
  const session = await SELF.fetch(`${origin}/api/user/session`, {
    headers: auth,
  });
  expect(session.status).toBe(200);
  const body = await session.json<SessionBody>();
  expect(body.authenticated).toBe(true);
  expect(body.csrfToken).toBeTruthy();
  return {
    auth,
    csrf: body.csrfToken || "",
    stableUserId: await hmacHex(`ordinary-test-user:${userId}`, testAuthSecret),
  };
}

function writeHeaders(user: Awaited<ReturnType<typeof authedUser>>) {
  return {
    ...user.auth,
    Origin: origin,
    Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${user.csrf}`,
    "X-CSRF-Token": user.csrf,
    "Content-Type": "application/json",
  };
}

async function insertReviewWithEndorsement(userId: string, comment: string) {
  const review = await env.DB.prepare(
    `INSERT INTO reviews(
      course_id,teacher_id,category,overall,comment,status,submitter_hash
    ) VALUES(1,1,'general',4,?,'approved',?)`,
  )
    .bind(comment, `account-${comment}-${Date.now()}-${Math.random()}`)
    .run();
  const reviewId = Number(review.meta.last_row_id);
  await env.DB.prepare(
    "INSERT INTO review_endorsements(user_id,review_id) VALUES(?,?)",
  )
    .bind(userId, reviewId)
    .run();
  return reviewId;
}

function assertNoIdentityLeak(value: unknown, userId: string) {
  const raw = JSON.stringify(value);
  expect(raw).not.toContain(userId);
  expect(raw).not.toMatch(/"user_id"|20230001|"id":"[0-9a-f]{32}"/);
}

describe("ordinary user account deletion", () => {
  it("marks an active user pending_deletion and removes their recognitions", async () => {
    const user = await authedUser("account-delete-user");
    const reviewId = await insertReviewWithEndorsement(
      user.stableUserId,
      "删除账号认可清理",
    );
    await env.DB.prepare(
      `INSERT INTO user_notifications(
         user_id,type,message,link,event_key,source_review_id
       ) VALUES(?,'review_endorsed','待清理消息','/courses/1',?,?)`,
    )
      .bind(user.stableUserId, `account-delete-${reviewId}`, reviewId)
      .run();

    const response = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<SessionBody>();
    expect(body.authenticated).toBe(false);
    expect(body.accountStatus).toBe("pending_deletion");
    expect(body.csrfToken).toBeTruthy();
    expect(body.loginPath).toBe("/login");
    expect(body.logoutPath).toBe("/logout");
    const restoreUntil = Date.parse(body.restoreUntil || "");
    expect(restoreUntil).toBeGreaterThan(Date.now());
    expect(
      Math.abs(restoreUntil - (Date.now() + 30 * 24 * 60 * 60 * 1000)),
    ).toBeLessThan(15_000);
    assertNoIdentityLeak(body, user.stableUserId);

    const row = await env.DB.prepare(
      "SELECT status, pending_deletion_at FROM users WHERE id=?",
    )
      .bind(user.stableUserId)
      .first<{ status: string; pending_deletion_at: string | null }>();
    expect(row?.status).toBe("pending_deletion");
    expect(row?.pending_deletion_at).toBeTruthy();

    const endorsement = await env.DB.prepare(
      "SELECT COUNT(*) count FROM review_endorsements WHERE user_id=?",
    )
      .bind(user.stableUserId)
      .first<{ count: number }>();
    expect(endorsement?.count).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM user_notifications WHERE user_id=?",
      )
        .bind(user.stableUserId)
        .first(),
    ).toEqual({ count: 0 });

    const review = await env.DB.prepare(
      "SELECT status FROM reviews WHERE id=?",
    )
      .bind(reviewId)
      .first<{ status: string }>();
    expect(review?.status).toBe("approved");
  });

  it("purges the public list tag when deletion removes relation signals", async () => {
    const user = await authedUser("account-delete-cache-user");
    await env.DB.prepare(
      "INSERT INTO relation_follows(user_id,course_id,teacher_id) VALUES(?,1,1)",
    )
      .bind(user.stableUserId)
      .run();
    const purge = vi.fn().mockResolvedValue(undefined);
    const response = await app.fetch(
      new Request(deletionPath, {
        method: "POST",
        headers: writeHeaders(user),
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
      env,
      {
        waitUntil() {},
        passThroughOnException() {},
        cache: { purge },
      } as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(purge).toHaveBeenCalledWith({
      tags: expect.arrayContaining([PUBLIC_CATALOG_CACHE_TAG]),
    });
  });

  it("exposes a pending_deletion session with CSRF and no public identity", async () => {
    const user = await authedUser("account-session-user");
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(deleted.status).toBe(200);

    const session = await SELF.fetch(`${origin}/api/user/session`, {
      headers: user.auth,
    });
    expect(session.status).toBe(200);
    const body = await session.json<SessionBody>();
    expect(body).toMatchObject({
      authenticated: false,
      accountStatus: "pending_deletion",
      loginPath: "/login",
      logoutPath: "/logout",
    });
    expect(body.csrfToken).toBeTruthy();
    expect(Date.parse(body.restoreUntil || "")).toBeGreaterThan(Date.now());
    assertNoIdentityLeak(body, user.stableUserId);
  });

  it("keeps endorsement writes forbidden during the recovery window", async () => {
    const user = await authedUser("account-write-user");
    const reviewId = await insertReviewWithEndorsement(
      user.stableUserId,
      "恢复期认可仍拒绝",
    );
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(deleted.status).toBe(200);

    const write = await SELF.fetch(
      `${origin}/api/reviews/${reviewId}/endorsement`,
      {
        method: "PUT",
        headers: {
          ...writeHeaders(user),
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    expect(write.status).toBe(403);
    assertNoIdentityLeak(await write.json(), user.stableUserId);
  });

  it("rejects guests, bad confirm, missing CSRF, cross-origin, admin, and banned deletion", async () => {
    const guest = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(guest.status).toBe(401);

    const admin = await adminAuth();
    const adminCookie = admin.cookie;
    const asAdmin = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(asAdmin.status).toBe(401);

    const user = await authedUser("account-reject-user");
    const noCsrf = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: { ...user.auth, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(noCsrf.status).toBe(403);

    const wrongOrigin = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: { ...writeHeaders(user), Origin: "https://evil.example" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongConfirm = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "delete" }),
    });
    expect(wrongConfirm.status).toBe(400);

    const banned = await authedUser("account-banned-user");
    await env.DB.prepare("UPDATE users SET status='banned' WHERE id=?")
      .bind(banned.stableUserId)
      .run();
    const bannedDelete = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(banned),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(bannedDelete.status).toBe(403);

    const stillActive = await env.DB.prepare(
      "SELECT status FROM users WHERE id=?",
    )
      .bind(user.stableUserId)
      .first<{ status: string }>();
    expect(stillActive?.status).toBe("active");
  });

  it("restores a pending_deletion account without bringing recognitions back", async () => {
    const user = await authedUser("account-restore-user");
    const reviewId = await insertReviewWithEndorsement(
      user.stableUserId,
      "恢复不还原认可",
    );
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    const deletedBody = await deleted.json<SessionBody>();
    expect(deleted.status).toBe(200);
    const restoreHeaders = {
      ...user.auth,
      Origin: origin,
      Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${deletedBody.csrfToken}`,
      "X-CSRF-Token": deletedBody.csrfToken || "",
    };

    const restored = await SELF.fetch(restorePath, {
      method: "POST",
      headers: restoreHeaders,
    });
    expect(restored.status).toBe(200);
    const body = await restored.json<SessionBody>();
    expect(body.authenticated).toBe(true);
    expect(body.accountStatus).toBeUndefined();
    expect(body.csrfToken).toBeTruthy();
    assertNoIdentityLeak(body, user.stableUserId);

    const row = await env.DB.prepare(
      "SELECT status, pending_deletion_at FROM users WHERE id=?",
    )
      .bind(user.stableUserId)
      .first<{ status: string; pending_deletion_at: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.pending_deletion_at).toBeNull();

    const endorsement = await env.DB.prepare(
      "SELECT COUNT(*) count FROM review_endorsements WHERE user_id=?",
    )
      .bind(user.stableUserId)
      .first<{ count: number }>();
    expect(endorsement?.count).toBe(0);

    const write = await SELF.fetch(
      `${origin}/api/reviews/${reviewId}/endorsement`,
      {
        method: "PUT",
        headers: {
          ...user.auth,
          Origin: origin,
          Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${body.csrfToken}`,
          "X-CSRF-Token": body.csrfToken || "",
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    expect(write.status).toBe(200);
  });

  it("does not change status when restore is called outside pending_deletion", async () => {
    const user = await authedUser("account-restore-active-user");
    const response = await SELF.fetch(restorePath, {
      method: "POST",
      headers: writeHeaders(user),
    });
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM users WHERE id=?")
      .bind(user.stableUserId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");

    const guest = await SELF.fetch(restorePath, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(guest.status).toBe(401);

    const pending = await authedUser("account-restore-guard-user");
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(pending),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    const deletedBody = await deleted.json<SessionBody>();
    const noCsrf = await SELF.fetch(restorePath, {
      method: "POST",
      headers: { ...pending.auth, Origin: origin },
    });
    expect(noCsrf.status).toBe(403);
    const wrongOrigin = await SELF.fetch(restorePath, {
      method: "POST",
      headers: {
        ...pending.auth,
        Origin: "https://evil.example",
        Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${deletedBody.csrfToken}`,
        "X-CSRF-Token": deletedBody.csrfToken || "",
      },
    });
    expect(wrongOrigin.status).toBe(403);
    const stillPending = await env.DB.prepare(
      "SELECT status FROM users WHERE id=?",
    )
      .bind(pending.stableUserId)
      .first<{ status: string }>();
    expect(stillPending?.status).toBe("pending_deletion");
  });

  it("still restores after the 30-day copy window and never finalizes", async () => {
    const user = await authedUser("account-late-restore-user");
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    const deletedBody = await deleted.json<SessionBody>();
    expect(deleted.status).toBe(200);

    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "UPDATE users SET pending_deletion_at=? WHERE id=?",
    )
      .bind(past, user.stableUserId)
      .run();

    await env.DB.prepare(
      "INSERT INTO auth_identities(provider,issuer,subject,user_id) VALUES(?,?,?,?)",
    )
      .bind("legacy", "jufexk", "late-restore-subject", user.stableUserId)
      .run();
    const identityBefore = await env.DB.prepare(
      "SELECT COUNT(*) count FROM auth_identities WHERE user_id=?",
    )
      .bind(user.stableUserId)
      .first<{ count: number }>();
    expect(identityBefore?.count).toBe(1);

    const restored = await SELF.fetch(restorePath, {
      method: "POST",
      headers: {
        ...user.auth,
        Origin: origin,
        Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${deletedBody.csrfToken}`,
        "X-CSRF-Token": deletedBody.csrfToken || "",
      },
    });
    expect(restored.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT status, pending_deletion_at FROM users WHERE id=?",
    )
      .bind(user.stableUserId)
      .first<{ status: string; pending_deletion_at: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.pending_deletion_at).toBeNull();
    expect(row?.status).not.toBe("deleted");

    const identityAfter = await env.DB.prepare(
      "SELECT COUNT(*) count FROM auth_identities WHERE user_id=?",
    )
      .bind(user.stableUserId)
      .first<{ count: number }>();
    expect(identityAfter?.count).toBe(identityBefore?.count);
  });

  it("lets a pending_deletion user log out without restoring", async () => {
    const user = await authedUser("account-logout-user");
    const deleted = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    const deletedBody = await deleted.json<SessionBody>();
    expect(deleted.status).toBe(200);

    const logout = await SELF.fetch(`${origin}/api/user/logout`, {
      method: "POST",
      headers: {
        ...user.auth,
        Origin: origin,
        Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${deletedBody.csrfToken}`,
        "X-CSRF-Token": deletedBody.csrfToken || "",
      },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toMatchObject({ authenticated: false });
    const row = await env.DB.prepare("SELECT status FROM users WHERE id=?")
      .bind(user.stableUserId)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending_deletion");
  });

  it("rejects a repeat deletion once the account is pending_deletion", async () => {
    const user = await authedUser("account-repeat-user");
    const first = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: writeHeaders(user),
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json<SessionBody>();
    const startedAt = (
      await env.DB.prepare(
        "SELECT pending_deletion_at FROM users WHERE id=?",
      )
        .bind(user.stableUserId)
        .first<{ pending_deletion_at: string }>()
    )?.pending_deletion_at;

    const second = await SELF.fetch(deletionPath, {
      method: "POST",
      headers: {
        ...user.auth,
        Origin: origin,
        Cookie: `${ORDINARY_USER_CSRF_COOKIE}=${firstBody.csrfToken}`,
        "X-CSRF-Token": firstBody.csrfToken || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(second.status).toBe(403);
    const after = await env.DB.prepare(
      "SELECT status, pending_deletion_at FROM users WHERE id=?",
    )
      .bind(user.stableUserId)
      .first<{ status: string; pending_deletion_at: string | null }>();
    expect(after?.status).toBe("pending_deletion");
    expect(after?.pending_deletion_at).toBe(startedAt);
  });
});
