import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildLatestPublicReviewsQuery } from "../src/public-reviews-latest";
import { authoredReviewJoinSql } from "../src/public-handle";
import {
  guestReviewBindingSql,
  historicalPublicVisibleSql,
} from "../src/public-review-visibility";
import { CURRENT_SCORES } from "./review-score-fixtures";

const origin = "https://example.com";

type FeedRow = { id: string; comment: string; created_at: string };

const legacyUnion = `
  SELECT 'historical:' || phr.id id, phr.comment comment, phr.imported_at created_at
  FROM public_historical_reviews phr
  JOIN courses c ON c.id=phr.course_id
  JOIN teachers t ON t.id=phr.teacher_id
  WHERE 1=1${historicalPublicVisibleSql("phr")}
  UNION ALL
  SELECT 'review:' || r.id id, r.comment comment, r.created_at created_at
  FROM reviews r
  JOIN courses c ON c.id=r.course_id
  JOIN teachers t ON t.id=r.teacher_id
  ${authoredReviewJoinSql}
  WHERE r.status='approved'
    AND trim(COALESCE(r.comment,''))<>''${guestReviewBindingSql}
`;

async function legacyPage(limit: number, cursor?: { t: string; id: string }) {
  const cursorFilter = cursor
    ? "AND (created_at<? OR (created_at=? AND id<?))"
    : "";
  const result = await env.DB.prepare(
    `SELECT id, comment, created_at
     FROM (${legacyUnion}) latest_reviews
     WHERE 1=1
     ${cursorFilter}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(...(cursor ? [cursor.t, cursor.t, cursor.id] : []), limit)
    .all<FeedRow>();
  return {
    rows: result.results,
    rowsRead: Number(result.meta?.rows_read ?? 0),
  };
}

async function relation(stamp: string) {
  const teacher = await env.DB.prepare(
    "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?,?)",
  )
    .bind(`教师${stamp}`, `教师${stamp}`, "测试学院")
    .run();
  const teacherId = Number(teacher.meta.last_row_id);
  const course = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department,scheme_key) VALUES(?,?,?,?,?)",
  )
    .bind(`L917-${stamp}`, `最新流${stamp}`, "general", "测试学院", "major")
    .run();
  const courseId = Number(course.meta.last_row_id);
  await env.DB.prepare(
    "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
  )
    .bind(courseId, teacherId)
    .run();
  return { courseId, teacherId };
}

async function insertReview(input: {
  id?: number;
  courseId: number;
  teacherId: number;
  comment: string;
  createdAt: string;
  status?: string;
  loginOnly?: number;
  blockedAt?: string | null;
  deletedAt?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO reviews(
      id,course_id,teacher_id,category,overall,comment,term,status,
      submitter_hash,scheme_key,scheme_version,scores,created_at,
      login_only,blocked_at,deleted_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.id ?? null,
      input.courseId,
      input.teacherId,
      "general",
      4,
      input.comment,
      "2026 春",
      input.status ?? "approved",
      `hash-${input.comment}`,
      "major",
      2,
      JSON.stringify(CURRENT_SCORES),
      input.createdAt,
      input.loginOnly ?? 0,
      input.blockedAt ?? null,
      input.deletedAt ?? null,
    )
    .run();
}

async function insertHistorical(input: {
  id: string;
  courseId: number;
  teacherId: number;
  comment: string;
  createdAt: string;
  blockedAt?: string | null;
  deletedAt?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO public_historical_reviews(
      id,course_id,teacher_id,comment,package_contract,
      approved_package_manifest_sha256,approved_catalog_content_sha256,imported_at,
      blocked_at,deleted_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.id,
      input.courseId,
      input.teacherId,
      input.comment,
      "legacy-historical-production-freeze-v1",
      "a".repeat(64),
      "b".repeat(64),
      input.createdAt,
      input.blockedAt ?? null,
      input.deletedAt ?? null,
    )
    .run();
}

function textOrderDiffers(left: number, right: number) {
  const leftTextGreater = String(left) > String(right);
  const leftNumericGreater = left > right;
  return leftTextGreater !== leftNumericGreater;
}

function freeTextOrderIds(maxId: number) {
  let narrow = maxId + 1;
  let wide = 10 ** String(narrow).length;
  if (wide <= narrow) wide = narrow * 10;
  while (!textOrderDiffers(narrow, wide)) {
    narrow += 1;
    if (String(narrow).length >= String(wide).length) wide *= 10;
  }
  return { narrow, wide };
}

function encodeCursor(cursor: { t: string; id: string }) {
  return btoa(JSON.stringify(cursor).replaceAll("历史", "\\u5386\\u53f2"));
}

async function apiPage(pageSize: number, cursor?: { t: string; id: string }) {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (cursor) query.set("cursor", encodeCursor(cursor));
  const response = await SELF.fetch(`${origin}/api/reviews/latest?${query}`);
  expect(response.status).toBe(200);
  const body = await response.json<{
    items: FeedRow[];
    nextCursor: string | null;
  }>();
  if (body.nextCursor) {
    const last = body.items.at(-1);
    expect(JSON.parse(atob(body.nextCursor))).toEqual({
      t: last?.created_at,
      id: last?.id,
    });
  }
  return body;
}

async function walkStamp(stamp: string, pageSize: number) {
  const items: FeedRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 40; i += 1) {
    const query = new URLSearchParams({ pageSize: String(pageSize) });
    if (cursor) query.set("cursor", cursor);
    const response = await SELF.fetch(`${origin}/api/reviews/latest?${query}`);
    expect(response.status).toBe(200);
    const body = await response.json<{
      items: FeedRow[];
      nextCursor: string | null;
    }>();
    if (body.nextCursor) {
      const last = body.items.at(-1);
      expect(JSON.parse(atob(body.nextCursor))).toEqual({
        t: last?.created_at,
        id: last?.id,
      });
    }
    items.push(...body.items);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
    const last = body.items.at(-1);
    if (last && last.created_at < "2999-05-01 00:00:00") break;
  }
  return items.filter((item) => item.comment.includes(stamp));
}

describe("latest public review union pagination", () => {
  it("matches the pre-pushdown cursor order across both branches, including equal timestamps", async () => {
    const stamp = `917-${Date.now()}`;
    const tie = "2999-06-01 00:00:00";
    const { courseId, teacherId } = await relation(stamp);
    const max = await env.DB.prepare("SELECT COALESCE(MAX(id),0) max_id FROM reviews").first<{
      max_id: number;
    }>();
    const { narrow, wide } = freeTextOrderIds(Number(max?.max_id ?? 0));
    const textFirst = String(narrow) > String(wide) ? narrow : wide;
    const textSecond = textFirst === narrow ? wide : narrow;
    expect(textFirst).toBeLessThan(textSecond);

    const unboundTeacher = await env.DB.prepare(
      "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?,?)",
    )
      .bind(`无关系${stamp}`, `无关系${stamp}`, "测试学院")
      .run();
    const unboundCourse = await env.DB.prepare(
      "INSERT INTO courses(code,name,category,department) VALUES(?,?,?,?)",
    )
      .bind(`L917-x-${stamp}`, `无关系课${stamp}`, "general", "测试学院")
      .run();

    await insertReview({
      courseId,
      teacherId,
      comment: `visible ${stamp} newer`,
      createdAt: "2999-07-01 00:00:00",
    });
    await insertReview({
      id: narrow,
      courseId,
      teacherId,
      comment: `visible ${stamp} narrow`,
      createdAt: tie,
    });
    await insertReview({
      id: wide,
      courseId,
      teacherId,
      comment: `visible ${stamp} wide`,
      createdAt: tie,
    });
    await insertHistorical({
      id: `a-${stamp}`,
      courseId,
      teacherId,
      comment: `visible ${stamp} hist-a`,
      createdAt: tie,
    });
    await insertHistorical({
      id: `m-${stamp}`,
      courseId,
      teacherId,
      comment: `visible ${stamp} hist-m`,
      createdAt: tie,
    });
    await insertHistorical({
      id: `z-${stamp}`,
      courseId,
      teacherId,
      comment: `visible ${stamp} hist-z`,
      createdAt: tie,
    });
    await insertHistorical({
      id: `old-${stamp}`,
      courseId,
      teacherId,
      comment: `visible ${stamp} older`,
      createdAt: "2999-05-01 00:00:00",
    });

    await insertReview({
      courseId,
      teacherId,
      comment: `hidden ${stamp} pending`,
      createdAt: "2999-08-01 00:00:00",
      status: "pending",
    });
    await insertReview({
      courseId,
      teacherId,
      comment: "   ",
      createdAt: "2999-08-01 00:00:00",
    });
    await insertReview({
      courseId,
      teacherId,
      comment: `hidden ${stamp} login`,
      createdAt: "2999-08-01 00:00:00",
      loginOnly: 1,
    });
    await insertReview({
      courseId,
      teacherId,
      comment: `hidden ${stamp} blocked`,
      createdAt: "2999-08-01 00:00:00",
      blockedAt: "2999-08-02 00:00:00",
    });
    await insertReview({
      courseId,
      teacherId,
      comment: `hidden ${stamp} deleted`,
      createdAt: "2999-08-01 00:00:00",
      deletedAt: "2999-08-02 00:00:00",
    });
    await insertReview({
      courseId: Number(unboundCourse.meta.last_row_id),
      teacherId: Number(unboundTeacher.meta.last_row_id),
      comment: `hidden ${stamp} unbound`,
      createdAt: "2999-08-01 00:00:00",
    });
    await insertHistorical({
      id: `blocked-${stamp}`,
      courseId,
      teacherId,
      comment: `hidden ${stamp} hist-blocked`,
      createdAt: "2999-08-01 00:00:00",
      blockedAt: "2999-08-02 00:00:00",
    });
    await insertHistorical({
      id: `deleted-${stamp}`,
      courseId,
      teacherId,
      comment: `hidden ${stamp} hist-deleted`,
      createdAt: "2999-08-01 00:00:00",
      deletedAt: "2999-08-02 00:00:00",
    });

    const expected = (await legacyPage(50)).rows.filter((row) =>
      row.comment.includes(stamp),
    );
    expect(expected.map((row) => row.comment)).toEqual([
      `visible ${stamp} newer`,
      `visible ${stamp} ${textFirst === narrow ? "narrow" : "wide"}`,
      `visible ${stamp} ${textSecond === narrow ? "narrow" : "wide"}`,
      `visible ${stamp} hist-z`,
      `visible ${stamp} hist-m`,
      `visible ${stamp} hist-a`,
      `visible ${stamp} older`,
    ]);

    const tieRows = expected.filter((row) => row.created_at === tie);
    const firstHistorical = tieRows.findIndex((row) => row.id.startsWith("historical:"));
    expect(firstHistorical).toBeGreaterThan(0);
    expect(
      tieRows.slice(0, firstHistorical).every((row) => row.id.startsWith("review:")),
    ).toBe(true);
    expect(tieRows.map((row) => row.id)).toEqual([
      `review:${textFirst}`,
      `review:${textSecond}`,
      `historical:z-${stamp}`,
      `historical:m-${stamp}`,
      `historical:a-${stamp}`,
    ]);

    const head = await apiPage(5);
    expect(head.items.some((row) => row.comment.trim() === "")).toBe(false);
    expect(head.items.some((row) => row.comment.includes(`hidden ${stamp}`))).toBe(false);

    for (const pageSize of [1, 2]) {
      const walked = await walkStamp(stamp, pageSize);
      expect(walked.map((row) => row.id)).toEqual(expected.map((row) => row.id));
      expect(walked.some((row) => row.comment.startsWith("hidden"))).toBe(false);
    }

    const boundary = await apiPage(1, { t: tie, id: `review:${textSecond}` });
    expect(boundary.items[0]).toMatchObject({
      id: `historical:z-${stamp}`,
      created_at: tie,
    });
    const legacyBoundary = await legacyPage(1, { t: tie, id: `review:${textSecond}` });
    expect(boundary.items.map((row) => row.id)).toEqual(
      legacyBoundary.rows.map((row) => row.id),
    );

    const cursors = [
      { t: tie, id: `review:${textFirst}` },
      { t: tie, id: `historical:m-${stamp}` },
      { t: tie, id: "m" },
      { t: tie, id: "\u5386\u53f2" },
      { t: tie, id: "review:" },
      { t: tie, id: "historical:" },
    ];
    for (const cursor of cursors) {
      const api = await apiPage(3, cursor);
      const legacy = await legacyPage(3, cursor);
      expect(api.items.map((row) => row.id)).toEqual(legacy.rows.map((row) => row.id));
    }
  });

  it("seeks the branch indexes and reads fewer rows than sorting the full union", async () => {
    const stamp = `917-scan-${Date.now()}`;
    const { courseId, teacherId } = await relation(`${stamp}-bulk`);
    const count = 250;
    const statements = [];
    for (let i = 1; i <= count; i += 1) {
      const day = String((i % 27) + 1).padStart(2, "0");
      const hour = String(i % 24).padStart(2, "0");
      const minute = String(Math.floor(i / 24) % 60).padStart(2, "0");
      const createdAt = `2024-04-${day} ${hour}:${minute}:00`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO reviews(
            course_id,teacher_id,category,overall,comment,term,status,
            submitter_hash,scheme_key,scheme_version,scores,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          courseId,
          teacherId,
          "general",
          4,
          `bulk review ${stamp} ${i}`,
          "2026 春",
          "approved",
          `bulk-${stamp}-${i}`,
          "major",
          2,
          JSON.stringify(CURRENT_SCORES),
          createdAt,
        ),
      );
      statements.push(
        env.DB.prepare(
          `INSERT INTO public_historical_reviews(
            id,course_id,teacher_id,comment,package_contract,
            approved_package_manifest_sha256,approved_catalog_content_sha256,imported_at
          ) VALUES(?,?,?,?,?,?,?,?)`,
        ).bind(
          `bulk-${stamp}-${i}`,
          courseId,
          teacherId,
          `bulk hist ${stamp} ${i}`,
          "legacy-historical-production-freeze-v1",
          "c".repeat(64),
          "d".repeat(64),
          createdAt,
        ),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 40) {
      await env.DB.batch(statements.slice(offset, offset + 40));
    }

    const firstLegacy = await legacyPage(21);
    const firstBuilt = buildLatestPublicReviewsQuery(null, 21);
    const firstNew = await env.DB.prepare(firstBuilt.sql).bind(...firstBuilt.params).all<FeedRow>();
    expect(firstNew.results.map((row) => row.id)).toEqual(firstLegacy.rows.map((row) => row.id));
    const firstRowsRead = Number(firstNew.meta?.rows_read ?? 0);
    expect(firstRowsRead).toBeGreaterThan(0);
    expect(firstRowsRead).toBeLessThan(count * 2);

    const deepCursor = { t: "2010-01-01 00:00:00", id: "zzzz" };
    const deepLegacy = await legacyPage(21, deepCursor);
    const deepBuilt = buildLatestPublicReviewsQuery(deepCursor, 21);
    const deepNew = await env.DB.prepare(deepBuilt.sql).bind(...deepBuilt.params).all<FeedRow>();
    expect(deepNew.results.map((row) => row.id)).toEqual(deepLegacy.rows.map((row) => row.id));
    expect(deepLegacy.rows).toEqual([]);
    const deepRowsRead = Number(deepNew.meta?.rows_read ?? 0);
    expect(deepLegacy.rowsRead).toBeGreaterThan(count);
    expect(deepRowsRead * 10).toBeLessThan(deepLegacy.rowsRead);

    const anchor = (await legacyPage(400)).rows.at(-1);
    expect(anchor).toBeTruthy();
    const nextLegacy = await legacyPage(21, { t: anchor!.created_at, id: anchor!.id });
    const nextBuilt = buildLatestPublicReviewsQuery(
      { t: anchor!.created_at, id: anchor!.id },
      21,
    );
    const nextNew = await env.DB.prepare(nextBuilt.sql).bind(...nextBuilt.params).all<FeedRow>();
    expect(nextNew.results.map((row) => row.id)).toEqual(nextLegacy.rows.map((row) => row.id));
    expect(nextLegacy.rows.length).toBe(21);
    const nextRowsRead = Number(nextNew.meta?.rows_read ?? 0);
    expect(nextRowsRead).toBeLessThan(firstRowsRead + 80);
    expect(nextLegacy.rowsRead).toBeGreaterThan(nextRowsRead * 2);

    const noCursorPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${firstBuilt.sql}`)
      .bind(...firstBuilt.params)
      .all<{ detail: string }>();
    const cursorPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${nextBuilt.sql}`)
      .bind(...nextBuilt.params)
      .all<{ detail: string }>();
    const deepPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${deepBuilt.sql}`)
      .bind(...deepBuilt.params)
      .all<{ detail: string }>();
    for (const plan of [noCursorPlan, cursorPlan, deepPlan]) {
      const details = plan.results.map((row) => row.detail).join("\n");
      expect(details).toContain("idx_public_historical_reviews_latest");
      expect(details).toContain("idx_reviews_public_latest");
    }
    const deepDetails = deepPlan.results.map((row) => row.detail).join("\n");
    expect(deepDetails).toContain("imported_at<?");
    expect(deepDetails).toContain("created_at<?");
  });
});
