import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensurePublicListPrecomputes,
  refreshPublicListPrecomputes,
  shouldRefreshPublicListPrecomputes,
} from "../src/public-list-precompute";

const databaseWithBatch = (
  batch: (
    statements: D1PreparedStatement[],
  ) => Promise<D1Result<unknown>[]>,
) =>
  new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") return batch;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;

describe("public list refresh coordination", () => {
  it.each([
    ["POST", "/api/admin/catalog-relation-additions"],
    ["POST", "/api/admin/import/relations"],
    ["POST", "/api/admin/import/course-plan-attributes"],
    ["POST", "/api/admin/historical-review-v5-imports"],
    ["POST", "/api/admin/offerings"],
    ["DELETE", "/api/admin/offerings/42"],
    ["POST", "/api/admin/courses"],
    ["DELETE", "/api/admin/courses/42"],
    ["POST", "/api/admin/teachers"],
    ["POST", "/api/admin/cta-sync"],
    ["DELETE", "/api/admin/teachers/42"],
    ["PUT", "/api/admin/courses/42/teachers"],
    ["POST", "/api/admin/catalog-baseline/uploads/batch-42/publish"],
    ["POST", "/api/admin/pe-specialization-queue/dispositions"],
    ["PATCH", "/api/admin/pe-specialization-queue/dispositions"],
    ["POST", "/api/admin/pe-specialization-queue/closeout"],
  ])("refreshes after %s %s", (method, path) => {
    expect(shouldRefreshPublicListPrecomputes(method, path)).toBe(true);
  });

  it.each([
    ["POST", "/api/admin/student-bindings"],
    ["POST", "/api/admin/logout"],
    ["POST", "/api/admin/sessions/revoke-others"],
    ["PUT", "/api/reviews/42/endorsement"],
    ["DELETE", "/api/reviews/42/endorsement"],
    ["PUT", "/api/reviews/42/challenge"],
    ["DELETE", "/api/reviews/42/challenge"],
    ["POST", "/api/catalog-requests"],
    ["POST", "/api/admin/catalog-relation-additions/preview"],
    ["POST", "/api/reviews"],
    ["PATCH", "/api/admin/catalog-requests/42"],
    ["PATCH", "/api/admin/reviews/42"],
    ["PATCH", "/api/admin/reviews/42/content"],
    ["POST", "/api/admin/catalog-baseline/uploads"],
    ["PUT", "/api/admin/catalog-baseline/uploads/batch-42/chunks/0"],
    ["POST", "/api/admin/catalog-baseline/uploads/batch-42/finalize"],
    ["GET", "/api/admin/pe-specialization-queue"],
    ["GET", "/api/courses"],
    ["POST", "/api/admin/import/program-plan"],
    ["GET", "/api/program-plan"],
  ])("does not refresh after %s %s", (method, path) => {
    expect(shouldRefreshPublicListPrecomputes(method, path)).toBe(false);
  });
});

describe("public list query shape", () => {
  it("reads list and detail counts from a hot precomputed projection", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    const originalState = await env.DB.prepare(
      "SELECT fingerprint FROM public_precompute_state WHERE id=1",
    ).first<{ fingerprint: string }>();
    await env.DB.prepare(
      `INSERT INTO public_review_counts(course_id,teacher_id,review_count)
       VALUES(1,1,777)
       ON CONFLICT(course_id,teacher_id) DO UPDATE SET review_count=excluded.review_count`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO public_teacher_course_counts(teacher_id,course_count)
       VALUES(1,888)
       ON CONFLICT(teacher_id) DO UPDATE SET course_count=excluded.course_count`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO public_teacher_review_counts(teacher_id,review_count,name,department)
       VALUES(1,777,'测试教师','测试学院')
       ON CONFLICT(teacher_id) DO UPDATE SET review_count=excluded.review_count`,
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE public_course_canonicals
         SET match_text=match_text || ' issue355projection'
         WHERE course_id=1`,
      ),
      env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=0,fingerprint='issue-355-stale' WHERE id=1`,
      ),
    ]);

    try {
      const courseList = await SELF.fetch(
        "https://example.com/api/courses?q=TEST101",
      ).then((response) =>
        response.json<{ items: Array<{ id: number; review_count: number }> }>(),
      );
      const teacherList = await SELF.fetch(
        `https://example.com/api/teachers?q=${encodeURIComponent("测试教师")}`,
      ).then((response) =>
        response.json<{
          items: Array<{ id: number; review_count: number; course_count: number }>;
        }>(),
      );
      const courseDetail = await SELF.fetch(
        "https://example.com/api/courses/1",
      ).then((response) =>
        response.json<{
          reviewCount: number;
          course: { teachers: Array<{ id: number; review_count: number }> };
        }>(),
      );
      const teacherDetail = await SELF.fetch(
        "https://example.com/api/teachers/1",
      ).then((response) =>
        response.json<{
          reviewCount: number;
          teacher: { review_count: number; course_count: number };
          courses: Array<{ id: number; review_count: number }>;
        }>(),
      );
      const options = await SELF.fetch(
        "https://example.com/api/courses/options?q=issue355projection",
      ).then((response) =>
        response.json<{ items: Array<{ id: number }> }>(),
      );
      const state = await env.DB.prepare(
        "SELECT dirty,fingerprint FROM public_precompute_state WHERE id=1",
      ).first<{ dirty: number; fingerprint: string }>();

      expect(courseList.items.find((item) => item.id === 1)?.review_count).toBe(777);
      expect(teacherList.items.find((item) => item.id === 1)?.review_count).toBe(777);
      expect(teacherList.items.find((item) => item.id === 1)?.course_count).toBe(888);
      expect(courseDetail.reviewCount).toBe(777);
      expect(
        courseDetail.course.teachers.find((teacher) => teacher.id === 1)
          ?.review_count,
      ).toBe(777);
      expect(teacherDetail.reviewCount).toBe(777);
      expect(teacherDetail.teacher).toMatchObject({
        review_count: 777,
        course_count: 888,
      });
      expect(
        teacherDetail.courses.find((course) => course.id === 1)?.review_count,
      ).toBe(777);
      expect(options.items.some((item) => item.id === 1)).toBe(true);
      expect(state).toEqual({ dirty: 0, fingerprint: "issue-355-stale" });
    } finally {
      await env.DB.prepare("UPDATE public_precompute_state SET dirty=1 WHERE id=1").run();
      await SELF.fetch("https://example.com/api/courses?q=TEST101");
      await env.DB.prepare(
        "UPDATE public_precompute_state SET fingerprint=? WHERE id=1",
      )
        .bind(originalState?.fingerprint || "")
        .run();
    }
  });
});

describe("public list refresh coordination", () => {
  it("publishes clean projections only after the source generation stays stable", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    const before = await env.DB.prepare(
      "SELECT generation FROM public_precompute_state WHERE id=1",
    ).first<{ generation: number }>();
    await env.DB.prepare(`
      CREATE TRIGGER issue355_write_during_pinyin
      AFTER UPDATE OF pinyin_text ON public_course_canonicals_staging
      WHEN NEW.course_id=1
       AND (SELECT dirty FROM public_precompute_state WHERE id=1)=1
       AND NOT EXISTS(
         SELECT 1 FROM course_name_variants
         WHERE course_id=1 AND name='并发刷新别名'
       )
      BEGIN
        INSERT INTO course_name_variants(course_id,name)
        VALUES(1,'并发刷新别名');
      END;
    `).run();
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=1 WHERE id=1",
    ).run();

    try {
      await refreshPublicListPrecomputes(env.DB);
      const state = await env.DB.prepare(
        "SELECT dirty,generation FROM public_precompute_state WHERE id=1",
      ).first<{
        dirty: number;
        generation: number;
      }>();
      const projection = await env.DB.prepare(
        "SELECT match_text FROM public_course_canonicals WHERE course_id=1",
      ).first<{ match_text: string }>();

      expect(state?.dirty).toBe(0);
      expect(state?.generation).toBeGreaterThan(before?.generation ?? -1);
      expect(projection?.match_text).toContain("并发刷新别名");
    } finally {
      await env.DB.exec("DROP TRIGGER IF EXISTS issue355_write_during_pinyin;");
      await env.DB.prepare(
        "DELETE FROM course_name_variants WHERE course_id=1 AND name='并发刷新别名'",
      ).run();
      await env.DB.prepare(
        "UPDATE public_precompute_state SET dirty=1 WHERE id=1",
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("serializes independent refresh coordinators with a database lease", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();

    let openFirstBatch!: () => void;
    let firstBatchReached!: () => void;
    const firstBatchGate = new Promise<void>((resolve) => {
      openFirstBatch = resolve;
    });
    const firstBatchStarted = new Promise<void>((resolve) => {
      firstBatchReached = resolve;
    });
    let gateFirstBatch = true;
    let secondBatchCalls = 0;
    const databaseA = databaseWithBatch(async (statements) => {
      if (gateFirstBatch) {
        gateFirstBatch = false;
        firstBatchReached();
        await firstBatchGate;
      }
      return env.DB.batch(statements);
    });
    const databaseB = databaseWithBatch(async (statements) => {
      secondBatchCalls += 1;
      return env.DB.batch(statements);
    });

    const firstRefresh = refreshPublicListPrecomputes(databaseA);
    await firstBatchStarted;
    const secondRefresh = refreshPublicListPrecomputes(databaseB);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15_250));
      expect(secondBatchCalls).toBe(0);
      openFirstBatch();
      await firstRefresh;
      await secondRefresh;
    } finally {
      openFirstBatch();
      await Promise.allSettled([firstRefresh, secondRefresh]);
    }
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    const state = await env.DB.prepare(
      `SELECT dirty,refresh_token,refresh_lease_until
       FROM public_precompute_state WHERE id=1`,
    ).first<{
      dirty: number;
      refresh_token: string | null;
      refresh_lease_until: number | null;
    }>();
    const missingPinyin = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM public_course_canonicals WHERE pinyin_text IS NULL) +
         (SELECT COUNT(*) FROM public_teacher_search WHERE pinyin_text IS NULL) count`,
    ).first<{ count: number }>();
    expect(state).toEqual({
      dirty: 0,
      refresh_token: null,
      refresh_lease_until: null,
    });
    expect(missingPinyin?.count).toBe(0);
  }, 30_000);

  it("bounds repeated refresh lease acquisition races", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    let acquireAttempts = 0;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) => {
            if (query.includes("SET refresh_token=?,refresh_lease_until"))
              return {
                bind: () => ({
                  run: async () => {
                    acquireAttempts += 1;
                    return { results: [] };
                  },
                }),
              } as unknown as D1PreparedStatement;
            return target.prepare(query);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    try {
      await expect(refreshPublicListPrecomputes(database)).rejects.toThrow(
        /刷新租约获取失败/,
      );
      expect(acquireAttempts).toBe(5);
    } finally {
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("keeps the original refresh error when dirty-state cleanup also fails", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=1 WHERE id=1",
    ).run();
    await env.DB.prepare(`
      CREATE TRIGGER issue355_fail_pinyin_refresh
      BEFORE UPDATE OF pinyin_text ON public_course_canonicals_staging
      WHEN NEW.course_id=1
      BEGIN
        SELECT RAISE(ABORT,'issue355 pinyin refresh failure');
      END;
    `).run();
    await env.DB.prepare(`
      CREATE TRIGGER issue355_fail_dirty_cleanup
      BEFORE UPDATE ON public_precompute_state
      WHEN NEW.dirty=1
       AND OLD.refresh_token IS NOT NULL
       AND NEW.refresh_token IS NULL
      BEGIN
        SELECT RAISE(ABORT,'issue355 dirty cleanup failure');
      END;
    `).run();

    try {
      await expect(refreshPublicListPrecomputes(env.DB)).rejects.toThrow(
        /issue355 pinyin refresh failure/,
      );
      const failed = await env.DB.prepare(
        `SELECT dirty,refresh_token,refresh_lease_until
         FROM public_precompute_state WHERE id=1`,
      ).first<{
        dirty: number;
        refresh_token: string | null;
        refresh_lease_until: number | null;
      }>();
      expect(failed?.dirty).toBe(1);
      expect(failed?.refresh_token).not.toBeNull();
    } finally {
      await env.DB.exec(`
        DROP TRIGGER IF EXISTS issue355_fail_dirty_cleanup;
        DROP TRIGGER IF EXISTS issue355_fail_pinyin_refresh;
      `);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });
});

describe("public list query shape", () => {
  it("reads course-row visibility from the precomputed canonical mapping", async () => {
    await SELF.fetch("https://example.com/api/courses?q=TEST101");
    await env.DB.prepare(
      "UPDATE public_course_canonicals SET canonical_course_id=2 WHERE course_id=1",
    ).run();

    try {
      const list = await SELF.fetch(
        "https://example.com/api/courses?q=TEST101",
      ).then((response) => response.json<{ items: Array<{ id: number }> }>());
      expect(list.items.some((item) => item.id === 1)).toBe(false);
    } finally {
      await env.DB.prepare("UPDATE public_precompute_state SET dirty=1 WHERE id=1").run();
      await SELF.fetch("https://example.com/api/courses?q=TEST101");
    }
  });

  it("uses the canonical projection for course options and departments", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(355101,'CANON355A','映射前课程','general','映射前院系')`,
      ),
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(355102,'CANON355B','映射后课程','general','映射后院系')`,
      ),
    ]);
    await SELF.fetch("https://example.com/api/courses?q=CANON355A");
    await env.DB.prepare(
      `UPDATE public_course_canonicals
       SET canonical_course_id=355102 WHERE course_id=355101`,
    ).run();

    try {
      const options = await SELF.fetch(
        "https://example.com/api/courses/options?q=CANON355A",
      ).then((response) =>
        response.json<{ items: Array<{ id: number }> }>(),
      );
      const departments = await SELF.fetch(
        "https://example.com/api/courses/departments",
      ).then((response) => response.json<{ items: string[] }>());

      expect(options.items.some((item) => item.id === 355101)).toBe(false);
      expect(departments.items).not.toContain("映射前院系");
      expect(departments.items).toContain("映射后院系");
    } finally {
      await env.DB.prepare(
        "DELETE FROM courses WHERE id IN (355101,355102)",
      ).run();
      await SELF.fetch("https://example.com/api/courses?q=CANON355A");
    }
  });
});

describe("public list refresh coordination", () => {
  it("leaves a clean projection untouched and rebuilds only when dirty", async () => {
    await refreshPublicListPrecomputes(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO public_review_counts(course_id,teacher_id,review_count)
         VALUES(1,1,321)
         ON CONFLICT(course_id,teacher_id) DO UPDATE SET review_count=excluded.review_count`,
      ),
      env.DB.prepare(
        "UPDATE public_precompute_state SET dirty=0 WHERE id=1",
      ),
    ]);

    await refreshPublicListPrecomputes(env.DB);
    await ensurePublicListPrecomputes(env.DB);
    const clean = await env.DB.prepare(
      "SELECT review_count FROM public_review_counts WHERE course_id=1 AND teacher_id=1",
    ).first<{ review_count: number }>();
    expect(clean?.review_count).toBe(321);

    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=1 WHERE id=1",
    ).run();
    await ensurePublicListPrecomputes(env.DB);
    const rebuilt = await env.DB.prepare(
      "SELECT dirty,refresh_token,refresh_lease_until FROM public_precompute_state WHERE id=1",
    ).first<{
      dirty: number;
      refresh_token: string | null;
      refresh_lease_until: number | null;
    }>();
    const after = await env.DB.prepare(
      "SELECT review_count FROM public_review_counts WHERE course_id=1 AND teacher_id=1",
    ).first<{ review_count: number }>();
    expect(rebuilt).toEqual({
      dirty: 0,
      refresh_token: null,
      refresh_lease_until: null,
    });
    expect(after?.review_count ?? 0).not.toBe(321);
  });

  it("single-flights concurrent refresh calls on the same D1 object", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    let batchStarts = 0;
    let releaseBatch!: () => void;
    let firstBatchReached!: () => void;
    const holdBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const firstBatchStarted = new Promise<void>((resolve) => {
      firstBatchReached = resolve;
    });
    const database = databaseWithBatch(async (statements) => {
      batchStarts += 1;
      if (batchStarts === 1) {
        firstBatchReached();
        await holdBatch;
      }
      return env.DB.batch(statements);
    });

    const first = refreshPublicListPrecomputes(database);
    try {
      await firstBatchStarted;
      const second = refreshPublicListPrecomputes(database);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(batchStarts).toBe(1);
      releaseBatch();
      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      releaseBatch();
      await Promise.allSettled([first]);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("waits on a live foreign lease and takes over after it expires", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,refresh_token='held-by-other',refresh_lease_until=unixepoch()+60
       WHERE id=1`,
    ).run();

    let batchCalls = 0;
    const waitingDb = databaseWithBatch(async (statements) => {
      batchCalls += 1;
      return env.DB.batch(statements);
    });
    const waiting = refreshPublicListPrecomputes(waitingDb);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(batchCalls).toBe(0);

      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=0,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await waiting;
      expect(batchCalls).toBe(0);

      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token='expired-lease',refresh_lease_until=unixepoch()-1
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
      const takenOver = await env.DB.prepare(
        `SELECT dirty,refresh_token,refresh_lease_until
         FROM public_precompute_state WHERE id=1`,
      ).first<{
        dirty: number;
        refresh_token: string | null;
        refresh_lease_until: number | null;
      }>();
      expect(takenOver).toEqual({
        dirty: 0,
        refresh_token: null,
        refresh_lease_until: null,
      });
    } finally {
      await Promise.allSettled([waiting]);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  }, 15_000);

  it("retries the rebuild after the refresh lease is lost mid-flight", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    await env.DB.prepare(
      "CREATE TABLE issue574_lease_lost(id INTEGER PRIMARY KEY)",
    ).run();
    await env.DB.prepare(`
      CREATE TRIGGER issue574_lose_lease_after_projection
      AFTER INSERT ON public_teacher_search
      WHEN NOT EXISTS(SELECT 1 FROM issue574_lease_lost)
      BEGIN
        INSERT INTO issue574_lease_lost(id) VALUES(1);
        UPDATE public_precompute_state
           SET refresh_lease_until=unixepoch()-1
         WHERE id=1 AND refresh_token IS NOT NULL;
      END;
    `).run();
    try {
      await refreshPublicListPrecomputes(env.DB);
      const state = await env.DB.prepare(
        `SELECT dirty,refresh_token,refresh_lease_until
         FROM public_precompute_state WHERE id=1`,
      ).first<{
        dirty: number;
        refresh_token: string | null;
        refresh_lease_until: number | null;
      }>();
      expect(state).toEqual({
        dirty: 0,
        refresh_token: null,
        refresh_lease_until: null,
      });
    } finally {
      await env.DB.exec(`
        DROP TRIGGER IF EXISTS issue574_lose_lease_after_projection;
        DROP TABLE IF EXISTS issue574_lease_lost;
      `);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("reports a dirty projection inside the stale window without rebuilding it first", async () => {
    await refreshPublicListPrecomputes(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO public_review_counts(course_id,teacher_id,review_count)
         VALUES(1,1,9153600)
         ON CONFLICT(course_id,teacher_id) DO UPDATE SET review_count=excluded.review_count`,
      ),
      env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,
             published_generation=CASE
               WHEN published_generation < 0 THEN 0
               ELSE published_generation
             END,
             published_at=unixepoch(),
             refresh_token=NULL,
             refresh_lease_until=NULL
         WHERE id=1`,
      ),
    ]);
    let releaseBatch!: () => void;
    const holdBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let batches = 0;
    const database = databaseWithBatch(async (statements) => {
      batches += 1;
      if (batches === 1) await holdBatch;
      return env.DB.batch(statements);
    });
    const pending: Promise<void>[] = [];
    let stale = false;
    const reading = ensurePublicListPrecomputes(database, {
      mode: "stale",
      waitUntil: (promise) => {
        pending.push(promise);
      },
      onStaleProjection: () => {
        stale = true;
      },
    });
    try {
      await reading;
      expect(stale).toBe(true);
      expect(batches).toBeLessThanOrEqual(1);
      const during = await env.DB.prepare(
        "SELECT review_count FROM public_review_counts WHERE course_id=1 AND teacher_id=1",
      ).first<{ review_count: number }>();
      const state = await env.DB.prepare(
        "SELECT dirty FROM public_precompute_state WHERE id=1",
      ).first<{ dirty: number }>();
      expect(during?.review_count).toBe(9153600);
      expect(state?.dirty).toBe(1);
    } finally {
      releaseBatch();
      await Promise.allSettled([reading, ...pending]);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });

  it("rebuilds a dirty projection older than the stale window", async () => {
    await env.DB.prepare(
      `UPDATE public_precompute_state
       SET dirty=1,published_generation=1,published_at=1,
           refresh_token=NULL,refresh_lease_until=NULL
       WHERE id=1`,
    ).run();
    let stale = false;
    await ensurePublicListPrecomputes(env.DB, {
      mode: "stale",
      waitUntil: () => {
        throw new Error("an expired projection should refresh in the request");
      },
      onStaleProjection: () => {
        stale = true;
      },
    });
    expect(stale).toBe(false);
    const state = await env.DB.prepare(
      "SELECT dirty FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number }>();
    expect(state?.dirty).toBe(0);
  });
});
