import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPeSpecializationMapping } from "../src/lib/pe-specialization-mapping";
import {
  loadPublicCourseListExtras,
  loadPublicRelationListExtras,
  publicCatalogListScope,
} from "../src/lib/public-catalog-list";
import {
  publicCourseDisplayName,
  publicCourseDisplayNameSql,
  publicCourseVisibleSql,
  publicRelationNameSortKey,
  publicRelationNameSortKeySql,
  publicRelationNameSortSql,
} from "../src/lib/public-course-presentation";
import {
  publicCourseIdentity,
  publicPeCourseIdentity,
  publicPeMappedSourceCourseExcludeSql,
  publicRelationIdentity,
} from "../src/lib/public-pe-course-projection";
import { publicPeMappedSourceRelationExcludeSql } from "../src/lib/public-pe-relation-projection";
import { CATALOG_BROWSE_PROJECTION_ENABLED } from "../src/public-catalog-browse-plan";
import { ensurePublicListPrecomputes } from "../src/public-list-precompute";
import { publicCourseCanonicalJoin } from "../src/public-list-projection-plan";
import {
  comparePublicCourseBrowseName,
  publicCourseBrowseNameBeforeSql,
  queryPublicCourseRelations,
  queryPublicCourses,
  relationBrowseAggregateFromSql,
  relationBrowseThresholdProbeSql,
  relationBrowseUsesIndexedThreshold,
  type PublicCatalogPage,
  type PublicCourseListItem,
  type PublicCourseListSort,
  type PublicRelationListItem,
  type PublicRelationListSort,
} from "../src/public-catalog-query";
import { CURRENT_SCORES } from "./review-score-fixtures";

/**
 * Issue #926 有意的次序变化：
 * - 关系 reviews/rating 平局不再用 (course_id, teacher_id) 或原始课名，
 *   改为 publicRelationNameSortKey（同一教师的大学英语按级别相邻）。
 * - 课程列表 SQL 与页内比较都用展示名、课号、id。未映射「篮球2」因此排在
 *   「体育1-4 [篮球]」，而不是原始课名。null id 的体育公共项排在相同展示名和课号的真实 id 之后。
 * 课程列表不套用关系的英语级别分组，展示名仍按字典序。
 */

const stamp = `ord926-${Date.now()}`;
const department = `${stamp}院`;

const ids: {
  jia: number;
  yi: number;
  mathJia: number;
  mathYi: number;
  linear: number;
  englishI: number;
  english2: number;
  english3: number;
  english4: number;
  english1Yi: number;
  basket: number;
  ahead: number;
  behind: number;
  topicReal: number;
  topicSource: number;
  tennis: number;
} = {
  jia: 0,
  yi: 0,
  mathJia: 0,
  mathYi: 0,
  linear: 0,
  englishI: 0,
  english2: 0,
  english3: 0,
  english4: 0,
  english1Yi: 0,
  basket: 0,
  ahead: 0,
  behind: 0,
  topicReal: 0,
  topicSource: 0,
  tennis: 0,
};

type CourseSortRow = {
  id: number | null;
  public_id: string;
  code: string;
  name: string;
  review_count: number;
};

type RelationSortRow = {
  course_id: number | null;
  public_id: string;
  code: string;
  name: string;
  teacher_id: number | null;
  teacher_name: string | null;
  rating: number | null;
  review_count: number;
};

type BrowseFilter = {
  category: string;
  department: string;
  teacherId: number | null;
};

async function insertTeacher(name: string) {
  const result = await env.DB.prepare(
    "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?,?)",
  )
    .bind(name, name, department)
    .run();
  return Number(result.meta.last_row_id);
}

async function insertCourse(input: {
  code: string;
  name: string;
  category?: "general" | "sports";
  scheme: string;
}) {
  const result = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department,scheme_key) VALUES(?,?,?,?,?)",
  )
    .bind(
      input.code,
      input.name,
      input.category ?? "general",
      department,
      input.scheme,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function bindTeacher(courseId: number, teacherId: number) {
  await env.DB.prepare(
    "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
  )
    .bind(courseId, teacherId)
    .run();
}

async function insertCountedRelation(input: {
  name: string;
  category?: "general" | "sports";
  scheme: string;
  teacherId: number;
  reviews: number;
  overall: number;
}) {
  const courseId = await insertCourse({
    code: `${stamp}-${input.name}`,
    name: input.name,
    category: input.category,
    scheme: input.scheme,
  });
  await bindTeacher(courseId, input.teacherId);
  for (let index = 0; index < input.reviews; index += 1) {
    await insertReview({
      courseId,
      teacherId: input.teacherId,
      overall: input.overall,
      comment: `${stamp}-${input.name}-${index}-评价正文足够长`,
    });
  }
}

async function insertReview(input: {
  courseId: number;
  teacherId: number;
  overall: number;
  comment: string;
}) {
  await env.DB.prepare(
    `INSERT INTO reviews(
      course_id,teacher_id,category,overall,comment,term,status,
      submitter_hash,scheme_key,scheme_version,scores,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.courseId,
      input.teacherId,
      "general",
      input.overall,
      input.comment,
      "2026 春",
      "approved",
      `hash-${stamp}-${input.comment}`,
      "major",
      2,
      JSON.stringify(CURRENT_SCORES),
      "2026-08-12 01:00:00",
    )
    .run();
}

async function insertPeMapping(input: {
  courseId: number;
  teacherId: number;
  specialization: string;
  courseCode: string;
  courseName: string;
  sourceTeacherLabel: string;
}) {
  const mapping = buildPeSpecializationMapping({
    sourceKind: "direct_skill",
    normalizedSpecialization: input.specialization,
    evidenceKind: "catalog_course_name",
    sourceCourseCode: input.courseCode,
    sourceCourseName: input.courseName,
    sourceTeacherLabel: input.sourceTeacherLabel,
    rawSpecializationName: input.specialization,
  });
  await env.DB.prepare(
    `INSERT INTO catalog_relation_pe_specializations(
      course_id,teacher_id,source_kind,normalized_specialization,display_semantics,evidence_json
    ) VALUES(?,?,?,?,?,?)`,
  )
    .bind(
      input.courseId,
      input.teacherId,
      mapping.sourceKind,
      mapping.normalizedSpecialization,
      mapping.displaySemantics,
      JSON.stringify(mapping.evidence),
    )
    .run();
}

function compareRelationName(left: RelationSortRow, right: RelationSortRow) {
  const key = (row: RelationSortRow) =>
    publicRelationNameSortKey({
      name: row.name,
      code: row.code,
      course_id: row.course_id == null ? 0 : Number(row.course_id),
      teacher_name: row.teacher_name,
      teacher_id: row.teacher_id,
    });
  const leftKey = key(left);
  const rightKey = key(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function compareRelationReviews(left: RelationSortRow, right: RelationSortRow) {
  if (left.review_count !== right.review_count) {
    return right.review_count - left.review_count;
  }
  return compareRelationName(left, right);
}

function compareRelationRating(left: RelationSortRow, right: RelationSortRow) {
  const leftMissing = left.rating == null ? 1 : 0;
  const rightMissing = right.rating == null ? 1 : 0;
  if (leftMissing !== rightMissing) return leftMissing - rightMissing;
  if (left.rating != null && right.rating != null && left.rating !== right.rating) {
    return right.rating - left.rating;
  }
  return compareRelationReviews(left, right);
}

function sortCourses(rows: CourseSortRow[], sort: PublicCourseListSort) {
  return [...rows].sort((left, right) =>
    sort === "name"
      ? comparePublicCourseBrowseName(left, right)
      : right.review_count - left.review_count ||
        comparePublicCourseBrowseName(left, right),
  );
}

function sortRelations(rows: RelationSortRow[], sort: PublicRelationListSort) {
  const compare =
    sort === "name"
      ? compareRelationName
      : sort === "rating"
        ? compareRelationRating
        : compareRelationReviews;
  return [...rows].sort(compare);
}

async function expectedCourses(filter: BrowseFilter): Promise<CourseSortRow[]> {
  const scope = publicCatalogListScope(filter);
  const joins =
    filter.teacherId === null
      ? publicCourseCanonicalJoin
      : `${publicCourseCanonicalJoin} LEFT JOIN course_teachers ct ON ct.course_id=c.id`;
  const { results } = await env.DB.prepare(
    `SELECT c.id,c.code,c.name,
       MAX(COALESCE(course_review_counts.review_count,0)) review_count
     FROM courses c
     ${joins}
     LEFT JOIN (
       SELECT course_id,SUM(review_count) review_count
       FROM public_review_counts
       GROUP BY course_id
     ) course_review_counts ON course_review_counts.course_id=c.id
     WHERE ${publicCourseVisibleSql("c")}
       AND ${publicPeMappedSourceCourseExcludeSql("c")}
       AND ${scope.sql}
     GROUP BY c.id`,
  )
    .bind(...scope.args)
    .all<{ id: number; code: string; name: string; review_count: number }>();
  const reals = (results ?? []).map((row) => ({
    id: Number(row.id),
    public_id: publicCourseIdentity(Number(row.id)),
    code: String(row.code ?? ""),
    name: publicCourseDisplayName(row.name),
    review_count: Number(row.review_count) || 0,
  }));
  const extras = await loadPublicCourseListExtras(env.DB, {
    ...filter,
    searchTerms: [],
  });
  return [
    ...reals,
    ...extras.map((item) => ({
      id: item.id,
      public_id: item.public_id,
      code: String(item.code ?? ""),
      name: item.name,
      review_count: Number(item.review_count) || 0,
    })),
  ];
}

async function expectedRelations(filter: BrowseFilter): Promise<RelationSortRow[]> {
  const scope = publicCatalogListScope(filter);
  const { results } = await env.DB.prepare(
    `SELECT c.id course_id,c.code,c.name,
       t.id teacher_id,t.name teacher_name,
       rel_rating.rating rating,
       COALESCE(rel_counts.review_count,0) review_count
     FROM courses c
     ${publicCourseCanonicalJoin}
     JOIN course_teachers ct ON ct.course_id=c.id
     JOIN teachers t ON t.id=ct.teacher_id
     LEFT JOIN public_review_counts rel_counts
       ON rel_counts.course_id=c.id AND rel_counts.teacher_id=t.id
     LEFT JOIN public_relation_ratings rel_rating
       ON rel_rating.course_id=c.id AND rel_rating.teacher_id=t.id
     WHERE ${publicCourseVisibleSql("c")}
       AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")}
       AND ${scope.sql}`,
  )
    .bind(...scope.args)
    .all<{
      course_id: number;
      code: string;
      name: string;
      teacher_id: number;
      teacher_name: string;
      rating: number | null;
      review_count: number;
    }>();
  const reals = (results ?? []).map((row) => ({
    course_id: Number(row.course_id),
    public_id: publicRelationIdentity(Number(row.course_id), Number(row.teacher_id)),
    code: String(row.code ?? ""),
    name: publicCourseDisplayName(row.name),
    teacher_id: Number(row.teacher_id),
    teacher_name: row.teacher_name,
    rating: row.rating == null ? null : Number(row.rating),
    review_count: Number(row.review_count) || 0,
  }));
  const extras = await loadPublicRelationListExtras(env.DB, {
    ...filter,
    searchTerms: [],
    exactTeacherIds: null,
    courseSearchTerms: [],
  });
  return [
    ...reals,
    ...extras.map((item) => ({
      course_id: item.course_id,
      public_id: item.public_id,
      code: String(item.code ?? ""),
      name: item.name,
      teacher_id: item.teacher_id,
      teacher_name: item.teacher_name,
      rating: item.rating == null ? null : Number(item.rating),
      review_count: Number(item.review_count) || 0,
    })),
  ];
}

function courseSignature(item: {
  public_id: string;
  name: string;
  review_count: number;
}) {
  return `${item.public_id}\t${item.name}\t${item.review_count}`;
}

function relationSignature(item: {
  public_id: string;
  name: string;
  teacher_name: string | null;
  rating: number | null;
  review_count: number;
}) {
  return `${item.public_id}\t${item.name}\t${item.teacher_name ?? ""}\t${item.rating ?? ""}\t${item.review_count}`;
}

async function collectPages<T>(
  load: (page: number, pageSize: number) => Promise<PublicCatalogPage<T>>,
  pageSize: number,
): Promise<T[]> {
  const first = await load(1, pageSize);
  expect(first.pageSize).toBe(pageSize);
  expect(first.pages).toBe(first.total === 0 ? 0 : Math.ceil(first.total / pageSize));
  const items = [...first.items];
  if (first.total === 0) {
    expect(items).toEqual([]);
    return items;
  }
  expect(items).toHaveLength(Math.min(pageSize, first.total));
  for (let page = 2; page <= first.pages; page += 1) {
    const next = await load(page, pageSize);
    expect(next.total).toBe(first.total);
    expect(next.pages).toBe(first.pages);
    expect(next.items).toHaveLength(
      Math.min(pageSize, first.total - (page - 1) * pageSize),
    );
    items.push(...next.items);
  }
  expect(items).toHaveLength(first.total);
  return items;
}

const filters: BrowseFilter[] = [];

beforeAll(async () => {
  ids.jia = await insertTeacher(`${stamp}甲`);
  ids.yi = await insertTeacher(`${stamp}乙`);
  await insertTeacher("黄丽萍");
  await insertTeacher("刘春来");

  // Smaller id, but 甲 sorts after 乙. Review-count ties must follow the name, not the id.
  ids.mathJia = await insertCourse({
    code: `${stamp}-MJ`,
    name: `${stamp}高数甲`,
    scheme: "math",
  });
  ids.mathYi = await insertCourse({
    code: `${stamp}-MY`,
    name: `${stamp}高数乙`,
    scheme: "math",
  });
  ids.linear = await insertCourse({
    code: `${stamp}-LIN`,
    name: `${stamp}线代`,
    scheme: "math",
  });
  // Insert 大学英语 out of level order so course_id order is not level order.
  ids.english2 = await insertCourse({
    code: `${stamp}-E2`,
    name: "大学英语2",
    scheme: "english",
  });
  ids.english4 = await insertCourse({
    code: `${stamp}-E4`,
    name: "大学英语4",
    scheme: "english",
  });
  ids.englishI = await insertCourse({
    code: `${stamp}-EI`,
    name: "大学英语I",
    scheme: "english",
  });
  ids.english3 = await insertCourse({
    code: `${stamp}-E3`,
    name: "大学英语3",
    scheme: "english",
  });
  ids.english1Yi = await insertCourse({
    code: `${stamp}-E1`,
    name: "大学英语1",
    scheme: "english",
  });
  ids.basket = await insertCourse({
    code: `${stamp}-B2`,
    name: "篮球2",
    category: "sports",
    scheme: "pe",
  });
  ids.ahead = await insertCourse({
    code: `${stamp}-AH`,
    name: `啊${stamp}`,
    scheme: "major",
  });
  ids.behind = await insertCourse({
    code: `${stamp}-BE`,
    name: `我${stamp}`,
    scheme: "major",
  });
  ids.topicReal = await insertCourse({
    code: `${stamp}-TOPIC`,
    name: "目录排序专题",
    scheme: "major",
  });
  ids.topicSource = await insertCourse({
    code: `${stamp}-TOPIC-SRC`,
    name: "目录排序专题",
    scheme: "major",
  });
  ids.tennis = await insertCourse({
    code: `${stamp}-TEN`,
    name: "网球",
    category: "sports",
    scheme: "pe",
  });

  await bindTeacher(ids.mathJia, ids.jia);
  await bindTeacher(ids.mathYi, ids.yi);
  await bindTeacher(ids.linear, ids.jia);
  await bindTeacher(ids.english2, ids.jia);
  await bindTeacher(ids.english4, ids.jia);
  await bindTeacher(ids.englishI, ids.jia);
  await bindTeacher(ids.english3, ids.jia);
  await bindTeacher(ids.english1Yi, ids.yi);
  await bindTeacher(ids.basket, ids.jia);
  await bindTeacher(ids.ahead, ids.jia);
  await bindTeacher(ids.behind, ids.yi);
  await bindTeacher(ids.topicReal, ids.yi);
  await bindTeacher(ids.topicSource, ids.jia);
  await bindTeacher(ids.tennis, ids.jia);

  await insertPeMapping({
    courseId: ids.topicSource,
    teacherId: ids.jia,
    specialization: "目录排序专题",
    courseCode: `${stamp}-TOPIC-SRC`,
    courseName: "目录排序专题",
    sourceTeacherLabel: `${stamp}甲`,
  });
  await insertPeMapping({
    courseId: ids.tennis,
    teacherId: ids.jia,
    specialization: "网球",
    courseCode: `${stamp}-TEN`,
    courseName: "网球",
    sourceTeacherLabel: `${stamp}甲`,
  });

  const tied = [
    [ids.mathJia, ids.jia, "高数甲"],
    [ids.mathYi, ids.yi, "高数乙"],
    [ids.englishI, ids.jia, "英语I"],
    [ids.english2, ids.jia, "英语2"],
    [ids.english3, ids.jia, "英语3"],
    [ids.english4, ids.jia, "英语4"],
    [ids.english1Yi, ids.yi, "英语1"],
  ] as const;
  for (const [courseId, teacherId, label] of tied) {
    await insertReview({
      courseId,
      teacherId,
      overall: 4,
      comment: `${stamp}-${label}-评价正文足够长`,
    });
  }
  for (const label of ["线代一", "线代二", "线代三"]) {
    await insertReview({
      courseId: ids.linear,
      teacherId: ids.jia,
      overall: 5,
      comment: `${stamp}-${label}-评价正文足够长`,
    });
  }
  for (const label of ["网球一", "网球二"]) {
    await insertReview({
      courseId: ids.tennis,
      teacherId: ids.jia,
      overall: 3,
      comment: `${stamp}-${label}-评价正文足够长`,
    });
  }

  // Reverse name order so a review-count/rating tie is not already in id order.
  // High band, a wide tie, then a lower band: a page that ends in the tie must
  // keep every tie row before sorting by the course-name key.
  for (const [prefix, category, scheme] of [
    ["平局课", "general", "major"],
    ["平局体", "sports", "pe"],
  ] as const) {
    for (const name of ["甲", "乙"]) {
      await insertCountedRelation({
        name: `${prefix}高${stamp}${name}`,
        category,
        scheme,
        teacherId: ids.jia,
        reviews: 4,
        overall: 5,
      });
    }
    for (let index = 7; index >= 0; index -= 1) {
      await insertCountedRelation({
        name: `${prefix}${stamp}-${String(index).padStart(2, "0")}`,
        category,
        scheme,
        teacherId: ids.jia,
        reviews: 2,
        overall: 4,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await insertCountedRelation({
        name: `${prefix}低${stamp}-${index}`,
        category,
        scheme,
        teacherId: ids.jia,
        reviews: 1,
        overall: 3,
      });
    }
  }

  await ensurePublicListPrecomputes(env.DB);
  const ready = await env.DB.prepare(
    "SELECT catalog_browse_ready ready FROM public_precompute_state WHERE id=1",
  ).first<{ ready: number }>();
  // #931: 开关关闭时不发布浏览表，ready 保持 0，下面的全序走 #929 旧查询。
  expect(Number(ready?.ready)).toBe(CATALOG_BROWSE_PROJECTION_ENABLED ? 1 : 0);
  filters.push(
    { category: "", department, teacherId: null },
    { category: "sports", department, teacherId: null },
    { category: "math", department, teacherId: null },
    { category: "english", department, teacherId: null },
    { category: "general", department, teacherId: null },
    { category: "math", department: "", teacherId: null },
    { category: "english", department: "", teacherId: null },
    { category: "sports", department: "", teacherId: null },
    { category: "", department: "", teacherId: null },
    { category: "", department, teacherId: ids.jia },
    { category: "english", department, teacherId: ids.yi },
    { category: "sports", department, teacherId: ids.jia },
  );
}, 60_000);

describe("公共目录浏览全序", () => {
  it("null 课程 id 排在相同展示名和课号的真实 id 之后", () => {
    expect(
      comparePublicCourseBrowseName(
        { id: 5, code: "X", name: "同名", public_id: "course:5" },
        { id: null, code: "X", name: "同名", public_id: "pe:同名" },
      ),
    ).toBeLessThan(0);
    expect(
      comparePublicCourseBrowseName(
        { id: null, code: "X", name: "同名", public_id: "pe:a" },
        { id: null, code: "X", name: "同名", public_id: "pe:b" },
      ),
    ).toBeLessThan(0);
  });

  it("合并窗口把 null sort_id 计成排在真实课号之后", async () => {
    const display = publicCourseDisplayName("篮球2");
    const code = `${stamp}-B2`;
    const before = publicCourseBrowseNameBeforeSql(publicCourseDisplayNameSql("c"));
    const countBefore = async (sortId: number | null) => {
      const row = await env.DB.prepare(
        `WITH extras(extra_key,sort_name,sort_code,sort_id,review_count) AS (VALUES (?,?,?,?,?))
         SELECT COUNT(*) n
         FROM courses c
         JOIN extras ON 1=1
         WHERE c.code=? AND ${before}`,
      )
        .bind("pe:synthetic", display, code, sortId, 0, code)
        .first<{ n: number }>();
      return Number(row?.n) || 0;
    };

    expect(await countBefore(null)).toBe(1);
    expect(await countBefore(ids.basket)).toBe(0);
    expect(await countBefore(ids.basket + 1)).toBe(1);
  });

  it("关系课名排序键与 SQL 元组、排序键字符串一致", async () => {
    const keySql = publicRelationNameSortKeySql("c", "t");
    const tupleSql = publicRelationNameSortSql("c", "t");
    const listed = async (orderSql: string) => {
      const { results } = await env.DB.prepare(
        `SELECT c.id course_id,c.code,c.name,
           t.id teacher_id,t.name teacher_name,
           ${keySql} sort_key
         FROM courses c
         JOIN course_teachers ct ON ct.course_id=c.id
         JOIN teachers t ON t.id=ct.teacher_id
         WHERE c.department=?
         ORDER BY ${orderSql}`,
      )
        .bind(department)
        .all<{
          course_id: number;
          code: string;
          name: string;
          teacher_id: number;
          teacher_name: string;
          sort_key: string;
        }>();
      return results ?? [];
    };

    const byTuple = await listed(tupleSql);
    const byKey = await listed(keySql);
    expect(byTuple.map((row) => `${row.course_id}:${row.teacher_id}`)).toEqual(
      byKey.map((row) => `${row.course_id}:${row.teacher_id}`),
    );
    const keys = byTuple.map((row) => row.sort_key);
    expect(keys).toEqual(
      [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(byTuple.length).toBeGreaterThan(0);
    for (const row of byTuple) {
      expect(row.sort_key).toBe(
        publicRelationNameSortKey({
          name: publicCourseDisplayName(row.name),
          code: row.code,
          course_id: Number(row.course_id),
          teacher_name: row.teacher_name,
          teacher_id: Number(row.teacher_id),
        }),
      );
    }
  });

  it("各过滤与页大小都是同一全序的切片", async () => {
    const failures: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      failures.push(args.map((part) => String(part)).join(" "));
      originalError(...args);
    };
    const seen = new Map<string, string[]>();
    try {
      for (const filter of filters) {
        const courses = await expectedCourses(filter);
        for (const sort of ["name", "reviews"] as const) {
          const expected = sortCourses(courses, sort).map(courseSignature);
          const pageSizes = filter.department === department && filter.category === "" && filter.teacherId == null
            ? [1, 3, 8]
            : [1, 5];
          for (const pageSize of pageSizes) {
            const items = await collectPages(
              (page, size) =>
                queryPublicCourses(env.DB, {
                  page,
                  pageSize: size,
                  q: "",
                  category: filter.category,
                  department: filter.department,
                  teacherId: filter.teacherId,
                  sort,
                }),
              pageSize,
            );
            const actual = items.map(courseSignature);
            expect(actual, `courses ${JSON.stringify(filter)} ${sort} pageSize=${pageSize}`).toEqual(expected);
            expect(new Set(items.map((item) => item.public_id)).size).toBe(items.length);
          }
        }

        const relations = await expectedRelations(filter);
        for (const sort of ["name", "reviews", "rating"] as const) {
          const expected = sortRelations(relations, sort).map(relationSignature);
          const pageSizes = filter.department === department && filter.category === "" && filter.teacherId == null
            ? [1, 3, 8]
            : [1, 5];
          for (const pageSize of pageSizes) {
            const items = await collectPages(
              (page, size) =>
                queryPublicCourseRelations(
                  env.DB,
                  {
                    page,
                    pageSize: size,
                    q: "",
                    category: filter.category,
                    department: filter.department,
                    teacherId: filter.teacherId,
                    sort,
                  },
                  null,
                ),
              pageSize,
            );
            const actual = items.map(relationSignature);
            expect(actual, `relations ${JSON.stringify(filter)} ${sort} pageSize=${pageSize}`).toEqual(expected);
            expect(new Set(items.map((item) => item.public_id)).size).toBe(items.length);
            if (pageSize === 1) {
              seen.set(`relations:${filter.category}:${filter.department}:${filter.teacherId ?? ""}:${sort}`, actual);
            }
          }
        }
      }
    } finally {
      console.error = originalError;
    }
    expect(
      failures.filter(
        (line) =>
          line.includes("relation_browse_fast_path_failed") ||
          line.includes("catalog_browse_fallback"),
      ),
    ).toEqual([]);

    const departmentCourses = sortCourses(
      await expectedCourses({ category: "", department, teacherId: null }),
      "name",
    );
    const courseIndex = (id: string) =>
      departmentCourses.findIndex((item) => item.public_id === id);
    expect(courseIndex(publicCourseIdentity(ids.basket))).toBeLessThan(
      courseIndex(publicCourseIdentity(ids.ahead)),
    );
    expect(courseIndex(publicCourseIdentity(ids.ahead))).toBeLessThan(
      courseIndex(publicCourseIdentity(ids.behind)),
    );
    expect(departmentCourses.find((item) => item.id === ids.basket)?.name).toBe(
      "体育1-4 [篮球]",
    );
    const topicExtra = publicPeCourseIdentity("目录排序专题");
    const topicReal = publicCourseIdentity(ids.topicReal);
    expect(courseIndex(topicExtra)).toBe(courseIndex(topicReal) - 1);

    const englishNames = departmentCourses
      .filter((item) => item.name.startsWith("大学英语"))
      .map((item) => item.name);
    expect(englishNames).toEqual([
      "大学英语1",
      "大学英语2",
      "大学英语3",
      "大学英语4",
      "大学英语I",
    ]);

    const relationNames = sortRelations(
      await expectedRelations({ category: "english", department, teacherId: null }),
      "name",
    );
    expect(relationNames.map((item) => `${item.name}:${item.teacher_name}`)).toEqual([
      `大学英语1:${stamp}乙`,
      `大学英语I:${stamp}甲`,
      `大学英语2:${stamp}甲`,
      `大学英语3:${stamp}甲`,
      `大学英语4:${stamp}甲`,
    ]);
    expect(ids.english2).toBeLessThan(ids.englishI);

    const tiedReviews = sortRelations(
      await expectedRelations({ category: "", department, teacherId: null }),
      "reviews",
    );
    const mathYiAt = tiedReviews.findIndex((item) => item.course_id === ids.mathYi);
    const mathJiaAt = tiedReviews.findIndex((item) => item.course_id === ids.mathJia);
    const linearAt = tiedReviews.findIndex((item) => item.course_id === ids.linear);
    expect(ids.mathJia).toBeLessThan(ids.mathYi);
    expect(linearAt).toBeLessThan(mathYiAt);
    expect(mathYiAt).toBeLessThan(mathJiaAt);

    const rated = sortRelations(
      await expectedRelations({ category: "", department, teacherId: null }),
      "rating",
    );
    const firstUnrated = rated.findIndex((item) => item.rating == null);
    expect(firstUnrated).toBeGreaterThan(0);
    expect(rated.slice(firstUnrated).every((item) => item.rating == null)).toBe(true);
    expect(rated.slice(0, firstUnrated).every((item) => item.rating != null)).toBe(true);
    const mathFastFirst = seen.get(["relations", "math", "", "", "reviews"].join(":"))?.[0] ?? "";
    expect(mathFastFirst).toContain(publicRelationIdentity(ids.linear, ids.jia));
  }, 180_000);

  it("关系快路径在阈值平局、行数不足和类别过滤下与全序一致", async () => {
    const failures: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      failures.push(args.map((part) => String(part)).join(" "));
      originalError(...args);
    };
    try {
      const sameKey = (
        sort: PublicRelationListSort,
        left: RelationSortRow,
        right: RelationSortRow,
      ) =>
        sort === "rating"
          ? left.rating != null && left.rating === right.rating
          : left.review_count === right.review_count;

      for (const category of ["", "sports", "general"]) {
        for (const sort of ["reviews", "rating"] as const) {
          const filter = { category, department: "", teacherId: null };
          const expected = sortRelations(await expectedRelations(filter), sort);
          const pageSize = 5;
          let tiedPage = 0;
          const windowEnd = category === "general" ? expected.length : Math.min(expected.length, 200);
          for (let page = 1; page * pageSize < windowEnd; page += 1) {
            const end = page * pageSize - 1;
            if (sort === "rating" ? expected[end].rating == null : expected[end].review_count <= 0) {
              continue;
            }
            if (!sameKey(sort, expected[end], expected[end + 1])) continue;
            const key = sort === "rating" ? expected[end].rating : expected[end].review_count;
            const band = expected.filter((row) =>
              sort === "rating" ? row.rating === key : row.review_count === key,
            );
            if (band.length < 8) continue;
            tiedPage = page;
            break;
          }
          expect(tiedPage, `${category} ${sort} 应在快路径窗口内有至少 8 行平局`).toBeGreaterThan(0);
          const items = await queryPublicCourseRelations(
            env.DB,
            {
              page: tiedPage,
              pageSize,
              q: "",
              category,
              department: "",
              teacherId: null,
              sort,
            },
            null,
          );
          expect(items.items.map(relationSignature)).toEqual(
            expected.slice((tiedPage - 1) * pageSize, tiedPage * pageSize).map(relationSignature),
          );
        }
      }

      for (const sort of ["reviews", "rating"] as const) {
        const filter = { category: "ideology", department: "", teacherId: null };
        const expected = sortRelations(await expectedRelations(filter), sort);
        const pageSize = expected.length + 5;
        const page = await queryPublicCourseRelations(
          env.DB,
          {
            page: 1,
            pageSize,
            q: "",
            category: "ideology",
            department: "",
            teacherId: null,
            sort,
          },
          null,
        );
        expect(page.total).toBe(expected.length);
        expect(page.items.map(relationSignature)).toEqual(expected.map(relationSignature));
        const past = await queryPublicCourseRelations(
          env.DB,
          {
            page: 400,
            pageSize: 10,
            q: "",
            category: "ideology",
            department: "",
            teacherId: null,
            sort,
          },
          null,
        );
        expect(past.items).toEqual([]);
        expect(past.total).toBe(expected.length);
      }
    } finally {
      console.error = originalError;
    }
    expect(failures.filter((line) => line.includes("relation_browse_fast_path_failed"))).toEqual([]);

    const scope = publicCatalogListScope({ category: "", department: "", teacherId: null });
    const fastWhere = `${publicCourseVisibleSql("c")} AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")} AND ${scope.sql}`;
    const sportsScope = publicCatalogListScope({
      category: "sports",
      department: "",
      teacherId: null,
    });
    const sportsWhere = `${publicCourseVisibleSql("c")} AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")} AND ${sportsScope.sql}`;

    const assertIndexProbe = async (
      sort: "reviews" | "rating",
      where: string,
      args: unknown[],
      indexName: string,
    ) => {
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${relationBrowseThresholdProbeSql(sort, where)}`,
      )
        .bind(...args, 19)
        .all<{ detail: string }>();
      const details = (plan.results ?? []).map((row) => String(row.detail ?? ""));
      expect(details.some((line) => line.includes(indexName))).toBe(true);
      expect(details.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    };
    await assertIndexProbe("reviews", fastWhere, scope.args, "idx_public_review_counts_review_count");
    await assertIndexProbe("rating", fastWhere, scope.args, "idx_public_relation_ratings_rating");

    expect(relationBrowseUsesIndexedThreshold({ category: "", sort: "reviews" })).toBe(true);
    expect(relationBrowseUsesIndexedThreshold({ category: "", sort: "rating" })).toBe(false);
    expect(relationBrowseUsesIndexedThreshold({ category: "sports", sort: "reviews" })).toBe(false);
    expect(relationBrowseUsesIndexedThreshold({ category: "sports", sort: "rating" })).toBe(false);
    expect(relationBrowseUsesIndexedThreshold({ category: "math", sort: "reviews" })).toBe(false);
    expect(relationBrowseUsesIndexedThreshold({ category: "general", sort: "reviews" })).toBe(false);
    expect(relationBrowseAggregateFromSql("reviews")).not.toContain("INDEXED BY");
    expect(relationBrowseAggregateFromSql("rating")).not.toContain("INDEXED BY");
    expect(relationBrowseThresholdProbeSql("reviews", sportsWhere)).toContain(
      "INDEXED BY idx_public_review_counts_review_count",
    );

    const sportsPagePlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT c.id
       ${relationBrowseAggregateFromSql("reviews")}
       WHERE ${sportsWhere}
       ORDER BY COALESCE(rel_counts.review_count,0) DESC
       LIMIT ?`,
    )
      .bind(...sportsScope.args, 21)
      .all<{ detail: string }>();
    const sportsPageDetails = (sportsPagePlan.results ?? []).map((row) =>
      String(row.detail ?? ""),
    );
    expect(
      sportsPageDetails.some((line) =>
        line.includes(
          "SCAN rel_counts USING COVERING INDEX idx_public_review_counts_review_count",
        ),
      ),
    ).toBe(false);
    expect(
      sportsPageDetails.some((line) => line.includes("idx_public_course_canonicals_sports")),
    ).toBe(true);

    const teacherId = 928_000_001;
    const idBase = 928_100_000;
    const inserted: Array<{ id: number; reviewCount: number; rating: number; name: string }> = [];
    for (let index = 0; index < 16; index += 1) {
      inserted.push({
        id: idBase + index,
        reviewCount: 1_000_000 - index,
        rating: 5,
        name: `阈高${stamp}-${String(index).padStart(2, "0")}`,
      });
    }
    for (let index = 0; index < 24; index += 1) {
      inserted.push({
        id: idBase + 16 + index,
        reviewCount: 500_000,
        rating: 4,
        name: `阈平${stamp}-${String(23 - index).padStart(2, "0")}`,
      });
    }
    for (let index = 0; index < 280; index += 1) {
      inserted.push({
        id: idBase + 40 + index,
        reviewCount: 1,
        rating: 2,
        name: `阈低${stamp}-${String(index).padStart(3, "0")}`,
      });
    }
    const departmentName = `${stamp}阈院`;
    const isolatedWhere = `${fastWhere} AND trim(c.department)=trim(?)`;
    try {
      await env.DB.prepare(
        "INSERT INTO teachers(id,source_teacher_label,name,department) VALUES(?,?,?,?)",
      )
        .bind(teacherId, `阈师${stamp}`, `阈师${stamp}`, departmentName)
        .run();
      const statements = inserted.flatMap((row) => [
        env.DB.prepare(
          "INSERT INTO courses(id,code,name,category,department,scheme_key) VALUES(?,?,?,?,?,?)",
        ).bind(row.id, `928-${row.id}`, row.name, "general", departmentName, "major"),
        env.DB.prepare(
          "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
        ).bind(row.id, teacherId),
        env.DB.prepare(
          "INSERT INTO public_course_canonicals(course_id,canonical_course_id,is_public_sports) VALUES(?,?,0)",
        ).bind(row.id, row.id),
        env.DB.prepare(
          "INSERT INTO public_review_counts(course_id,teacher_id,review_count) VALUES(?,?,?)",
        ).bind(row.id, teacherId, row.reviewCount),
        env.DB.prepare(
          "INSERT INTO public_relation_ratings(course_id,teacher_id,rating) VALUES(?,?,?)",
        ).bind(row.id, teacherId, row.rating),
      ]);
      for (let offset = 0; offset < statements.length; offset += 80) {
        await env.DB.batch(statements.slice(offset, offset + 80));
      }

      const nameSort = publicRelationNameSortSql("c", "t");
      const runOrdered = async (
        sort: "reviews" | "rating",
        limit: number,
        offset: number,
      ) => {
        const order =
          sort === "rating"
            ? `(rel_rating.rating IS NULL),rel_rating.rating DESC,COALESCE(rel_counts.review_count,0) DESC,${nameSort}`
            : `COALESCE(rel_counts.review_count,0) DESC,${nameSort}`;
        const fromSql = relationBrowseAggregateFromSql(sort);
        const full = await env.DB.prepare(
          `SELECT c.id course_id,t.id teacher_id
           ${fromSql}
           WHERE ${isolatedWhere}
           ORDER BY ${order}
           LIMIT ? OFFSET ?`,
        )
          .bind(...scope.args, departmentName, limit, offset)
          .all<{ course_id: number; teacher_id: number }>();
        const probe = await env.DB.prepare(
          relationBrowseThresholdProbeSql(sort, isolatedWhere),
        )
          .bind(...scope.args, departmentName, offset + limit - 1)
          .all<{ sort_threshold: number | null }>();
        const threshold = probe.results?.[0]?.sort_threshold;
        expect(threshold).not.toBeNull();
        const key = sort === "rating" ? "rel_rating.rating" : "rel_counts.review_count";
        const bounded = await env.DB.prepare(
          `SELECT c.id course_id,t.id teacher_id
           ${fromSql}
           WHERE ${isolatedWhere} AND ${key} >= ?
           ORDER BY ${order}
           LIMIT ? OFFSET ?`,
        )
          .bind(...scope.args, departmentName, Number(threshold), limit, offset)
          .all<{ course_id: number; teacher_id: number }>();
        const signature = (row: { course_id: number; teacher_id: number }) =>
          `${row.course_id}:${row.teacher_id}`;
        expect((bounded.results ?? []).map(signature)).toEqual((full.results ?? []).map(signature));
        const fullRead = Number(full.meta?.rows_read) || 0;
        const probeRead = Number(probe.meta?.rows_read) || 0;
        const boundedRead = Number(bounded.meta?.rows_read) || 0;
        expect(probeRead).toBeGreaterThan(0);
        expect(fullRead).toBeGreaterThan(probeRead);
        expect(fullRead).toBeGreaterThan(boundedRead);
        return { threshold: Number(threshold), fullRead, probeRead, boundedRead };
      };

      const top = await runOrdered("reviews", 10, 0);
      expect(top.threshold).toBe(1_000_000 - 9);
      const tiePage = await runOrdered("reviews", 8, 20);
      expect(tiePage.threshold).toBe(500_000);
      const ratedTop = await runOrdered("rating", 10, 0);
      expect(ratedTop.threshold).toBe(5);
      const ratedTie = await runOrdered("rating", 8, 20);
      expect(ratedTie.threshold).toBe(4);

      const unfilteredOrder = `COALESCE(rel_counts.review_count,0) DESC,${nameSort}`;
      const unfilteredFrom = relationBrowseAggregateFromSql("reviews");
      const unfilteredFull = await env.DB.prepare(
        `SELECT c.id course_id,t.id teacher_id
         ${unfilteredFrom}
         WHERE ${fastWhere}
         ORDER BY ${unfilteredOrder}
         LIMIT ? OFFSET ?`,
      )
        .bind(...scope.args, 20, 0)
        .all<{ course_id: number; teacher_id: number }>();
      const unfilteredProbe = await env.DB.prepare(
        relationBrowseThresholdProbeSql("reviews", fastWhere),
      )
        .bind(...scope.args, 19)
        .all<{ sort_threshold: number }>();
      const unfilteredThreshold = Number(unfilteredProbe.results?.[0]?.sort_threshold);
      expect(unfilteredThreshold).toBeGreaterThan(1);
      const unfilteredBounded = await env.DB.prepare(
        `SELECT c.id course_id,t.id teacher_id
         ${unfilteredFrom}
         WHERE ${fastWhere} AND rel_counts.review_count >= ?
         ORDER BY ${unfilteredOrder}
         LIMIT ? OFFSET ?`,
      )
        .bind(...scope.args, unfilteredThreshold, 20, 0)
        .all<{ course_id: number; teacher_id: number }>();
      const pair = (row: { course_id: number; teacher_id: number }) =>
        `${row.course_id}:${row.teacher_id}`;
      expect((unfilteredBounded.results ?? []).map(pair)).toEqual(
        (unfilteredFull.results ?? []).map(pair),
      );
      const unfilteredFullRead = Number(unfilteredFull.meta?.rows_read) || 0;
      const unfilteredProbeRead = Number(unfilteredProbe.meta?.rows_read) || 0;
      expect(unfilteredProbeRead).toBeGreaterThan(0);
      expect(unfilteredFullRead).toBeGreaterThan(unfilteredProbeRead);

      const sportsPage = await env.DB.prepare(
        `SELECT c.id course_id
         ${relationBrowseAggregateFromSql("reviews")}
         WHERE ${sportsWhere}
         ORDER BY COALESCE(rel_counts.review_count,0) DESC
         LIMIT ?`,
      )
        .bind(...sportsScope.args, 21)
        .all<{ course_id: number }>();
      const sportsIndexedProbe = await env.DB.prepare(
        relationBrowseThresholdProbeSql("reviews", sportsWhere),
      )
        .bind(...sportsScope.args, 19)
        .all<{ sort_threshold: number | null }>();
      const sportsPageRead = Number(sportsPage.meta?.rows_read) || 0;
      const sportsIndexedProbeRead = Number(sportsIndexedProbe.meta?.rows_read) || 0;
      expect(sportsPageRead).toBeGreaterThan(0);
      expect(sportsIndexedProbeRead).toBeGreaterThan(sportsPageRead);

      const shortProbe = await env.DB.prepare(
        relationBrowseThresholdProbeSql("reviews", isolatedWhere),
      )
        .bind(...scope.args, departmentName, 1_000_000)
        .all<{ sort_threshold: number }>();
      expect(shortProbe.results ?? []).toEqual([]);
    } finally {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM public_review_counts WHERE course_id BETWEEN ? AND ?",
        ).bind(idBase, idBase + 399),
        env.DB.prepare(
          "DELETE FROM public_relation_ratings WHERE course_id BETWEEN ? AND ?",
        ).bind(idBase, idBase + 399),
        env.DB.prepare(
          "DELETE FROM public_course_canonicals WHERE course_id BETWEEN ? AND ?",
        ).bind(idBase, idBase + 399),
        env.DB.prepare(
          "DELETE FROM course_teachers WHERE course_id BETWEEN ? AND ?",
        ).bind(idBase, idBase + 399),
        env.DB.prepare("DELETE FROM courses WHERE id BETWEEN ? AND ?").bind(
          idBase,
          idBase + 399,
        ),
        env.DB.prepare("DELETE FROM teachers WHERE id=?").bind(teacherId),
      ]);
      await ensurePublicListPrecomputes(env.DB);
    }
  }, 120_000);
});
