import { catalogPinyinText } from "./lib/catalog-pinyin";
import {
  PE_SKILL_FAMILIES,
  PUBLIC_CATEGORY_FILTERS,
  publicBrowseFamilySql,
  publicCategoryFilterSql,
  publicCourseDisplayName,
  publicPeDisplaySearchSql,
  publicPeHasTextReviewSql,
  publicCourseVisibleSql,
  publicSportsMatchSql,
  publicHasMoocTagSql,
} from "./lib/public-course-presentation";
import { publicPeMappedSourceRelationExcludeSql } from "./lib/public-pe-relation-projection";
import {
  guestReviewBindingSql,
  historicalPublicVisibleSql,
} from "./public-review-visibility";

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const unnumberedPreference = PE_SKILL_FAMILIES.flatMap((family) => family.keys)
  .map(sqlLiteral)
  .join(",");
const firstNumberedPreference = PE_SKILL_FAMILIES.flatMap((family) =>
  family.keys.flatMap((key) => [`${key}1`, `${key}专项理论与实践1`]),
)
  .map(sqlLiteral)
  .join(",");

const refreshLeaseGuard = `EXISTS(
  SELECT 1 FROM public_precompute_state
  WHERE id=1
    AND dirty=1
    AND generation=?
    AND refresh_token=?
    AND refresh_lease_until>unixepoch()
)`;

export type PublicProjectionTarget = "active" | "staging";

type ProjectionTables = {
  canonicals: string;
  reviewCounts: string;
  teacherCourseCounts: string;
  teacherReviewCounts: string;
  teacherListTotals: string;
  teacherSearch: string;
  relationRatings: string;
  relationTotals: string;
};

const projectionTables = (target: PublicProjectionTarget): ProjectionTables =>
  target === "staging"
    ? {
        canonicals: "public_course_canonicals_staging",
        reviewCounts: "public_review_counts_staging",
        teacherCourseCounts: "public_teacher_course_counts_staging",
        teacherReviewCounts: "public_teacher_review_counts_staging",
        teacherListTotals: "public_teacher_list_totals_staging",
        teacherSearch: "public_teacher_search_staging",
        relationRatings: "public_relation_ratings_staging",
        relationTotals: "public_relation_list_totals_staging",
      }
    : {
        canonicals: "public_course_canonicals",
        reviewCounts: "public_review_counts",
        teacherCourseCounts: "public_teacher_course_counts",
        teacherReviewCounts: "public_teacher_review_counts",
        teacherListTotals: "public_teacher_list_totals",
        teacherSearch: "public_teacher_search",
        relationRatings: "public_relation_ratings",
        relationTotals: "public_relation_list_totals",
      };

const RELATION_TOTAL_CATEGORIES = ["all", ...PUBLIC_CATEGORY_FILTERS] as const;

const relationListFromSql = (canonicals: string) =>
  `FROM courses c
   JOIN ${canonicals} pcc ON pcc.course_id=c.id AND pcc.canonical_course_id=c.id
   JOIN course_teachers ct ON ct.course_id=c.id
   JOIN teachers t ON t.id=ct.teacher_id`;

const relationTotalInsert = (tables: ProjectionTables, category: string) => {
  const filter = publicCategoryFilterSql(
    category === "all" ? "" : category,
    "c",
    "pcc",
  );
  return {
    sql: `INSERT INTO ${tables.relationTotals}(category, n)
      SELECT category, n FROM (
        SELECT ? category, COUNT(*) n
        ${relationListFromSql(tables.canonicals)}
        WHERE ${publicCourseVisibleSql("c")}
          AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")}
          AND ${filter.sql}
      ) counted
      WHERE ${refreshLeaseGuard}`,
    args: [category, ...filter.args] as unknown[],
  };
};

const canonicalInsert = (tables: ProjectionTables) => `
  WITH classified AS (
    SELECT c.id,c.name,c.code,c.category,c.scheme_key,c.department,
      (${publicBrowseFamilySql("c")}) family_label,
      CASE WHEN ${publicPeHasTextReviewSql("c")} THEN 0 ELSE 1 END has_text,
      CASE
        WHEN c.name IN (${unnumberedPreference}) THEN 0
        WHEN c.name IN (${firstNumberedPreference}) THEN 1
        ELSE 2
      END preference
    FROM courses c
  ), ranked AS (
    SELECT id,family_label,
      FIRST_VALUE(id) OVER (
        PARTITION BY family_label
        ORDER BY has_text,preference,id
      ) canonical_id
    FROM classified
    WHERE family_label IS NOT NULL
  ), family_search AS (
    SELECT family_label,
      GROUP_CONCAT(COALESCE(name,'') || ' ' || COALESCE(code,''),' ') search_text
    FROM classified
    WHERE family_label IS NOT NULL
    GROUP BY family_label
  ), teacher_text AS (
    SELECT ct.course_id,
      GROUP_CONCAT(COALESCE(t.name,''), ' ') names,
      GROUP_CONCAT(char(31) || t.name || char(31), '') delimited
    FROM course_teachers ct
    JOIN teachers t ON t.id=ct.teacher_id
    GROUP BY ct.course_id
  ), variant_text AS (
    SELECT course_id,
      GROUP_CONCAT(COALESCE(name,''), ' ') names,
      GROUP_CONCAT(char(31) || name || char(31), '') delimited
    FROM course_name_variants
    GROUP BY course_id
  )
  INSERT INTO ${tables.canonicals}(
    course_id,canonical_course_id,family_label,search_text,match_text,teacher_variant_text,is_public_sports
  )
  SELECT c.id,COALESCE(r.canonical_id,c.id),c.family_label,
    COALESCE(fs.search_text,COALESCE(c.name,'') || ' ' || COALESCE(c.code,'')),
    trim(
      COALESCE(c.name,'') || ' ' ||
      COALESCE(c.code,'') || ' ' ||
      COALESCE(c.department,'') || ' ' ||
      COALESCE(c.family_label,'') || ' ' ||
      COALESCE((${publicPeDisplaySearchSql("c")}),'') || ' ' ||
      COALESCE(fs.search_text,'') || ' ' ||
      COALESCE(tt.names,'') || ' ' ||
      COALESCE(vt.names,'')
    ),
    COALESCE(tt.delimited,'') || COALESCE(vt.delimited,''),
    CASE WHEN (${publicSportsMatchSql("c")} OR c.scheme_key='pe')
       AND NOT ${publicHasMoocTagSql("c")} THEN 1 ELSE 0 END
  FROM classified c
  LEFT JOIN ranked r ON r.id=c.id
  LEFT JOIN family_search fs ON fs.family_label=c.family_label
  LEFT JOIN teacher_text tt ON tt.course_id=c.id
  LEFT JOIN variant_text vt ON vt.course_id=c.id
  WHERE ${refreshLeaseGuard};
`;

const teacherSearchInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.teacherSearch}(teacher_id,match_text)
  SELECT id, trim(COALESCE(name,'') || ' ' || COALESCE(department,''))
  FROM teachers
  WHERE ${refreshLeaseGuard};
`;

const aggregateInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.reviewCounts}(course_id,teacher_id,review_count)
  SELECT course_id,teacher_id,COUNT(*)
  FROM (
    SELECT r.course_id,r.teacher_id
    FROM reviews r
    WHERE r.status='approved'
      AND trim(COALESCE(r.comment,''))<>''
      ${guestReviewBindingSql}
    UNION ALL
    SELECT phr.course_id,phr.teacher_id
    FROM public_historical_reviews phr
    WHERE 1=1${historicalPublicVisibleSql("phr")}
  ) visible_text_reviews
  WHERE ${refreshLeaseGuard}
  GROUP BY course_id,teacher_id;
`;

const teacherCourseCountInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.teacherCourseCounts}(teacher_id,course_count)
  SELECT ct.teacher_id,COUNT(DISTINCT pcc.canonical_course_id)
  FROM course_teachers ct
  JOIN courses c ON c.id=ct.course_id
  JOIN ${tables.canonicals} pcc ON pcc.course_id=c.id
  WHERE ${publicCourseVisibleSql("c")}
    AND ${refreshLeaseGuard}
  GROUP BY ct.teacher_id;
`;

const teacherReviewCountInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.teacherReviewCounts}(teacher_id,review_count,name,department)
  SELECT t.id,COALESCE(sums.review_count,0),t.name,t.department
  FROM teachers t
  LEFT JOIN (
    SELECT teacher_id,SUM(review_count) review_count
    FROM ${tables.reviewCounts}
    GROUP BY teacher_id
  ) sums ON sums.teacher_id=t.id
  WHERE ${refreshLeaseGuard};
`;

const teacherListTotalInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.teacherListTotals}(id,n)
  SELECT id,n FROM (
    SELECT 1 id,COUNT(*) n FROM teachers
  ) counted
  WHERE ${refreshLeaseGuard};
`;

async function hasProjectionTable(db: D1Database, table: string) {
  const row = await db
    .prepare(
      `SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .bind(table)
    .first<{ ok: number }>();
  return Boolean(row);
}

const relationRatingInsert = (tables: ProjectionTables) => `
  INSERT INTO ${tables.relationRatings}(course_id,teacher_id,rating)
  SELECT r.course_id,r.teacher_id,ROUND(AVG(r.overall),1)
  FROM reviews r
  WHERE r.status='approved'${guestReviewBindingSql}
    AND r.overall IS NOT NULL
    AND ${refreshLeaseGuard}
  GROUP BY r.course_id,r.teacher_id;
`;

export const publicCourseCanonicalJoin =
  "JOIN public_course_canonicals pcc ON pcc.course_id=c.id AND pcc.canonical_course_id=c.id";

export const publicCourseMatchJoin =
  "JOIN public_course_canonicals pcc ON pcc.course_id=c.id";

export const publicTeacherSearchJoin =
  "JOIN public_teacher_search pts ON pts.teacher_id=t.id";

const guardedProjectionDelete = (table: string) =>
  `DELETE FROM ${table} WHERE ${refreshLeaseGuard}`;

const PYINYIN_BATCH = 40;
const NAME_SPLIT = "\u001f";

async function refreshCatalogPinyinTexts(
  db: D1Database,
  generation: number,
  token: string,
  renewLease: () => Promise<void>,
  tables: ProjectionTables,
) {
  await renewLease();
  const courses = await db
    .prepare(
      `SELECT pcc.course_id,
        COALESCE(c.name,'') name,
        COALESCE(pcc.family_label,'') family_label,
        COALESCE((
          SELECT GROUP_CONCAT(t.name, '${NAME_SPLIT}')
          FROM course_teachers ct JOIN teachers t ON t.id=ct.teacher_id
          WHERE ct.course_id=c.id
        ),'') teachers,
        COALESCE((
          SELECT GROUP_CONCAT(cnv.name, '${NAME_SPLIT}')
          FROM course_name_variants cnv
          WHERE cnv.course_id=c.id
        ),'') variants
       FROM ${tables.canonicals} pcc
       JOIN courses c ON c.id=pcc.course_id`,
    )
    .all<{
      course_id: number;
      name: string;
      family_label: string;
      teachers: string;
      variants: string;
    }>();
  const teachers = await db
    .prepare("SELECT id,name FROM teachers")
    .all<{ id: number; name: string }>();

  const splitNames = (value: string) =>
    value.split(NAME_SPLIT).map((part) => part.trim()).filter(Boolean);

  const updates = [
    ...courses.results.map((row) =>
      db
        .prepare(
          `UPDATE ${tables.canonicals} SET pinyin_text=?
           WHERE course_id=? AND ${refreshLeaseGuard}`,
        )
        .bind(
          catalogPinyinText([
            row.name,
            row.family_label,
            publicCourseDisplayName(row.name),
            ...splitNames(row.teachers),
            ...splitNames(row.variants),
          ]),
          row.course_id,
          generation,
          token,
        ),
    ),
    ...teachers.results.map((row) =>
      db
        .prepare(
          `UPDATE ${tables.teacherSearch} SET pinyin_text=?
           WHERE teacher_id=? AND ${refreshLeaseGuard}`,
        )
        .bind(
          catalogPinyinText([row.name], { surname: true }),
          row.id,
          generation,
          token,
        ),
    ),
  ];

  for (let offset = 0; offset < updates.length; offset += PYINYIN_BATCH) {
    await renewLease();
    await db.batch(updates.slice(offset, offset + PYINYIN_BATCH));
  }
}

export async function rebuildPublicListProjection({
  db,
  generation,
  token,
  renewLease,
}: {
  db: D1Database;
  generation: number;
  token: string;
  renewLease: () => Promise<void>;
}): Promise<void> {
  const staging = projectionTables("staging");
  const active = projectionTables("active");
  // Migration 0061 can land after this build. Skip the new tables until then
  // so an in-flight rebuild of the older projections still publishes.
  const teacherReviewCounts = await hasProjectionTable(
    db,
    staging.teacherReviewCounts,
  );
  const stage: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM ${staging.canonicals}`),
    db.prepare(`DELETE FROM ${staging.reviewCounts}`),
    db.prepare(`DELETE FROM ${staging.teacherCourseCounts}`),
    db.prepare(`DELETE FROM ${staging.teacherSearch}`),
    db.prepare(`DELETE FROM ${staging.relationRatings}`),
    db.prepare(`DELETE FROM ${staging.relationTotals}`),
  ];
  if (teacherReviewCounts) {
    stage.push(
      db.prepare(`DELETE FROM ${staging.teacherReviewCounts}`),
      db.prepare(`DELETE FROM ${staging.teacherListTotals}`),
    );
  }
  stage.push(
    db.prepare(canonicalInsert(staging)).bind(generation, token),
    db.prepare(aggregateInsert(staging)).bind(generation, token),
    db.prepare(teacherCourseCountInsert(staging)).bind(generation, token),
    db.prepare(teacherSearchInsert(staging)).bind(generation, token),
    db.prepare(relationRatingInsert(staging)).bind(generation, token),
    ...RELATION_TOTAL_CATEGORIES.map((category) => {
      const insert = relationTotalInsert(staging, category);
      return db.prepare(insert.sql).bind(...insert.args, generation, token);
    }),
  );
  if (teacherReviewCounts) {
    stage.push(
      db.prepare(teacherReviewCountInsert(staging)).bind(generation, token),
      db.prepare(teacherListTotalInsert(staging)).bind(generation, token),
    );
  }
  await db.batch(stage);
  await refreshCatalogPinyinTexts(db, generation, token, renewLease, staging);
  await renewLease();
  const publish: D1PreparedStatement[] = [
    db.prepare(guardedProjectionDelete(active.canonicals)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.canonicals}(
         course_id,canonical_course_id,family_label,search_text,match_text,
         teacher_variant_text,pinyin_text,is_public_sports
       )
       SELECT course_id,canonical_course_id,family_label,search_text,match_text,
         teacher_variant_text,pinyin_text,is_public_sports
       FROM ${staging.canonicals}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
    db.prepare(guardedProjectionDelete(active.reviewCounts)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.reviewCounts}(course_id,teacher_id,review_count)
       SELECT course_id,teacher_id,review_count FROM ${staging.reviewCounts}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
    db.prepare(guardedProjectionDelete(active.teacherCourseCounts)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.teacherCourseCounts}(teacher_id,course_count)
       SELECT teacher_id,course_count FROM ${staging.teacherCourseCounts}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
    db.prepare(guardedProjectionDelete(active.teacherSearch)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.teacherSearch}(teacher_id,match_text,pinyin_text)
       SELECT teacher_id,match_text,pinyin_text FROM ${staging.teacherSearch}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
    db.prepare(guardedProjectionDelete(active.relationRatings)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.relationRatings}(course_id,teacher_id,rating)
       SELECT course_id,teacher_id,rating FROM ${staging.relationRatings}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
    db.prepare(guardedProjectionDelete(active.relationTotals)).bind(generation, token),
    db.prepare(
      `INSERT INTO ${active.relationTotals}(category, n)
       SELECT category, n FROM ${staging.relationTotals}
       WHERE ${refreshLeaseGuard}`,
    ).bind(generation, token),
  ];
  if (teacherReviewCounts) {
    publish.push(
      db.prepare(guardedProjectionDelete(active.teacherReviewCounts)).bind(
        generation,
        token,
      ),
      db.prepare(
        `INSERT INTO ${active.teacherReviewCounts}(teacher_id,review_count,name,department)
         SELECT teacher_id,review_count,name,department
         FROM ${staging.teacherReviewCounts}
         WHERE ${refreshLeaseGuard}`,
      ).bind(generation, token),
      db.prepare(guardedProjectionDelete(active.teacherListTotals)).bind(
        generation,
        token,
      ),
      db.prepare(
        `INSERT INTO ${active.teacherListTotals}(id,n)
         SELECT id,n FROM ${staging.teacherListTotals}
         WHERE ${refreshLeaseGuard}`,
      ).bind(generation, token),
      db.prepare(
        `UPDATE public_precompute_state
         SET teacher_review_counts_ready=1
         WHERE id=1
           AND dirty=1
           AND generation=?
           AND refresh_token=?
           AND refresh_lease_until>unixepoch()`,
      ).bind(generation, token),
    );
  }
  await db.batch(publish);
}
