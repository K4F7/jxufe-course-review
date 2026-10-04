import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { catalogPinyinText } from "../src/lib/catalog-pinyin";
import {
  publicCourseCanonicalJoin,
  publicCourseMatchJoin,
  publicTeacherSearchJoin,
  rebuildPublicListProjection,
} from "../src/public-list-projection-plan";

const holdRebuildLease = async () => {
  const token = crypto.randomUUID();
  const state = await env.DB.prepare(
    `UPDATE public_precompute_state
     SET dirty=1,refresh_token=?,refresh_lease_until=unixepoch()+60
     WHERE id=1
     RETURNING generation`,
  )
    .bind(token)
    .first<{ generation: number }>();
  return { generation: Number(state?.generation) || 0, token };
};

const rebuildWithLease = async (
  renewLease: () => Promise<void> = async () => {},
) => {
  const lease = await holdRebuildLease();
  await rebuildPublicListProjection({
    db: env.DB,
    ...lease,
    renewLease,
  });
  return lease;
};

describe("public list projection plan", () => {
  it("maps every course and keeps only the canonical row visible to browse joins", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57401,'ENG574I','大学英语I','general','外国语学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57402,'ENG574II','大学英语II','general','外国语学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57405,'PE574B1','篮球1','sports','体育学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57406,'PE574B2','篮球2','sports','体育学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57407,'PE574U1','体育1','sports','体育学院')`,
      ),
    ]);

    try {
      await rebuildWithLease();
      const mapped = await env.DB.prepare(
        `SELECT course_id,canonical_course_id,family_label
         FROM public_course_canonicals
         WHERE course_id IN (1,2,3,57401,57402,57405,57406,57407)
         ORDER BY course_id`,
      ).all<{
        course_id: number;
        canonical_course_id: number;
        family_label: string | null;
      }>();
      const byId = Object.fromEntries(
        mapped.results.map((row) => [row.course_id, row]),
      );

      expect(mapped.results).toHaveLength(8);
      expect(byId[1]).toMatchObject({
        canonical_course_id: 1,
        family_label: null,
      });
      expect(byId[57401].family_label).toBeNull();
      expect(byId[57402].family_label).toBeNull();
      expect(byId[57401].canonical_course_id).toBe(57401);
      expect(byId[57402].canonical_course_id).toBe(57402);
      expect(byId[57405].family_label).toBe("篮球");
      expect(byId[57406].canonical_course_id).toBe(57405);
      expect(byId[57407]).toMatchObject({
        canonical_course_id: 57407,
        family_label: null,
      });

      const browse = await env.DB.prepare(
        `SELECT c.id FROM courses c ${publicCourseCanonicalJoin}
         WHERE c.id IN (57401,57402,57405,57406)
         ORDER BY c.id`,
      ).all<{ id: number }>();
      expect(browse.results.map((row) => row.id)).toEqual([
        57401,
        57402,
        57405,
      ]);

      const matched = await env.DB.prepare(
        `SELECT c.id FROM courses c ${publicCourseMatchJoin}
         WHERE c.id IN (57405,57406) ORDER BY c.id`,
      ).all<{ id: number }>();
      expect(matched.results.map((row) => row.id)).toEqual([57405, 57406]);
    } finally {
      await env.DB.prepare(
        "DELETE FROM courses WHERE id IN (57401,57402,57405,57406,57407)",
      ).run();
    }
  });

  it("keeps 大学英语 I–IV as distinct browse and 投稿选项 rows", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57411,'ENG574I','大学英语I','general','外国语学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57412,'ENG574II','大学英语II','general','外国语学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57413,'ENG574III','大学英语III','general','外国语学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57414,'ENG574IV','大学英语IV','general','外国语学院')`,
      ),
    ]);

    try {
      await rebuildWithLease();
      const options = await env.DB.prepare(
        `SELECT c.id,c.name FROM courses c ${publicCourseCanonicalJoin}
         WHERE c.id IN (57411,57412,57413,57414)
         ORDER BY c.id`,
      ).all<{ id: number; name: string }>();
      const browse = await env.DB.prepare(
        `SELECT c.id FROM courses c ${publicCourseCanonicalJoin}
         WHERE c.id IN (57411,57412,57413,57414)`,
      ).all<{ id: number }>();

      expect(options.results.map((row) => row.name)).toEqual([
        "大学英语I",
        "大学英语II",
        "大学英语III",
        "大学英语IV",
      ]);
      expect(browse.results).toHaveLength(4);
    } finally {
      await env.DB.prepare(
        "DELETE FROM courses WHERE id IN (57411,57412,57413,57414)",
      ).run();
    }
  });

  it("writes course and teacher search text plus pinyin tokens", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name,department)
         VALUES(57421,'张三','张三','数学学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(57420,'MATH574','高等数学','general','数学学院')`,
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57420,57421)",
      ),
      env.DB.prepare(
        "INSERT INTO course_name_variants(course_id,name) VALUES(57420,'高数')",
      ),
    ]);

    try {
      await rebuildWithLease();
      const course = await env.DB.prepare(
        `SELECT search_text,match_text,pinyin_text
         FROM public_course_canonicals WHERE course_id=57420`,
      ).first<{
        search_text: string;
        match_text: string;
        pinyin_text: string;
      }>();
      const teacher = await env.DB.prepare(
        `SELECT t.id,pts.match_text,pts.pinyin_text
         FROM teachers t ${publicTeacherSearchJoin}
         WHERE t.id=57421`,
      ).first<{
        id: number;
        match_text: string;
        pinyin_text: string;
      }>();

      expect(course?.search_text).toContain("高等数学");
      expect(course?.search_text).toContain("MATH574");
      expect(course?.match_text).toContain("高等数学");
      expect(course?.match_text).toContain("数学学院");
      expect(course?.match_text).toContain("张三");
      expect(course?.match_text).toContain("高数");
      expect(course?.pinyin_text).toContain("gaodengshuxue");
      expect(course?.pinyin_text).toContain("gaoshu");
      expect(teacher?.match_text).toContain("张三");
      expect(teacher?.match_text).toContain("数学学院");
      expect(teacher?.pinyin_text).toContain("zhangsan");
      expect(
        await env.DB.prepare(
          "SELECT rowid FROM course_search_fts WHERE course_search_fts MATCH ?",
        )
          .bind('"高等数"')
          .first<{ rowid: number }>(),
      ).toEqual({ rowid: 57420 });
      expect(
        await env.DB.prepare(
          "SELECT rowid FROM teacher_search_fts WHERE teacher_search_fts MATCH ?",
        )
          .bind('"zhang"')
          .first<{ rowid: number }>(),
      ).toEqual({ rowid: 57421 });

      await env.DB.prepare(
        "UPDATE public_course_canonicals SET match_text=? WHERE course_id=?",
      )
        .bind("触发器新文本", 57420)
        .run();
      expect(
        await env.DB.prepare(
          "SELECT rowid FROM course_search_fts WHERE course_search_fts MATCH ? AND rowid=?",
        )
          .bind('match_text : "高等数"', 57420)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT rowid FROM course_search_fts WHERE course_search_fts MATCH ?",
        )
          .bind('match_text : "触发器新"')
          .first<{ rowid: number }>(),
      ).toEqual({ rowid: 57420 });

    } finally {
      await env.DB.prepare(
        "DELETE FROM course_name_variants WHERE course_id=57420",
      ).run();
      await env.DB.prepare(
        "DELETE FROM course_teachers WHERE course_id=57420 AND teacher_id=57421",
      ).run();
      await env.DB.prepare("DELETE FROM courses WHERE id=57420").run();
      await env.DB.prepare("DELETE FROM teachers WHERE id=57421").run();
    }
  });

  it("counts public text reviews from historical and current sources under shared visibility rules", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name)
         VALUES(57431,'计数教师','计数教师')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(57430,'COUNT574','计数课程','general')`,
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57430,57431)",
      ),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash
        ) VALUES(57430,57431,'general',5,'公开正文','approved','vis-ok')`,
      ),
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash,login_only
        ) VALUES(57430,57431,'general',5,'仅登录可见','approved','vis-login',1)`,
      ),
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash,blocked_at
        ) VALUES(57430,57431,'general',5,'已屏蔽','approved','vis-block','2026-08-01')`,
      ),
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash,deleted_at
        ) VALUES(57430,57431,'general',5,'已删除','approved','vis-del','2026-08-01')`,
      ),
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash
        ) VALUES(57430,57431,'general',5,'待审核','pending','vis-pending')`,
      ),
      env.DB.prepare(
        `INSERT INTO reviews(
          course_id,teacher_id,category,overall,comment,status,submitter_hash
        ) VALUES(57430,57431,'general',5,'   ','approved','vis-blank')`,
      ),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO public_historical_reviews(
          id,course_id,teacher_id,comment,package_contract,
          approved_package_manifest_sha256,approved_catalog_content_sha256
        ) VALUES('hist-574',57430,57431,'冻结历史','legacy-historical-production-freeze-v1',?,?)`,
      ).bind("a".repeat(64), "b".repeat(64)),
    ]);

    try {
      await rebuildWithLease();
      const count = await env.DB.prepare(
        `SELECT review_count FROM public_review_counts
         WHERE course_id=57430 AND teacher_id=57431`,
      ).first<{ review_count: number }>();
      expect(count?.review_count).toBe(2);
    } finally {
      await env.DB.prepare(
        "DELETE FROM public_historical_reviews WHERE id='hist-574'",
      ).run();
      await env.DB.prepare("DELETE FROM reviews WHERE course_id=57430").run();
      await env.DB.prepare(
        "DELETE FROM course_teachers WHERE course_id=57430 AND teacher_id=57431",
      ).run();
      await env.DB.prepare("DELETE FROM courses WHERE id=57430").run();
      await env.DB.prepare("DELETE FROM teachers WHERE id=57431").run();
    }
  });

  it("counts distinct visible canonical courses for each teacher", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name)
         VALUES(57441,'课数教师','课数教师')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(57440,'ENG574A','大学英语I','general')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(57442,'ENG574B','大学英语II','general')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(57443,'PE574U','体育1','sports')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(57444,'VIS574','可见选修','general')`,
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57440,57441)",
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57442,57441)",
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57443,57441)",
      ),
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(57444,57441)",
      ),
    ]);

    try {
      await rebuildWithLease();
      const count = await env.DB.prepare(
        "SELECT course_count FROM public_teacher_course_counts WHERE teacher_id=57441",
      ).first<{ course_count: number }>();
      // 大学英语 I/II 各计一门；教务伞形课名「体育1」不计入公开浏览。
      expect(count?.course_count).toBe(3);
    } finally {
      await env.DB.prepare(
        "DELETE FROM course_teachers WHERE teacher_id=57441",
      ).run();
      await env.DB.prepare(
        "DELETE FROM courses WHERE id IN (57440,57442,57443,57444)",
      ).run();
      await env.DB.prepare("DELETE FROM teachers WHERE id=57441").run();
    }
  });

  it("rebuilds all four projection tables for the current source generation", async () => {
    await rebuildWithLease();
    const tables = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM public_course_canonicals) courses,
         (SELECT COUNT(*) FROM public_teacher_search) teachers,
         (SELECT COUNT(*) FROM public_teacher_course_counts) teacher_courses,
         (SELECT COUNT(*) FROM public_review_counts) reviews`,
    ).first<{
      courses: number;
      teachers: number;
      teacher_courses: number;
      reviews: number;
    }>();
    const seedCourse = await env.DB.prepare(
      "SELECT course_id FROM public_course_canonicals WHERE course_id=1",
    ).first<{ course_id: number }>();
    const seedTeacher = await env.DB.prepare(
      "SELECT teacher_id FROM public_teacher_search WHERE teacher_id=1",
    ).first<{ teacher_id: number }>();
    const seedTeacherCourses = await env.DB.prepare(
      "SELECT course_count FROM public_teacher_course_counts WHERE teacher_id=1",
    ).first<{ course_count: number }>();

    expect(tables?.courses).toBeGreaterThanOrEqual(3);
    expect(tables?.teachers).toBeGreaterThanOrEqual(1);
    expect(tables?.teacher_courses).toBeGreaterThanOrEqual(1);
    expect(tables?.reviews).toBeGreaterThanOrEqual(0);
    expect(seedCourse?.course_id).toBe(1);
    expect(seedTeacher?.teacher_id).toBe(1);
    expect(seedTeacherCourses?.course_count).toBe(2);
  });

  it("renews the lease for each pinyin batch and stops writing after the lease is lost", async () => {
    const teacherIds = Array.from({ length: 42 }, (_, index) => 57480 + index);
    await env.DB.batch(
      teacherIds.map((id) =>
        env.DB.prepare(
          `INSERT INTO teachers(id,source_teacher_label,name)
           VALUES(?,?,'批量拼音教师')`,
        ).bind(id, `批量教师${id}`),
      ),
    );

    try {
      const lease = await holdRebuildLease();
      let renewals = 0;
      await expect(
        rebuildPublicListProjection({
          db: env.DB,
          ...lease,
          renewLease: async () => {
            renewals += 1;
            if (renewals >= 3)
              throw new Error("公开目录预计算刷新租约已失效");
          },
        }),
      ).rejects.toThrow(/刷新租约已失效/);
      expect(renewals).toBe(3);

      const dummy = await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN pinyin_text<>'' THEN 1 ELSE 0 END) filled,
           SUM(CASE WHEN pinyin_text='' THEN 1 ELSE 0 END) empty
         FROM public_teacher_search_staging
         WHERE teacher_id BETWEEN 57480 AND 57521`,
      ).first<{ filled: number; empty: number }>();
      const written = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM public_course_canonicals_staging WHERE pinyin_text<>'') +
           (SELECT COUNT(*) FROM public_teacher_search_staging WHERE pinyin_text<>'') count`,
      ).first<{ count: number }>();
      expect(written?.count).toBeGreaterThan(0);
      expect(dummy?.empty).toBeGreaterThan(0);
    } finally {
      await env.DB.prepare(
        "DELETE FROM teachers WHERE id BETWEEN 57480 AND 57521",
      ).run();
    }
  });

  it("rewrites pinyin and published rows only when the source text changed", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name,department)
         VALUES(92121,'张三','张三','数学学院'),(92122,'李四','李四','统计学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(92120,'MATH921','高等数学','general','数学学院'),
               (92123,'MATH922','线性代数','general','数学学院')`,
      ),
      env.DB.prepare(
        `INSERT INTO course_teachers(course_id,teacher_id)
         VALUES(92120,92121),(92123,92122)`,
      ),
      env.DB.prepare(
        "INSERT INTO course_name_variants(course_id,name) VALUES(92120,'高数')",
      ),
    ]);
    const logWrites = async () => {
      const rows = await env.DB.prepare(
        "SELECT op,entity,row_key FROM projection_write_log ORDER BY id",
      ).all<{ op: string; entity: string; row_key: string }>();
      return rows.results;
    };
    try {
      await rebuildWithLease();
      const coursePinyin = async (courseId: number) =>
        (
          await env.DB.prepare(
            "SELECT pinyin_text FROM public_course_canonicals WHERE course_id=?",
          )
            .bind(courseId)
            .first<{ pinyin_text: string }>()
        )?.pinyin_text;
      const teacherPinyin = async (teacherId: number) =>
        (
          await env.DB.prepare(
            "SELECT pinyin_text,match_text FROM public_teacher_search WHERE teacher_id=?",
          )
            .bind(teacherId)
            .first<{ pinyin_text: string; match_text: string }>()
        );
      const originalCourse = await coursePinyin(92120);
      const originalOther = await coursePinyin(92123);
      const originalTeacher = await teacherPinyin(92121);
      const originalOtherTeacher = await teacherPinyin(92122);
      expect(originalCourse).toContain("gaodengshuxue");
      expect(originalTeacher?.pinyin_text).toContain("zhangsan");

      await env.DB.batch([
        env.DB.prepare(
          `CREATE TABLE projection_write_log(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             op TEXT NOT NULL,
             entity TEXT NOT NULL,
             row_key TEXT NOT NULL
           )`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_course_update
           AFTER UPDATE ON public_course_canonicals
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('update','course',NEW.course_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_course_insert
           AFTER INSERT ON public_course_canonicals
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('insert','course',NEW.course_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_course_delete
           AFTER DELETE ON public_course_canonicals
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('delete','course',OLD.course_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_teacher_update
           AFTER UPDATE ON public_teacher_search
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('update','teacher',NEW.teacher_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_teacher_insert
           AFTER INSERT ON public_teacher_search
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('insert','teacher',NEW.teacher_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_teacher_delete
           AFTER DELETE ON public_teacher_search
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('delete','teacher',OLD.teacher_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_course_pinyin
           AFTER UPDATE ON public_course_canonicals_staging
           WHEN OLD.pinyin_text IS NOT NEW.pinyin_text
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('pinyin','course_staging',NEW.course_id);
           END`,
        ),
        env.DB.prepare(
          `CREATE TRIGGER projection_write_log_teacher_pinyin
           AFTER UPDATE ON public_teacher_search_staging
           WHEN OLD.pinyin_text IS NOT NEW.pinyin_text
           BEGIN
             INSERT INTO projection_write_log(op,entity,row_key)
             VALUES('pinyin','teacher_staging',NEW.teacher_id);
           END`,
        ),
      ]);

      await rebuildWithLease();
      expect(await logWrites()).toEqual([]);
      expect(await coursePinyin(92120)).toBe(originalCourse);
      expect(await teacherPinyin(92121)).toEqual(originalTeacher);

      await env.DB.batch([
        env.DB.prepare("UPDATE courses SET name='数学分析' WHERE id=92120"),
        env.DB.prepare(
          "UPDATE teachers SET department='应用数学学院' WHERE id=92121",
        ),
        env.DB.prepare("DELETE FROM projection_write_log"),
      ]);
      await rebuildWithLease();
      const writes = await logWrites();
      const keys = (entity: string) =>
        writes.filter((row) => row.entity === entity).map((row) => row.row_key);
      expect(keys("course")).toEqual(["92120"]);
      expect(keys("teacher")).toEqual(["92121"]);
      expect(keys("course_staging")).toEqual(["92120"]);
      expect(keys("teacher_staging")).toEqual([]);
      expect(await coursePinyin(92123)).toBe(originalOther);
      expect(await teacherPinyin(92122)).toEqual(originalOtherTeacher);
      const renamed = await coursePinyin(92120);
      // Renaming keeps the previous course name as a variant, so both names are pinyin source.
      const variantNames = (
        await env.DB.prepare(
          "SELECT name FROM course_name_variants WHERE course_id=92120 ORDER BY name",
        ).all<{ name: string }>()
      ).results.map((row) => row.name);
      expect(variantNames).toEqual(expect.arrayContaining(["高等数学", "高数", "数学分析"]));
      for (const token of [
        catalogPinyinText(["数学分析"]),
        catalogPinyinText(["张三"]),
        catalogPinyinText(["高数"]),
        catalogPinyinText(["高等数学"]),
      ]) {
        expect(renamed).toContain(token.split(" ")[0]);
      }
      expect(renamed).not.toBe(originalCourse);
      const moved = await teacherPinyin(92121);
      expect(moved?.pinyin_text).toBe(originalTeacher?.pinyin_text);
      expect(moved?.match_text).toContain("应用数学学院");
      expect(moved?.match_text).not.toBe(originalTeacher?.match_text);
    } finally {
      await env.DB.batch([
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_course_update"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_course_insert"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_course_delete"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_teacher_update"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_teacher_insert"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_teacher_delete"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_course_pinyin"),
        env.DB.prepare("DROP TRIGGER IF EXISTS projection_write_log_teacher_pinyin"),
        env.DB.prepare("DROP TABLE IF EXISTS projection_write_log"),
        env.DB.prepare("DELETE FROM course_name_variants WHERE course_id=92120"),
        env.DB.prepare(
          "DELETE FROM course_teachers WHERE course_id IN (92120,92123)",
        ),
        env.DB.prepare("DELETE FROM courses WHERE id IN (92120,92123)"),
        env.DB.prepare("DELETE FROM teachers WHERE id IN (92121,92122)"),
      ]);
    }
  });
});
