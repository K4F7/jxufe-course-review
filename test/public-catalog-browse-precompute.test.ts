import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPeSpecializationMapping } from "../src/lib/pe-specialization-mapping";
import { publicRelationNameSortKey } from "../src/lib/public-course-presentation";
import {
  CATALOG_BROWSE_PROJECTION_ENABLED,
  columnRowInsertStatements,
} from "../src/public-catalog-browse-plan";
import { rebuildPublicListProjection } from "../src/public-list-projection-plan";
import { refreshPublicListPrecomputes } from "../src/public-list-precompute";
import {
  queryPublicCourseRelations,
  queryPublicCourseRelationsLegacy,
  queryPublicCourses,
  queryPublicCoursesLegacy,
  type PublicCourseListQuery,
  type PublicCourseListSort,
  type PublicRelationListQuery,
  type PublicRelationListSort,
} from "../src/public-catalog-query";
import { CURRENT_SCORES } from "./review-score-fixtures";

const stamp = `browse924-${Date.now()}`;
const deptA = `${stamp}甲院`;
const deptB = `${stamp}乙院`;

const ids = {
  jia: 0,
  yi: 0,
  huang: 0,
  liu: 0,
  lonely: 0,
  math: 0,
  english: 0,
  major: 0,
  basic: 0,
  ideology: 0,
  mooc: 0,
  basket: 0,
  sourceA: 0,
  sourceB: 0,
};

const browseTables = [
  "public_relation_browse",
  "public_relation_browse_departments",
  "public_relation_browse_totals",
  "public_course_browse",
  "public_course_browse_departments",
  "public_course_browse_teachers",
  "public_course_browse_totals",
];

let consoleErrors: string[] = [];
const originalConsoleError = console.error;

beforeAll(async () => {
  // #931: 开关关闭时下面整组依赖浏览表的用例被跳过，不必建夹具。
  if (!CATALOG_BROWSE_PROJECTION_ENABLED) return;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((part) => String(part)).join(" "));
    originalConsoleError(...args);
  };
  ids.jia = await insertTeacher(`${stamp}甲`, deptA);
  ids.yi = await insertTeacher(`${stamp}乙`, deptA);
  ids.huang = await insertTeacher("黄丽萍", `${stamp}虚拟`);
  ids.liu = await insertTeacher("刘春来", `${stamp}虚拟`);
  ids.lonely = await insertTeacher(`${stamp}无课`, deptA);

  ids.math = await insertCourse({
    code: `${stamp}-MATH`,
    name: `${stamp}高等数学`,
    scheme: "math",
    department: deptA,
  });
  ids.english = await insertCourse({
    code: `${stamp}-ENG`,
    name: "大学英语2",
    scheme: "english",
    department: deptA,
  });
  ids.major = await insertCourse({
    code: `${stamp}-MAJ`,
    name: `${stamp}专业课`,
    scheme: "major",
    department: deptA,
  });
  ids.basic = await insertCourse({
    code: `${stamp}-BAS`,
    name: `${stamp}公基`,
    scheme: "public_basic",
    department: deptB,
  });
  ids.ideology = await insertCourse({
    code: `${stamp}-IDE`,
    name: `${stamp}思修`,
    scheme: "ideology",
    department: deptA,
  });
  ids.mooc = await insertCourse({
    code: `${stamp}-MOOC`,
    name: `${stamp}慕课`,
    scheme: "major",
    department: deptA,
  });
  ids.basket = await insertCourse({
    code: `${stamp}-B2`,
    name: "篮球2",
    scheme: "pe",
    category: "sports",
    department: deptA,
  });
  ids.sourceA = await insertCourse({
    code: `${stamp}-PEA`,
    name: `${stamp}双院来源甲`,
    scheme: "major",
    department: deptA,
  });
  ids.sourceB = await insertCourse({
    code: `${stamp}-PEB`,
    name: `${stamp}双院来源乙`,
    scheme: "major",
    department: deptB,
  });

  await env.DB.prepare(
    "INSERT INTO course_tags(course_id,tag) VALUES(?,'mooc')",
  )
    .bind(ids.mooc)
    .run();

  for (const courseId of [
    ids.math,
    ids.english,
    ids.major,
    ids.ideology,
    ids.mooc,
    ids.basket,
    ids.sourceA,
  ]) {
    await bindTeacher(courseId, ids.jia);
  }
  await bindTeacher(ids.math, ids.yi);
  await bindTeacher(ids.basic, ids.yi);
  await bindTeacher(ids.sourceB, ids.jia);

  await insertPeMapping({
    courseId: ids.sourceA,
    teacherId: ids.jia,
    specialization: `${stamp}双院`,
    courseCode: `${stamp}-PEA`,
    courseName: `${stamp}双院来源甲`,
  });
  await insertPeMapping({
    courseId: ids.sourceB,
    teacherId: ids.jia,
    specialization: `${stamp}双院`,
    courseCode: `${stamp}-PEB`,
    courseName: `${stamp}双院来源乙`,
  });

  await insertReview(ids.math, ids.jia, 5, `${stamp}-高数甲`);
  await insertReview(ids.math, ids.jia, 3, `${stamp}-高数甲二`);
  await insertReview(ids.english, ids.jia, 4, `${stamp}-英语`);
  await insertReview(ids.basket, ids.jia, 2, `${stamp}-篮球`);
  await insertReview(ids.sourceA, ids.jia, 4, `${stamp}-双院甲`);
  await insertReview(ids.sourceB, ids.jia, 2, `${stamp}-双院乙`);

  await refreshPublicListPrecomputes(env.DB);
}, 60_000);

afterEach(() => {
  if (!CATALOG_BROWSE_PROJECTION_ENABLED) return;
  const leaked = consoleErrors.filter((line) =>
    line.includes("catalog_browse_fallback"),
  );
  consoleErrors = [];
  expect(leaked).toEqual([]);
});

// #931: 开关关闭期间这些用例依赖浏览表重建，重新打开后再跑。
describe.skipIf(!CATALOG_BROWSE_PROJECTION_ENABLED)("预计算公共目录浏览", () => {
  const courseSorts = ["name", "reviews"] as const;
  const relationSorts = ["name", "reviews", "rating"] as const;
  const filters: Array<{
    category: string;
    department: string;
    teacherId: number | null;
  }> = [];

  it("与旧路径在排序、分页和字段上一致", async () => {
    const categories = [
      "",
      "sports",
      "math",
      "english",
      "general",
      "major",
      "public_basic",
      "mooc",
      "ideology",
    ];
    const departments = ["", deptA, deptB, `${stamp}不存在`];
    const teachers = [null, ids.jia, ids.yi, ids.huang, ids.lonely];
    for (const category of categories) {
      for (const department of departments) {
        for (const teacherId of teachers) {
          filters.push({ category, department, teacherId });
        }
      }
    }

    for (const filter of filters) {
      for (const sort of courseSorts) {
        await expectCourseParity(filter, sort);
      }
      for (const sort of relationSorts) {
        await expectRelationParity(filter, sort);
      }
    }
  }, 180_000);

  it("搜索仍走旧路径，结果不变", async () => {
    const courseQuery: PublicCourseListQuery = {
      page: 1,
      pageSize: 5,
      q: "瑜伽",
      category: "",
      department: "",
      teacherId: null,
      sort: "reviews",
    };
    expect(await queryPublicCourses(env.DB, courseQuery)).toEqual(
      await queryPublicCoursesLegacy(env.DB, courseQuery),
    );
    const relationQuery: PublicRelationListQuery = {
      ...courseQuery,
      q: `${stamp}甲`,
      sort: "rating",
    };
    expect(
      await queryPublicCourseRelations(env.DB, relationQuery, null),
    ).toEqual(
      await queryPublicCourseRelationsLegacy(env.DB, relationQuery, null),
    );
  });

  it("无筛选和分类查询走对应索引", async () => {
    const plans = [
      [
        "idx_rel_browse_reviews",
        `SELECT public_id FROM public_relation_browse INDEXED BY idx_rel_browse_reviews
         ORDER BY review_count DESC, name_sort_key LIMIT 2 OFFSET 0`,
      ],
      [
        "idx_rel_browse_sports_name",
        `SELECT public_id FROM public_relation_browse INDEXED BY idx_rel_browse_sports_name
         WHERE in_sports=1 ORDER BY name_sort_key LIMIT 2 OFFSET 0`,
      ],
      [
        "idx_course_browse_name",
        `SELECT public_id FROM public_course_browse INDEXED BY idx_course_browse_name
         ORDER BY sort_name, sort_code, sort_id_missing, sort_id, public_id
         LIMIT 2 OFFSET 0`,
      ],
    ] as const;
    for (const [index, sql] of plans) {
      const explained = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${sql}`,
      ).all<{ detail: string }>();
      expect(
        (explained.results ?? []).some((row) =>
          String(row.detail).includes(index),
        ),
      ).toBe(true);
      await env.DB.prepare(sql).all();
    }
  });

  it("排序键与比较器一致，体育公共项按任一来源院系匹配且不重复", async () => {
    const ordinary = await env.DB.prepare(
      `SELECT public_id,course_id,code,name,teacher_id,teacher_name,name_sort_key
       FROM public_relation_browse WHERE course_id=? AND teacher_id=?`,
    )
      .bind(ids.math, ids.jia)
      .first<{
        public_id: string;
        course_id: number;
        code: string;
        name: string;
        teacher_id: number;
        teacher_name: string;
        name_sort_key: string;
      }>();
    expect(ordinary).toBeTruthy();
    expect(ordinary?.name_sort_key).toBe(
      publicRelationNameSortKey({
        name: ordinary?.name ?? "",
        code: ordinary?.code,
        course_id: Number(ordinary?.course_id),
        teacher_name: ordinary?.teacher_name,
        teacher_id: Number(ordinary?.teacher_id),
      }),
    );

    const extra = await env.DB.prepare(
      `SELECT public_id,course_id,code,name,department,teacher_id,teacher_name,
         review_count,name_sort_key
       FROM public_relation_browse WHERE name LIKE ?`,
    )
      .bind(`%${stamp}双院%`)
      .first<{
        public_id: string;
        course_id: number | null;
        code: string;
        name: string;
        department: string;
        teacher_id: number;
        teacher_name: string;
        review_count: number;
        name_sort_key: string;
      }>();
    expect(extra?.course_id).toBeNull();
    expect(extra?.department).toBe("");
    expect(Number(extra?.review_count)).toBe(2);
    expect(extra?.name_sort_key).toBe(
      publicRelationNameSortKey({
        name: extra?.name ?? "",
        code: extra?.code,
        course_id: 0,
        teacher_name: extra?.teacher_name,
        teacher_id: Number(extra?.teacher_id),
      }),
    );
    const membership = await env.DB.prepare(
      `SELECT department FROM public_relation_browse_departments
       WHERE public_id=? ORDER BY department`,
    )
      .bind(extra?.public_id)
      .all<{ department: string }>();
    expect(
      (membership.results ?? []).map((row) => row.department).sort(),
    ).toEqual([deptA, deptB].sort());

    const sportsA = await queryPublicCourseRelations(
      env.DB,
      relationQuery({ category: "sports", department: deptA, teacherId: ids.jia }),
      null,
    );
    const sportsB = await queryPublicCourseRelations(
      env.DB,
      relationQuery({ category: "sports", department: deptB, teacherId: ids.jia }),
      null,
    );
    expect(
      sportsA.items.filter((item) => item.public_id === extra?.public_id),
    ).toHaveLength(1);
    expect(
      sportsB.items.filter((item) => item.public_id === extra?.public_id),
    ).toHaveLength(1);

    const virtual = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "sports", department: "", teacherId: ids.huang }),
    );
    expect(virtual.items.map((item) => item.id)).toContain(800001);
    expect(virtual.items.find((item) => item.id === 800001)?.teachers).toBe(
      "黄丽萍",
    );
    const hiddenVirtual = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "sports", department: deptA, teacherId: null }),
    );
    expect(hiddenVirtual.items.map((item) => item.id)).not.toContain(800001);

    const narrowed = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "math", department: deptA, teacherId: ids.jia }),
    );
    const mathRow = narrowed.items.find((item) => item.id === ids.math);
    expect(mathRow?.teachers).toBe(`${stamp}甲`);
    expect(mathRow?.teacher_refs).toBe(`${ids.jia}:${stamp}甲`);
    const both = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "math", department: deptA, teacherId: null }),
    );
    const bothTeachers = both.items.find((item) => item.id === ids.math);
    expect(bothTeachers?.teachers ?? "").toContain(`${stamp}甲`);
    expect(bothTeachers?.teachers ?? "").toContain(`${stamp}乙`);
  });

  it("评价通过后的重建会更新计数并保留未变化的行", async () => {
    const courseId = `course:${ids.english}`;
    const relationId = `relation:${ids.english}:${ids.jia}`;
    const controlId = `course:${ids.math}`;
    const before = await browseCounts([courseId, relationId, controlId]);
    await insertReview(ids.english, ids.jia, 5, `${stamp}-英语新增`);
    const page = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "english", department: deptA, teacherId: null }),
    );
    const legacy = await queryPublicCoursesLegacy(
      env.DB,
      courseQuery({ category: "english", department: deptA, teacherId: null }),
    );
    expect(page).toEqual(legacy);
    const after = await browseCounts([courseId, relationId, controlId]);
    expect(after.get(courseId)).toBe((before.get(courseId) ?? 0) + 1);
    expect(after.get(relationId)).toBe((before.get(relationId) ?? 0) + 1);
    expect(after.get(controlId)).toBe(before.get(controlId));
    expect(page.items.find((item) => item.public_id === courseId)?.review_count).toBe(
      after.get(courseId),
    );
  });

  it("任课关系删除后两边都去掉该行", async () => {
    await env.DB.prepare(
      "DELETE FROM course_teachers WHERE course_id=? AND teacher_id=?",
    )
      .bind(ids.basic, ids.yi)
      .run();
    const filter = { category: "public_basic", department: deptB, teacherId: ids.yi };
    const courses = await queryPublicCourses(env.DB, courseQuery(filter));
    const legacyCourses = await queryPublicCoursesLegacy(env.DB, courseQuery(filter));
    expect(courses).toEqual(legacyCourses);
    expect(courses.items.map((item) => item.public_id)).not.toContain(
      `course:${ids.basic}`,
    );
    const relations = await queryPublicCourseRelations(
      env.DB,
      relationQuery({ ...filter, sort: "name" }),
      null,
    );
    const legacyRelations = await queryPublicCourseRelationsLegacy(
      env.DB,
      relationQuery({ ...filter, sort: "name" }),
      null,
    );
    expect(relations).toEqual(legacyRelations);
    expect(relations.total).toBe(0);
  });

  it("ready 仍为 0 时下一次读取会重建浏览表", async () => {
    await env.DB.batch([
      ...browseTables.map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
      env.DB.prepare(
        `UPDATE public_precompute_state
         SET catalog_browse_ready=0,dirty=0,
             refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ),
    ]);
    const page = await queryPublicCourses(
      env.DB,
      courseQuery({ category: "", department: "", teacherId: null, sort: "name" }),
    );
    const legacy = await queryPublicCoursesLegacy(
      env.DB,
      courseQuery({ category: "", department: "", teacherId: null, sort: "name" }),
    );
    expect(page).toEqual(legacy);
    expect(page.total).toBeGreaterThan(0);
    const ready = await env.DB.prepare(
      "SELECT catalog_browse_ready ready,dirty FROM public_precompute_state WHERE id=1",
    ).first<{ ready: number; dirty: number }>();
    expect(Number(ready?.ready)).toBe(1);
    expect(Number(ready?.dirty)).toBe(0);
  });

  it("表不存在时回退旧路径", async () => {
    await hideBrowseTables();
    try {
      const filter = { category: "math", department: deptA, teacherId: ids.jia };
      const courses = await queryPublicCourses(env.DB, courseQuery(filter));
      const legacyCourses = await queryPublicCoursesLegacy(
        env.DB,
        courseQuery(filter),
      );
      expect(courses).toEqual(legacyCourses);
      const relations = await queryPublicCourseRelations(
        env.DB,
        relationQuery(filter),
        null,
      );
      const legacyRelations = await queryPublicCourseRelationsLegacy(
        env.DB,
        relationQuery(filter),
        null,
      );
      expect(relations).toEqual(legacyRelations);
      expect(
        consoleErrors.some((line) => line.includes("catalog_browse_fallback")),
      ).toBe(true);
      consoleErrors = [];
    } finally {
      await restoreBrowseTables();
    }
  });

  it("迁移未建浏览表时仍发布原有投影且 ready 保持 0", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET catalog_browse_ready=0,dirty=1,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    await env.DB.prepare(
      "ALTER TABLE public_relation_browse_staging RENAME TO public_relation_browse_staging_off",
    ).run();
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
        "SELECT catalog_browse_ready ready FROM public_precompute_state WHERE id=1",
      ).first<{ ready: number }>();
      const canonicals = await env.DB.prepare(
        "SELECT COUNT(*) n FROM public_course_canonicals",
      ).first<{ n: number }>();
      expect(Number(ready?.ready)).toBe(0);
      expect(Number(canonicals?.n)).toBeGreaterThan(0);
    } finally {
      await env.DB.prepare(
        "ALTER TABLE public_relation_browse_staging_off RENAME TO public_relation_browse_staging",
      ).run();
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("D1 接受宽度 2 的满块 VALUES 插入", async () => {
    const columns = ["department", "public_id"] as const;
    const rows = Array.from({ length: 49 }, (_, index) => ({
      department: `满块院系${index}`,
      public_id: `relation:chunk:${index}`,
    }));
    const [statement] = columnRowInsertStatements(
      "public_relation_browse_departments_staging",
      columns,
      rows,
    );
    expect(statement).toBeDefined();
    expect(statement?.sql).not.toContain("UNION ALL");
    expect(statement?.sql.match(/\(\?,\?\)/g)).toHaveLength(49);
    await env.DB.prepare(statement!.sql)
      .bind(...statement!.values, -1, "not-a-lease")
      .run();
    const leaked = await env.DB.prepare(
      `SELECT COUNT(*) n FROM public_relation_browse_departments_staging
       WHERE public_id LIKE 'relation:chunk:%'`,
    ).first<{ n: number }>();
    expect(Number(leaked?.n)).toBe(0);
  });
});

describe.skipIf(CATALOG_BROWSE_PROJECTION_ENABLED)("浏览预计算暂停 (#932)", () => {
  it("开关关闭时重建不写浏览表，读取走旧路径且结果正确", async () => {
    const stamp = `pause932-${Date.now()}`;
    const department = `${stamp}院`;
    const teacher = await env.DB.prepare(
      "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?,?)",
    )
      .bind(stamp, stamp, department)
      .run();
    const teacherId = Number(teacher.meta.last_row_id);
    const course = await env.DB.prepare(
      "INSERT INTO courses(code,name,category,department,scheme_key) VALUES(?,?,?,?,?)",
    )
      .bind(`${stamp}-C`, `${stamp}高等数学`, "general", department, "math")
      .run();
    const courseId = Number(course.meta.last_row_id);
    await env.DB.prepare(
      "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
    )
      .bind(courseId, teacherId)
      .run();
    await env.DB.prepare(
      `INSERT INTO reviews(
        course_id,teacher_id,category,overall,comment,term,status,
        submitter_hash,scheme_key,scheme_version,scores,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        courseId,
        teacherId,
        "general",
        5,
        `${stamp}-评价正文足够长`,
        "2026 春",
        "approved",
        `hash-${stamp}`,
        "major",
        2,
        JSON.stringify(CURRENT_SCORES),
        "2026-08-12 01:00:00",
      )
      .run();

    await insertPausedBrowseSentinels();
    const before = await browseTableCounts();
    expect(before.names).toEqual([
      "public_course_browse",
      "public_course_browse_departments",
      "public_course_browse_departments_staging",
      "public_course_browse_staging",
      "public_course_browse_teachers",
      "public_course_browse_teachers_staging",
      "public_course_browse_totals",
      "public_course_browse_totals_staging",
      "public_relation_browse",
      "public_relation_browse_departments",
      "public_relation_browse_departments_staging",
      "public_relation_browse_staging",
      "public_relation_browse_totals",
      "public_relation_browse_totals_staging",
    ]);
    expect([...before.counts.values()].every((count) => count === 1)).toBe(true);

    // ready 已经是 1 时，关闭开关的重建也不能把它清成 0。
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET catalog_browse_ready=1,dirty=1,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
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

    expect(await browseTableCounts()).toEqual(before);
    await expectPausedBrowseSentinels();
    const afterRebuild = await env.DB.prepare(
      "SELECT catalog_browse_ready ready FROM public_precompute_state WHERE id=1",
    ).first<{ ready: number }>();
    expect(Number(afterRebuild?.ready)).toBe(1);

    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET catalog_browse_ready=1,dirty=0,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    const listQuery = {
      page: 1,
      pageSize: 20,
      q: "",
      category: "math",
      department,
      teacherId,
      sort: "reviews" as const,
    };
    const courses = await queryPublicCourses(env.DB, listQuery);
    const legacyCourses = await queryPublicCoursesLegacy(env.DB, listQuery);
    expect(courses).toEqual(legacyCourses);
    expect(courses.total).toBe(1);
    expect(courses.items.map((item) => item.id)).toEqual([courseId]);
    expect(courses.items[0]?.review_count).toBe(1);

    const relationsQuery = { ...listQuery, sort: "rating" as const };
    const relations = await queryPublicCourseRelations(
      env.DB,
      relationsQuery,
      null,
    );
    const legacyRelations = await queryPublicCourseRelationsLegacy(
      env.DB,
      relationsQuery,
      null,
    );
    expect(relations).toEqual(legacyRelations);
    expect(relations.total).toBe(1);
    expect(relations.items[0]).toMatchObject({
      course_id: courseId,
      teacher_id: teacherId,
      review_count: 1,
      rating: 5,
    });

    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET catalog_browse_ready=0,dirty=0,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    expect(await queryPublicCourses(env.DB, listQuery)).toEqual(legacyCourses);
    expect(
      await queryPublicCourseRelations(env.DB, relationsQuery, null),
    ).toEqual(legacyRelations);
    const afterRead = await env.DB.prepare(
      "SELECT catalog_browse_ready ready,dirty FROM public_precompute_state WHERE id=1",
    ).first<{ ready: number; dirty: number }>();
    expect(Number(afterRead?.ready)).toBe(0);
    expect(Number(afterRead?.dirty)).toBe(0);
    expect(await browseTableCounts()).toEqual(before);
    await expectPausedBrowseSentinels();
  });
});

const pausedBrowseSentinel = "pause932:sentinel";

async function browseTableCounts() {
  const listed = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name GLOB 'public_*browse*'
     ORDER BY name`,
  ).all<{ name: string }>();
  const names = (listed.results ?? []).map((row) => row.name);
  const counts = new Map<string, number>();
  for (const name of names) {
    const row = await env.DB.prepare(`SELECT COUNT(*) n FROM ${name}`).first<{
      n: number;
    }>();
    counts.set(name, Number(row?.n) || 0);
  }
  return { names, counts };
}

async function insertPausedBrowseSentinels() {
  for (const table of ["public_relation_browse", "public_relation_browse_staging"]) {
    await env.DB.prepare(
      `INSERT INTO ${table}(
        public_id,code,name,category,department,teacher_id,teacher_name,
        review_count,name_sort_key,rating_missing
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(pausedBrowseSentinel, "P", "暂停", "general", "院", 1, "师", 0, "z", 1)
      .run();
  }
  for (const table of [
    "public_relation_browse_departments",
    "public_relation_browse_departments_staging",
    "public_course_browse_departments",
    "public_course_browse_departments_staging",
  ]) {
    await env.DB.prepare(
      `INSERT INTO ${table}(department, public_id) VALUES(?,?)`,
    )
      .bind("pause932", pausedBrowseSentinel)
      .run();
  }
  for (const table of [
    "public_relation_browse_totals",
    "public_relation_browse_totals_staging",
    "public_course_browse_totals",
    "public_course_browse_totals_staging",
  ]) {
    await env.DB.prepare(`INSERT INTO ${table}(category, n) VALUES(?,?)`)
      .bind("pause932", 0)
      .run();
  }
  for (const table of ["public_course_browse", "public_course_browse_staging"]) {
    await env.DB.prepare(
      `INSERT INTO ${table}(
        public_id,code,name,category,department,review_count,
        sort_name,sort_code,sort_id_missing,sort_id,is_extra
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(pausedBrowseSentinel, "P", "暂停", "general", "院", 0, "暂停", "P", 0, 0, 0)
      .run();
  }
  for (const table of [
    "public_course_browse_teachers",
    "public_course_browse_teachers_staging",
  ]) {
    await env.DB.prepare(
      `INSERT INTO ${table}(teacher_id, public_id) VALUES(?,?)`,
    )
      .bind(1, pausedBrowseSentinel)
      .run();
  }
}

async function expectPausedBrowseSentinels() {
  for (const table of [
    "public_relation_browse",
    "public_relation_browse_staging",
    "public_course_browse",
    "public_course_browse_staging",
  ]) {
    const row = await env.DB.prepare(
      `SELECT public_id FROM ${table} WHERE public_id=?`,
    )
      .bind(pausedBrowseSentinel)
      .first<{ public_id: string }>();
    expect(row?.public_id, table).toBe(pausedBrowseSentinel);
  }
  for (const table of [
    "public_relation_browse_departments",
    "public_relation_browse_departments_staging",
    "public_course_browse_departments",
    "public_course_browse_departments_staging",
    "public_course_browse_teachers",
    "public_course_browse_teachers_staging",
  ]) {
    const row = await env.DB.prepare(
      `SELECT public_id FROM ${table} WHERE public_id=?`,
    )
      .bind(pausedBrowseSentinel)
      .first<{ public_id: string }>();
    expect(row?.public_id, table).toBe(pausedBrowseSentinel);
  }
  for (const table of [
    "public_relation_browse_totals",
    "public_relation_browse_totals_staging",
    "public_course_browse_totals",
    "public_course_browse_totals_staging",
  ]) {
    const row = await env.DB.prepare(
      `SELECT category FROM ${table} WHERE category=?`,
    )
      .bind("pause932")
      .first<{ category: string }>();
    expect(row?.category, table).toBe("pause932");
  }
}

async function expectCourseParity(
  filter: { category: string; department: string; teacherId: number | null },
  sort: PublicCourseListSort,
) {
  for (const pageSize of [1, 3, 8]) {
    const legacy = await queryPublicCoursesLegacy(
      env.DB,
      courseQuery({ ...filter, sort, pageSize, page: 1 }),
    );
    const page = await queryPublicCourses(
      env.DB,
      courseQuery({ ...filter, sort, pageSize, page: 1 }),
    );
    expect(page, courseLabel(filter, sort, pageSize, 1)).toEqual(legacy);
    if (legacy.pages > 1) {
      const last = legacy.pages;
      expect(
        await queryPublicCourses(
          env.DB,
          courseQuery({ ...filter, sort, pageSize, page: last }),
        ),
        courseLabel(filter, sort, pageSize, last),
      ).toEqual(
        await queryPublicCoursesLegacy(
          env.DB,
          courseQuery({ ...filter, sort, pageSize, page: last }),
        ),
      );
    }
  }
}

async function expectRelationParity(
  filter: { category: string; department: string; teacherId: number | null },
  sort: PublicRelationListSort,
) {
  for (const pageSize of [1, 3]) {
    const query = relationQuery({ ...filter, sort, pageSize, page: 1 });
    const legacy = await queryPublicCourseRelationsLegacy(env.DB, query, null);
    const page = await queryPublicCourseRelations(env.DB, query, null);
    expect(page, relationLabel(filter, sort, pageSize, 1)).toEqual(legacy);
    if (legacy.pages > 2) {
      const middle = 2;
      const middleQuery = relationQuery({
        ...filter,
        sort,
        pageSize,
        page: middle,
      });
      expect(
        await queryPublicCourseRelations(env.DB, middleQuery, null),
        relationLabel(filter, sort, pageSize, middle),
      ).toEqual(
        await queryPublicCourseRelationsLegacy(env.DB, middleQuery, null),
      );
    }
  }
}

function courseLabel(
  filter: { category: string; department: string; teacherId: number | null },
  sort: string,
  pageSize: number,
  page: number,
) {
  return `courses ${JSON.stringify(filter)} ${sort} pageSize=${pageSize} page=${page}`;
}

function relationLabel(
  filter: { category: string; department: string; teacherId: number | null },
  sort: string,
  pageSize: number,
  page: number,
) {
  return `relations ${JSON.stringify(filter)} ${sort} pageSize=${pageSize} page=${page}`;
}

function courseQuery(input: {
  category: string;
  department: string;
  teacherId: number | null;
  sort?: PublicCourseListSort;
  page?: number;
  pageSize?: number;
  q?: string;
}): PublicCourseListQuery {
  return {
    page: input.page ?? 1,
    pageSize: input.pageSize ?? 5,
    q: input.q ?? "",
    category: input.category,
    department: input.department,
    teacherId: input.teacherId,
    sort: input.sort ?? "name",
  };
}

function relationQuery(input: {
  category: string;
  department: string;
  teacherId: number | null;
  sort?: PublicRelationListSort;
  page?: number;
  pageSize?: number;
  q?: string;
}): PublicRelationListQuery {
  return {
    page: input.page ?? 1,
    pageSize: input.pageSize ?? 5,
    q: input.q ?? "",
    category: input.category,
    department: input.department,
    teacherId: input.teacherId,
    sort: input.sort ?? "reviews",
  };
}

async function browseCounts(publicIds: string[]) {
  const counts = new Map<string, number>();
  for (const publicId of publicIds) {
    const table = publicId.startsWith("course:")
      ? "public_course_browse"
      : "public_relation_browse";
    const row = await env.DB.prepare(
      `SELECT review_count FROM ${table} WHERE public_id=?`,
    )
      .bind(publicId)
      .first<{ review_count: number }>();
    counts.set(publicId, Number(row?.review_count) || 0);
  }
  return counts;
}

async function hideBrowseTables() {
  for (const table of browseTables) {
    await env.DB.prepare(`ALTER TABLE ${table} RENAME TO ${table}_off`).run();
  }
}

async function restoreBrowseTables() {
  for (const table of browseTables) {
    await env.DB.prepare(`ALTER TABLE ${table}_off RENAME TO ${table}`).run();
  }
}

async function insertTeacher(name: string, department: string) {
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
  scheme: string;
  department: string;
  category?: "general" | "sports";
}) {
  const result = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department,scheme_key) VALUES(?,?,?,?,?)",
  )
    .bind(
      input.code,
      input.name,
      input.category ?? "general",
      input.department,
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

async function insertReview(
  courseId: number,
  teacherId: number,
  overall: number,
  label: string,
) {
  await env.DB.prepare(
    `INSERT INTO reviews(
      course_id,teacher_id,category,overall,comment,term,status,
      submitter_hash,scheme_key,scheme_version,scores,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      courseId,
      teacherId,
      "general",
      overall,
      `${label}-评价正文足够长`,
      "2026 春",
      "approved",
      `hash-${stamp}-${label}`,
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
}) {
  const mapping = buildPeSpecializationMapping({
    sourceKind: "direct_skill",
    normalizedSpecialization: input.specialization,
    evidenceKind: "catalog_course_name",
    sourceCourseCode: input.courseCode,
    sourceCourseName: input.courseName,
    sourceTeacherLabel: `${stamp}甲`,
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
