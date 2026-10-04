import { D1_MAX_BOUND_PARAMETERS } from "./lib/public-catalog-list";
import {
  loadPublicCourseListExtras,
  loadPublicRelationListExtras,
} from "./lib/public-catalog-list";
import {
  publicCategoryFilterSql,
  publicCourseDisplayNameSql,
  publicCourseVisibleSql,
  publicPeSkillFamilySql,
  publicRelationNameSortKey,
  publicRelationNameSortKeySql,
} from "./lib/public-course-presentation";
import { loadPublicPeCourseProjection } from "./lib/public-pe-course-projection";
import { publicPeMappedSourceCourseExcludeSql } from "./lib/public-pe-course-projection";
import {
  loadPublicPeRelationProjection,
  publicPeMappedSourceRelationExcludeSql,
} from "./lib/public-pe-relation-projection";

export const CATALOG_BROWSE_READY_COLUMN = "catalog_browse_ready";

const refreshLeaseGuard = `EXISTS(
  SELECT 1 FROM public_precompute_state
  WHERE id=1
    AND dirty=1
    AND generation=?
    AND refresh_token=?
    AND refresh_lease_until>unixepoch()
)`;

export const RELATION_BROWSE_COLUMNS = [
  "public_id",
  "course_id",
  "code",
  "name",
  "category",
  "department",
  "teacher_id",
  "teacher_name",
  "rating",
  "review_count",
  "source_course_ids",
  "name_sort_key",
  "rating_missing",
  "in_sports",
  "in_mooc",
  "in_general",
  "in_english",
  "in_ideology",
  "in_math",
] as const;

export const COURSE_BROWSE_COLUMNS = [
  "public_id",
  "course_id",
  "code",
  "name",
  "category",
  "department",
  "teachers",
  "teacher_refs",
  "review_count",
  "credits",
  "description",
  "created_at",
  "scheme_key",
  "enrollment_category",
  "teaching_type",
  "course_level",
  "sort_name",
  "sort_code",
  "sort_id_missing",
  "sort_id",
  "is_extra",
  "in_sports",
  "in_mooc",
  "in_general",
  "in_english",
  "in_ideology",
  "in_math",
] as const;

export type CatalogBrowseProjection = {
  active: string;
  staging: string;
  columns: readonly string[];
  keys: readonly string[];
};

export const catalogBrowseProjections: readonly CatalogBrowseProjection[] = [
  {
    active: "public_relation_browse",
    staging: "public_relation_browse_staging",
    columns: RELATION_BROWSE_COLUMNS,
    keys: ["public_id"],
  },
  {
    active: "public_relation_browse_departments",
    staging: "public_relation_browse_departments_staging",
    columns: ["department", "public_id"],
    keys: ["department", "public_id"],
  },
  {
    active: "public_relation_browse_totals",
    staging: "public_relation_browse_totals_staging",
    columns: ["category", "n"],
    keys: ["category"],
  },
  {
    active: "public_course_browse",
    staging: "public_course_browse_staging",
    columns: COURSE_BROWSE_COLUMNS,
    keys: ["public_id"],
  },
  {
    active: "public_course_browse_departments",
    staging: "public_course_browse_departments_staging",
    columns: ["department", "public_id"],
    keys: ["department", "public_id"],
  },
  {
    active: "public_course_browse_teachers",
    staging: "public_course_browse_teachers_staging",
    columns: ["teacher_id", "public_id"],
    keys: ["teacher_id", "public_id"],
  },
  {
    active: "public_course_browse_totals",
    staging: "public_course_browse_totals_staging",
    columns: ["category", "n"],
    keys: ["category"],
  },
];

const BROWSE_TOTAL_CATEGORIES = [
  "all",
  "sports",
  "mooc",
  "general",
  "english",
  "ideology",
  "math",
] as const;

const CATEGORY_FLAGS = [
  ["in_sports", "sports"],
  ["in_mooc", "mooc"],
  ["in_general", "general"],
  ["in_english", "english"],
  ["in_ideology", "ideology"],
  ["in_math", "math"],
] as const;

function inlineCategoryFilter(category: string): string {
  const filter = publicCategoryFilterSql(category, "c", "pcc");
  let sql = filter.sql;
  for (const arg of filter.args) {
    const literal = `'${String(arg).replaceAll("'", "''")}'`;
    sql = sql.replace("?", literal);
  }
  return sql;
}

const displayCategorySql = `CASE
  WHEN (${publicPeSkillFamilySql("c")}) IS NOT NULL THEN 'sports'
  WHEN c.category IN ('sports','pe') THEN 'sports'
  WHEN trim(c.category)='' THEN ''
  ELSE 'general'
END`;

const categoryFlagSql = CATEGORY_FLAGS.map(
  ([, category]) => `CASE WHEN ${inlineCategoryFilter(category)} THEN 1 ELSE 0 END`,
).join(",");

function bindLease(
  db: D1Database,
  sql: string,
  generation: number,
  token: string,
  leading: readonly unknown[] = [],
) {
  return db.prepare(sql).bind(...leading, generation, token);
}

/**
 * The PE list loaders read `public_review_counts`. During a rebuild those
 * rows live in staging until the publish batch, so the same functions see
 * this generation's counts without a second aggregation implementation.
 */
function withStagingReviewCounts(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) =>
          target.prepare(
            sql.replace(
              /\bpublic_review_counts\b/g,
              "public_review_counts_staging",
            ),
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function uniqueDepartmentRows(
  rows: ReadonlyArray<{ department: string; public_id: string }>,
) {
  const seen = new Set<string>();
  const unique: Array<{ department: string; public_id: string }> = [];
  for (const row of rows) {
    const key = `${row.department}\u001f${row.public_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function canonicalJoin(canonicals: string): string {
  return `JOIN ${canonicals} pcc ON pcc.course_id=c.id AND pcc.canonical_course_id=c.id`;
}

/** Generation and token placeholders in `refreshLeaseGuard`. */
const LEASE_PARAMETER_COUNT = 2;

/**
 * Rows per INSERT. D1 rejects more than D1_MAX_BOUND_PARAMETERS bound
 * parameters, and two of them belong to the refresh lease.
 */
export function columnRowInsertChunkSize(width: number): number {
  return Math.max(
    1,
    Math.floor((D1_MAX_BOUND_PARAMETERS - LEASE_PARAMETER_COUNT) / width),
  );
}

export type ColumnRowInsertStatement = {
  sql: string;
  values: unknown[];
};

/**
 * Workerd's compound-SELECT cap is far below 49 terms, so a 2-column
 * department insert built as `SELECT ? UNION ALL SELECT ?` fails and the
 * rebuild rolls back to dirty. Multi-row VALUES is exempt since SQLite
 * 3.8.8; outputs are named column1..columnN.
 */
export function columnRowInsertStatements(
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ColumnRowInsertStatement[] {
  if (!rows.length) return [];
  const chunkSize = columnRowInsertChunkSize(columns.length);
  const projected = columns.map((_, index) => `column${index + 1}`).join(",");
  const statements: ColumnRowInsertStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const slice = rows.slice(offset, offset + chunkSize);
    const tuples = slice
      .map(() => `(${columns.map(() => "?").join(",")})`)
      .join(",");
    statements.push({
      sql: `INSERT INTO ${table}(${columns.join(",")})
       SELECT ${projected} FROM (VALUES ${tuples})
       WHERE ${refreshLeaseGuard}`,
      values: slice.flatMap((row) => columns.map((column) => row[column])),
    });
  }
  return statements;
}

async function insertColumnRows(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  generation: number,
  token: string,
  renewLease: () => Promise<void>,
) {
  for (const statement of columnRowInsertStatements(table, columns, rows)) {
    await renewLease();
    await bindLease(
      db,
      statement.sql,
      generation,
      token,
      statement.values,
    ).run();
  }
}

function teacherIdsFromRefs(refs: string | null | undefined): number[] {
  if (!refs) return [];
  const ids: number[] = [];
  for (const ref of refs.split(",")) {
    const colon = ref.indexOf(":");
    if (colon <= 0) continue;
    const id = Number(ref.slice(0, colon));
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

async function stageBrowseExtras(
  db: D1Database,
  generation: number,
  token: string,
  renewLease: () => Promise<void>,
) {
  const proxied = withStagingReviewCounts(db);
  const [relationExtras, relationProjection, courseExtras, courseProjection] =
    await Promise.all([
      loadPublicRelationListExtras(proxied, {
        category: "",
        department: "",
        teacherId: null,
        searchTerms: [],
        exactTeacherIds: null,
        courseSearchTerms: [],
      }),
      loadPublicPeRelationProjection(proxied),
      loadPublicCourseListExtras(proxied, {
        category: "",
        department: "",
        teacherId: null,
        searchTerms: [],
      }),
      loadPublicPeCourseProjection(proxied),
    ]);
  const relationDepartments = new Map(
    relationProjection.items.map((item) => [item.public_id, item.sourceDepartments]),
  );
  const courseAggregates = new Map(
    courseProjection.items.map((item) => [item.public_id, item]),
  );

  const relationRows = relationExtras.map((item) => {
    const courseId = item.course_id == null ? null : Number(item.course_id);
    const sources =
      "source_course_ids" in item && Array.isArray(item.source_course_ids)
        ? item.source_course_ids.join(",")
        : "";
    return {
      public_id: item.public_id,
      course_id: courseId,
      code: item.code ?? "",
      name: item.name,
      category: item.category,
      department: item.department ?? "",
      teacher_id: item.teacher_id,
      teacher_name: item.teacher_name ?? "",
      rating: item.rating,
      review_count: Number(item.review_count) || 0,
      source_course_ids: sources,
      name_sort_key: publicRelationNameSortKey({
        name: item.name,
        code: item.code ?? "",
        course_id: courseId == null ? 0 : courseId,
        teacher_name: item.teacher_name,
        teacher_id: item.teacher_id,
      }),
      rating_missing: item.rating == null ? 1 : 0,
      in_sports: 1,
      in_mooc: 0,
      in_general: 0,
      in_english: 0,
      in_ideology: 0,
      in_math: 0,
    };
  });
  const relationDepartmentRows = uniqueDepartmentRows(
    relationExtras.flatMap((item) =>
      (relationDepartments.get(item.public_id) ?? [])
        .map((department) => department.trim())
        .filter(Boolean)
        .map((department) => ({ department, public_id: item.public_id })),
    ),
  );

  const courseRows = courseExtras.map((item) => {
    const courseId = item.id == null ? null : Number(item.id);
    return {
      public_id: item.public_id,
      course_id: courseId,
      code: item.code ?? "",
      name: item.name,
      category: item.category,
      department: item.department ?? "",
      teachers: item.teachers,
      teacher_refs: item.teacher_refs,
      review_count: Number(item.review_count) || 0,
      credits: null,
      description: null,
      created_at: null,
      scheme_key: null,
      enrollment_category: null,
      teaching_type: null,
      course_level: null,
      sort_name: item.name,
      sort_code: item.code ?? "",
      sort_id_missing: courseId == null ? 1 : 0,
      sort_id: courseId == null ? 0 : courseId,
      is_extra: 1,
      in_sports: 1,
      in_mooc: 0,
      in_general: 0,
      in_english: 0,
      in_ideology: 0,
      in_math: 0,
    };
  });
  const courseDepartmentRows = uniqueDepartmentRows(
    courseExtras.flatMap((item) =>
      (courseAggregates.get(item.public_id)?.sourceDepartments ?? [])
        .map((department) => department.trim())
        .filter(Boolean)
        .map((department) => ({ department, public_id: item.public_id })),
    ),
  );
  const courseTeacherRows = courseExtras.flatMap((item) => {
    const aggregate = courseAggregates.get(item.public_id);
    const teacherIds = aggregate
      ? aggregate.teacherIds
      : teacherIdsFromRefs(item.teacher_refs);
    return [...new Set(teacherIds)].map((teacherId) => ({
      teacher_id: teacherId,
      public_id: item.public_id,
    }));
  });

  await insertColumnRows(
    db,
    "public_relation_browse_staging",
    RELATION_BROWSE_COLUMNS,
    relationRows,
    generation,
    token,
    renewLease,
  );
  await insertColumnRows(
    db,
    "public_relation_browse_departments_staging",
    ["department", "public_id"],
    relationDepartmentRows,
    generation,
    token,
    renewLease,
  );
  await insertColumnRows(
    db,
    "public_course_browse_staging",
    COURSE_BROWSE_COLUMNS,
    courseRows,
    generation,
    token,
    renewLease,
  );
  await insertColumnRows(
    db,
    "public_course_browse_departments_staging",
    ["department", "public_id"],
    courseDepartmentRows,
    generation,
    token,
    renewLease,
  );
  await insertColumnRows(
    db,
    "public_course_browse_teachers_staging",
    ["teacher_id", "public_id"],
    courseTeacherRows,
    generation,
    token,
    renewLease,
  );
}

function totalInserts(
  table: string,
  flag: string | null,
  category: string,
  source: string,
): string {
  const where = flag ? `${flag}=1 AND ${refreshLeaseGuard}` : refreshLeaseGuard;
  return `INSERT INTO ${table}(category, n)
    SELECT '${category}', COUNT(*) FROM ${source}
    WHERE ${where}`;
}

export async function stagePublicCatalogBrowse({
  db,
  generation,
  token,
  renewLease,
  canonicals,
  reviewCounts,
  relationRatings,
}: {
  db: D1Database;
  generation: number;
  token: string;
  renewLease: () => Promise<void>;
  canonicals: string;
  reviewCounts: string;
  relationRatings: string;
}): Promise<void> {
  await renewLease();
  const stagingTables = catalogBrowseProjections.map((spec) => spec.staging);
  await db.batch(
    stagingTables.map((table) =>
      bindLease(
        db,
        `DELETE FROM ${table} WHERE ${refreshLeaseGuard}`,
        generation,
        token,
      ),
    ),
  );

  const displayName = `(${publicCourseDisplayNameSql("c")})`;
  const visible = publicCourseVisibleSql("c");
  const relationWhere = `${visible}
    AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")}
    AND ${refreshLeaseGuard}`;
  const courseWhere = `${visible}
    AND ${publicPeMappedSourceCourseExcludeSql("c")}
    AND ${refreshLeaseGuard}`;
  const relationFrom = `FROM courses c
    ${canonicalJoin(canonicals)}
    JOIN course_teachers ct ON ct.course_id=c.id
    JOIN teachers t ON t.id=ct.teacher_id
    LEFT JOIN ${reviewCounts} rel_counts
      ON rel_counts.course_id=c.id AND rel_counts.teacher_id=t.id
    LEFT JOIN ${relationRatings} rel_rating
      ON rel_rating.course_id=c.id AND rel_rating.teacher_id=t.id`;

  await renewLease();
  await db.batch([
    bindLease(
      db,
      `INSERT INTO public_relation_browse_staging(${RELATION_BROWSE_COLUMNS.join(",")})
       SELECT 'relation:' || c.id || ':' || t.id,
         c.id,
         c.code,
         ${displayName},
         ${displayCategorySql},
         c.department,
         t.id,
         t.name,
         rel_rating.rating,
         COALESCE(rel_counts.review_count,0),
         '',
         ${publicRelationNameSortKeySql("c", "t")},
         CASE WHEN rel_rating.rating IS NULL THEN 1 ELSE 0 END,
         ${categoryFlagSql}
       ${relationFrom}
       WHERE ${relationWhere}`,
      generation,
      token,
    ),
    bindLease(
      db,
      `INSERT INTO public_relation_browse_departments_staging(department, public_id)
       SELECT trim(c.department), 'relation:' || c.id || ':' || t.id
       ${relationFrom}
       WHERE ${relationWhere}
         AND trim(c.department)<>''`,
      generation,
      token,
    ),
    bindLease(
      db,
      `INSERT INTO public_course_browse_staging(${COURSE_BROWSE_COLUMNS.join(",")})
       SELECT 'course:' || c.id,
         c.id,
         c.code,
         ${displayName},
         ${displayCategorySql},
         c.department,
         GROUP_CONCAT(DISTINCT t.name),
         GROUP_CONCAT(DISTINCT t.id || ':' || t.name),
         COALESCE(course_review_counts.review_count,0),
         c.credits,
         c.description,
         c.created_at,
         c.scheme_key,
         c.enrollment_category,
         c.teaching_type,
         c.course_level,
         ${displayName},
         c.code,
         0,
         c.id,
         0,
         ${categoryFlagSql}
       FROM courses c
       ${canonicalJoin(canonicals)}
       LEFT JOIN course_teachers ct ON ct.course_id=c.id
       LEFT JOIN teachers t ON t.id=ct.teacher_id
       LEFT JOIN (
         SELECT course_id, SUM(review_count) review_count
         FROM ${reviewCounts}
         GROUP BY course_id
       ) course_review_counts ON course_review_counts.course_id=c.id
       WHERE ${courseWhere}
       GROUP BY c.id`,
      generation,
      token,
    ),
    bindLease(
      db,
      `INSERT INTO public_course_browse_departments_staging(department, public_id)
       SELECT trim(c.department), 'course:' || c.id
       FROM courses c
       ${canonicalJoin(canonicals)}
       WHERE ${courseWhere}
         AND trim(c.department)<>''`,
      generation,
      token,
    ),
    bindLease(
      db,
      `INSERT INTO public_course_browse_teachers_staging(teacher_id, public_id)
       SELECT ct.teacher_id, 'course:' || c.id
       FROM courses c
       ${canonicalJoin(canonicals)}
       JOIN course_teachers ct ON ct.course_id=c.id
       WHERE ${courseWhere}`,
      generation,
      token,
    ),
  ]);

  await stageBrowseExtras(db, generation, token, renewLease);
  await renewLease();
  const totalStatements = [
    ...BROWSE_TOTAL_CATEGORIES.map((category) =>
      bindLease(
        db,
        totalInserts(
          "public_relation_browse_totals_staging",
          category === "all" ? null : `in_${category}`,
          category,
          "public_relation_browse_staging",
        ),
        generation,
        token,
      ),
    ),
    ...BROWSE_TOTAL_CATEGORIES.map((category) =>
      bindLease(
        db,
        totalInserts(
          "public_course_browse_totals_staging",
          category === "all" ? null : `in_${category}`,
          category,
          "public_course_browse_staging",
        ),
        generation,
        token,
      ),
    ),
  ];
  await db.batch(totalStatements);
}
