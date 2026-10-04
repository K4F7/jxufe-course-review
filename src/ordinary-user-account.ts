import { resolveOrdinaryUser } from "./ordinary-user-authentication";
import { ordinaryUserSessionPayload } from "./ordinary-user-session";
import {
  canOrdinaryUserWrite,
  ordinaryUserMutationSecurityOk,
} from "./ordinary-user-write-authorization";
import { markPublicCatalogCacheChanged } from "./routes/support";
import type { AppContext } from "./routes/types";

export const USER_DELETION_PATH = "/api/user/deletion";
export const USER_DELETION_RESTORE_PATH = "/api/user/deletion/restore";

/**
 * Ordinary-user account deletion (issue #172 / ADR-0016).
 * An active user who confirms DELETE immediately becomes pending_deletion,
 * loses their recognitions, and keeps the auth identity for CSRF restore.
 * This version does not finalize after 30 days.
 */
export async function handleRequestOrdinaryUserDeletion(c: AppContext) {
  const user = await resolveOrdinaryUser(c);
  if (!user) return c.json({ error: "请先登录" }, 401);
  if (!canOrdinaryUserWrite(user))
    return c.json({ error: "当前账号状态无法执行删除" }, 403);
  if (!ordinaryUserMutationSecurityOk(c))
    return c.json({ error: "安全校验失败，请刷新后重试" }, 403);

  let confirm: unknown;
  try {
    const body = await c.req.json<{ confirm?: unknown }>();
    confirm = body.confirm;
  } catch {
    return c.json({ error: "请确认删除" }, 400);
  }
  if (confirm !== "DELETE") return c.json({ error: "请确认删除" }, 400);

  const pendingDeletionAt = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM review_endorsements WHERE user_id=?").bind(
      user.id,
    ),
    c.env.DB.prepare(
      "DELETE FROM historical_review_endorsements WHERE user_id=?",
    ).bind(user.id),
    c.env.DB.prepare(
      "DELETE FROM review_comment_endorsements WHERE user_id=?",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM review_challenges WHERE user_id=?").bind(
      user.id,
    ),
    c.env.DB.prepare(
      "DELETE FROM historical_review_challenges WHERE user_id=?",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM relation_follows WHERE user_id=?").bind(
      user.id,
    ),
    c.env.DB.prepare(
      "DELETE FROM relation_recommendations WHERE user_id=?",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM user_notifications WHERE user_id=?").bind(
      user.id,
    ),
    c.env.DB.prepare(
      "DELETE FROM user_follows WHERE follower_user_id=? OR followed_user_id=?",
    ).bind(user.id, user.id),
    c.env.DB.prepare(
      "UPDATE users SET status='pending_deletion', pending_deletion_at=? WHERE id=? AND status='active'",
    ).bind(pendingDeletionAt, user.id),
  ]);
  // Deletion drops this user's relation signals and recognitions, which are
  // part of the shared list and detail payloads.
  markPublicCatalogCacheChanged(c);
  return c.json(await ordinaryUserSessionPayload(c));
}

export async function handleRestoreOrdinaryUserDeletion(c: AppContext) {
  const user = await resolveOrdinaryUser(c);
  if (!user) return c.json({ error: "请先登录" }, 401);
  if (user.status !== "pending_deletion")
    return c.json({ error: "当前账号不在恢复期" }, 409);
  if (!ordinaryUserMutationSecurityOk(c))
    return c.json({ error: "安全校验失败，请刷新后重试" }, 403);

  await c.env.DB.prepare(
    "UPDATE users SET status='active', pending_deletion_at=NULL WHERE id=? AND status='pending_deletion'",
  )
    .bind(user.id)
    .run();
  return c.json(await ordinaryUserSessionPayload(c));
}
