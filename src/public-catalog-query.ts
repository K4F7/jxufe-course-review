import { isAsciiLetterTerm } from "./lib/catalog-pinyin";
import {
  andSearchTerms,
  containsPattern,
  likeSql,
  parseSearchTerms,
  type SearchFilter,
} from "./lib/catalog-search";
import { buildCatalogSearchRanking } from "./lib/catalog-search-ranking";
import {
  loadPublicCourseListExtras,
  loadPublicRelationListExtras,
  planMergedCatalogWindow,
  publicCatalogCourseRankingFields,
  publicCatalogIndexedCourseSearch,
  publicCatalogListScope,
  publicCatalogPageMeta,
} from "./lib/public-catalog-list";
import {
  publicCourseCategory,
  publicCourseDisplayName,
  publicCourseDisplayNameSql,
  publicCourseVisibleSql,
  publicRelationNameSortKey,
  publicRelationNameSortKeySql,
  publicRelationNameSortSql,
} from "./lib/public-course-presentation";
import {
  publicCourseIdentity,
  publicPeMappedSourceCourseExcludeSql,
  publicPeRelationIdentity,
  publicRelationIdentity,
} from "./lib/public-pe-course-projection";
import { publicPeMappedSourceRelationExcludeSql } from "./lib/public-pe-relation-projection";
import { relationDimensionKey } from "./lib/relation-four-dims";
import {
  loadGroupedRelationDimensionLabels,
  loadRelationDimensionLabels,
} from "./lib/relation-projections";
import type { PublicDimensionLabel } from "./lib/review-schemes";
import {
  ensurePublicListPrecomputes,
  ensureTeacherReviewCountProjection,
  isMissingPublicSchemaError,
  type PublicPrecomputeReadOptions,
} from "./public-list-precompute";
import {
  publicCourseCanonicalJoin,
  publicTeacherSearchJoin,
} from "./public-list-projection-plan";
import { guestReviewBindingSql } from "./public-review-visibility";
import {
  loadRelationSignalPayloads,
  type RelationSignalCounts,
  type RelationSignalViewer,
} from "./relation-signals";

export type PublicCourseListSort = "name" | "reviews";
export type PublicRelationListSort = "name" | "rating" | "reviews";

export type PublicCatalogListQuery<Sort extends string> = {
  page: number;
  pageSize: number;
  q: string;
  category: string;
  department: string;
  teacherId: number | null;
  sort: Sort;
};

export type PublicCourseListQuery = PublicCatalogListQuery<PublicCourseListSort>;
export type PublicRelationListQuery =
  PublicCatalogListQuery<PublicRelationListSort>;

export type PublicCatalogPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

export type PublicCourseListItem = {
  /** Ordinary Course identity is `courses.id`; PE public specializations are `null`. */
  id: number | null;
  /** `course:<id>` for ordinary rows; `pe:<normalizedSpecialization>` for PE public items. */
  public_id: string;
  code: string;
  name: string;
  category: string;
  department: string;
  teachers: string | null;
  teacher_refs: string | null;
  review_count: number;
};

export type PublicRelationListItem = {
  /** Ordinary Relation identity is `courses.id`; PE public specializations are `null`. */
  course_id: number | null;
  /** `relation:<courseId>:<teacherId>` for ordinary rows; `pe:<spec>:<teacherId>` for PE. */
  public_id: string;
  code: string;
  name: string;
  category: string;
  department: string;
  teacher_id: number | null;
  teacher_name: string | null;
  rating: number | null;
  review_count: number;
  dimensionLabels: PublicDimensionLabel[] | null;
} & RelationSignalCounts &
  Partial<RelationSignalViewer>;

type RelationRow = {
  course_id: number | null;
  public_id?: string;
  code: string;
  name: string;
  category: string;
  department: string;
  teacher_id: number | null;
  teacher_name: string | null;
  rating: number | null;
  review_count: number;
  source_course_ids?: number[];
};
type ExactTeacherHits = {
  ids: number[];
  matchedTerms: Set<string>;
  active: boolean;
};

const withPublicCourseItem = <
  T extends { id?: unknown; name?: unknown; category?: unknown },
>(
  row: T,
) => {
  const rawName = typeof row.name === "string" ? row.name : "";
  const id = Number(row.id);
  return {
    ...row,
    id,
    public_id: publicCourseIdentity(id),
    name: publicCourseDisplayName(rawName),
    category: publicCourseCategory(
      rawName,
      typeof row.category === "string" ? row.category : "",
    ),
  };
};

const withPublicRelationNames = (row: RelationRow): RelationRow & { public_id: string } => {
  const rawName = row.name || "";
  const courseId = row.course_id == null ? null : Number(row.course_id);
  const teacherId = row.teacher_id == null ? null : Number(row.teacher_id);
  const pePublic = (row.public_id ?? "").startsWith("pe:");
  const publicId =
    row.public_id ||
    (courseId == null
      ? publicPeRelationIdentity("", teacherId ?? 0)
      : publicRelationIdentity(courseId, teacherId));
  return {
    ...row,
    course_id: courseId,
    public_id: publicId,
    name: pePublic ? rawName : publicCourseDisplayName(rawName),
    category: pePublic
      ? "sports"
      : publicCourseCategory(rawName, row.category),
    rating: row.rating == null ? null : Number(row.rating),
    review_count: Number(row.review_count) || 0,
    teacher_id: teacherId,
  };
};

async function loadExactTeacherHits(
  db: D1Database,
  terms: string[],
): Promise<ExactTeacherHits> {
  if (!terms.length) return { ids: [], matchedTerms: new Set(), active: false };
  const placeholders = terms.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT id,name,source_teacher_label FROM teachers WHERE name IN (${placeholders}) OR source_teacher_label IN (${placeholders})`,
    )
    .bind(...terms, ...terms)
    .all<{ id: number; name: string; source_teacher_label: string }>();
  const matchedTerms = new Set<string>();
  const idsByTerm = new Map<string, Set<number>>();
  const termSet = new Set(terms);
  const addHit = (term: string, id: number) => {
    matchedTerms.add(term);
    const ids = idsByTerm.get(term) ?? new Set<number>();
    ids.add(id);
    idsByTerm.set(term, ids);
  };
  for (const row of results ?? []) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (termSet.has(row.name)) addHit(row.name, id);
    if (termSet.has(row.source_teacher_label)) {
      addHit(row.source_teacher_label, id);
    }
  }
  if (!idsByTerm.size) return { ids: [], matchedTerms, active: false };
  let intersection: Set<number> | undefined;
  for (const ids of idsByTerm.values()) {
    if (!intersection) {
      intersection = new Set(ids);
      continue;
    }
    for (const id of [...intersection]) {
      if (!ids.has(id)) intersection.delete(id);
    }
  }
  return { ids: [...(intersection ?? [])], matchedTerms, active: true };
}

function relationRowHit(terms: string[]): SearchFilter {
  if (!terms.length) return { sql: "", args: [] };
  const textSql = [
    likeSql("c.name"),
    likeSql("c.code"),
    likeSql("c.department"),
    likeSql("pcc.family_label"),
    likeSql("pcc.teacher_variant_text"),
    likeSql("t.name"),
    likeSql("t.source_teacher_label"),
  ].join(" OR ");
  return {
    sql: terms
      .map((term) =>
        isAsciiLetterTerm(term)
          ? `(${textSql} OR ${likeSql("pcc.pinyin_text")})`
          : `(${textSql})`,
      )
      .join(" AND "),
    args: terms.flatMap((term) => {
      const textArgs = andSearchTerms([term], textSql).args;
      return isAsciiLetterTerm(term)
        ? [...textArgs, containsPattern(term)]
        : textArgs;
    }),
  };
}

function extraPublicId(item: { public_id?: string }): string {
  return item.public_id ?? "";
}

/**
 * Mapped PE public rows have a null course id. They sort after every real id.
 * SQL binds NULL and `publicCourseBrowseNameBeforeSql` treats that the same way.
 */
function courseExtraSortId(item: { id?: number | null }): number | null {
  return item.id == null ? null : Number(item.id);
}

export function comparePublicCourseBrowseName(
  a: { id?: unknown; code?: unknown; name?: unknown; public_id?: unknown },
  b: { id?: unknown; code?: unknown; name?: unknown; public_id?: unknown },
) {
  const nameA = String(a.name ?? "");
  const nameB = String(b.name ?? "");
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  const codeA = String(a.code ?? "");
  const codeB = String(b.code ?? "");
  if (codeA !== codeB) return codeA < codeB ? -1 : 1;
  const idA = a.id == null ? Number.POSITIVE_INFINITY : Number(a.id);
  const idB = b.id == null ? Number.POSITIVE_INFINITY : Number(b.id);
  if (idA !== idB) return idA - idB;
  const publicA = String(a.public_id ?? "");
  const publicB = String(b.public_id ?? "");
  if (publicA !== publicB) return publicA < publicB ? -1 : 1;
  return 0;
}

/** `alias` is the courses table. Real rows only; null ids never appear here. */
export function publicCourseBrowseNameOrderSql(alias = "c"): string {
  return `(${publicCourseDisplayNameSql(alias)}),${alias}.code,${alias}.id`;
}

/**
 * Reals strictly before one merged extra. `extras.sort_id` NULL means the extra
 * id is null and therefore after every real id with the same 展示名 and 课号.
 */
export function publicCourseBrowseNameBeforeSql(displayNameSql: string): string {
  const name = `(${displayNameSql})`;
  return `(${name} < extras.sort_name
    OR (${name} = extras.sort_name AND c.code < extras.sort_code)
    OR (${name} = extras.sort_name AND c.code = extras.sort_code
      AND (extras.sort_id IS NULL OR c.id < extras.sort_id)))`;
}

function publicCourseBrowseReviewsBeforeSql(displayNameSql: string): string {
  const nameBefore = publicCourseBrowseNameBeforeSql(displayNameSql);
  return `(COALESCE(course_review_counts.review_count,0) > extras.review_count
    OR (COALESCE(course_review_counts.review_count,0) = extras.review_count
      AND ${nameBefore}))`;
}

function byNameCodeTeacher(a: RelationRow, b: RelationRow) {
  const keyA = publicRelationNameSortKey({
    name: String(a.name ?? ""),
    code: String(a.code ?? ""),
    course_id: a.course_id == null ? 0 : Number(a.course_id),
    teacher_name: a.teacher_name,
    teacher_id: a.teacher_id,
  });
  const keyB = publicRelationNameSortKey({
    name: String(b.name ?? ""),
    code: String(b.code ?? ""),
    course_id: b.course_id == null ? 0 : Number(b.course_id),
    teacher_name: b.teacher_name,
    teacher_id: b.teacher_id,
  });
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function relationReviewsOrderSql(nameSortSql: string): string {
  return `COALESCE(rel_counts.review_count,0) DESC,${nameSortSql}`;
}

function relationRatingOrderSql(nameSortSql: string): string {
  return `(rel_rating.rating IS NULL),rel_rating.rating DESC,${relationReviewsOrderSql(nameSortSql)}`;
}

function byRelationRating(a: RelationRow, b: RelationRow) {
  const aMissing = a.rating == null ? 1 : 0;
  const bMissing = b.rating == null ? 1 : 0;
  if (aMissing !== bMissing) return aMissing - bMissing;
  if (a.rating != null && b.rating != null && a.rating !== b.rating) {
    return b.rating - a.rating;
  }
  if (a.review_count !== b.review_count) return b.review_count - a.review_count;
  return byNameCodeTeacher(a, b);
}

function byRelationReviews(a: RelationRow, b: RelationRow) {
  if (a.review_count !== b.review_count) return b.review_count - a.review_count;
  return byNameCodeTeacher(a, b);
}

/** First 10 pages at the default pageSize; deeper pages keep the generic merge. */
const RELATION_BROWSE_FAST_OFFSET_LIMIT = 200;
const RELATION_BROWSE_REAL_FETCH_CAP = 1000;
const RELATION_REVIEW_COUNT_BROWSE_INDEX =
  "idx_public_review_counts_review_count";
const RELATION_RATING_BROWSE_INDEX = "idx_public_relation_ratings_rating";

/**
 * `indexed` pins the sort-key index. Only the unfiltered reviews threshold
 * probe sets it. The page query leaves the plan free so `review_count >= ?`
 * can range-scan. A category filter must not pin the index: `is_public_sports`
 * and `scheme_key` are selective, and walking review_count / rating order
 * reads almost every aggregate row.
 */
export function relationBrowseAggregateFromSql(
  sort: PublicRelationListSort,
  indexed = false,
): string {
  if (sort === "rating") {
    const index = indexed ? ` INDEXED BY ${RELATION_RATING_BROWSE_INDEX}` : "";
    return `FROM public_relation_ratings rel_rating${index}
      JOIN courses c ON c.id=rel_rating.course_id
      ${publicCourseCanonicalJoin}
      JOIN course_teachers ct
        ON ct.course_id=c.id AND ct.teacher_id=rel_rating.teacher_id
      JOIN teachers t ON t.id=rel_rating.teacher_id
      LEFT JOIN public_review_counts rel_counts
        ON rel_counts.course_id=c.id AND rel_counts.teacher_id=t.id`;
  }
  const index = indexed
    ? ` INDEXED BY ${RELATION_REVIEW_COUNT_BROWSE_INDEX}`
    : "";
  return `FROM public_review_counts rel_counts${index}
      JOIN courses c ON c.id=rel_counts.course_id
      ${publicCourseCanonicalJoin}
      JOIN course_teachers ct
        ON ct.course_id=c.id AND ct.teacher_id=rel_counts.teacher_id
      JOIN teachers t ON t.id=rel_counts.teacher_id
      LEFT JOIN public_relation_ratings rel_rating
        ON rel_rating.course_id=c.id AND rel_rating.teacher_id=t.id`;
}

function relationBrowseThresholdKey(sort: PublicRelationListSort): string {
  return sort === "rating" ? "rel_rating.rating" : "rel_counts.review_count";
}

/** Same joins and WHERE as the page, ordered only by the indexed sort key. */
export function relationBrowseThresholdProbeSql(
  sort: PublicRelationListSort,
  where: string,
): string {
  const key = relationBrowseThresholdKey(sort);
  return `SELECT ${key} AS sort_threshold
     ${relationBrowseAggregateFromSql(sort, true)}
     WHERE ${where}
     ORDER BY ${key} DESC
     LIMIT 1 OFFSET ?`;
}

function canUseRelationBrowseFastPath(
  query: PublicRelationListQuery,
  searchTerms: string[],
): boolean {
  return (
    searchTerms.length === 0 &&
    !query.department &&
    query.teacherId == null &&
    (query.sort === "reviews" || query.sort === "rating")
  );
}

/**
 * Pin review_count order only for the dense unfiltered reviews browse.
 * Category filters (sports especially) are selective, so INDEXED BY scans
 * nearly the whole aggregate before the rank is filled. Rating lists already
 * stop on the rating index; the extra probe only adds reads. Both fall back
 * to the #927 aggregate query and let the planner choose.
 */
export function relationBrowseUsesIndexedThreshold(
  query: Pick<PublicRelationListQuery, "category" | "sort">,
): boolean {
  return query.category.trim() === "" && query.sort === "reviews";
}

async function loadPrecomputedRelationTotal(
  db: D1Database,
  category: string,
): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `SELECT n FROM public_relation_list_totals WHERE category=?`,
      )
      .bind(category || "all")
      .first<{ n: number }>();
    return row ? Number(row.n) : null;
  } catch {
    return null;
  }
}

/**
 * The name key blocks an index-ordered stop. Read the indexed sort key at the
 * last requested rank under the same WHERE (filters drop aggregate rows, so the
 * rank is not the raw index offset). Keep every row at or above that key, then
 * apply the full order. No threshold when the filtered set is shorter than the
 * window; ties at the boundary stay in the candidate set.
 */
async function loadRelationBrowseThreshold(
  db: D1Database,
  input: {
    sort: PublicRelationListSort;
    where: string;
    args: unknown[];
    limit: number;
    offset: number;
  },
): Promise<number | null> {
  const rank = input.offset + input.limit;
  if (rank < 1) return null;
  const row = await db
    .prepare(relationBrowseThresholdProbeSql(input.sort, input.where))
    .bind(...input.args, rank - 1)
    .first<{ sort_threshold: number | null }>();
  if (row?.sort_threshold == null) return null;
  const value = Number(row.sort_threshold);
  return Number.isFinite(value) ? value : null;
}

async function loadRelationBrowseFromAggregate(
  db: D1Database,
  input: {
    sort: PublicRelationListSort;
    where: string;
    args: unknown[];
    limit: number;
    offset: number;
    indexedThreshold: boolean;
  },
): Promise<RelationRow[]> {
  const fromSql = relationBrowseAggregateFromSql(input.sort);
  const nameSortSql = publicRelationNameSortSql("c", "t");
  const orderBy =
    input.sort === "rating"
      ? relationRatingOrderSql(nameSortSql)
      : relationReviewsOrderSql(nameSortSql);
  const threshold = input.indexedThreshold
    ? await loadRelationBrowseThreshold(db, input)
    : null;
  const thresholdSql =
    threshold == null
      ? ""
      : ` AND ${relationBrowseThresholdKey(input.sort)} >= ?`;
  const { results } = await db
    .prepare(
      `SELECT c.id course_id,c.code,c.name,c.category,c.department,
       t.id teacher_id,t.name teacher_name,
       rel_rating.rating,
       COALESCE(rel_counts.review_count,0) review_count
      ${fromSql}
     WHERE ${input.where}${thresholdSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    )
    .bind(
      ...input.args,
      ...(threshold == null ? [] : [threshold]),
      input.limit,
      input.offset,
    )
    .all<RelationRow>();
  return results ?? [];
}

function emptyRelationSignals(
  viewerUserId: string | null,
): RelationSignalCounts & Partial<RelationSignalViewer> {
  return {
    follow_count: 0,
    recommend_count: 0,
    not_recommend_count: 0,
    ...(viewerUserId
      ? {
          viewer_followed: false,
          viewer_recommended: false,
          viewer_not_recommended: false,
        }
      : {}),
  };
}

async function attachRelationProjection(
  db: D1Database,
  items: RelationRow[],
  viewerUserId: string | null,
): Promise<PublicRelationListItem[]> {
  const ordinary = items.filter(
    (item): item is RelationRow & { course_id: number } => item.course_id != null,
  );
  const peItems = items.filter(
    (item): item is RelationRow & { public_id: string; teacher_id: number } =>
      item.course_id == null &&
      item.teacher_id != null &&
      Boolean(item.public_id),
  );
  const [dimMap, peDimMap, signalMap] = await Promise.all([
    loadRelationDimensionLabels(
      db,
      ordinary.map((item) => ({
        courseId: item.course_id,
        teacherId: item.teacher_id,
      })),
    ),
    loadGroupedRelationDimensionLabels(
      db,
      peItems.map((item) => ({
        key: item.public_id,
        sources: (item.source_course_ids ?? []).map((courseId) => ({
          courseId,
          teacherId: item.teacher_id,
        })),
      })),
    ),
    loadRelationSignalPayloads(
      db,
      ordinary
        .filter(
          (item): item is RelationRow & { course_id: number; teacher_id: number } =>
            item.teacher_id != null,
        )
        .map((item) => ({ courseId: item.course_id, teacherId: item.teacher_id })),
      viewerUserId,
    ),
  ]);
  return items.map((item) => {
    const { source_course_ids: _sourceCourseIds, ...rest } = item;
    const publicId =
      rest.public_id ||
      (item.course_id == null
        ? publicPeRelationIdentity("", item.teacher_id ?? 0)
        : publicRelationIdentity(item.course_id, item.teacher_id));
    const signals =
      item.course_id != null && item.teacher_id != null
        ? signalMap.get(`${item.course_id}:${item.teacher_id}`)
        : undefined;
    const dimensionLabels =
      item.course_id == null
        ? (peDimMap.get(publicId) ?? null)
        : (dimMap.get(relationDimensionKey(item.course_id, item.teacher_id)) ??
          null);
    return {
      ...rest,
      public_id: publicId,
      dimensionLabels,
      ...(signals ?? emptyRelationSignals(viewerUserId)),
    };
  });
}

function relationSortKey(item: RelationRow): string {
  return publicRelationNameSortKey({
    name: String(item.name ?? ""),
    code: String(item.code ?? ""),
    course_id: item.course_id == null ? 0 : Number(item.course_id),
    teacher_name: item.teacher_name,
    teacher_id: item.teacher_id,
  });
}

export async function queryPublicCourses(
  db: D1Database,
  query: PublicCourseListQuery,
  precompute: PublicPrecomputeReadOptions = {},
): Promise<PublicCatalogPage<PublicCourseListItem>> {
  await ensurePublicListPrecomputes(db, precompute);
  const { page, pageSize: size, teacherId, sort } = query;
  const search = query.q;
  const searchTerms = parseSearchTerms(search);
  const scope = publicCatalogListScope(query);
  const indexedSearchGroup = publicCatalogIndexedCourseSearch(searchTerms);
  const extrasAllUnsorted = await loadPublicCourseListExtras(db, {
    ...query,
    searchTerms,
  });
  const baseWhere = `${publicCourseVisibleSql("c")} AND ${publicPeMappedSourceCourseExcludeSql("c")} AND ${scope.sql}`;
  const baseArgs = scope.args;
  let where = `${baseWhere}${indexedSearchGroup.sql ? ` AND ${indexedSearchGroup.sql}` : ""}`;
  let args = [...baseArgs, ...indexedSearchGroup.args];

  // Exact course-code queries are common and do not need FTS/ranking work, but
  // only take the fast path after confirming the code exists and matches all
  // visibility/category/department/teacher filters.
  const exactCodeTerm =
    searchTerms.length === 1 && /^[A-Za-z0-9_-]+$/.test(searchTerms[0])
      ? searchTerms[0]
      : null;
  let exactCodeMatched = false;
  if (exactCodeTerm) {
    const exact = await db
      .prepare(
        `SELECT c.id FROM courses c ${publicCourseCanonicalJoin}
         LEFT JOIN course_teachers ct ON ct.course_id=c.id
         WHERE ${baseWhere} AND c.code=? LIMIT 1`,
      )
      .bind(...baseArgs, exactCodeTerm)
      .first();
    if (exact) {
      exactCodeMatched = true;
      where = `${baseWhere} AND c.code=?`;
      args = [...baseArgs, exactCodeTerm];
    }
  }
  const countJoins =
    teacherId === null
      ? publicCourseCanonicalJoin
      : `${publicCourseCanonicalJoin} LEFT JOIN course_teachers ct ON ct.course_id=c.id`;
  const courseCount = () =>
    db
      .prepare(
        `SELECT COUNT(DISTINCT c.id) n FROM courses c ${countJoins} WHERE ${where}`,
      )
      .bind(...args)
      .first<{ n: number }>()
      .then((row) => row?.n || 0);
  const displayNameSql = publicCourseDisplayNameSql("c");
  const sharedRanking = buildCatalogSearchRanking(
    searchTerms,
    {
      ...publicCatalogCourseRankingFields(displayNameSql),
      teacher: ["c.department", "pcc.teacher_variant_text"],
      teacherExactPredicates: [
        "instr(pcc.teacher_variant_text, char(31) || $TERM || char(31)) > 0",
      ],
    },
    "course",
    args.length,
  );
  const courseNameOrderSql = publicCourseBrowseNameOrderSql("c");
  const courseReviewsOrderSql = `COALESCE(course_review_counts.review_count,0) DESC,${courseNameOrderSql}`;
  const useSearchRank =
    sort !== "name" && !exactCodeMatched && searchTerms.length > 0;
  const relevanceOrder = useSearchRank
    ? `${sharedRanking.sql},${courseReviewsOrderSql}`
    : courseReviewsOrderSql;
  const searchRankArgs = useSearchRank ? sharedRanking.args : [];
  const mergeName = extrasAllUnsorted.length > 0 && sort === "name";
  const mergeReviews =
    extrasAllUnsorted.length > 0 &&
    sort !== "name" &&
    (searchTerms.length === 0 || exactCodeMatched);
  let extrasAll = extrasAllUnsorted;
  let pageExtras: PublicCourseListItem[] = [];
  let realOffset = (page - 1) * size;
  let realLimit = size;
  if (mergeName || mergeReviews) {
    const reviewCountJoin = `LEFT JOIN (SELECT course_id,SUM(review_count) review_count FROM public_review_counts GROUP BY course_id) course_review_counts ON course_review_counts.course_id=c.id`;
    const window = await planMergedCatalogWindow({
      db,
      extras: extrasAllUnsorted,
      compare: mergeName
        ? comparePublicCourseBrowseName
        : (left, right) =>
            right.review_count - left.review_count ||
            comparePublicCourseBrowseName(left, right),
      extraKey: extraPublicId,
      extraColumnSql: "extra_key,sort_name,sort_code,sort_id,review_count",
      extraRowSql: "(?,?,?,?,?)",
      extraBindsFor: (item) => [
        item.public_id,
        item.name,
        item.code,
        courseExtraSortId(item),
        item.review_count,
      ],
      selectCountSql: "COUNT(DISTINCT c.id)",
      fromSql: `FROM courses c ${countJoins}`,
      extraJoins: mergeReviews ? reviewCountJoin : "",
      where,
      beforePredicate: mergeName
        ? publicCourseBrowseNameBeforeSql(displayNameSql)
        : publicCourseBrowseReviewsBeforeSql(displayNameSql),
      args,
      start: realOffset,
      size,
    });
    extrasAll = window.extrasAll;
    pageExtras = window.pageExtras;
    realOffset = window.realOffset;
    realLimit = window.realLimit;
  }
  const [pageResult, countResult] = await Promise.all([
    realLimit === 0
      ? Promise.resolve({ results: [] as unknown[] })
      : db
          .prepare(
            `SELECT c.id,c.code,c.name,c.category,c.department,c.credits,c.description,
       c.created_at,c.scheme_key,c.enrollment_category,c.teaching_type,c.course_level,
       GROUP_CONCAT(DISTINCT t.id || ':' || t.name) teacher_refs,
       GROUP_CONCAT(DISTINCT t.name) teachers,
       COALESCE(course_review_counts.review_count,0) review_count
      FROM courses c
      ${publicCourseCanonicalJoin}
      LEFT JOIN course_teachers ct ON ct.course_id=c.id
      LEFT JOIN teachers t ON t.id=ct.teacher_id
      LEFT JOIN (SELECT course_id,SUM(review_count) review_count FROM public_review_counts GROUP BY course_id) course_review_counts ON course_review_counts.course_id=c.id
     WHERE ${where}
     GROUP BY c.id
     ORDER BY ${sort === "name" ? courseNameOrderSql : relevanceOrder}
     LIMIT ? OFFSET ?`,
          )
          .bind(
            ...args,
            ...searchRankArgs,
            realLimit + 1,
            realOffset,
          )
          .all(),
    courseCount(),
  ]);
  const pageRows = {
    items: (pageResult.results || []) as Array<Record<string, unknown>>,
    total: Number(countResult) || 0,
  };
  const listed = pageRows.items.slice(0, realLimit).map((row) =>
    withPublicCourseItem(row as PublicCourseListItem),
  );
  const realTotal = pageRows.total;
  const extras = mergeName || mergeReviews
    ? pageExtras
    : extrasAll.slice(
        Math.max(0, realOffset - realTotal),
        Math.max(0, realOffset - realTotal) + Math.max(0, size - listed.length),
      );
  const totalCount = realTotal + extrasAll.length;
  const items = mergeName
    ? [...listed, ...pageExtras].sort(comparePublicCourseBrowseName).slice(0, size)
    : mergeReviews
      ? [...listed, ...pageExtras]
          .sort(
            (left, right) =>
              right.review_count - left.review_count ||
              comparePublicCourseBrowseName(left, right),
          )
          .slice(0, size)
    : [...listed, ...extras].slice(0, size);
  return {
    items,
    ...publicCatalogPageMeta(page, size, totalCount),
  };
}

type RelationMergeKind = "name" | "rating" | "reviews";

export async function queryPublicCourseRelations(
  db: D1Database,
  query: PublicRelationListQuery,
  viewerUserId: string | null,
  precompute: PublicPrecomputeReadOptions = {},
): Promise<PublicCatalogPage<PublicRelationListItem>> {
  await ensurePublicListPrecomputes(db, precompute);
  const { page, pageSize: size, sort } = query;
  const search = query.q;
  const searchTerms = parseSearchTerms(search);
  const scope = publicCatalogListScope(query);
  const exactTeachers = await loadExactTeacherHits(db, searchTerms);
  const exactTeacherFilter = !exactTeachers.active
    ? ""
    : exactTeachers.ids.length === 0
      ? " AND 0"
      : ` AND ct.teacher_id IN (${exactTeachers.ids.map(() => "?").join(",")})`;
  const courseSearchTerms = searchTerms.filter(
    (term) => !exactTeachers.matchedTerms.has(term),
  );
  const searchGroup = publicCatalogIndexedCourseSearch(courseSearchTerms);
  const rowHit = relationRowHit(courseSearchTerms);
  const where = `${publicCourseVisibleSql("c")} AND ${publicPeMappedSourceRelationExcludeSql("c", "ct")} AND ${scope.sql}${searchGroup.sql ? ` AND ${searchGroup.sql}` : ""}${rowHit.sql ? ` AND ${rowHit.sql}` : ""}${exactTeacherFilter}`;
  const args = [
    ...scope.args,
    ...searchGroup.args,
    ...rowHit.args,
    ...exactTeachers.ids,
  ];
  const relationFrom = `FROM courses c
      ${publicCourseCanonicalJoin}
      JOIN course_teachers ct ON ct.course_id=c.id
      JOIN teachers t ON t.id=ct.teacher_id`;
  const ratingJoins = `
      LEFT JOIN public_review_counts rel_counts
        ON rel_counts.course_id=c.id AND rel_counts.teacher_id=t.id
      LEFT JOIN public_relation_ratings rel_rating
        ON rel_rating.course_id=c.id AND rel_rating.teacher_id=t.id`;
  const relationCount = () =>
    db
      .prepare(
        `SELECT COUNT(*) n
       ${relationFrom}
       WHERE ${where}`,
      )
      .bind(...args)
      .first()
      .then((row) => Number((row as { n?: number } | null)?.n) || 0);

  const displayNameSql = publicCourseDisplayNameSql("c");
  const nameSortSql = publicRelationNameSortSql("c", "t");
  const sharedRanking = buildCatalogSearchRanking(
    searchTerms,
    {
      ...publicCatalogCourseRankingFields(displayNameSql),
      teacher: ["t.name", "t.source_teacher_label", "c.department"],
    },
    "relation",
    args.length,
  );
  const reviewsOrder = relationReviewsOrderSql(nameSortSql);
  const ratingOrder = relationRatingOrderSql(nameSortSql);
  const useSearchRank = sort !== "name" && sort !== "rating" && searchTerms.length > 0;
  const orderBy =
    sort === "name"
      ? nameSortSql
      : sort === "rating"
        ? ratingOrder
        : useSearchRank
          ? `${sharedRanking.sql},${reviewsOrder}`
          : reviewsOrder;
  const searchRankArgs = useSearchRank ? sharedRanking.args : [];
  const extrasAllUnsorted =
    query.category && query.category !== "sports"
      ? []
      : await loadPublicRelationListExtras(db, {
          ...query,
          searchTerms,
          exactTeacherIds: exactTeachers.active ? exactTeachers.ids : null,
          courseSearchTerms,
        });
  const start = (page - 1) * size;
  if (canUseRelationBrowseFastPath(query, searchTerms)) {
    try {
      const realTotal =
        (await loadPrecomputedRelationTotal(db, query.category)) ??
        (await relationCount());
      const extrasTotal = extrasAllUnsorted.length;
      const totalCount = realTotal + extrasTotal;
      const withinFastWindow = start + size <= RELATION_BROWSE_FAST_OFFSET_LIMIT;
      if (withinFastWindow || extrasTotal === 0) {
        const take =
          extrasTotal === 0
            ? size + 1
            : Math.min(
                RELATION_BROWSE_REAL_FETCH_CAP,
                Math.max(start + size + extrasTotal + 16, size + 1),
              );
        const fastRows = await loadRelationBrowseFromAggregate(db, {
          sort,
          where,
          args,
          limit: take,
          offset: extrasTotal === 0 ? start : 0,
          indexedThreshold: relationBrowseUsesIndexedThreshold(query),
        });
        const listed = fastRows.map((row) => withPublicRelationNames(row));
        const compare = sort === "rating" ? byRelationRating : byRelationReviews;
        // Aggregate rows are only the scored prefix. Zero-count reviews and
        // unrated ratings are absent, so a full merged page is returned only
        // when every missing real sorts strictly after that page.
        let items: RelationRow[];
        let pageComplete: boolean;
        if (extrasTotal === 0) {
          items = listed.slice(0, size);
          pageComplete =
            items.length === size || start + items.length >= totalCount;
        } else {
          const aggregateExhausted = fastRows.length < take;
          const merged = [...listed, ...extrasAllUnsorted].sort(compare);
          items = merged.slice(start, start + size);
          const coversAll = listed.length + extrasTotal >= totalCount;
          const last = items[items.length - 1];
          const boundary = listed[listed.length - 1];
          const scoredPrefix =
            aggregateExhausted &&
            last != null &&
            (sort === "rating" ? last.rating != null : last.review_count > 0);
          const beforeUnfetched =
            !aggregateExhausted &&
            last != null &&
            boundary != null &&
            compare(last, boundary) < 0;
          pageComplete =
            coversAll ||
            (items.length === size && (scoredPrefix || beforeUnfetched));
        }
        if (pageComplete) {
          return {
            items: await attachRelationProjection(db, items, viewerUserId),
            ...publicCatalogPageMeta(page, size, totalCount),
          };
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "relation_browse_fast_path_failed",
          sort,
          category: query.category,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  const mergeKind: RelationMergeKind | null = !extrasAllUnsorted.length
    ? null
    : sort === "name"
      ? "name"
      : sort === "rating"
        ? "rating"
        : searchTerms.length === 0
          ? "reviews"
          : null;
  let extrasAll = extrasAllUnsorted;
  let pageExtras: RelationRow[] = [];
  let realOffset = start;
  let realLimit = size;

  if (mergeKind) {
    const sortKeySql = publicRelationNameSortKeySql("c", "t");
    const window = await planMergedCatalogWindow({
      db,
      extras: extrasAllUnsorted,
      compare:
        mergeKind === "name"
          ? byNameCodeTeacher
          : mergeKind === "rating"
            ? byRelationRating
            : byRelationReviews,
      extraKey: extraPublicId,
      extraColumnSql:
        mergeKind === "name"
          ? "extra_key,sort_key"
          : mergeKind === "reviews"
            ? "extra_key,review_count,sort_key"
            : "extra_key,rating_missing,rating,review_count,sort_key",
      extraRowSql:
        mergeKind === "name"
          ? "(?,?)"
          : mergeKind === "rating"
            ? "(?,?,?,?,?)"
            : "(?,?,?)",
      extraBindsFor: (extra) =>
        mergeKind === "name"
          ? [extraPublicId(extra), relationSortKey(extra)]
          : mergeKind === "reviews"
            ? [extraPublicId(extra), extra.review_count, relationSortKey(extra)]
            : [
                extraPublicId(extra),
                extra.rating == null ? 1 : 0,
                extra.rating ?? 0,
                extra.review_count,
                relationSortKey(extra),
              ],
      selectCountSql: "COUNT(*)",
      fromSql: relationFrom,
      extraJoins: mergeKind === "name" ? "" : ratingJoins,
      where,
      beforePredicate:
        mergeKind === "name"
          ? `${sortKeySql} < extras.sort_key`
          : mergeKind === "reviews"
            ? `(COALESCE(rel_counts.review_count,0) > extras.review_count
             OR (COALESCE(rel_counts.review_count,0) = extras.review_count
               AND ${sortKeySql} < extras.sort_key))`
            : `((CASE WHEN rel_rating.rating IS NULL THEN 1 ELSE 0 END) < extras.rating_missing
             OR ((CASE WHEN rel_rating.rating IS NULL THEN 1 ELSE 0 END) = extras.rating_missing
               AND (
                 (extras.rating_missing = 0 AND rel_rating.rating > extras.rating)
                 OR (
                   (extras.rating_missing = 1 OR rel_rating.rating = extras.rating)
                   AND (
                     COALESCE(rel_counts.review_count,0) > extras.review_count
                     OR (
                       COALESCE(rel_counts.review_count,0) = extras.review_count
                       AND ${sortKeySql} < extras.sort_key
                     )
                   )
                 )
               )))`,
      args,
      start,
      size,
    });
    extrasAll = window.extrasAll;
    pageExtras = window.pageExtras;
    realOffset = window.realOffset;
    realLimit = window.realLimit;
  }

  const [pageResult, countResult] = await Promise.all([
    realLimit === 0
      ? Promise.resolve({ results: [] as unknown[] })
      : db
          .prepare(
            `SELECT c.id course_id,c.code,c.name,c.category,c.department,
       t.id teacher_id,t.name teacher_name,
       rel_rating.rating,
       COALESCE(rel_counts.review_count,0) review_count
      ${relationFrom}
      ${ratingJoins}
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
          )
          .bind(...args, ...searchRankArgs, realLimit + 1, realOffset)
          .all(),
    canUseRelationBrowseFastPath(query, searchTerms)
      ? loadPrecomputedRelationTotal(db, query.category).then(
          (n) => n ?? relationCount(),
        )
      : relationCount(),
  ]);

  const rows = ((pageResult.results || []) as RelationRow[]).slice(0, realLimit);
  const listed = rows.map((row) => withPublicRelationNames(row));
  const extras = mergeKind
    ? pageExtras
    : extrasAllUnsorted.filter(
        (item) =>
          !listed.some((row) => extraPublicId(row) === extraPublicId(item)),
      );
  const extrasTotal = mergeKind ? extrasAll.length : extras.length;
  const realTotal = Number(countResult) || 0;
  const totalCount = realTotal + extrasTotal;
  let items: RelationRow[];
  if (mergeKind === "name") {
    items = [...listed, ...pageExtras].sort(byNameCodeTeacher).slice(0, size);
  } else if (mergeKind === "rating") {
    items = [...listed, ...pageExtras].sort(byRelationRating).slice(0, size);
  } else if (mergeKind === "reviews") {
    items = [...listed, ...pageExtras].sort(byRelationReviews).slice(0, size);
  } else if (extras.length) {
    items =
      start >= realTotal
        ? extras.slice(start - realTotal, start - realTotal + size)
        : [
            ...listed,
            ...extras.slice(0, Math.max(0, start + size - realTotal)),
          ];
  } else {
    items = listed;
  }

  return {
    items: await attachRelationProjection(db, items.slice(0, size), viewerUserId),
    ...publicCatalogPageMeta(page, size, totalCount),
  };
}

export const PUBLIC_TEACHER_REVIEW_BROWSE_INDEX =
  "idx_public_teacher_review_counts_browse";

/** Inner page scan. The index order is the unfiltered teacher browse order. */
export const publicTeacherBrowsePageSql = `
  SELECT teacher_id,review_count,name,department
  FROM public_teacher_review_counts INDEXED BY ${PUBLIC_TEACHER_REVIEW_BROWSE_INDEX}
  ORDER BY review_count DESC,name,department,teacher_id
  LIMIT ? OFFSET ?`;

export type PublicTeacherListRequest = {
  page: number;
  pageSize: number;
  hasSearch: boolean;
  where: string;
  args: unknown[];
  rankingSql: string;
  rankingArgs: unknown[];
};

const legacyTeacherReviewJoin = `LEFT JOIN (
  SELECT teacher_id,SUM(review_count) review_count
  FROM public_review_counts
  GROUP BY teacher_id
) teacher_review_counts ON teacher_review_counts.teacher_id=t.id`;

const precomputedTeacherReviewJoin =
  "LEFT JOIN public_teacher_review_counts ON public_teacher_review_counts.teacher_id=t.id";

function withoutWindowTotal(row: Record<string, unknown>) {
  const { window_total: _windowTotal, ...rest } = row;
  return rest;
}

async function countJoinedTeachers(
  db: D1Database,
  where: string,
  args: unknown[],
) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) n FROM teachers t ${publicTeacherSearchJoin} WHERE ${where}`,
    )
    .bind(...args)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

async function loadPrecomputedTeacherTotal(db: D1Database) {
  const stored = await db
    .prepare(`SELECT n FROM public_teacher_list_totals WHERE id=1`)
    .first<{ n: number }>();
  if (stored) return Number(stored.n) || 0;
  const counted = await db
    .prepare(`SELECT COUNT(*) n FROM public_teacher_review_counts`)
    .first<{ n: number }>();
  return Number(counted?.n) || 0;
}

async function queryPrecomputedTeacherBrowse(
  db: D1Database,
  request: PublicTeacherListRequest,
) {
  const offset = (request.page - 1) * request.pageSize;
  const { results } = await db
    .prepare(
      `SELECT t.*,
         COALESCE(public_teacher_course_counts.course_count,0) course_count,
         page.review_count review_count
       FROM (${publicTeacherBrowsePageSql}) page
       JOIN teachers t ON t.id=page.teacher_id
       LEFT JOIN public_teacher_course_counts
         ON public_teacher_course_counts.teacher_id=page.teacher_id
       ORDER BY page.review_count DESC,page.name,page.department,page.teacher_id`,
    )
    .bind(request.pageSize, offset)
    .all<Record<string, unknown>>();
  return {
    rows: results ?? [],
    total: await loadPrecomputedTeacherTotal(db),
  };
}

async function queryJoinedTeacherList(
  db: D1Database,
  request: PublicTeacherListRequest,
  reviewJoin: string,
  reviewExpr: string,
) {
  const offset = (request.page - 1) * request.pageSize;
  const { results } = await db
    .prepare(
      `SELECT t.*,
         COALESCE(public_teacher_course_counts.course_count,0) course_count,
         ${reviewExpr} review_count,
         COUNT(*) OVER() window_total
       FROM teachers t
       ${publicTeacherSearchJoin}
       LEFT JOIN public_teacher_course_counts
         ON public_teacher_course_counts.teacher_id=t.id
       ${reviewJoin}
       WHERE ${request.where}
       ORDER BY ${request.rankingSql},review_count DESC,t.name,t.department,t.id
       LIMIT ? OFFSET ?`,
    )
    .bind(
      ...request.args,
      ...request.rankingArgs,
      request.pageSize,
      offset,
    )
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  if (rows.length) {
    return {
      rows: rows.map(withoutWindowTotal),
      total: Number(rows[0]?.window_total) || 0,
    };
  }
  if (request.page <= 1) return { rows: [], total: 0 };
  return {
    rows: [],
    total: await countJoinedTeachers(db, request.where, request.args),
  };
}

export async function queryPublicTeacherList(
  db: D1Database,
  request: PublicTeacherListRequest,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const ready = await ensureTeacherReviewCountProjection(db);
  if (!request.hasSearch && ready) {
    try {
      return await queryPrecomputedTeacherBrowse(db, request);
    } catch (error) {
      if (!isMissingPublicSchemaError(error)) throw error;
    }
  }
  if (ready) {
    try {
      return await queryJoinedTeacherList(
        db,
        request,
        precomputedTeacherReviewJoin,
        "COALESCE(public_teacher_review_counts.review_count,0)",
      );
    } catch (error) {
      if (!isMissingPublicSchemaError(error)) throw error;
    }
  }
  return queryJoinedTeacherList(
    db,
    request,
    legacyTeacherReviewJoin,
    "COALESCE(teacher_review_counts.review_count,0)",
  );
}

function teacherHeadSql(reviewExpr: string, reviewJoin: string) {
  return `SELECT t.*,
    COALESCE(public_teacher_course_counts.course_count,0) course_count,
    ${reviewExpr} review_count,
    (SELECT ROUND(AVG(r.overall),1) FROM reviews r
      WHERE r.teacher_id=t.id AND r.status='approved'${guestReviewBindingSql}) rating
   FROM teachers t
   LEFT JOIN public_teacher_course_counts
     ON public_teacher_course_counts.teacher_id=t.id
   ${reviewJoin}
   WHERE t.id=?`;
}

export async function loadPublicTeacherHead(
  db: D1Database,
  id: number | null,
): Promise<Record<string, unknown> | null> {
  const ready = await ensureTeacherReviewCountProjection(db);
  const load = (sql: string) =>
    db.prepare(sql).bind(id).first<Record<string, unknown>>();
  if (ready) {
    try {
      return await load(
        teacherHeadSql(
          "COALESCE(public_teacher_review_counts.review_count,0)",
          precomputedTeacherReviewJoin,
        ),
      );
    } catch (error) {
      if (!isMissingPublicSchemaError(error)) throw error;
    }
  }
  return load(
    teacherHeadSql(
      `COALESCE((
         SELECT SUM(public_review_counts.review_count)
         FROM public_review_counts
         WHERE public_review_counts.teacher_id=t.id
       ),0)`,
      "",
    ),
  );
}
