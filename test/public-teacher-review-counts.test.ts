import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { isAsciiLetterTerm } from "../src/lib/catalog-pinyin";
import {
  andSearchTermsWithPinyin,
  andSearchTermsWithTrigram,
  likeSql,
  parseSearchTerms,
} from "../src/lib/catalog-search";
import { buildCatalogSearchRanking } from "../src/lib/catalog-search-ranking";
import {
  PUBLIC_TEACHER_REVIEW_BROWSE_INDEX,
  publicTeacherBrowsePageSql,
} from "../src/public-catalog-query";
import { refreshPublicListPrecomputes } from "../src/public-list-precompute";
import { rebuildPublicListProjection } from "../src/public-list-projection-plan";
import { clean } from "../src/routes/support";

const origin = "https://example.com";
const stamp = `预计算教师${Date.now()}`;

let courseId = 0;
let exactId = 0;
let popularId = 0;
let threeId = 0;
let nullDeptId = 0;
let zeroLowId = 0;
let zeroHighId = 0;

const hiddenTables = [
  "public_teacher_review_counts",
  "public_teacher_review_counts_staging",
  "public_teacher_list_totals",
  "public_teacher_list_totals_staging",
] as const;

type TeacherPage = {
  items: Array<{ id: number; review_count: number }>;
  total: number;
  pages: number;
  page: number;
  pageSize: number;
};

function teacherSearch(raw: string) {
  const searchTerms = parseSearchTerms(clean(raw, 80));
  const searchGroup = andSearchTermsWithTrigram(
    searchTerms,
    (term) =>
      andSearchTermsWithPinyin(
        [term],
        likeSql("pts.match_text"),
        likeSql("pts.pinyin_text"),
        isAsciiLetterTerm,
      ),
    "pts.teacher_id IN (SELECT rowid FROM teacher_search_fts WHERE teacher_search_fts MATCH ?)",
  );
  const where = searchGroup.sql || "1=1";
  const ranking = buildCatalogSearchRanking(
    searchTerms,
    {
      exact: ["t.name"],
      prefix: ["t.name"],
      substring: ["t.name"],
      pinyin: "pts.pinyin_text",
      teacher: ["t.department"],
    },
    "teacher",
    searchGroup.args.length,
  );
  return { where, args: searchGroup.args, ranking };
}

async function legacyTeacherOrder(raw: string) {
  const search = teacherSearch(raw);
  const { results } = await env.DB.prepare(
    `SELECT t.id id,
       COALESCE(teacher_review_counts.review_count,0) review_count
     FROM teachers t
     JOIN public_teacher_search pts ON pts.teacher_id=t.id
     LEFT JOIN (
       SELECT teacher_id,SUM(review_count) review_count
       FROM public_review_counts
       GROUP BY teacher_id
     ) teacher_review_counts ON teacher_review_counts.teacher_id=t.id
     WHERE ${search.where}
     ORDER BY ${search.ranking.sql},review_count DESC,t.name,t.department,t.id`,
  )
    .bind(...search.args, ...search.ranking.args)
    .all<{ id: number; review_count: number }>();
  return results ?? [];
}

async function fetchTeacherPages(query: string) {
  const pageSize = 2;
  const items: TeacherPage["items"] = [];
  let total = -1;
  for (let page = 1; page <= 30; page += 1) {
    const response = await SELF.fetch(
      `${origin}/api/teachers?${query ? `${query}&` : ""}page=${page}&pageSize=${pageSize}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json<TeacherPage>();
    if (total < 0) total = body.total;
    expect(body.total).toBe(total);
    expect(body.page).toBe(page);
    expect(body.pageSize).toBe(pageSize);
    expect(body.pages).toBe(Math.ceil(total / pageSize));
    for (const item of body.items) expect(item).not.toHaveProperty("window_total");
    items.push(...body.items);
    if (page >= body.pages) break;
  }
  expect(items).toHaveLength(total);
  return items;
}

async function insertTeacher(
  source: string,
  name: string,
  department: string | null,
) {
  const result = await env.DB.prepare(
    "INSERT INTO teachers(source_teacher_label,name,department,title) VALUES(?,?,?,'讲师')",
  )
    .bind(source, name, department)
    .run();
  return Number(result.meta.last_row_id);
}

async function insertReviews(teacherId: number, count: number) {
  for (let index = 0; index < count; index += 1) {
    await env.DB.prepare(
      `INSERT INTO reviews(course_id,teacher_id,category,overall,comment,status,submitter_hash)
       VALUES(?,?,'general',4,?,'approved',?)`,
    )
      .bind(
        courseId,
        teacherId,
        `${stamp}公开评价${teacherId}-${index}`,
        `${stamp}-${teacherId}-${index}`,
      )
      .run();
  }
}

async function hideTeacherReviewSchema() {
  for (const table of hiddenTables) {
    await env.DB.prepare(`ALTER TABLE ${table} RENAME TO ${table}_off`).run();
  }
}

async function restoreTeacherReviewSchema() {
  for (const table of hiddenTables) {
    await env.DB.prepare(`ALTER TABLE ${table}_off RENAME TO ${table}`).run();
  }
}

beforeAll(async () => {
  const course = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department) VALUES(?,?,'general',?)",
  )
    .bind(`R918-${stamp}`, `${stamp}课`, stamp)
    .run();
  courseId = Number(course.meta.last_row_id);
  exactId = await insertTeacher(`${stamp}-exact`, stamp, `${stamp}-精确`);
  popularId = await insertTeacher(`${stamp}-popular`, `${stamp}-热门`, `${stamp}-甲`);
  threeId = await insertTeacher(`${stamp}-three`, `${stamp}-同名`, `${stamp}-乙`);
  nullDeptId = await insertTeacher(`${stamp}-null`, `${stamp}-同名`, null);
  zeroLowId = await insertTeacher(`${stamp}-zero-a`, `${stamp}-同名`, `${stamp}-甲`);
  zeroHighId = await insertTeacher(`${stamp}-zero-b`, `${stamp}-同名`, `${stamp}-甲`);
  await env.DB.batch(
    [exactId, popularId, threeId, nullDeptId, zeroLowId, zeroHighId].map((teacherId) =>
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
      ).bind(courseId, teacherId),
    ),
  );
  await insertReviews(exactId, 1);
  await insertReviews(popularId, 5);
  await insertReviews(threeId, 3);
  const ready = await SELF.fetch(`${origin}/api/teachers?pageSize=1`);
  expect(ready.status).toBe(200);
}, 30_000);

describe("precomputed teacher review counts", () => {
  it("keeps unfiltered order, pages and total aligned with the live aggregate", async () => {
    const legacy = await legacyTeacherOrder("");
    const items = await fetchTeacherPages("");
    expect(items.map((item) => [item.id, item.review_count])).toEqual(
      legacy.map((row) => [row.id, row.review_count]),
    );
    const ids = items.map((item) => item.id);
    expect(ids.indexOf(popularId)).toBeLessThan(ids.indexOf(threeId));
    expect(ids.indexOf(threeId)).toBeLessThan(ids.indexOf(exactId));
    expect(ids.indexOf(exactId)).toBeLessThan(ids.indexOf(nullDeptId));
    expect(ids.indexOf(nullDeptId)).toBeLessThan(ids.indexOf(zeroLowId));
    expect(ids.indexOf(zeroLowId)).toBeLessThan(ids.indexOf(zeroHighId));
    expect(items.find((item) => item.id === popularId)?.review_count).toBe(5);
    expect(items.find((item) => item.id === zeroLowId)?.review_count).toBe(0);

    const stored = await env.DB.prepare(
      "SELECT n FROM public_teacher_list_totals WHERE id=1",
    ).first<{ n: number }>();
    const teachers = await env.DB.prepare(
      "SELECT COUNT(*) n FROM teachers",
    ).first<{ n: number }>();
    expect(Number(stored?.n)).toBe(items.length);
    expect(Number(stored?.n)).toBe(Number(teachers?.n));

    const past = await SELF.fetch(`${origin}/api/teachers?page=9&pageSize=2`);
    const pastBody = await past.json<TeacherPage>();
    expect(pastBody.items).toEqual([]);
    expect(pastBody.total).toBe(items.length);
  });

  it("keeps search order and pages aligned with the live aggregate", async () => {
    const legacy = await legacyTeacherOrder(stamp);
    const items = await fetchTeacherPages(`q=${encodeURIComponent(stamp)}`);
    expect(items.map((item) => [item.id, item.review_count])).toEqual(
      legacy.map((row) => [row.id, row.review_count]),
    );
    expect(items[0]?.id).toBe(exactId);
    expect(items).toHaveLength(6);
    const second = await SELF.fetch(
      `${origin}/api/teachers?q=${encodeURIComponent(stamp)}&page=2&pageSize=2`,
    );
    const secondBody = await second.json<TeacherPage>();
    expect(secondBody.total).toBe(6);
    expect(secondBody.items.map((item) => item.id)).toEqual(
      items.slice(2, 4).map((item) => item.id),
    );
  });

  it("reuses the stored review count on the teacher detail", async () => {
    for (const [id, reviewCount] of [
      [popularId, 5],
      [threeId, 3],
      [exactId, 1],
      [zeroHighId, 0],
    ] as const) {
      const body = await SELF.fetch(`${origin}/api/teachers/${id}`).then(
        (response) =>
          response.json<{
            reviewCount: number;
            teacher: { review_count: number };
          }>(),
      );
      expect(body.reviewCount).toBe(reviewCount);
      expect(body.teacher.review_count).toBe(reviewCount);
    }
  });

  it("publishes one review row per teacher and a browse index", async () => {
    const mismatched = await env.DB.prepare(
      `SELECT t.id
       FROM teachers t
       LEFT JOIN public_teacher_review_counts tr ON tr.teacher_id=t.id
       WHERE tr.teacher_id IS NULL
         OR tr.review_count != COALESCE((
           SELECT SUM(review_count) FROM public_review_counts
           WHERE teacher_id=t.id
         ),0)
         OR tr.name != t.name
         OR NOT (tr.department IS t.department)`,
    ).all<{ id: number }>();
    expect(mismatched.results ?? []).toEqual([]);

    const ready = await env.DB.prepare(
      "SELECT teacher_review_counts_ready ready FROM public_precompute_state WHERE id=1",
    ).first<{ ready: number }>();
    expect(Number(ready?.ready)).toBe(1);

    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    )
      .bind(PUBLIC_TEACHER_REVIEW_BROWSE_INDEX)
      .first<{ sql: string }>();
    expect(index?.sql).toContain("review_count DESC");
    expect(index?.sql).toContain("name");
    expect(index?.sql).toContain("department");
    expect(index?.sql).toContain("teacher_id");

    const explained = publicTeacherBrowsePageSql.replace(
      "LIMIT ? OFFSET ?",
      "LIMIT 2 OFFSET 0",
    );
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${explained}`,
    ).all<{ detail: string }>();
    expect(
      (plan.results ?? []).some((row) =>
        String(row.detail).includes(PUBLIC_TEACHER_REVIEW_BROWSE_INDEX),
      ),
    ).toBe(true);
  });

  it("reads a default page without scanning every review-count row", async () => {
    const courseIds = Array.from({ length: 40 }, (_, index) => 918300 + index);
    await env.DB.batch(
      courseIds.flatMap((id) => [
        env.DB.prepare(
          `INSERT INTO courses(id,code,name,category,department)
           VALUES(?,?,'评价行','general','测试学院')`,
        ).bind(id, `R918-${id}`),
        env.DB.prepare(
          `INSERT INTO public_review_counts(course_id,teacher_id,review_count)
           VALUES(?,1,1)`,
        ).bind(id),
      ]),
    );
    try {
      const browse = await env.DB.prepare(publicTeacherBrowsePageSql)
        .bind(2, 0)
        .all();
      const legacy = await env.DB.prepare(
        `SELECT t.id
         FROM teachers t
         JOIN public_teacher_search pts ON pts.teacher_id=t.id
         LEFT JOIN (
           SELECT teacher_id,SUM(review_count) review_count
           FROM public_review_counts
           GROUP BY teacher_id
         ) teacher_review_counts ON teacher_review_counts.teacher_id=t.id
         ORDER BY COALESCE(teacher_review_counts.review_count,0) DESC,t.name,t.department,t.id
         LIMIT 2 OFFSET 0`,
      ).all();
      const browseRead = Number(browse.meta?.rows_read) || 0;
      const legacyRead = Number(legacy.meta?.rows_read) || 0;
      expect(browseRead).toBeGreaterThan(0);
      expect(legacyRead).toBeGreaterThan(browseRead);
    } finally {
      await env.DB.prepare(
        "DELETE FROM courses WHERE id BETWEEN 918300 AND 918339",
      ).run();
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("falls back to the live aggregate when the new tables are absent", async () => {
    await hideTeacherReviewSchema();
    try {
      const legacy = await legacyTeacherOrder("");
      const items = await fetchTeacherPages("");
      expect(items.map((item) => [item.id, item.review_count])).toEqual(
        legacy.map((row) => [row.id, row.review_count]),
      );
      const searched = await fetchTeacherPages(
        `q=${encodeURIComponent(stamp)}`,
      );
      const legacySearch = await legacyTeacherOrder(stamp);
      expect(searched.map((item) => item.id)).toEqual(
        legacySearch.map((row) => row.id),
      );
      const detail = await SELF.fetch(`${origin}/api/teachers/${popularId}`).then(
        (response) =>
          response.json<{ teacher: { review_count: number }; reviewCount: number }>(),
      );
      expect(detail.reviewCount).toBe(5);
      expect(detail.teacher.review_count).toBe(5);
    } finally {
      await restoreTeacherReviewSchema();
    }
  });

  it("rebuilds an empty projection when the ready flag is still 0", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM public_teacher_review_counts"),
      env.DB.prepare("DELETE FROM public_teacher_list_totals"),
      env.DB.prepare(
        `UPDATE public_precompute_state
         SET teacher_review_counts_ready=0,dirty=0,
             refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ),
    ]);
    const response = await SELF.fetch(`${origin}/api/teachers?pageSize=5`);
    expect(response.status).toBe(200);
    const state = await env.DB.prepare(
      `SELECT teacher_review_counts_ready ready,dirty
       FROM public_precompute_state WHERE id=1`,
    ).first<{ ready: number; dirty: number }>();
    expect(Number(state?.ready)).toBe(1);
    expect(Number(state?.dirty)).toBe(0);
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) n FROM public_teacher_review_counts",
    ).first<{ n: number }>();
    const teachers = await env.DB.prepare(
      "SELECT COUNT(*) n FROM teachers",
    ).first<{ n: number }>();
    expect(Number(counts?.n)).toBe(Number(teachers?.n));
    const popular = await env.DB.prepare(
      "SELECT review_count FROM public_teacher_review_counts WHERE teacher_id=?",
    )
      .bind(popularId)
      .first<{ review_count: number }>();
    expect(Number(popular?.review_count)).toBe(5);
  });

  it("still publishes the older projections when migration 0061 is absent", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET teacher_review_counts_ready=0,dirty=1,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    await hideTeacherReviewSchema();
    try {
      const token = crypto.randomUUID();
      const state = await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=?,refresh_lease_until=unixepoch()+60
         WHERE id=1
         RETURNING generation`,
      )
        .bind(token)
        .first<{ generation: number }>();
      await rebuildPublicListProjection({
        db: env.DB,
        generation: Number(state?.generation) || 0,
        token,
        renewLease: async () => {},
      });
      const ready = await env.DB.prepare(
        "SELECT teacher_review_counts_ready ready FROM public_precompute_state WHERE id=1",
      ).first<{ ready: number }>();
      const courses = await env.DB.prepare(
        "SELECT COUNT(*) n FROM public_course_canonicals",
      ).first<{ n: number }>();
      expect(Number(ready?.ready)).toBe(0);
      expect(Number(courses?.n)).toBeGreaterThan(0);
    } finally {
      await restoreTeacherReviewSchema();
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });
});
