import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hmacHex } from "../src/ordinary-user-authentication";
import {
  RESERVED_PUBLIC_CODE,
  RESERVED_USER_ID,
  defaultAvatarKey,
  formatPublicCode,
  formatPublicHandle,
} from "../src/public-handle";
import {
  ORDINARY_TEST_AUTH_SECRET,
  WRITE_ORIGIN,
  ordinaryWriteHeaders,
  ordinaryWriteSession,
} from "./ordinary-write-session";

async function stableUserId(userId: string) {
  return hmacHex(`ordinary-test-user:${userId}`, ORDINARY_TEST_AUTH_SECRET);
}

async function publicCodeFor(userId: string) {
  const id = await stableUserId(userId);
  const row = await env.DB.prepare(
    "SELECT public_code FROM users WHERE id=?",
  )
    .bind(id)
    .first<{ public_code: number }>();
  return { id, public_code: Number(row?.public_code) };
}

async function createBoundCourse(code: string) {
  const inserted = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department) VALUES(?,?,'general','测试学院')",
  )
    .bind(code, `公开主页课 ${code}`)
    .run();
  const courseId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,1)",
  )
    .bind(courseId)
    .run();
  return courseId;
}

describe("public user profile and follow", () => {
  it("exposes reserved #000000 for unattributed reviews and allows follow", async () => {
    const reserved = await env.DB.prepare(
      "SELECT id,public_code FROM users WHERE id=?",
    )
      .bind(RESERVED_USER_ID)
      .first<{ id: string; public_code: number | null }>();
    expect(reserved?.id).toBe(RESERVED_USER_ID);
    expect(reserved?.public_code == null || reserved.public_code === 0).toBe(
      true,
    );
    await env.DB.prepare(
      `INSERT INTO reviews(
         course_id,teacher_id,category,overall,comment,status,submitter_hash
       ) VALUES(1,1,'general',4,'来自以前的学长学姐的评价正文','approved','anon-hash')`,
    ).run();
    const response = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000`);
    expect(response.status).toBe(200);
    const body = await response.json<{
      public_code: number;
      handle: string;
      reserved: boolean;
      followable: boolean;
      viewer_followed: boolean;
      note: string;
      reviews: Array<{
        author_public_code: number;
        author_avatar_key: number;
        comment: string;
      }>;
    }>();
    expect(body).toMatchObject({
      public_code: 0,
      handle: "匿名用户#000000",
      reserved: true,
      followable: false,
      viewer_followed: false,
      note: "来自以前的学长学姐的评价，部分整理自 QQ 频道「江西财经大学」",
    });
    expect(
      body.reviews.some((review) => review.comment.includes("学长学姐")),
    ).toBe(true);
    expect(
      body.reviews.every((review) => review.author_public_code === 0),
    ).toBe(true);
    expect(
      body.reviews.every((review) => review.author_avatar_key === 0),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"id":"[0-9a-f]{32}"/);
    expect(JSON.stringify(body)).not.toContain(RESERVED_USER_ID);

    const session = await ordinaryWriteSession("follow-reserved");
    const follow = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000/follow`, {
      method: "PUT",
      headers: ordinaryWriteHeaders(session),
    });
    expect(follow.status).toBe(200);
    expect(await follow.json()).toMatchObject({ viewer_followed: true });
    const viewing = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000`, {
      headers: session.auth,
    });
    const viewingBody = await viewing.json<{
      followable: boolean;
      viewer_followed: boolean;
      follower_count: number;
      following_count: number;
    }>();
    expect(viewingBody).toMatchObject({
      followable: true,
      viewer_followed: true,
      follower_count: 1,
      following_count: 0,
    });
    expect(JSON.stringify(viewingBody)).not.toContain(RESERVED_USER_ID);

    const unfollowed = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000/follow`, {
      method: "DELETE",
      headers: ordinaryWriteHeaders(session),
    });
    expect(await unfollowed.json()).toMatchObject({ viewer_followed: false });
    const after = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000`, {
      headers: session.auth,
    });
    expect(await after.json()).toMatchObject({
      viewer_followed: false,
      follower_count: 0,
    });
  });

  it("counts distinct public courses for reserved and numbered handles", async () => {
    const first = await createBoundCourse("U612A");
    const second = await createBoundCourse("U612B");
    const statements = [];
    for (let index = 0; index < 51; index += 1) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO reviews(
             course_id,teacher_id,category,overall,comment,status,submitter_hash
           ) VALUES(?,1,'general',4,?,'approved',?)`,
        ).bind(first, `保留号重复课点评 ${index}`, `u612-reserved-${index}`),
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,submitter_hash
         ) VALUES(?,1,'general',4,'保留号第二门课','approved','u612-reserved-other')`,
      ).bind(second),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,submitter_hash
         ) VALUES(?,1,'general',4,'待审不计入','pending','u612-reserved-pending')`,
      ).bind(first),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,submitter_hash
         ) VALUES(?,1,'general',4,'驳回不计入','rejected','u612-reserved-rejected')`,
      ).bind(second),
    );
    await env.DB.batch(statements);
    await env.DB.prepare(
      `INSERT INTO public_historical_reviews(
         id,course_id,teacher_id,comment,package_contract,
         approved_package_manifest_sha256,approved_catalog_content_sha256
       ) VALUES('u612-hist',?,1,'历史同一门课','contract','manifest','catalog')`,
    )
      .bind(first)
      .run();

    const reserved = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000`);
    const reservedBody = await reserved.json<{
      review_count: number;
      reviews: Array<{ course_id: number }>;
    }>();
    expect(reservedBody.reviews).toHaveLength(50);
    expect(reservedBody.review_count).not.toBe(50);
    expect(reservedBody.review_count).toBeGreaterThanOrEqual(2);
    expect(reservedBody.review_count).toBeLessThan(reservedBody.reviews.length);

    const author = await ordinaryWriteSession("count-author");
    const { id: authorId, public_code } = await publicCodeFor(author.userId);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,
           submitter_hash,author_user_id
         ) VALUES(?,1,'general',5,'作者第一门','approved','u612-author-a',?)`,
      ).bind(first, authorId),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,
           submitter_hash,author_user_id
         ) VALUES(?,1,'general',4,'作者同一门第二篇','approved','u612-author-a2',?)`,
      ).bind(first, authorId),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,
           submitter_hash,author_user_id
         ) VALUES(?,1,'general',5,'作者第二门','approved','u612-author-b',?)`,
      ).bind(second, authorId),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,
           submitter_hash,author_user_id
         ) VALUES(?,1,'general',3,'作者待审','pending','u612-author-p',?)`,
      ).bind(first, authorId),
    ]);
    const numbered = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}`,
    );
    const numberedBody = await numbered.json<{ review_count: number }>();
    expect(numberedBody.review_count).toBe(2);
  });

  it("shows authored reviews under a real handle and allows follow", async () => {
    const author = await ordinaryWriteSession("public-author");
    const follower = await ordinaryWriteSession("public-follower");
    const { id: authorId, public_code } = await publicCodeFor(author.userId);
    const followerId = await stableUserId(follower.userId);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,headline,status,
           submitter_hash,author_user_id
         ) VALUES(1,1,'general',5,'作者公开点评','公开总结','approved','hash-a',?)`,
      ).bind(authorId),
      env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,
           submitter_hash,author_user_id
         ) VALUES(1,1,'general',3,'作者待审点评','pending','hash-p',?)`,
      ).bind(authorId),
    ]);

    const guest = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}`,
    );
    expect(guest.status).toBe(200);
    const guestBody = await guest.json<{
      handle: string;
      followable: boolean;
      following_count: number;
      follower_count: number;
      reviews: Array<{ headline?: string; status?: string }>;
    }>();
    expect(guestBody.handle).toBe(formatPublicHandle(public_code));
    expect(guestBody.followable).toBe(false);
    expect(guestBody).toMatchObject({
      following_count: 0,
      follower_count: 0,
    });
    expect(guestBody.reviews).toEqual([
      expect.objectContaining({ headline: "公开总结" }),
    ]);
    expect(JSON.stringify(guestBody)).not.toContain(authorId);
    expect(JSON.stringify(guestBody)).not.toContain("待审");

    const self = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}`,
      { headers: author.auth },
    );
    expect((await self.json<{ viewer_is_self: boolean }>()).viewer_is_self).toBe(
      true,
    );
    const selfFollow = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}/follow`,
      { method: "PUT", headers: ordinaryWriteHeaders(author) },
    );
    expect(selfFollow.status).toBe(400);

    const followed = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}/follow`,
      { method: "PUT", headers: ordinaryWriteHeaders(follower) },
    );
    expect(followed.status).toBe(200);
    expect(await followed.json()).toMatchObject({ viewer_followed: true });
    const viewing = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}`,
      { headers: follower.auth },
    );
    const viewingBody = await viewing.json();
    expect(viewingBody).toMatchObject({
      viewer_followed: true,
      follower_count: 1,
      following_count: 0,
    });
    expect(JSON.stringify(viewingBody)).not.toContain(followerId);
    const authorInbox = await SELF.fetch(`${WRITE_ORIGIN}/api/user/notifications`, {
      headers: author.auth,
    });
    const authorInboxBody = await authorInbox.json<{
      items: Array<{ type: string; message: string; link: string }>;
    }>();
    expect(
      authorInboxBody.items.some(
        (item) =>
          item.type === "user_followed" &&
          item.message.includes("关注了你") &&
          item.link.startsWith("/u/"),
      ),
    ).toBe(true);

    await env.DB.prepare(
      `INSERT INTO reviews(
         course_id,teacher_id,category,overall,comment,status,
         submitter_hash,author_user_id
       ) VALUES(1,1,'general',4,'关注后新点评','approved','hash-n',?)`,
    )
      .bind(authorId)
      .run();
    const inbox = await SELF.fetch(`${WRITE_ORIGIN}/api/user/notifications`, {
      headers: follower.auth,
    });
    const inboxBody = await inbox.json<{
      items: Array<{ type: string; message: string }>;
    }>();
    expect(inboxBody.items.some((item) => item.type === "followed_user_review")).toBe(
      true,
    );
    expect(
      inboxBody.items.some((item) =>
        item.message.includes(formatPublicHandle(public_code)),
      ),
    ).toBe(true);

    const unfollowed = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}/follow`,
      { method: "DELETE", headers: ordinaryWriteHeaders(follower) },
    );
    expect(await unfollowed.json()).toMatchObject({ viewer_followed: false });
  });

  it("projects reserved handle on public review lists", async () => {
    await env.DB.prepare(
      `INSERT INTO reviews(
         course_id,teacher_id,category,overall,comment,status,submitter_hash
       ) VALUES(1,1,'general',4,'公开流匿名点评','approved','list-anon')`,
    ).run();
    const latest = await SELF.fetch(`${WRITE_ORIGIN}/api/reviews/latest`);
    const latestBody = await latest.json<{
      items: Array<{ comment: string; author_public_code: number }>;
    }>();
    const anon = latestBody.items.find((item) => item.comment === "公开流匿名点评");
    expect(anon?.author_public_code).toBe(0);

    const author = await ordinaryWriteSession("list-author");
    const { id, public_code } = await publicCodeFor(author.userId);
    await env.DB.prepare(
      `INSERT INTO reviews(
         course_id,teacher_id,category,overall,comment,status,
         submitter_hash,author_user_id
       ) VALUES(1,1,'general',5,'公开流作者点评','approved','list-author',?)`,
    )
      .bind(id)
      .run();
    const again = await SELF.fetch(`${WRITE_ORIGIN}/api/reviews/latest`);
    const authored = (
      await again.json<{
        items: Array<{ comment: string; author_public_code: number }>;
      }>()
    ).items.find((item) => item.comment === "公开流作者点评");
    expect(authored?.author_public_code).toBe(public_code);
  });

  it("uses the stored avatar_key on numbered profile reviews", async () => {
    const author = await ordinaryWriteSession("stored-avatar-author");
    const { id, public_code } = await publicCodeFor(author.userId);
    const storedKey = (defaultAvatarKey(public_code) + 1) % 5;
    const patched = await SELF.fetch(`${WRITE_ORIGIN}/api/user/profile/avatar`, {
      method: "PATCH",
      headers: ordinaryWriteHeaders(author),
      body: JSON.stringify({ avatar_key: storedKey }),
    });
    expect(patched.status).toBe(200);
    await env.DB.prepare(
      `INSERT INTO reviews(
         course_id,teacher_id,category,overall,comment,status,
         submitter_hash,author_user_id
       ) VALUES(1,1,'general',5,'头像随存储值','approved','avatar-stored',?)`,
    )
      .bind(id)
      .run();

    const response = await SELF.fetch(
      `${WRITE_ORIGIN}/api/u/${formatPublicCode(public_code)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      avatar_key: number;
      reviews: Array<{ comment: string; author_avatar_key: number }>;
    }>();
    expect(body.avatar_key).toBe(storedKey);
    expect(body.avatar_key).not.toBe(defaultAvatarKey(public_code));
    const authored = body.reviews.find(
      (review) => review.comment === "头像随存储值",
    );
    expect(authored?.author_avatar_key).toBe(storedKey);
  });
});
