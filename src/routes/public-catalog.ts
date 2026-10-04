import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { isAsciiLetterTerm } from "../lib/catalog-pinyin";
import { shouldShowScheduleNav } from "../lib/public-surface";
import {
  andSearchTermsWithPinyin,
  andSearchTermsWithTrigram,
  likeSql,
  parseSearchTerms,
} from "../lib/catalog-search";
import { buildCatalogSearchRanking } from "../lib/catalog-search-ranking";
import {
  groupEnglishLevelItems,
  isPublicListCategoryFilter,
  publicCategoryFilterError,
  publicOptionDisplayName,
  publicCourseVisibleSql,
  virtualPeSportDisplayName,
  virtualPeSportForTeacherName,
} from "../lib/public-course-presentation";
import {
  courseSchemeView,
  publicDimensionAverage,
  publicDimensionLabels,
} from "../lib/review-schemes";
import {
  PUBLIC_CATALOG_CACHE_CONTROL,
  PUBLIC_CATALOG_CACHE_TAG,
  isPublicCatalogCacheableRequest,
  isPublicCourseListCacheableRequest,
  isPublicLatestReviewsCacheableRequest,
  matchPublicCatalogCache,
  putPublicCatalogCache,
  setPublicCatalogCacheHeaders,
  shouldPutPublicCatalogCache,
  shouldUsePublicCatalogCacheApi,
} from "../lib/public-catalog-cache";
import {
  ensurePublicListPrecomputes,
  type PublicPrecomputeReadOptions,
} from "../public-list-precompute";
import {
  publicCourseCanonicalJoin,
  publicTeacherSearchJoin,
} from "../public-list-projection-plan";
import { deriveCourseCatalogMeta } from "../lib/course-metadata";
import {
  isDefaultCtaAvatarSha256,
  toPublicTeacher,
} from "../cta-teacher-homepage";
import {
  publicCreatedAt,
  publicGrade,
  publicHeadline,
  publicOverall,
} from "../lib/public-review-fields";
import {
  expandOverallStarFilter,
  parseReviewRatingFilter,
} from "../lib/review-overall";
import { relationDimensionKey } from "../lib/relation-four-dims";
import { loadRelationDimensionLabels } from "../lib/relation-projections";
import {
  queryPublicCourseRelations,
  queryPublicCourses,
  type PublicCourseListQuery,
  type PublicRelationListQuery,
} from "../public-catalog-query";
import {
  buildCatalogCandidateFtsQuery,
  CATALOG_FUZZY_SERVER_HARD_LIMIT,
} from "../lib/catalog-search-candidates";
import { handleLatestPublicReviews } from "../public-reviews-latest";
import { handleListReviewComments } from "../review-comments";
import { decoratePublicReviews } from "../review-endorsements";
import { readVoteActorId } from "../review-vote-actor";
import { loadRelationSignalPayloads } from "../relation-signals";
import { isLoopbackWorkerRequest } from "../ordinary-user-write-authorization";
import {
  authoredReviewAuthorSql,
  authoredReviewJoinSql,
  publicAuthorFields,
  reservedAuthorSql,
} from "../public-handle";
import {
  guestReviewBindingSql,
  historicalNotDeletedSql,
  historicalPublicVisibleSql,
  publicReviewBindingSql,
  reviewNotDeletedBindingSql,
} from "../public-review-visibility";
import { getCourseRelationSummaries } from "../review-summary";
import { publicPeCourseIdentity } from "../lib/public-pe-course-projection";
import {
  loadMappedPeCourseDetail,
  loadMappedPeSourceRelations,
  loadVirtualPeCourseDetail,
  peCourseFromTeacherRelation,
  resolvePublicPeReadTarget,
  virtualPeCourseListItem,
} from "../lib/public-pe-detail";
import {
  loadPublicPeRelationProjection,
  publicPeMappedSourceRelationExcludeSql,
} from "../lib/public-pe-relation-projection";
import { readSecret } from "../secrets";
import { loadSiteBanner } from "../site-banner";
import {
  clean,
  fail,
  hasValidAdminSession,
  integer,
  markServerTiming,
  pageArgs,
  parseTagCsv,
  publicCourseRawName,
  skipTurnstile,
  windowedPage,
  withMappedCourseNames,
  withPublicCourseCategory,
  type WindowedRow,
} from "./support";
import type { AppContext } from "./types";

const publicCatalogRoutes = new Hono<AppEnv>();

function publicPrecomputeReadOptions(
  c: AppContext,
  cacheable = isPublicCatalogCacheableRequest(c),
): PublicPrecomputeReadOptions {
  // Miniflare's deterministic test binding expects writes to be visible on the
  // immediately following read; production has no test auth binding.
  if (c.env.ORDINARY_USER_TEST_AUTH_SECRET) return {};
  if (!cacheable) return {};
  return {
    mode: "stale",
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    onStaleProjection: () => {
      c.set("publicCatalogProjectionStale", true);
    },
  };
}

function setPublicListCacheHeaders(c: AppContext) {
  setPublicCatalogCacheHeaders(
    c,
    "list",
    c.get("publicCatalogProjectionStale") === true,
  );
}

function storePublicListResponse(
  c: AppContext,
  response: Response,
  queryMs: number,
) {
  if (
    !shouldPutPublicCatalogCache(
      queryMs,
      c.get("publicCatalogProjectionStale") === true,
    )
  )
    return;
  c.executionCtx.waitUntil(putPublicCatalogCache(c.req.url, response.clone()));
}

const withCourseReviewScheme = <
  T extends {
    scheme_key?: unknown;
    category?: unknown;
    tag_csv?: unknown;
    name?: unknown;
    course_name?: unknown;
  },
>(
  row: T,
) => {
  const view = courseSchemeView(
    typeof row.scheme_key === "string" ? row.scheme_key : null,
    typeof row.category === "string" ? row.category : "",
    parseTagCsv(row.tag_csv),
  );
  const { scheme_key: _schemeKey, tag_csv: _tagCsv, ...rest } = row;
  return { ...withPublicCourseCategory(rest), ...view };
};
const withPublicCourseOption = <
  T extends {
    scheme_key?: unknown;
    category?: unknown;
    tag_csv?: unknown;
    name?: unknown;
    course_name?: unknown;
  },
>(
  row: T,
) => {
  const view = courseSchemeView(
    typeof row.scheme_key === "string" ? row.scheme_key : null,
    typeof row.category === "string" ? row.category : "",
    parseTagCsv(row.tag_csv),
  );
  const { scheme_key: _schemeKey, tag_csv: _tagCsv, ...rest } = row;
  return {
    ...withMappedCourseNames(
      rest,
      publicOptionDisplayName(publicCourseRawName(rest)),
    ),
    ...view,
  };
};
// 任课评价公开可见性规则与全站公开投影共用。
const publicReviewBinding = publicReviewBindingSql;
type PublicReviewCursor =
  | { source: number; key: string; total?: number }
  | {
      source: number;
      key: string;
      order: string | number;
      query: string;
      total: number;
    };
type PublicReviewSort = "recognized" | "latest" | "oldest";
type PublicReviewQuery = {
  sort: PublicReviewSort;
  /** 整星 1–5；空或缺省为全部（含无评分）。 */
  rating: number[] | null;
};
const publicReviewPageSize = (c: AppContext) =>
  Math.min(50, Math.max(1, integer(c.req.query("pageSize")) || 20));
function utf8ToBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToUtf8(encoded: string) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
const decodePublicReviewCursor = (
  value: string | undefined,
): PublicReviewCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(base64ToUtf8(value)) as PublicReviewCursor;
    return Number.isInteger(parsed.source) && typeof parsed.key === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
};
const encodePublicReviewCursor = (cursor: PublicReviewCursor) =>
  utf8ToBase64(JSON.stringify(cursor));
type ReviewSourceRelation = { courseId: number; teacherId: number };
const emptyPublicReviewPage = {
  items: [] as Awaited<ReturnType<typeof decoratePublicReviews>>,
  total: 0,
  nextCursor: null as string | null,
};
const getPublicReviewPage = async (
  db: D1Database,
  subject: "course_id" | "teacher_id",
  id: number | null,
  size: number,
  cursor: PublicReviewCursor | null,
  viewerUserId: string | null = null,
  teacherId: number | null = null,
  query: PublicReviewQuery | null = null,
  includeBlocked = false,
  recordTiming?: (name: string, durationMs: number) => void,
  sourceRelations: ReviewSourceRelation[] | null = null,
) => {
  if (sourceRelations && !sourceRelations.length) return emptyPublicReviewPage;
  const cursorSource = cursor && "source" in cursor ? cursor.source : -1;
  const cursorKey = cursor && "key" in cursor ? cursor.key : "";
  const reviewBinding = includeBlocked
    ? reviewNotDeletedBindingSql
    : viewerUserId
      ? publicReviewBinding
      : guestReviewBindingSql;
  const historicalBinding = includeBlocked
    ? historicalNotDeletedSql("phr")
    : historicalPublicVisibleSql("phr");
  /** 课程页评价按 课程×教师 作用域展示：选定教师时追加逐分支过滤。 */
  const teacherFilter = (alias: string) =>
    teacherId ? ` AND ${alias}.teacher_id=?` : "";
  const teacherBinds = teacherId ? [teacherId] : [];
  const pairFilter = (alias: string) =>
    sourceRelations
      ? ` AND (${sourceRelations
          .map(() => `(${alias}.course_id=? AND ${alias}.teacher_id=?)`)
          .join(" OR ")})`
      : "";
  const pairBinds = sourceRelations
    ? sourceRelations.flatMap((item) => [item.courseId, item.teacherId])
    : [];
  const filterParts: string[] = [];
  const filterBinds: unknown[] = [];
  if (query?.rating?.length) {
    const ratingValues = expandOverallStarFilter(query.rating);
    filterParts.push(
      `overall IN (${ratingValues.map(() => "?").join(",")})`,
    );
    filterBinds.push(...ratingValues);
  }
  const orderConfig: Record<
    PublicReviewSort,
    { expression: string; direction: "ASC" | "DESC" }
  > = {
    recognized: { expression: "endorsement_count", direction: "DESC" },
    latest: {
      expression: "COALESCE(created_at,'')",
      direction: "DESC",
    },
    oldest: {
      expression: "COALESCE(created_at,'9999-12-31 23:59:59')",
      direction: "ASC",
    },
  };
  const order = query ? orderConfig[query.sort] : null;
  const queryKey = query
    ? JSON.stringify([query.sort, query.rating])
    : "";
  const orderedCursor =
    query && cursor && "order" in cursor && cursor.query === queryKey
      ? cursor
      : null;
  const orderedCursorSql = orderedCursor
    ? ` AND (${order?.expression} ${order?.direction === "DESC" ? "<" : ">"} ?
         OR (${order?.expression}=? AND
           (source_order>? OR (source_order=? AND sort_key>?))))`
    : "";
  const reviewUnion = `
         SELECT 0 source_order,phr.id sort_key,'historical:' || phr.id id,
           phr.course_id,phr.teacher_id,phr.comment,NULL comment_format,
           '' headline,NULL grade,
           c.name course_name,c.code course_code,t.name teacher_name,
           COALESCE(signal.endorsement_count,0) endorsement_count,
           COALESCE(signal.challenge_count,0) challenge_count,
           NULL scheme_key,NULL scheme_version,NULL scores,
           NULL overall,phr.imported_at created_at,
           ${reservedAuthorSql}, phr.blocked_at
         FROM public_historical_reviews phr
         JOIN courses c ON c.id=phr.course_id
         JOIN teachers t ON t.id=phr.teacher_id
         LEFT JOIN public_review_signal_counts signal
           ON signal.source_kind='historical' AND signal.source_id=CAST(phr.id AS TEXT)
         WHERE ${
           sourceRelations
             ? `1=1${pairFilter("phr")}${historicalBinding}`
             : `phr.${subject}=?${teacherFilter("phr")}${historicalBinding}`
         }
         UNION ALL
         SELECT 2 source_order,printf('%020d',r.id) sort_key,'review:' || r.id id,
           r.course_id,r.teacher_id,r.comment,r.comment_format,
           r.headline,r.grade,
           c.name course_name,c.code course_code,t.name teacher_name,
           COALESCE(signal.endorsement_count,0) endorsement_count,
           COALESCE(signal.challenge_count,0) challenge_count,
           r.scheme_key,r.scheme_version,r.scores,
           r.overall,r.created_at,
           ${authoredReviewAuthorSql}, r.blocked_at
         FROM reviews r
         JOIN courses c ON c.id=r.course_id
         JOIN teachers t ON t.id=r.teacher_id
         LEFT JOIN public_review_signal_counts signal
           ON signal.source_kind='review' AND signal.source_id=CAST(r.id AS TEXT)
         ${authoredReviewJoinSql}
         WHERE ${
           sourceRelations
             ? `r.status='approved'
           AND trim(COALESCE(r.comment,''))<>''${reviewBinding}${pairFilter("r")}`
             : `r.${subject}=? AND r.status='approved'
           AND trim(COALESCE(r.comment,''))<>''${reviewBinding}${teacherFilter("r")}`
         }
       `;
  const filterSql = filterParts.length ? filterParts.join(" AND ") : "1=1";
  const pageSql = query
    ? `WHERE ${filterSql}${orderedCursorSql}
       ORDER BY ${order?.expression} ${order?.direction},source_order,sort_key LIMIT ?`
    : `WHERE source_order>? OR (source_order=? AND sort_key>?)
       ORDER BY source_order,sort_key LIMIT ?`;
  const baseBinds = sourceRelations
    ? [...pairBinds, ...pairBinds]
    : [id, ...teacherBinds, id, ...teacherBinds];
  const needsCount = query
    ? !(orderedCursor && "total" in orderedCursor)
    : !(cursor && "total" in cursor);
  const countPromise = needsCount
    ? db
        .prepare(`SELECT COUNT(*) n FROM (${reviewUnion}) public_reviews WHERE ${filterSql}`)
        .bind(...baseBinds, ...filterBinds)
        .first<{ n: number }>()
    : Promise.resolve({
        n: Number(((query ? orderedCursor : cursor) as { total?: number } | null)?.total) || 0,
      });
  const queryStarted = performance.now();
  const [pageResult, countResult] = await Promise.all([
    db
      .prepare(
        `SELECT source_order,sort_key,id,course_id,teacher_id,comment,comment_format,
         headline,grade,
         course_name,course_code,teacher_name,endorsement_count,challenge_count,
         scheme_key,scheme_version,scores,overall,created_at,
         author_public_code,author_avatar_key,blocked_at
         FROM (${reviewUnion}) public_reviews
         ${pageSql}`,
      )
      .bind(
        ...baseBinds,
        ...(query
          ? [
              ...filterBinds,
              ...(orderedCursor
                ? [
                    orderedCursor.order,
                    orderedCursor.order,
                    orderedCursor.source,
                    orderedCursor.source,
                    orderedCursor.key,
                  ]
                : []),
              size + 1,
            ]
          : [cursorSource, cursorSource, cursorKey, size + 1]),
      )
      .all(),
    countPromise,
  ]);
  const typedResults = (pageResult.results || []) as Array<
    Record<string, unknown> & { source_order: number; sort_key: string }
  >;
  recordTiming?.("query", performance.now() - queryStarted);
  const hasMore = typedResults.length > size;
  const page = typedResults.slice(0, size);
  const last = page.at(-1);
  const projectionStarted = performance.now();
  const decoratedItems = await decoratePublicReviews(
      db,
      page.map(
        ({
          source_order: _source,
          sort_key: _key,
          scheme_key: schemeKey,
          scheme_version: schemeVersion,
          scores,
          grade: rawGrade,
          blocked_at: blockedAt,
          ...review
        }) => {
          const dimensionAverage = publicDimensionAverage({
            schemeKey,
            schemeVersion,
            scores,
          });
          const dimensionLabels = publicDimensionLabels({
            schemeKey,
            schemeVersion,
            scores,
          });
          const grade = publicGrade(rawGrade);
          return {
            ...review,
            headline: publicHeadline(review.headline),
            ...(grade == null ? {} : { grade }),
            overall: publicOverall(review.overall),
            created_at: publicCreatedAt(review.created_at),
            ...publicAuthorFields(review),
            ...(dimensionAverage == null ? {} : { dimensionAverage }),
            ...(dimensionLabels == null ? {} : { dimensionLabels }),
            ...(includeBlocked && blockedAt ? { blocked: true } : {}),
          };
        },
      ),
      viewerUserId,
    );
  recordTiming?.("projection", performance.now() - projectionStarted);
  return {
    items: decoratedItems,
    total: Number(countResult?.n) || 0,
    nextCursor:
      hasMore && last
        ? encodePublicReviewCursor(
            query && order
              ? {
                  source: last.source_order,
                  key: last.sort_key,
                  order:
                    query.sort === "recognized"
                      ? Number(last.endorsement_count)
                      : query.sort === "latest"
                        ? String(last.created_at ?? "")
                        : String(last.created_at ?? "9999-12-31 23:59:59"),
                  query: queryKey,
                  total: Number(countResult?.n) || 0,
                }
              : {
                  source: last.source_order,
                  key: last.sort_key,
                  total: Number(countResult?.n) || 0,
                },
          )
        : null,
  };
};
const publicReviewViewerId = async (c: AppContext) => readVoteActorId(c);
const getPublicReviewPageFor = async (
  c: AppContext,
  subject: "course_id" | "teacher_id",
  id: number | null,
  size: number,
  cursor: PublicReviewCursor | null,
  teacherId: number | null = null,
  query: PublicReviewQuery | null = null,
  cacheable = false,
  sourceRelations: ReviewSourceRelation[] | null = null,
) =>
  getPublicReviewPage(
    c.env.DB,
    subject,
    id,
    size,
    cursor,
    cacheable ? null : await publicReviewViewerId(c),
    teacherId,
    query,
    cacheable ? false : await hasValidAdminSession(c),
    (name, durationMs) => markServerTiming(c, name, durationMs),
    sourceRelations,
  );
publicCatalogRoutes.get("/api/config", async (c) => {
  const turnstileSecret = await readSecret(c.env.TURNSTILE_SECRET);
  if (isPublicCatalogCacheableRequest(c)) {
    setPublicCatalogCacheHeaders(c, "config");
  }
  return c.json({
    siteName: c.env.SITE_NAME,
    universityName: c.env.UNIVERSITY_NAME,
    admin: false,
    showScheduleNav: shouldShowScheduleNav({
      publicSurface: c.env.PUBLIC_SURFACE,
      loopback: isLoopbackWorkerRequest(c),
    }),
    turnstileSiteKey:
      !skipTurnstile(turnstileSecret) &&
      c.env.TURNSTILE_SITE_KEY &&
      turnstileSecret
        ? c.env.TURNSTILE_SITE_KEY
        : "",
  });
});
publicCatalogRoutes.get("/api/site/banner", async (c) =>
  c.json(await loadSiteBanner(c.env.DB)),
);
publicCatalogRoutes.get("/api/search/candidates", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const kind = clean(c.req.query("kind"), 20);
  if (kind !== "course" && kind !== "teacher") {
    return fail(c, "kind 只允许 course 或 teacher", 400);
  }
  const query = clean(c.req.query("q"), 80);
  const requestedLimit = Number(c.req.query("limit") || "200");
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), CATALOG_FUZZY_SERVER_HARD_LIMIT))
    : 200;
  const ftsQuery = buildCatalogCandidateFtsQuery(query);
  if (!ftsQuery) {
    if (cacheable) setPublicListCacheHeaders(c);
    return c.json({ items: [], meta: { rows_read: 0, candidate_count: 0 } });
  }
  if (kind === "course") {
    const result = await c.env.DB.prepare(
      `WITH hits AS (
         SELECT rowid,bm25(course_search_fts) score
         FROM course_search_fts
         WHERE course_search_fts MATCH ?
         ORDER BY score
         LIMIT ?
       )
       SELECT c.id,c.name,c.code,c.department,pcc.pinyin_text pinyin,
        GROUP_CONCAT(DISTINCT t.name) teachers
       FROM hits
       JOIN courses c ON c.id=hits.rowid
       ${publicCourseCanonicalJoin}
       LEFT JOIN course_teachers ct ON ct.course_id=c.id
       LEFT JOIN teachers t ON t.id=ct.teacher_id
       WHERE ${publicCourseVisibleSql("c")}
       GROUP BY c.id
       ORDER BY hits.score,c.name,c.code,c.id`,
    )
      .bind(ftsQuery, limit)
      .all();
    const rows = (result.results || []) as Array<Record<string, unknown>>;
    if (cacheable) setPublicListCacheHeaders(c);
    return c.json({
      items: rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name || ""),
        code: String(row.code || ""),
        department: String(row.department || ""),
        teachers: row.teachers ? String(row.teachers).split(",") : [],
        pinyin: String(row.pinyin || ""),
      })),
      meta: {
        rows_read: Number((result as { meta?: { rows_read?: number } }).meta?.rows_read) || 0,
        candidate_count: rows.length,
      },
    });
  }
  const result = await c.env.DB.prepare(
    `WITH hits AS (
       SELECT rowid,bm25(teacher_search_fts) score
       FROM teacher_search_fts
       WHERE teacher_search_fts MATCH ?
       ORDER BY score
       LIMIT ?
     )
     SELECT t.id,t.name,t.department,pts.pinyin_text pinyin
       FROM hits
       JOIN teachers t ON t.id=hits.rowid
       ${publicTeacherSearchJoin}
      ORDER BY hits.score,t.name,t.department,t.id`,
  )
    .bind(ftsQuery, limit)
    .all();
  const rows = (result.results || []) as Array<Record<string, unknown>>;
  if (cacheable) setPublicListCacheHeaders(c);
  return c.json({
    items: rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
      department: String(row.department || ""),
      pinyin: String(row.pinyin || ""),
    })),
    meta: {
      rows_read: Number((result as { meta?: { rows_read?: number } }).meta?.rows_read) || 0,
      candidate_count: rows.length,
    },
  });
});
publicCatalogRoutes.get("/api/courses", async (c) => {
  const relations = clean(c.req.query("view"), 20) === "relations";
  const cacheable = isPublicCourseListCacheableRequest(c);
  const useCacheApi =
    cacheable && shouldUsePublicCatalogCacheApi(c.env);
  if (useCacheApi) {
    const cached = await matchPublicCatalogCache(c.req.url);
    if (cached) {
      markServerTiming(c, "cache", 0);
      return cached;
    }
  }
  const { page, size } = pageArgs(c);
  const search = clean(c.req.query("q"), 80);
  const cat = clean(c.req.query("category"), 20);
  const department = clean(c.req.query("department"), 80);
  const teacherId = integer(c.req.query("teacherId"));
  if (cat && !isPublicListCategoryFilter(cat))
    return fail(c, publicCategoryFilterError());
  const listQuery = {
    page,
    pageSize: size,
    q: search,
    category: cat,
    department,
    teacherId,
  };
  if (relations) {
    const viewerId = cacheable ? null : await publicReviewViewerId(c);
    const sortRaw = clean(c.req.query("sort"), 20);
    const query: PublicRelationListQuery = {
      ...listQuery,
      sort:
        sortRaw === "name" ? "name" : sortRaw === "rating" ? "rating" : "reviews",
    };
    const queryStarted = performance.now();
    const result = await queryPublicCourseRelations(
      c.env.DB,
      query,
      viewerId,
      publicPrecomputeReadOptions(c, cacheable),
    );
    const queryMs = performance.now() - queryStarted;
    markServerTiming(c, "query", queryMs);
    if (cacheable) setPublicListCacheHeaders(c);
    const response = c.json(result);
    if (useCacheApi) storePublicListResponse(c, response, queryMs);
    return response;
  }
  // 排序：默认投稿数优先（含搜索相关度），sort=name 按课名（Issue #203）。
  const query: PublicCourseListQuery = {
    ...listQuery,
    sort: clean(c.req.query("sort"), 20) === "name" ? "name" : "reviews",
  };
  const queryStarted = performance.now();
  const result = await queryPublicCourses(
    c.env.DB,
    query,
    publicPrecomputeReadOptions(c, cacheable),
  );
  const queryMs = performance.now() - queryStarted;
  markServerTiming(c, "query", queryMs);
  if (cacheable) setPublicListCacheHeaders(c);
  const response = c.json(result);
  if (useCacheApi) storePublicListResponse(c, response, queryMs);
  return response;
});
publicCatalogRoutes.get("/api/teachers", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const { page, size } = pageArgs(c);
  const search = clean(c.req.query("q"), 80);
  const searchTerms = parseSearchTerms(search);
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
  const args = searchGroup.args;
  const teacherRanking = buildCatalogSearchRanking(
    searchTerms,
    {
      exact: ["t.name"],
      prefix: ["t.name"],
      substring: ["t.name"],
      pinyin: "pts.pinyin_text",
      teacher: ["t.department"],
    },
    "teacher",
    args.length,
  );
  const teacherCount = () =>
    c.env.DB.prepare(
      `SELECT COUNT(*) n FROM teachers t ${publicTeacherSearchJoin} WHERE ${where}`,
    )
      .bind(...args)
      .first<{ n: number }>()
      .then((row) => row?.n || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT t.*,
       COALESCE(public_teacher_course_counts.course_count,0) course_count,
       COALESCE(teacher_review_counts.review_count,0) review_count,
       COUNT(*) OVER() window_total
      FROM teachers t
      ${publicTeacherSearchJoin}
      LEFT JOIN public_teacher_course_counts ON public_teacher_course_counts.teacher_id=t.id
      LEFT JOIN (SELECT teacher_id,SUM(review_count) review_count FROM public_review_counts GROUP BY teacher_id) teacher_review_counts ON teacher_review_counts.teacher_id=t.id
     WHERE ${where}
       ORDER BY ${teacherRanking.sql},review_count DESC,t.name,t.department,t.id
     LIMIT ? OFFSET ?`,
  )
    .bind(
      ...args,
      ...teacherRanking.args,
      size,
      (page - 1) * size,
    )
    .all();
  const pageRows = await windowedPage(
    results as WindowedRow[],
    page,
    teacherCount,
  );
  const totalCount = pageRows.total;
  if (cacheable) setPublicListCacheHeaders(c);
  return c.json({
    items: pageRows.items.map((row: Record<string, unknown>) => {
      const teacher = toPublicTeacher(row);
      const sport = virtualPeSportForTeacherName(
        typeof teacher.name === "string" ? teacher.name : "",
      );
      if (!sport) return teacher;
      return {
        ...teacher,
        course_count: Number(teacher.course_count || 0) + 1,
      };
    }),
    page,
    pageSize: size,
    total: totalCount,
    pages: Math.ceil(totalCount / size),
  });
});
publicCatalogRoutes.get("/api/teachers/:id", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const id = integer(c.req.param("id"));
  const [teacherResult, coursesResult] = await c.env.DB.batch<
    Record<string, unknown>
  >([
    c.env.DB.prepare(
      `SELECT t.*,
         COALESCE(public_teacher_course_counts.course_count,0) course_count,
         COALESCE((
           SELECT SUM(public_review_counts.review_count)
           FROM public_review_counts
           WHERE public_review_counts.teacher_id=t.id
         ),0) review_count,
         (SELECT ROUND(AVG(r.overall),1) FROM reviews r WHERE r.teacher_id=t.id AND r.status='approved'${guestReviewBindingSql}) rating
       FROM teachers t
       LEFT JOIN public_teacher_course_counts ON public_teacher_course_counts.teacher_id=t.id
       WHERE t.id=?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT c.*,COALESCE(visible_counts.review_count,0) review_count,
         (SELECT ROUND(AVG(r.overall),1) FROM reviews r WHERE r.course_id=c.id AND r.teacher_id=? AND r.status='approved'${guestReviewBindingSql}) rating
       FROM course_teachers ct
       JOIN courses taught ON taught.id=ct.course_id
       JOIN public_course_canonicals pcc ON pcc.course_id=taught.id
       JOIN courses c ON c.id=pcc.canonical_course_id
       LEFT JOIN public_review_counts visible_counts
         ON visible_counts.course_id=c.id AND visible_counts.teacher_id=ct.teacher_id
       WHERE ct.teacher_id=? AND ${publicCourseVisibleSql("taught")} AND ${publicCourseVisibleSql("c")}
         AND ${publicPeMappedSourceRelationExcludeSql("taught", "ct")}
       GROUP BY c.id
       ORDER BY review_count DESC,c.name,c.id`,
    ).bind(id, id),
  ]);
  const teacherRow = teacherResult.results[0];
  if (!teacherRow) return fail(c, "教师不存在", 404);
  const teacher = toPublicTeacher(teacherRow);
  const reviewCount = Number(teacher.review_count) || 0;
  const reviewPage = await getPublicReviewPageFor(
    c,
    "teacher_id",
    id,
    20,
    null,
    null,
    null,
    cacheable,
  );
  const courses = coursesResult.results;
  const publicCourses = groupEnglishLevelItems(
    courses.map(withPublicCourseCategory) as Array<{
      name: string;
      [key: string]: unknown;
    }>,
  );
  const peRelations = (await loadPublicPeRelationProjection(c.env.DB)).items.filter(
    (item) => item.teacher_id === id,
  );
  const peSpecs = new Set(peRelations.map((item) => item.specialization));
  for (const item of peRelations) {
    const peCourse = peCourseFromTeacherRelation(item);
    if (
      publicCourses.some(
        (course) => String(course.public_id ?? "") === peCourse.public_id,
      )
    ) {
      continue;
    }
    publicCourses.push(peCourse);
  }
  const teacherName =
    typeof teacher.name === "string" ? teacher.name : "";
  const visibleSport = virtualPeSportForTeacherName(teacherName);
  if (
    visibleSport &&
    !peSpecs.has(visibleSport.label) &&
    !publicCourses.some(
      (course) =>
        course.public_id === publicPeCourseIdentity(visibleSport.label) ||
        course.name === virtualPeSportDisplayName(visibleSport) ||
        Number(course.id) === visibleSport.id,
    )
  ) {
    publicCourses.push(
      virtualPeCourseListItem(visibleSport, [
        {
          id: id as number,
          name: teacherName,
        },
      ]),
    );
    teacher.course_count = Number(teacher.course_count || 0) + 1;
  }
  if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
  return c.json({
    teacher,
    courses: publicCourses,
    reviews: reviewPage.items,
    reviewCount,
    nextReviewCursor: reviewPage.nextCursor,
  });
});
publicCatalogRoutes.get("/api/teachers/:id/avatar", async (c) => {
  const id = integer(c.req.param("id"));
  if (!id) return fail(c, "教师不存在", 404);
  const teacher = await c.env.DB.prepare(
    `SELECT image_locked,avatar_sha256 FROM teachers WHERE id=?`,
  )
    .bind(id)
    .first<{ image_locked: number | null; avatar_sha256: string | null }>();
  if (!teacher) return fail(c, "教师不存在", 404);
  if (
    Number(teacher.image_locked) === 1 ||
    !teacher.avatar_sha256 ||
    isDefaultCtaAvatarSha256(teacher.avatar_sha256)
  ) {
    return fail(c, "没有可展示的教师头像", 404);
  }
  const stored = await c.env.DB.prepare(
    `SELECT content_type,sha256,bytes FROM teacher_avatars WHERE teacher_id=?`,
  )
    .bind(id)
    .first<{ content_type: string; sha256: string; bytes: ArrayBuffer }>();
  if (
    !stored?.bytes ||
    stored.sha256 !== teacher.avatar_sha256 ||
    isDefaultCtaAvatarSha256(stored.sha256)
  ) {
    return fail(c, "没有可展示的教师头像", 404);
  }
  const bytes = new Uint8Array(stored.bytes);
  return c.body(bytes, 200, {
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "Content-Type": stored.content_type || "image/webp",
  });
});
publicCatalogRoutes.get("/api/teachers/:id/reviews", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  const id = integer(c.req.param("id"));
  const teacher = await c.env.DB.prepare("SELECT id FROM teachers WHERE id=?")
    .bind(id)
    .first();
  if (!teacher) return fail(c, "教师不存在", 404);
  const rawCursor = c.req.query("cursor");
  const cursor = decodePublicReviewCursor(rawCursor);
  if (rawCursor && !cursor) return fail(c, "评价游标无效", 400);
  const page = await getPublicReviewPageFor(
    c,
    "teacher_id",
    id,
    publicReviewPageSize(c),
    cursor,
    null,
    null,
    cacheable,
  );
  if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
  return c.json(page);
});
publicCatalogRoutes.get("/api/courses/options", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const { page, size } = pageArgs(c);
  const search = clean(c.req.query("q"), 80);
  const searchTerms = parseSearchTerms(search);
  const searchGroup = andSearchTermsWithTrigram(
    searchTerms,
    (term) =>
      andSearchTermsWithPinyin(
        [term],
        likeSql("pcc.match_text"),
        likeSql("pcc.pinyin_text"),
        isAsciiLetterTerm,
      ),
    "pcc.course_id IN (SELECT rowid FROM course_search_fts WHERE course_search_fts MATCH ?)",
  );
  const where = `${publicCourseVisibleSql("c")}${searchGroup.sql ? ` AND ${searchGroup.sql}` : ""}`;
  const args = searchGroup.args;
  const optionRanking = buildCatalogSearchRanking(
    searchTerms,
    {
      exact: ["c.name", "c.code"],
      exactPredicates: ["EXISTS (SELECT 1 FROM course_name_variants cnv WHERE cnv.course_id=c.id AND lower(cnv.name)=$TERM)"],
      prefix: ["c.name", "c.code"],
      prefixPredicates: ["EXISTS (SELECT 1 FROM course_name_variants cnv WHERE cnv.course_id=c.id AND lower(cnv.name) LIKE $LITERAL || '%' ESCAPE '\\')"],
      substring: ["c.name", "c.code"],
      substringPredicates: ["EXISTS (SELECT 1 FROM course_name_variants cnv WHERE cnv.course_id=c.id AND lower(cnv.name) LIKE '%' || $LITERAL || '%' ESCAPE '\\')"],
      pinyin: "pcc.pinyin_text",
      teacher: ["c.department", "pcc.teacher_variant_text"],
      teacherExactPredicates: ["instr(pcc.teacher_variant_text, char(31) || $TERM || char(31)) > 0"],
    },
    "option",
    args.length,
  );
  const optionCount = () =>
    c.env.DB.prepare(
      `SELECT COUNT(*) n FROM courses c ${publicCourseCanonicalJoin} WHERE ${where}`,
    )
      .bind(...args)
      .first<{ n: number }>()
      .then((row) => row?.n || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT c.id,c.code,c.name,c.category,c.department,c.scheme_key,
       (SELECT GROUP_CONCAT(tag) FROM course_tags WHERE course_id=c.id) tag_csv,
       GROUP_CONCAT(DISTINCT t.name) teachers,
       COUNT(*) OVER() window_total
     FROM courses c ${publicCourseCanonicalJoin} LEFT JOIN course_teachers ct ON ct.course_id=c.id LEFT JOIN teachers t ON t.id=ct.teacher_id
     WHERE ${where} GROUP BY c.id ORDER BY ${searchTerms.length ? `${optionRanking.sql},` : ""}c.name,c.id LIMIT ? OFFSET ?`,
  )
    .bind(...args, ...(searchTerms.length ? optionRanking.args : []), size, (page - 1) * size)
    .all();
  const pageRows = await windowedPage(
    results as WindowedRow[],
    page,
    optionCount,
  );
  const totalCount = pageRows.total;
  if (cacheable) setPublicListCacheHeaders(c);
  return c.json({
    items: pageRows.items.map((row) => withPublicCourseOption(row)),
    page,
    pageSize: size,
    total: totalCount,
    pages: Math.ceil(totalCount / size),
  });
});
// 院筛选项：公开可见课程的去重非空院系（trim 去重）；为空时前端隐藏院系筛（Issue #203）。
publicCatalogRoutes.get("/api/courses/departments", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT trim(c.department) department
     FROM courses c
     ${publicCourseCanonicalJoin}
     WHERE ${publicCourseVisibleSql("c")}
       AND trim(COALESCE(c.department,''))<>''
     ORDER BY trim(c.department)`,
  ).all<{ department: string }>();
  if (cacheable) setPublicListCacheHeaders(c);
  return c.json({ items: results.map((row) => row.department) });
});
publicCatalogRoutes.get("/api/courses/:id", async (c) => {
  await ensurePublicListPrecomputes(c.env.DB, publicPrecomputeReadOptions(c));
  const peTarget = await resolvePublicPeReadTarget(c.env.DB, c.req.param("id"));
  if (peTarget.kind === "missing") return fail(c, "课程不存在", 404);
  if (peTarget.kind === "mapped" || peTarget.kind === "virtual") {
    const cacheable = isPublicCatalogCacheableRequest(c);
    const viewerId = cacheable ? null : await publicReviewViewerId(c);
    const payload =
      peTarget.kind === "mapped"
        ? await loadMappedPeCourseDetail(c.env.DB, peTarget.specialization, viewerId)
        : await loadVirtualPeCourseDetail(c.env.DB, peTarget.sport, viewerId);
    if (!payload) return fail(c, "课程不存在", 404);
    if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
    return c.json(payload);
  }
  const id = peTarget.courseId;
  const [
    courseResult,
    reviewCountResult,
    teachersResult,
    nameVariantsResult,
    tagRowsResult,
  ] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT c.*,
           (SELECT ROUND(AVG(r.overall),1) FROM reviews r WHERE r.course_id=c.id AND r.status='approved'${guestReviewBindingSql}) rating
         FROM courses c WHERE c.id=?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(review_count),0) count
         FROM public_review_counts WHERE course_id=?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT t.*,COALESCE(visible_counts.review_count,0) review_count,
           ratings.rating
         FROM teachers t
         JOIN course_teachers ct ON ct.teacher_id=t.id
         JOIN courses taught ON taught.id=ct.course_id
         JOIN courses requested ON requested.id=?
         JOIN public_course_canonicals taught_pcc ON taught_pcc.course_id=taught.id
         JOIN public_course_canonicals requested_pcc ON requested_pcc.course_id=requested.id
         LEFT JOIN public_review_counts visible_counts
           ON visible_counts.course_id=requested.id AND visible_counts.teacher_id=t.id
         LEFT JOIN public_relation_ratings ratings
           ON ratings.course_id=requested.id AND ratings.teacher_id=t.id
         WHERE ${publicCourseVisibleSql("taught")}
           AND taught_pcc.canonical_course_id=requested_pcc.canonical_course_id
         GROUP BY t.id
         ORDER BY review_count DESC,t.name,t.id`,
    ).bind(id),
    c.env.DB.prepare(
      "SELECT name,created_at FROM course_name_variants WHERE course_id=? ORDER BY name",
    ).bind(id),
    c.env.DB.prepare(
      "SELECT tag FROM course_tags WHERE course_id=? ORDER BY tag",
    ).bind(id),
  ]);
  const course = courseResult.results[0];
  if (!course) return fail(c, "课程不存在", 404);
  const reviewCount = Number(reviewCountResult.results[0]?.count) || 0;
  const teachers = teachersResult.results;
  const nameVariants = nameVariantsResult.results;
  // 课程详情不再直接返回评价流：评价按 课程×教师 作用域经 /reviews?teacherId= 获取。
  // 任课关系 AI 总结（#401）按教师 ID 索引随载荷下发；空总结不下发。
  if (id == null) return fail(c, "课程不存在", 404);
  const summaries = await getCourseRelationSummaries(c.env.DB, id);
  const cacheable = isPublicCatalogCacheableRequest(c);
  const viewerId = cacheable ? null : await publicReviewViewerId(c);
  const typedTeachers = teachers as Array<{
    id: number;
    name: string;
    review_count?: number;
    rating?: number | null;
  }>;
  const teacherIds = typedTeachers.map((teacher) => teacher.id);
  const [dimMap, signalMap] = await Promise.all([
    loadRelationDimensionLabels(
      c.env.DB,
      teacherIds.map((teacherId) => ({ courseId: id, teacherId })),
    ),
    loadRelationSignalPayloads(
      c.env.DB,
      teacherIds.map((teacherId) => ({ courseId: id, teacherId })),
      viewerId,
    ),
  ]);
  const tags = (tagRowsResult.results as Array<{ tag: string }>).map(
    (row) => row.tag,
  );
  const decoratedCourse = withCourseReviewScheme({
    ...course,
    tag_csv: tags.join(","),
  });
  const meta = deriveCourseCatalogMeta(course);
  if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
  return c.json({
    course: {
      ...decoratedCourse,
      ...meta,
      teachers: typedTeachers.map((teacher) => ({
        ...toPublicTeacher(teacher as Record<string, unknown>),
        dimensionLabels:
          dimMap.get(relationDimensionKey(id, teacher.id)) ?? null,
        ...(signalMap.get(`${id}:${teacher.id}`) ?? {
          follow_count: 0,
          recommend_count: 0,
          not_recommend_count: 0,
        }),
      })),
      nameVariants,
    },
    reviewCount,
    summaries,
  });
});
publicCatalogRoutes.get("/api/courses/:id/reviews", async (c) => {
  const cacheable = isPublicCatalogCacheableRequest(c);
  const teacherId = integer(c.req.query("teacherId"));
  const rawSort = clean(c.req.query("sort"), 20);
  const allowedSorts = new Set<PublicReviewSort>([
    "recognized",
    "latest",
    "oldest",
  ]);
  if (rawSort && !allowedSorts.has(rawSort as PublicReviewSort))
    return fail(c, "评价排序参数无效", 400);
  const rawRating = clean(c.req.query("rating"), 20);
  const rating = rawRating ? parseReviewRatingFilter(rawRating) : null;
  if (rawRating && rating == null) return fail(c, "评价评分参数无效", 400);
  const hasReviewQuery = Boolean(rawSort || c.req.query("rating"));
  const reviewQuery: PublicReviewQuery | null = hasReviewQuery
    ? {
        sort: (rawSort as PublicReviewSort) || "latest",
        rating,
      }
    : null;
  const peTarget = await resolvePublicPeReadTarget(c.env.DB, c.req.param("id"));
  if (peTarget.kind === "missing") return fail(c, "课程不存在", 404);
  if (peTarget.kind === "mapped") {
    const sources = await loadMappedPeSourceRelations(
      c.env.DB,
      peTarget.specialization,
      teacherId,
    );
    if (teacherId && !sources.length) return fail(c, "课程不存在", 404);
    const rawMappedCursor = c.req.query("cursor");
    const mappedCursor = decodePublicReviewCursor(rawMappedCursor);
    if (rawMappedCursor && !mappedCursor) return fail(c, "评价游标无效", 400);
    const page = await getPublicReviewPageFor(
      c,
      "course_id",
      null,
      publicReviewPageSize(c),
      mappedCursor,
      null,
      reviewQuery,
      cacheable,
      sources,
    );
    if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
    return c.json(page);
  }
  if (peTarget.kind === "virtual") {
    // 无映射时保留空虚拟行：未选教师返回空页，选定教师后按其教师流展示。
    if (!teacherId) {
      if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
      return c.json({ items: [], nextCursor: null });
    }
    const teacher = await c.env.DB.prepare(
      "SELECT id,name FROM teachers WHERE id=?",
    )
      .bind(teacherId)
      .first<{ id: number; name: string }>();
    if (
      !teacher ||
      !(peTarget.sport.teacherNames as readonly string[]).includes(teacher.name)
    )
      return fail(c, "课程不存在", 404);
    const rawVirtualCursor = c.req.query("cursor");
    const virtualCursor = decodePublicReviewCursor(rawVirtualCursor);
    if (rawVirtualCursor && !virtualCursor) return fail(c, "评价游标无效", 400);
    const page = await getPublicReviewPageFor(
        c,
        "teacher_id",
        teacherId,
        publicReviewPageSize(c),
        virtualCursor,
        null,
        reviewQuery,
        cacheable,
      );
    if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
    return c.json(page);
  }
  const id = peTarget.courseId;
  const course = await c.env.DB.prepare("SELECT id FROM courses WHERE id=?")
    .bind(id)
    .first();
  if (!course) return fail(c, "课程不存在", 404);
  const rawCursor = c.req.query("cursor");
  const cursor = decodePublicReviewCursor(rawCursor);
  if (rawCursor && !cursor) return fail(c, "评价游标无效", 400);
  const page = await getPublicReviewPageFor(
    c,
    "course_id",
    id,
    publicReviewPageSize(c),
    cursor,
    teacherId,
    reviewQuery,
    cacheable,
  );
  if (cacheable) setPublicCatalogCacheHeaders(c, "detail");
  return c.json(page);
});

publicCatalogRoutes.get("/api/reviews/latest", async (c) => {
  const response = await handleLatestPublicReviews(c);
  if (isPublicLatestReviewsCacheableRequest(c) && response.status < 400) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", PUBLIC_CATALOG_CACHE_CONTROL);
    headers.set("Cache-Tag", PUBLIC_CATALOG_CACHE_TAG);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
});

publicCatalogRoutes.get("/api/reviews/:id/comments", handleListReviewComments);

export default publicCatalogRoutes;
