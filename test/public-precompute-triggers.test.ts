import { env } from "cloudflare:test";
import { expect, it } from "vitest";

const sourceTables = [
  "courses",
  "course_name_variants",
  "course_tags",
  "teachers",
  "course_teachers",
  "reviews",
  "public_historical_reviews",
  "offerings",
  "offering_teachers",
  "catalog_relation_pe_specializations",
] as const;

const triggerNames = sourceTables
  .flatMap((table) =>
    ["insert", "update", "delete"].map(
      (operation) => `public_precompute_dirty_${table}_${operation}`,
    ),
  )
  .sort();

async function expectWriteToMarkDirty(
  label: string,
  statement: D1PreparedStatement,
) {
  const before = await env.DB.prepare(
    "SELECT generation FROM public_precompute_state WHERE id=1",
  ).first<{ generation: number }>();
  await env.DB.prepare(
    `UPDATE public_precompute_state
     SET dirty=0,refresh_token='stale-refresh',refresh_lease_until=unixepoch()+60
     WHERE id=1`,
  ).run();
  await statement.run();
  const state = await env.DB.prepare(
    `SELECT dirty,generation,refresh_token,refresh_lease_until
     FROM public_precompute_state WHERE id=1`,
  ).first<{
    dirty: number;
    generation: number;
    refresh_token: string | null;
    refresh_lease_until: number | null;
  }>();
  expect(state?.dirty, label).toBe(1);
  expect(state?.generation, label).toBeGreaterThan(before?.generation ?? -1);
  expect(state?.refresh_token, label).toBeNull();
  expect(state?.refresh_lease_until, label).toBeNull();
}

it("marks public projections dirty for raw source-table inserts, updates and deletes", async () => {
  const installed = await env.DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type='trigger' AND name LIKE 'public_precompute_dirty_%'
     ORDER BY name`,
  ).all<{ name: string }>();
  expect(installed.results.map((row) => row.name)).toEqual(triggerNames);

  try {
    await expectWriteToMarkDirty(
      "courses INSERT",
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category,department)
         VALUES(355001,'TRIGGER355C','触发器课程','general','触发器学院')`,
      ),
    );
    await expectWriteToMarkDirty(
      "courses UPDATE",
      env.DB.prepare(
        "UPDATE courses SET department='触发器学院二' WHERE id=355001",
      ),
    );
    await expectWriteToMarkDirty(
      "courses DELETE",
      env.DB.prepare("DELETE FROM courses WHERE id=355001"),
    );

    await expectWriteToMarkDirty(
      "course_name_variants INSERT",
      env.DB.prepare(
        "INSERT INTO course_name_variants(course_id,name) VALUES(1,'触发器课名甲')",
      ),
    );
    await expectWriteToMarkDirty(
      "course_name_variants UPDATE",
      env.DB.prepare(
        "UPDATE course_name_variants SET name='触发器课名乙' WHERE course_id=1 AND name='触发器课名甲'",
      ),
    );
    await expectWriteToMarkDirty(
      "course_name_variants DELETE",
      env.DB.prepare(
        "DELETE FROM course_name_variants WHERE course_id=1 AND name='触发器课名乙'",
      ),
    );

    await expectWriteToMarkDirty(
      "teachers INSERT",
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name,department)
         VALUES(355002,'触发器教师','触发器教师','触发器学院')`,
      ),
    );
    await expectWriteToMarkDirty(
      "teachers UPDATE",
      env.DB.prepare("UPDATE teachers SET name='触发器教师改名' WHERE id=355002"),
    );
    await expectWriteToMarkDirty(
      "teachers DELETE",
      env.DB.prepare("DELETE FROM teachers WHERE id=355002"),
    );

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO courses(id,code,name,category)
         VALUES(355003,'TRIGGER355R','触发器关系课程','general')`,
      ),
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name)
         VALUES(355003,'触发器关系教师甲','触发器关系教师甲'),
               (355004,'触发器关系教师乙','触发器关系教师乙')`,
      ),
    ]);
    await expectWriteToMarkDirty(
      "course_teachers INSERT",
      env.DB.prepare(
        "INSERT INTO course_teachers(course_id,teacher_id) VALUES(355003,355003)",
      ),
    );
    await expectWriteToMarkDirty(
      "course_teachers UPDATE",
      env.DB.prepare(
        "UPDATE course_teachers SET teacher_id=355004 WHERE course_id=355003 AND teacher_id=355003",
      ),
    );
    await expectWriteToMarkDirty(
      "course_teachers DELETE",
      env.DB.prepare(
        "DELETE FROM course_teachers WHERE course_id=355003 AND teacher_id=355004",
      ),
    );

    await expectWriteToMarkDirty(
      "reviews INSERT",
      env.DB.prepare(
        `INSERT INTO reviews(id,course_id,teacher_id,category,overall,comment,status)
         VALUES(355005,1,1,'general',4,'触发器评价甲','approved')`,
      ),
    );
    await expectWriteToMarkDirty(
      "reviews UPDATE",
      env.DB.prepare(
        "UPDATE reviews SET comment='触发器评价乙' WHERE id=355005",
      ),
    );
    await expectWriteToMarkDirty(
      "reviews DELETE",
      env.DB.prepare("DELETE FROM reviews WHERE id=355005"),
    );

    await expectWriteToMarkDirty(
      "public_historical_reviews INSERT",
      env.DB.prepare(
        `INSERT INTO public_historical_reviews(
           id,course_id,teacher_id,comment,package_contract,
           approved_package_manifest_sha256,approved_catalog_content_sha256
         ) VALUES(
           'trigger-355',1,1,'触发器公开历史评价甲','trigger-contract',
           'trigger-manifest','trigger-catalog'
         )`,
      ),
    );
    await expectWriteToMarkDirty(
      "public_historical_reviews UPDATE",
      env.DB.prepare(
        `UPDATE public_historical_reviews
         SET comment='触发器公开历史评价乙' WHERE id='trigger-355'`,
      ),
    );
    await expectWriteToMarkDirty(
      "public_historical_reviews DELETE",
      env.DB.prepare(
        "DELETE FROM public_historical_reviews WHERE id='trigger-355'",
      ),
    );

    await expectWriteToMarkDirty(
      "offerings INSERT",
      env.DB.prepare(
        `INSERT INTO offerings(id,course_id,term,section,status)
         VALUES(355007,1,'触发器学期','触发器班','active')`,
      ),
    );
    await expectWriteToMarkDirty(
      "offerings UPDATE",
      env.DB.prepare(
        "UPDATE offerings SET course_id=course_id WHERE id=355007",
      ),
    );
    await expectWriteToMarkDirty(
      "offerings DELETE",
      env.DB.prepare("DELETE FROM offerings WHERE id=355007"),
    );

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teachers(id,source_teacher_label,name)
         VALUES(355008,'触发器开课教师','触发器开课教师')`,
      ),
      env.DB.prepare(
        `INSERT INTO offerings(id,course_id,term,section,status)
         VALUES(355008,1,'触发器学期','触发器教师班','active')`,
      ),
    ]);
    await expectWriteToMarkDirty(
      "offering_teachers INSERT",
      env.DB.prepare(
        "INSERT INTO offering_teachers(offering_id,teacher_id) VALUES(355008,1)",
      ),
    );
    await expectWriteToMarkDirty(
      "offering_teachers UPDATE",
      env.DB.prepare(
        "UPDATE offering_teachers SET teacher_id=355008 WHERE offering_id=355008 AND teacher_id=1",
      ),
    );
    await expectWriteToMarkDirty(
      "offering_teachers DELETE",
      env.DB.prepare(
        "DELETE FROM offering_teachers WHERE offering_id=355008 AND teacher_id=355008",
      ),
    );

    await expectWriteToMarkDirty(
      "catalog_relation_pe_specializations INSERT",
      env.DB.prepare(
        `INSERT INTO catalog_relation_pe_specializations(
           course_id,teacher_id,source_kind,normalized_specialization,display_semantics,evidence_json
         ) VALUES(
           1,1,'direct_skill','篮球','keep_source_name',
           '{"kind":"catalog_course_name","sourceCourseCode":"TEST101","sourceCourseName":"测试课程","sourceTeacherLabel":"测试教师","rawSpecializationName":"篮球"}'
         )`,
      ),
    );
    await expectWriteToMarkDirty(
      "catalog_relation_pe_specializations UPDATE",
      env.DB.prepare(
        "UPDATE catalog_relation_pe_specializations SET normalized_specialization='武术' WHERE course_id=1 AND teacher_id=1",
      ),
    );
    await expectWriteToMarkDirty(
      "catalog_relation_pe_specializations DELETE",
      env.DB.prepare(
        "DELETE FROM catalog_relation_pe_specializations WHERE course_id=1 AND teacher_id=1",
      ),
    );
  } finally {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM catalog_relation_pe_specializations WHERE course_id=1 AND teacher_id=1"),
      env.DB.prepare("DELETE FROM public_historical_reviews WHERE id='trigger-355'"),
      env.DB.prepare("DELETE FROM reviews WHERE id=355005"),
      env.DB.prepare("DELETE FROM offerings WHERE id IN (355007,355008)"),
      env.DB.prepare("DELETE FROM course_teachers WHERE course_id=355003"),
      env.DB.prepare("DELETE FROM courses WHERE id IN (355001,355003)"),
      env.DB.prepare("DELETE FROM teachers WHERE id IN (355002,355003,355004,355008)"),
      env.DB.prepare(
        "DELETE FROM course_name_variants WHERE course_id=1 AND name IN ('触发器课名甲','触发器课名乙')",
      ),
      env.DB.prepare("UPDATE public_precompute_state SET dirty=1 WHERE id=1"),
    ]);
  }
});

it("ignores unrelated writes and coalesces one dirty epoch", async () => {
  const before = await env.DB.prepare(
    "SELECT dirty,generation,refresh_token,refresh_lease_until,published_generation,published_at FROM public_precompute_state WHERE id=1",
  ).first<{
    dirty: number;
    generation: number;
    refresh_token: string | null;
    refresh_lease_until: number | null;
    published_generation: number;
    published_at: number;
  }>();
  await env.DB.prepare(
    "UPDATE public_precompute_state SET dirty=0,generation=100,refresh_token='held',refresh_lease_until=unixepoch()+60 WHERE id=1",
  ).run();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE teachers SET title=title WHERE id=1"),
      env.DB.prepare("UPDATE teachers SET bio=bio WHERE id=1"),
    ]);
    const clean = await env.DB.prepare(
      "SELECT dirty,generation,refresh_token,refresh_lease_until FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number; generation: number; refresh_token: string | null; refresh_lease_until: number | null }>();
    expect(clean?.dirty).toBe(0);
    expect(clean?.generation).toBe(100);
    expect(clean?.refresh_token).toBe("held");

    await env.DB.batch([
      env.DB.prepare("UPDATE teachers SET name=name WHERE id=1"),
      env.DB.prepare("UPDATE teachers SET department=department WHERE id=1"),
      env.DB.prepare("UPDATE courses SET name=name WHERE id=1"),
    ]);
    const dirty = await env.DB.prepare(
      "SELECT dirty,generation,refresh_token,refresh_lease_until FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number; generation: number; refresh_token: string | null; refresh_lease_until: number | null }>();
    expect(dirty).toEqual({ dirty: 1, generation: 101, refresh_token: null, refresh_lease_until: null });

    await env.DB.batch([
      env.DB.prepare("UPDATE teachers SET name=name WHERE id=1"),
      env.DB.prepare("UPDATE courses SET department=department WHERE id=1"),
    ]);
    const coalesced = await env.DB.prepare(
      "SELECT generation FROM public_precompute_state WHERE id=1",
    ).first<{ generation: number }>();
    expect(coalesced?.generation).toBe(101);
  } finally {
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=?,generation=?,refresh_token=?,refresh_lease_until=?,published_generation=?,published_at=? WHERE id=1",
    ).bind(
      before?.dirty ?? 1,
      before?.generation ?? 0,
      before?.refresh_token ?? null,
      before?.refresh_lease_until ?? null,
      before?.published_generation ?? -1,
      before?.published_at ?? 0,
    ).run();
  }
});

it("keeps offering and tag invalidation scoped to projection inputs", async () => {
  const before = await env.DB.prepare(
    "SELECT generation FROM public_precompute_state WHERE id=1",
  ).first<{ generation: number }>();
  await env.DB.prepare(
    "UPDATE public_precompute_state SET dirty=0,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1",
  ).run();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teachers(id,source_teacher_label,name) VALUES(355008,'触发器开课教师','触发器开课教师')"),
      env.DB.prepare("INSERT INTO courses(id,code,name,category) VALUES(355009,'TRIGGER355T','触发器标签课程','general')"),
      env.DB.prepare("INSERT INTO offerings(id,course_id,term,section,status) VALUES(355007,1,'触发器学期','触发器班','active')"),
      env.DB.prepare("INSERT INTO offering_teachers(offering_id,teacher_id) VALUES(355007,355008)"),
      env.DB.prepare("UPDATE public_precompute_state SET dirty=0,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1"),
    ]);
    const baseline = await env.DB.prepare(
      "SELECT generation FROM public_precompute_state WHERE id=1",
    ).first<{ generation: number }>();
    const offeringTrigger = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE name='public_precompute_dirty_offerings_update'",
    ).first<{ sql: string }>();
    const offeringTeacherTrigger = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE name='public_precompute_dirty_offering_teachers_update'",
    ).first<{ sql: string }>();
    expect(offeringTrigger?.sql).toContain("UPDATE OF id,course_id");
    expect(offeringTeacherTrigger?.sql).toContain("UPDATE OF offering_id,teacher_id");
    const unrelated = await env.DB.prepare(
      "SELECT dirty,generation FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number; generation: number }>();
    expect(unrelated).toEqual({ dirty: 0, generation: baseline?.generation ?? 0 });

    await env.DB.prepare(
      "INSERT INTO course_tags(course_id,tag) VALUES(355009,'mooc')",
    ).run();
    const inserted = await env.DB.prepare(
      "SELECT dirty FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number }>();
    expect(inserted?.dirty).toBe(1);
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=0,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1",
    ).run();
    await env.DB.prepare(
      "UPDATE course_tags SET course_id=355009 WHERE course_id=355009 AND tag='mooc'",
    ).run();
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=0,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1",
    ).run();
    await env.DB.prepare(
      "DELETE FROM course_tags WHERE course_id=355009 AND tag='mooc'",
    ).run();
    const deleted = await env.DB.prepare(
      "SELECT dirty FROM public_precompute_state WHERE id=1",
    ).first<{ dirty: number }>();
    expect(deleted?.dirty).toBe(1);
  } finally {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM offering_teachers WHERE offering_id=355007"),
      env.DB.prepare("DELETE FROM offerings WHERE id=355007"),
      env.DB.prepare("DELETE FROM teachers WHERE id=355008"),
      env.DB.prepare("DELETE FROM courses WHERE id=355009"),
    ]);
    await env.DB.prepare(
      "DELETE FROM course_tags WHERE course_id=1 AND tag IN ('trigger-tag','trigger-tag-updated')",
    ).run();
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1",
    ).run();
  }
});

async function expectReviewWriteToStayClean(
  label: string,
  statement: D1PreparedStatement,
) {
  await env.DB.prepare(
    `UPDATE public_precompute_state
     SET dirty=0,refresh_token='stale-refresh',refresh_lease_until=unixepoch()+60
     WHERE id=1`,
  ).run();
  const before = await env.DB.prepare(
    "SELECT generation FROM public_precompute_state WHERE id=1",
  ).first<{ generation: number }>();
  await statement.run();
  const state = await env.DB.prepare(
    `SELECT dirty,generation,refresh_token
     FROM public_precompute_state WHERE id=1`,
  ).first<{ dirty: number; generation: number; refresh_token: string | null }>();
  expect(state?.dirty, label).toBe(0);
  expect(state?.generation, label).toBe(before?.generation ?? -1);
  expect(state?.refresh_token, label).toBe("stale-refresh");
}

it("dirties reviews only when an approved row enters or leaves the public set", async () => {
  const triggers = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE type='trigger' AND name LIKE 'public_precompute_dirty_reviews_%'
     ORDER BY name`,
  ).all<{ name: string; sql: string }>();
  const byName = Object.fromEntries(triggers.results.map((row) => [row.name, row.sql]));
  expect(byName.public_precompute_dirty_reviews_insert).toContain(
    "WHEN NEW.status='approved'",
  );
  expect(byName.public_precompute_dirty_reviews_update).toContain(
    "UPDATE OF course_id,teacher_id,status,comment,overall,blocked_at,deleted_at,login_only,offering_id",
  );
  expect(byName.public_precompute_dirty_reviews_update).toContain(
    "WHEN OLD.status='approved' OR NEW.status='approved'",
  );
  expect(byName.public_precompute_dirty_reviews_delete).toContain(
    "WHEN OLD.status='approved'",
  );

  try {
    await expectReviewWriteToStayClean(
      "pending INSERT",
      env.DB.prepare(
        `INSERT INTO reviews(id,course_id,teacher_id,category,overall,comment,status)
         VALUES(921101,1,1,'general',4,'待审核投稿','pending')`,
      ),
    );
    await expectReviewWriteToStayClean(
      "pending comment UPDATE",
      env.DB.prepare("UPDATE reviews SET comment='待审核改稿' WHERE id=921101"),
    );
    await expectReviewWriteToStayClean(
      "pending to rejected",
      env.DB.prepare("UPDATE reviews SET status='rejected' WHERE id=921101"),
    );
    await expectReviewWriteToStayClean(
      "rejected DELETE",
      env.DB.prepare("DELETE FROM reviews WHERE id=921101"),
    );
    await expectReviewWriteToStayClean(
      "rejected INSERT",
      env.DB.prepare(
        `INSERT INTO reviews(id,course_id,teacher_id,category,overall,comment,status)
         VALUES(921102,1,1,'general',4,'已驳回投稿','rejected')`,
      ),
    );
    await expectReviewWriteToStayClean(
      "rejected blocked_at",
      env.DB.prepare(
        "UPDATE reviews SET blocked_at='2026-10-04' WHERE id=921102",
      ),
    );

    await expectReviewWriteToStayClean(
      "pending insert before approval",
      env.DB.prepare(
        `INSERT INTO reviews(id,course_id,teacher_id,category,overall,comment,status)
         VALUES(921103,1,1,'general',4,'即将通过','pending')`,
      ),
    );
    await expectWriteToMarkDirty(
      "pending to approved",
      env.DB.prepare("UPDATE reviews SET status='approved' WHERE id=921103"),
    );

    await expectWriteToMarkDirty(
      "approved comment",
      env.DB.prepare("UPDATE reviews SET comment='通过后改稿' WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved overall",
      env.DB.prepare("UPDATE reviews SET overall=3.5 WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved login_only",
      env.DB.prepare("UPDATE reviews SET login_only=1 WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved blocked_at",
      env.DB.prepare("UPDATE reviews SET blocked_at='2026-10-04' WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved deleted_at",
      env.DB.prepare("UPDATE reviews SET deleted_at='2026-10-04' WHERE id=921103"),
    );
    await expectReviewWriteToStayClean(
      "approved headline",
      env.DB.prepare("UPDATE reviews SET headline='不进投影' WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved to rejected",
      env.DB.prepare("UPDATE reviews SET status='rejected' WHERE id=921103"),
    );
    await expectReviewWriteToStayClean(
      "former approved comment",
      env.DB.prepare("UPDATE reviews SET comment='驳回后改稿' WHERE id=921103"),
    );
    await expectWriteToMarkDirty(
      "approved INSERT",
      env.DB.prepare(
        `INSERT INTO reviews(id,course_id,teacher_id,category,overall,comment,status)
         VALUES(921104,1,1,'general',5,'直接通过','approved')`,
      ),
    );
    await expectWriteToMarkDirty(
      "approved row DELETE",
      env.DB.prepare("DELETE FROM reviews WHERE id=921104"),
    );
  } finally {
    await env.DB.prepare(
      "DELETE FROM reviews WHERE id IN (921101,921102,921103,921104)",
    ).run();
    await env.DB.prepare(
      "UPDATE public_precompute_state SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL WHERE id=1",
    ).run();
  }
});
