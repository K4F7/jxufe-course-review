import {
  CATALOG_BROWSE_PROJECTION_ENABLED,
  CATALOG_BROWSE_READY_COLUMN,
  catalogBrowseProjections,
  stagePublicCatalogBrowse,
} from "./public-catalog-browse-plan";
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

const relationTotalSelect = (tables: ProjectionTables, category: string) => {
  const filter = publicCategoryFilterSql(
    category === "all" ? "" : category,
    "c",
    "pcc",
  );
  return {
    sql: `SELECT category, n FROM (
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

const canonicalColumns = [
  "course_id",
  "canonical_course_id",
  "family_label",
  "search_text",
  "match_text",
  "teacher_variant_text",
  "pinyin_text",
  "is_public_sports",
] as const;

const courseMatchSql = `trim(
      COALESCE(c.name,'') || ' ' ||
      COALESCE(c.code,'') || ' ' ||
      COALESCE(c.department,'') || ' ' ||
      COALESCE(c.family_label,'') || ' ' ||
      COALESCE((${publicPeDisplaySearchSql("c")}),'') || ' ' ||
      COALESCE(fs.search_text,'') || ' ' ||
      COALESCE(tt.names,'') || ' ' ||
      COALESCE(vt.names,'')
    )`;

const canonicalSelect = (publishedCanonicals: string) => `
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
  SELECT computed.course_id,computed.canonical_course_id,computed.family_label,
    computed.search_text,computed.match_text,computed.teacher_variant_text,
    CASE
      WHEN published.course_id IS NOT NULL
       AND published.match_text=computed.match_text
      THEN published.pinyin_text
      ELSE ''
    END,
    computed.is_public_sports
  FROM (
    SELECT c.id course_id,COALESCE(r.canonical_id,c.id) canonical_course_id,c.family_label,
      COALESCE(fs.search_text,COALESCE(c.name,'') || ' ' || COALESCE(c.code,'')) search_text,
      ${courseMatchSql} match_text,
      COALESCE(tt.delimited,'') || COALESCE(vt.delimited,'') teacher_variant_text,
      CASE WHEN (${publicSportsMatchSql("c")} OR c.scheme_key='pe')
         AND NOT ${publicHasMoocTagSql("c")} THEN 1 ELSE 0 END is_public_sports
    FROM classified c
    LEFT JOIN ranked r ON r.id=c.id
    LEFT JOIN family_search fs ON fs.family_label=c.family_label
    LEFT JOIN teacher_text tt ON tt.course_id=c.id
    LEFT JOIN variant_text vt ON vt.course_id=c.id
  ) computed
  LEFT JOIN ${publishedCanonicals} published ON published.course_id=computed.course_id
  WHERE ${refreshLeaseGuard}`;

const teacherSearchColumns = ["teacher_id", "match_text", "pinyin_text"] as const;

const teacherMatchSql = `trim(COALESCE(name,'') || ' ' || COALESCE(department,''))`;

const teacherSearchSelect = (publishedTeacherSearch: string) => `
  SELECT computed.teacher_id,computed.match_text,
    CASE
      WHEN published.teacher_id IS NOT NULL
       AND published.match_text=computed.match_text
      THEN published.pinyin_text
      ELSE ''
    END
  FROM (
    SELECT id teacher_id, ${teacherMatchSql} match_text
    FROM teachers
  ) computed
  LEFT JOIN ${publishedTeacherSearch} published
    ON published.teacher_id=computed.teacher_id
  WHERE ${refreshLeaseGuard}`;

const visibleTextReviewsSql = `
  SELECT r.course_id,r.teacher_id
  FROM reviews r
  WHERE r.status='approved'
    AND trim(COALESCE(r.comment,''))<>''
    ${guestReviewBindingSql}
  UNION ALL
  SELECT phr.course_id,phr.teacher_id
  FROM public_historical_reviews phr
  WHERE 1=1${historicalPublicVisibleSql("phr")}`;

const aggregateSelect = () => `
  SELECT course_id,teacher_id,COUNT(*) review_count
  FROM (
    ${visibleTextReviewsSql}
  ) visible_text_reviews
  WHERE ${refreshLeaseGuard}
  GROUP BY course_id,teacher_id`;

const teacherCourseCountSelect = (tables: ProjectionTables) => `
  SELECT ct.teacher_id,COUNT(DISTINCT pcc.canonical_course_id) course_count
  FROM course_teachers ct
  JOIN courses c ON c.id=ct.course_id
  JOIN ${tables.canonicals} pcc ON pcc.course_id=c.id
  WHERE ${publicCourseVisibleSql("c")}
    AND ${refreshLeaseGuard}
  GROUP BY ct.teacher_id`;

const teacherReviewCountSelect = (tables: ProjectionTables) => `
  SELECT t.id,COALESCE(sums.review_count,0),t.name,t.department
  FROM teachers t
  LEFT JOIN (
    SELECT teacher_id,SUM(review_count) review_count
    FROM ${tables.reviewCounts}
    GROUP BY teacher_id
  ) sums ON sums.teacher_id=t.id
  WHERE ${refreshLeaseGuard}`;

const teacherListTotalSelect = () => `
  SELECT id,n FROM (
    SELECT 1 id,COUNT(*) n FROM teachers
  ) counted
  WHERE ${refreshLeaseGuard}`;

async function hasProjectionTable(db: D1Database, table: string) {
  const row = await db
    .prepare(
      `SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .bind(table)
    .first<{ ok: number }>();
  return Boolean(row);
}

const relationRatingSelect = () => `
  SELECT r.course_id,r.teacher_id,ROUND(AVG(r.overall),1) rating
  FROM reviews r
  WHERE r.status='approved'${guestReviewBindingSql}
    AND r.overall IS NOT NULL
    AND ${refreshLeaseGuard}
  GROUP BY r.course_id,r.teacher_id`;

export const publicCourseCanonicalJoin =
  "JOIN public_course_canonicals pcc ON pcc.course_id=c.id AND pcc.canonical_course_id=c.id";

export const publicCourseMatchJoin =
  "JOIN public_course_canonicals pcc ON pcc.course_id=c.id";

export const publicTeacherSearchJoin =
  "JOIN public_teacher_search pts ON pts.teacher_id=t.id";

const PINYIN_ROWS_PER_STATEMENT = 30;
const NAME_SPLIT = "\u001f";

const chunk = <T>(items: readonly T[], size: number) => {
  const groups: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size)
    groups.push(items.slice(offset, offset + size));
  return groups;
};

const projectionUpsert = ({
  table,
  columns,
  keys,
  selectSql,
  preserveUnchangedPinyin = false,
}: {
  table: string;
  columns: readonly string[];
  keys: readonly string[];
  selectSql: string;
  preserveUnchangedPinyin?: boolean;
}) => {
  const keySet = new Set(keys);
  const assignments = columns
    .filter((column) => !keySet.has(column))
    .map((column) => {
      if (preserveUnchangedPinyin && column === "pinyin_text") {
        return `pinyin_text=CASE
          WHEN excluded.match_text=${table}.match_text THEN excluded.pinyin_text
          WHEN excluded.pinyin_text<>'' THEN excluded.pinyin_text
          ELSE ${table}.pinyin_text
        END`;
      }
      return `${column}=excluded.${column}`;
    })
    .join(",");
  const differences = columns
    .filter((column) => !keySet.has(column))
    .map((column) => {
      if (preserveUnchangedPinyin && column === "pinyin_text") {
        return `(
          (excluded.match_text=${table}.match_text AND ${table}.pinyin_text IS NOT excluded.pinyin_text)
          OR (
            excluded.match_text IS NOT ${table}.match_text
            AND excluded.pinyin_text<>''
            AND ${table}.pinyin_text IS NOT excluded.pinyin_text
          )
        )`;
      }
      return `${table}.${column} IS NOT excluded.${column}`;
    })
    .join(" OR ");
  return `INSERT INTO ${table}(${columns.join(",")})
    ${selectSql}
    ON CONFLICT(${keys.join(",")}) DO UPDATE SET
      ${assignments}
    WHERE ${differences}`;
};

const staleKeyDelete = (
  table: string,
  keys: readonly string[],
  freshSql: string,
) => `DELETE FROM ${table}
  WHERE NOT EXISTS (
    SELECT 1 FROM (${freshSql}) fresh
    WHERE ${keys.map((key) => `fresh.${key}=${table}.${key}`).join(" AND ")}
  )
  AND ${refreshLeaseGuard}`;

const bindLease = (
  db: D1Database,
  sql: string,
  generation: number,
  token: string,
  leading: readonly unknown[] = [],
) => db.prepare(sql).bind(...leading, generation, token);

const pinyinUpdateSql = (table: string, idColumn: string, count: number) => {
  const cases = Array.from({ length: count }, () => "WHEN ? THEN ?").join(" ");
  const ids = Array.from({ length: count }, () => "?").join(",");
  return `UPDATE ${table}
    SET pinyin_text=CASE ${idColumn} ${cases} ELSE pinyin_text END
    WHERE ${idColumn} IN (${ids})
      AND ${refreshLeaseGuard}`;
};

async function refreshChangedPinyinTexts(
  db: D1Database,
  generation: number,
  token: string,
  renewLease: () => Promise<void>,
  staging: ProjectionTables,
  published: ProjectionTables,
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
        ),'') variants,
        pcc.pinyin_text pinyin_text
       FROM ${staging.canonicals} pcc
       JOIN courses c ON c.id=pcc.course_id
       LEFT JOIN ${published.canonicals} published
         ON published.course_id=pcc.course_id
       WHERE published.course_id IS NULL
          OR published.match_text IS NOT pcc.match_text`,
    )
    .all<{
      course_id: number;
      name: string;
      family_label: string;
      teachers: string;
      variants: string;
      pinyin_text: string;
    }>();
  const teachers = await db
    .prepare(
      `SELECT s.teacher_id id, COALESCE(t.name,'') name, s.pinyin_text pinyin_text
       FROM ${staging.teacherSearch} s
       JOIN teachers t ON t.id=s.teacher_id
       LEFT JOIN ${published.teacherSearch} published
         ON published.teacher_id=s.teacher_id
       WHERE published.teacher_id IS NULL
          OR published.match_text IS NOT s.match_text`,
    )
    .all<{ id: number; name: string; pinyin_text: string }>();

  const splitNames = (value: string) =>
    value.split(NAME_SPLIT).map((part) => part.trim()).filter(Boolean);
  const courseUpdates = courses.results.flatMap((row) => {
    const pinyin = catalogPinyinText([
      row.name,
      row.family_label,
      publicCourseDisplayName(row.name),
      ...splitNames(row.teachers),
      ...splitNames(row.variants),
    ]);
    return pinyin === row.pinyin_text
      ? []
      : [{ id: row.course_id, pinyin }];
  });
  const teacherUpdates = teachers.results.flatMap((row) => {
    const pinyin = catalogPinyinText([row.name], { surname: true });
    return pinyin === row.pinyin_text ? [] : [{ id: row.id, pinyin }];
  });
  const statements = [
    ...chunk(courseUpdates, PINYIN_ROWS_PER_STATEMENT).map((rows) =>
      db
        .prepare(pinyinUpdateSql(staging.canonicals, "course_id", rows.length))
        .bind(
          ...rows.flatMap((row) => [row.id, row.pinyin]),
          ...rows.map((row) => row.id),
          generation,
          token,
        ),
    ),
    ...chunk(teacherUpdates, PINYIN_ROWS_PER_STATEMENT).map((rows) =>
      db
        .prepare(pinyinUpdateSql(staging.teacherSearch, "teacher_id", rows.length))
        .bind(
          ...rows.flatMap((row) => [row.id, row.pinyin]),
          ...rows.map((row) => row.id),
          generation,
          token,
        ),
    ),
  ];
  for (const group of chunk(statements, 1)) {
    await renewLease();
    await db.batch(group);
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
    bindLease(
      db,
      projectionUpsert({
        table: staging.canonicals,
        columns: canonicalColumns,
        keys: ["course_id"],
        selectSql: canonicalSelect(active.canonicals),
        preserveUnchangedPinyin: true,
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        staging.canonicals,
        ["course_id"],
        "SELECT id course_id FROM courses",
      ),
      generation,
      token,
    ),
    bindLease(
      db,
      projectionUpsert({
        table: staging.reviewCounts,
        columns: ["course_id", "teacher_id", "review_count"],
        keys: ["course_id", "teacher_id"],
        selectSql: aggregateSelect(),
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        staging.reviewCounts,
        ["course_id", "teacher_id"],
        visibleTextReviewsSql,
      ),
      generation,
      token,
    ),
    bindLease(
      db,
      projectionUpsert({
        table: staging.teacherCourseCounts,
        columns: ["teacher_id", "course_count"],
        keys: ["teacher_id"],
        selectSql: teacherCourseCountSelect(staging),
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        staging.teacherCourseCounts,
        ["teacher_id"],
        `SELECT DISTINCT ct.teacher_id
         FROM course_teachers ct
         JOIN courses c ON c.id=ct.course_id
         JOIN ${staging.canonicals} pcc ON pcc.course_id=c.id
         WHERE ${publicCourseVisibleSql("c")}`,
      ),
      generation,
      token,
    ),
    bindLease(
      db,
      projectionUpsert({
        table: staging.teacherSearch,
        columns: teacherSearchColumns,
        keys: ["teacher_id"],
        selectSql: teacherSearchSelect(active.teacherSearch),
        preserveUnchangedPinyin: true,
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        staging.teacherSearch,
        ["teacher_id"],
        "SELECT id teacher_id FROM teachers",
      ),
      generation,
      token,
    ),
    bindLease(
      db,
      projectionUpsert({
        table: staging.relationRatings,
        columns: ["course_id", "teacher_id", "rating"],
        keys: ["course_id", "teacher_id"],
        selectSql: relationRatingSelect(),
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        staging.relationRatings,
        ["course_id", "teacher_id"],
        `SELECT r.course_id,r.teacher_id
         FROM reviews r
         WHERE r.status='approved'${guestReviewBindingSql}
           AND r.overall IS NOT NULL`,
      ),
      generation,
      token,
    ),
    ...RELATION_TOTAL_CATEGORIES.map((category) => {
      const select = relationTotalSelect(staging, category);
      return bindLease(
        db,
        projectionUpsert({
          table: staging.relationTotals,
          columns: ["category", "n"],
          keys: ["category"],
          selectSql: select.sql,
        }),
        generation,
        token,
        select.args,
      );
    }),
    bindLease(
      db,
      `DELETE FROM ${staging.relationTotals}
       WHERE category NOT IN (${RELATION_TOTAL_CATEGORIES.map(() => "?").join(",")})
         AND ${refreshLeaseGuard}`,
      generation,
      token,
      [...RELATION_TOTAL_CATEGORIES],
    ),
  ];
  if (teacherReviewCounts) {
    stage.push(
      bindLease(
        db,
        projectionUpsert({
          table: staging.teacherReviewCounts,
          columns: ["teacher_id", "review_count", "name", "department"],
          keys: ["teacher_id"],
          selectSql: teacherReviewCountSelect(staging),
        }),
        generation,
        token,
      ),
      bindLease(
        db,
        staleKeyDelete(
          staging.teacherReviewCounts,
          ["teacher_id"],
          "SELECT id teacher_id FROM teachers",
        ),
        generation,
        token,
      ),
      bindLease(
        db,
        projectionUpsert({
          table: staging.teacherListTotals,
          columns: ["id", "n"],
          keys: ["id"],
          selectSql: teacherListTotalSelect(),
        }),
        generation,
        token,
      ),
      bindLease(
        db,
        `DELETE FROM ${staging.teacherListTotals}
         WHERE id<>1 AND ${refreshLeaseGuard}`,
        generation,
        token,
      ),
    );
  }
  await db.batch(stage);
  await refreshChangedPinyinTexts(
    db,
    generation,
    token,
    renewLease,
    staging,
    active,
  );
  await renewLease();
  // Browse staging reads the review-count staging rows committed above.
  // It stays after the pinyin rewrite so a lost lease there still stops
  // before these tables are filled. #932 turns the writes off entirely.
  // Migration 0063 can also land later. Either way, skip staging and the
  // publish below, and do not write catalog_browse_ready (clearing it to 0
  // would make an older instance rebuild again during the deploy window).
  const catalogBrowse =
    CATALOG_BROWSE_PROJECTION_ENABLED &&
    (await hasProjectionTable(db, "public_relation_browse_staging"));
  if (catalogBrowse) {
    await stagePublicCatalogBrowse({
      db,
      generation,
      token,
      renewLease,
      canonicals: staging.canonicals,
      reviewCounts: staging.reviewCounts,
      relationRatings: staging.relationRatings,
    });
  }
  const publishTable = (
    table: string,
    stagingTable: string,
    columns: readonly string[],
    keys: readonly string[],
  ) => [
    bindLease(
      db,
      projectionUpsert({
        table,
        columns,
        keys,
        selectSql: `SELECT ${columns.join(",")} FROM ${stagingTable} WHERE ${refreshLeaseGuard}`,
      }),
      generation,
      token,
    ),
    bindLease(
      db,
      staleKeyDelete(
        table,
        keys,
        `SELECT ${keys.join(",")} FROM ${stagingTable}`,
      ),
      generation,
      token,
    ),
  ];
  const publish: D1PreparedStatement[] = [
    ...publishTable(
      active.canonicals,
      staging.canonicals,
      canonicalColumns,
      ["course_id"],
    ),
    ...publishTable(
      active.reviewCounts,
      staging.reviewCounts,
      ["course_id", "teacher_id", "review_count"],
      ["course_id", "teacher_id"],
    ),
    ...publishTable(
      active.teacherCourseCounts,
      staging.teacherCourseCounts,
      ["teacher_id", "course_count"],
      ["teacher_id"],
    ),
    ...publishTable(
      active.teacherSearch,
      staging.teacherSearch,
      teacherSearchColumns,
      ["teacher_id"],
    ),
    ...publishTable(
      active.relationRatings,
      staging.relationRatings,
      ["course_id", "teacher_id", "rating"],
      ["course_id", "teacher_id"],
    ),
    ...publishTable(
      active.relationTotals,
      staging.relationTotals,
      ["category", "n"],
      ["category"],
    ),
  ];
  if (teacherReviewCounts) {
    publish.push(
      ...publishTable(
        active.teacherReviewCounts,
        staging.teacherReviewCounts,
        ["teacher_id", "review_count", "name", "department"],
        ["teacher_id"],
      ),
      ...publishTable(
        active.teacherListTotals,
        staging.teacherListTotals,
        ["id", "n"],
        ["id"],
      ),
      db.prepare(
        `UPDATE public_precompute_state
         SET teacher_review_counts_ready=1
         WHERE id=1
           AND dirty=1
           AND generation=?
           AND refresh_token=?
           AND refresh_lease_until>unixepoch()
           AND teacher_review_counts_ready IS NOT 1`,
      ).bind(generation, token),
    );
  }
  if (catalogBrowse) {
    const publishBrowse = (
      table: string,
      stagingTable: string,
      columns: readonly string[],
      keys: readonly string[],
    ) => {
      const keyOnly =
        columns.length === keys.length &&
        keys.every((key, index) => key === columns[index]);
      if (!keyOnly) return publishTable(table, stagingTable, columns, keys);
      return [
        bindLease(
          db,
          `INSERT INTO ${table}(${columns.join(",")})
           SELECT ${columns.join(",")} FROM ${stagingTable}
           WHERE ${refreshLeaseGuard}
           ON CONFLICT(${keys.join(",")}) DO NOTHING`,
          generation,
          token,
        ),
        bindLease(
          db,
          staleKeyDelete(
            table,
            keys,
            `SELECT ${keys.join(",")} FROM ${stagingTable}`,
          ),
          generation,
          token,
        ),
      ];
    };
    for (const spec of catalogBrowseProjections) {
      publish.push(
        ...publishBrowse(spec.active, spec.staging, spec.columns, spec.keys),
      );
    }
    publish.push(
      db.prepare(
        `UPDATE public_precompute_state
         SET ${CATALOG_BROWSE_READY_COLUMN}=1
         WHERE id=1
           AND dirty=1
           AND generation=?
           AND refresh_token=?
           AND refresh_lease_until>unixepoch()
           AND ${CATALOG_BROWSE_READY_COLUMN} IS NOT 1`,
      ).bind(generation, token),
    );
  }
  await db.batch(publish);
}
