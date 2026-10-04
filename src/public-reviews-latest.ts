import type { Context } from "hono";
import {
  publicCourseCategory,
  publicCourseDisplayName,
} from "./lib/public-course-presentation";
import {
  publicCreatedAt,
  publicGrade,
  publicHeadline,
} from "./lib/public-review-fields";
import {
  authoredReviewAuthorSql,
  authoredReviewJoinSql,
  publicAuthorFields,
  reservedAuthorSql,
} from "./public-handle";
import {
  guestReviewBindingSql,
  historicalPublicVisibleSql,
} from "./public-review-visibility";

const fail = (c: Context, error: string, status = 400) =>
  c.json({ error }, status as 400);

const integer = (v: unknown) => {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

type LatestCursor = { t: string; id: string };
type QueryParam = string | number;

const HISTORICAL_ID_PREFIX = "historical:";
const REVIEW_ID_PREFIX = "review:";

const encodeLatestCursor = (cursor: LatestCursor) =>
  btoa(JSON.stringify(cursor));

const decodeLatestCursor = (value: string | undefined): LatestCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as LatestCursor;
    return typeof parsed.t === "string" && typeof parsed.id === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const nextAsciiPrefix = (prefix: string) =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

const isAscii = (value: string) => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) return false;
  }
  return true;
};

// Indexed cursor shapes. 'historical:' || id compares as id, so the historical
// branch can seek (imported_at, id). Review public ids are 'review:' || id in
// text order, not integer order. 'review:' sorts after every 'historical:' id,
// so a cursor from the other branch is a plain timestamp bound.
type BranchCursor =
  | { kind: "none" }
  | { kind: "raw"; time: string; bound: string }
  | { kind: "before"; time: string }
  | { kind: "through"; time: string }
  | { kind: "expr"; time: string; id: string };

const branchCursor = (cursor: LatestCursor | null, prefix: string): BranchCursor => {
  if (!cursor) return { kind: "none" };
  if (!isAscii(cursor.id)) return { kind: "expr", time: cursor.t, id: cursor.id };
  if (cursor.id.startsWith(prefix)) {
    const bound = cursor.id.slice(prefix.length);
    return bound
      ? { kind: "raw", time: cursor.t, bound }
      : { kind: "before", time: cursor.t };
  }
  if (cursor.id < prefix) return { kind: "before", time: cursor.t };
  if (cursor.id >= nextAsciiPrefix(prefix)) return { kind: "through", time: cursor.t };
  return { kind: "expr", time: cursor.t, id: cursor.id };
};

const historicalCursorClause = (cursor: LatestCursor | null) => {
  const mode = branchCursor(cursor, HISTORICAL_ID_PREFIX);
  if (mode.kind === "none") return { sql: "", params: [] as QueryParam[] };
  if (mode.kind === "raw") {
    return {
      sql: "AND (phr.imported_at, phr.id) < (?, ?)",
      params: [mode.time, mode.bound],
    };
  }
  if (mode.kind === "before") {
    return { sql: "AND phr.imported_at < ?", params: [mode.time] };
  }
  if (mode.kind === "through") {
    return { sql: "AND phr.imported_at <= ?", params: [mode.time] };
  }
  return {
    sql: "AND (phr.imported_at < ? OR (phr.imported_at = ? AND ('historical:' || phr.id) < ?))",
    params: [mode.time, mode.time, mode.id],
  };
};

const reviewCursorClause = (cursor: LatestCursor | null) => {
  const mode = branchCursor(cursor, REVIEW_ID_PREFIX);
  if (mode.kind === "none") return { sql: "", params: [] as QueryParam[] };
  if (mode.kind === "raw") {
    return {
      sql: "AND (r.created_at, ('review:' || r.id)) < (?, ?)",
      params: [mode.time, `${REVIEW_ID_PREFIX}${mode.bound}`],
    };
  }
  if (mode.kind === "before") {
    return { sql: "AND r.created_at < ?", params: [mode.time] };
  }
  if (mode.kind === "through") {
    return { sql: "AND r.created_at <= ?", params: [mode.time] };
  }
  return {
    sql: "AND (r.created_at < ? OR (r.created_at = ? AND ('review:' || r.id) < ?))",
    params: [mode.time, mode.time, mode.id],
  };
};

const latestColumns =
  "id,course_id,teacher_id,comment,comment_format,headline,grade,course_name,course_code,teacher_name,created_at,author_public_code,author_avatar_key";

// UNION ALL ignores ORDER BY/LIMIT on a bare branch. Each branch is wrapped so
// SQLite can apply the cursor, walk the branch index, and stop at LIMIT rows
// before the outer query merges at most 2*(size+1) rows.
export function buildLatestPublicReviewsQuery(
  cursor: LatestCursor | null,
  limit: number,
): { sql: string; params: QueryParam[] } {
  const historicalCursor = historicalCursorClause(cursor);
  const reviewCursor = reviewCursorClause(cursor);
  const sql = `
    SELECT ${latestColumns}
    FROM (
      SELECT * FROM (
        SELECT 'historical:' || phr.id id, phr.course_id, phr.teacher_id, phr.comment,
          NULL comment_format, '' headline, NULL grade,
          c.name course_name, c.code course_code, t.name teacher_name,
          phr.imported_at created_at, ${reservedAuthorSql}
        FROM public_historical_reviews phr
        JOIN courses c ON c.id=phr.course_id
        JOIN teachers t ON t.id=phr.teacher_id
        WHERE 1=1${historicalPublicVisibleSql("phr")}
          ${historicalCursor.sql}
        ORDER BY phr.imported_at DESC, phr.id DESC
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT 'review:' || r.id id, r.course_id, r.teacher_id, r.comment,
          r.comment_format, r.headline, r.grade,
          c.name course_name, c.code course_code, t.name teacher_name,
          r.created_at, ${authoredReviewAuthorSql}
        FROM reviews r
        JOIN courses c ON c.id=r.course_id
        JOIN teachers t ON t.id=r.teacher_id
        ${authoredReviewJoinSql}
        WHERE r.status='approved'
          AND trim(COALESCE(r.comment,''))<>''${guestReviewBindingSql}
          ${reviewCursor.sql}
        ORDER BY r.created_at DESC, ('review:' || r.id) DESC
        LIMIT ?
      )
    ) latest_reviews
    ORDER BY created_at DESC, id DESC
    LIMIT ?`;
  return {
    sql,
    params: [...historicalCursor.params, limit, ...reviewCursor.params, limit, limit],
  };
}

export async function handleLatestPublicReviews(c: Context) {
  const size = Math.min(50, Math.max(1, integer(c.req.query("pageSize")) || 20));
  const rawCursor = c.req.query("cursor");
  const cursor = decodeLatestCursor(rawCursor);
  if (rawCursor && !cursor) return fail(c, "评价游标无效", 400);
  const page = buildLatestPublicReviewsQuery(cursor, size + 1);
  const raw = await c.env.DB.prepare(page.sql).bind(...page.params).all();
  const results = raw.results as Array<{
    id: string;
    course_id: number;
    teacher_id: number;
    comment: string;
    comment_format: string | null;
    headline: string | null;
    grade: string | null;
    course_name: string;
    course_code: string;
    teacher_name: string;
    created_at: string;
    author_public_code: number | null;
    author_avatar_key: number | null;
  }>;
  const hasMore = results.length > size;
  const rows = results.slice(0, size);
  const last = rows.at(-1);
  return c.json({
    items: rows.map((row) => {
      const rawName = row.course_name || "";
      const grade = publicGrade(row.grade);
      return {
        id: row.id,
        course_id: row.course_id,
        teacher_id: row.teacher_id,
        comment: row.comment,
        comment_format: row.comment_format || null,
        headline: publicHeadline(row.headline),
        ...(grade == null ? {} : { grade }),
        course_name: publicCourseDisplayName(rawName),
        course_code: row.course_code,
        teacher_name: row.teacher_name,
        category: publicCourseCategory(rawName, ""),
        created_at: publicCreatedAt(row.created_at),
        ...publicAuthorFields(row),
      };
    }),
    nextCursor:
      hasMore && last
        ? encodeLatestCursor({ t: last.created_at, id: last.id })
        : null,
  });
}
