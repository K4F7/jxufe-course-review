import { sourceLabelForPackageContract } from "./historical-review-packages";
import {
  publicCourseCategory,
  publicCourseDisplayName,
} from "./lib/public-course-presentation";
import {
  publicCreatedAt,
  publicGrade,
  publicHeadline,
} from "./lib/public-review-fields";
import { resolveOrdinaryUser } from "./ordinary-user-authentication";
import {
  isOrdinaryUserAuthenticated,
  requireOrdinaryWriteUser,
} from "./ordinary-user-write-authorization";
import {
  FIRST_USER_PUBLIC_CODE,
  RESERVED_PUBLIC_CODE,
  defaultAvatarKey,
  findUserByPublicCode,
  formatPublicCode,
  formatPublicHandle,
  parsePublicCodeParam,
} from "./public-handle";
import {
  historicalPublicVisibleSql,
  publicReviewBindingSql,
} from "./public-review-visibility";
import type { AppContext } from "./routes/types";

const fail = (c: AppContext, error: string, status = 400) =>
  c.json({ error }, status as 400);

const PROFILE_REVIEW_PAGE_SIZE = 50;

export const RESERVED_PUBLIC_PROFILE_NOTE =
  "来自以前的学长学姐的评价，部分整理自 QQ 频道「江西财经大学」";

const reservedReviewsUnion = `
  SELECT 'historical:' || phr.id id, phr.course_id, phr.teacher_id, phr.comment,
    NULL comment_format, '' headline, NULL grade,
    c.name course_name, c.code course_code, t.name teacher_name,
    phr.imported_at created_at, phr.package_contract package_contract
  FROM public_historical_reviews phr
  JOIN courses c ON c.id=phr.course_id
  JOIN teachers t ON t.id=phr.teacher_id
  WHERE 1=1${historicalPublicVisibleSql("phr")}
  UNION ALL
  SELECT 'review:' || r.id id, r.course_id, r.teacher_id, r.comment,
    r.comment_format, r.headline, r.grade,
    c.name course_name, c.code course_code, t.name teacher_name,
    r.created_at, NULL AS package_contract
  FROM reviews r
  JOIN courses c ON c.id=r.course_id
  JOIN teachers t ON t.id=r.teacher_id
  WHERE r.status='approved'
    AND r.author_user_id IS NULL
    AND trim(COALESCE(r.comment,''))<>''${publicReviewBindingSql}
`;

const authoredReviewsSql = `
  SELECT 'review:' || r.id id, r.course_id, r.teacher_id, r.comment,
    r.comment_format, r.headline, r.grade,
    c.name course_name, c.code course_code, t.name teacher_name,
    r.created_at, NULL AS package_contract
  FROM reviews r
  JOIN courses c ON c.id=r.course_id
  JOIN teachers t ON t.id=r.teacher_id
  WHERE r.status='approved'
    AND r.author_user_id=?
    AND trim(COALESCE(r.comment,''))<>''${publicReviewBindingSql}
`;

type PublicAuthorReviewRow = {
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
  package_contract: string | null;
};

function mapPublicAuthorReviews(
  rows: PublicAuthorReviewRow[],
  publicCode: number,
  avatarKey: number,
) {
  return rows.map((row) => {
    const rawName = row.course_name || "";
    const grade = publicGrade(row.grade);
    const sourceLabel = sourceLabelForPackageContract(row.package_contract);
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
      author_public_code: publicCode,
      author_avatar_key: avatarKey,
      ...(sourceLabel ? { source_label: sourceLabel } : {}),
    };
  });
}

function profileReviewSourceSql(reserved: boolean) {
  return reserved ? reservedReviewsUnion : authoredReviewsSql;
}

async function loadPublicProfile(
  db: D1Database,
  publicCode: number,
  viewerId: string | null,
) {
  const author = await findUserByPublicCode(db, publicCode);
  if (!author) return null;
  const reserved = publicCode === RESERVED_PUBLIC_CODE;
  const reviewsSql = profileReviewSourceSql(reserved);
  const prepareListedReviews = (sql: string) => {
    const statement = db.prepare(sql);
    return reserved ? statement : statement.bind(author.id);
  };
  const countStmt = prepareListedReviews(
    `SELECT COUNT(DISTINCT course_id) AS review_count
     FROM (${reviewsSql}) profile_reviews`,
  );
  const listStmt = prepareListedReviews(
    `SELECT id,course_id,teacher_id,comment,comment_format,headline,grade,
            course_name,course_code,teacher_name,created_at,package_contract
     FROM (${reviewsSql}) profile_reviews
     ORDER BY created_at DESC, id DESC
     LIMIT ${PROFILE_REVIEW_PAGE_SIZE}`,
  );
  const countsStmt = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM user_follows WHERE follower_user_id=?) AS following_count,
         (SELECT COUNT(*) FROM user_follows WHERE followed_user_id=?) AS follower_count`,
    )
    .bind(author.id, author.id);
  const [countResult, listResult, countsResult] = await db.batch([
    countStmt,
    listStmt,
    countsStmt,
  ]);
  const reviewCount = Number(
    (countResult.results[0] as { review_count?: number } | undefined)
      ?.review_count,
  );
  const results = (listResult.results || []) as PublicAuthorReviewRow[];
  const counts = countsResult.results[0] as
    | { following_count: number; follower_count: number }
    | undefined;
  const viewerIsSelf = Boolean(viewerId && viewerId === author.id);
  let viewerFollowed = false;
  if (viewerId && !viewerIsSelf) {
    const follow = await db
      .prepare(
        "SELECT 1 ok FROM user_follows WHERE follower_user_id=? AND followed_user_id=?",
      )
      .bind(viewerId, author.id)
      .first<{ ok: number }>();
    viewerFollowed = Boolean(follow);
  }
  const avatarKey = author.avatar_key ?? defaultAvatarKey(publicCode);
  return {
    public_code: publicCode,
    handle: formatPublicHandle(publicCode),
    avatar_key: avatarKey,
    reserved,
    followable: Boolean(viewerId && !viewerIsSelf),
    viewer_followed: viewerFollowed,
    viewer_is_self: viewerIsSelf,
    note: reserved ? RESERVED_PUBLIC_PROFILE_NOTE : null,
    review_count: Number.isFinite(reviewCount) ? reviewCount : 0,
    following_count: Number(counts?.following_count) || 0,
    follower_count: Number(counts?.follower_count) || 0,
    reviews: mapPublicAuthorReviews(results, publicCode, avatarKey),
  };
}

export async function handlePublicUserProfile(c: AppContext) {
  const publicCode = parsePublicCodeParam(c.req.param("code"));
  if (publicCode == null) return fail(c, "公开编号无效", 404);
  const viewer = await resolveOrdinaryUser(c);
  const viewerId =
    viewer && isOrdinaryUserAuthenticated(viewer) ? viewer.id : null;
  const profile = await loadPublicProfile(c.env.DB, publicCode, viewerId);
  if (!profile) return fail(c, "公开编号不存在", 404);
  return c.json(profile);
}

async function resolveFollowTarget(c: AppContext) {
  const publicCode = parsePublicCodeParam(c.req.param("code"));
  if (publicCode == null) return { error: fail(c, "公开编号无效", 404) };
  const auth = await requireOrdinaryWriteUser(
    c,
    "请先登录后再关注",
    "当前账号无法关注用户",
  );
  if ("error" in auth) return { error: auth.error };
  const target = await findUserByPublicCode(c.env.DB, publicCode);
  if (!target) return { error: fail(c, "公开编号不存在", 404) };
  if (target.id === auth.user.id) {
    return { error: fail(c, "不能关注自己", 400) };
  }
  return { user: auth.user, targetId: target.id, publicCode };
}

export async function handleFollowPublicUser(c: AppContext) {
  const resolved = await resolveFollowTarget(c);
  if ("error" in resolved) return resolved.error;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_follows(follower_user_id,followed_user_id) VALUES(?,?)",
  )
    .bind(resolved.user.id, resolved.targetId)
    .run();
  const followerCode = resolved.user.public_code;
  if (followerCode != null && followerCode >= FIRST_USER_PUBLIC_CODE) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_notifications(
         user_id,type,message,link,event_key,source_review_id
       ) VALUES(?,'user_followed',?,?,?,NULL)`,
    )
      .bind(
        resolved.targetId,
        `${formatPublicHandle(followerCode)} 关注了你`,
        `/u/${formatPublicCode(followerCode)}`,
        `user-followed:${resolved.user.id}:${resolved.targetId}`,
      )
      .run();
  }
  return c.json({
    ok: true,
    public_code: resolved.publicCode,
    handle: formatPublicHandle(resolved.publicCode),
    viewer_followed: true,
  });
}

export async function handleUnfollowPublicUser(c: AppContext) {
  const resolved = await resolveFollowTarget(c);
  if ("error" in resolved) return resolved.error;
  await c.env.DB.prepare(
    "DELETE FROM user_follows WHERE follower_user_id=? AND followed_user_id=?",
  )
    .bind(resolved.user.id, resolved.targetId)
    .run();
  return c.json({
    ok: true,
    public_code: resolved.publicCode,
    handle: formatPublicHandle(resolved.publicCode),
    viewer_followed: false,
  });
}
