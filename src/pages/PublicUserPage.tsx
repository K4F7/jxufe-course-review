/**
 * 公开作者页 /u/:code（#493）：公开编号、官方头像与已过审点评。
 * #000000 是学长学姐匿名评价；关注与统计与普通用户同一路径。
 */
import { PersonPlus } from "@gravity-ui/icons";
import { Button, Card, Separator, Spinner, Typography } from "@heroui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AnonymousAvatar } from "../components/AnonymousAvatar";
import { DetailErrorAlert } from "../components/DetailErrorAlert";
import { ReviewNoteContent } from "../components/ReviewNoteContent";
import { ReviewSourceLabel } from "../components/ReviewSourceLabel";
import { RouterAriaLink } from "../components/RouterAriaLink";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useViewer } from "../hooks/useViewer";
import { api } from "../lib/api";
import { previewFilledPublicUser, readDevPreviewOrFilled } from "../lib/dev-preview";
import { formatReviewDate } from "../lib/review-date";
import { reviewAnchorId } from "../lib/review-dimensions";
import type { LatestReview, PublicUserProfile } from "../lib/types";
import { formatPublicCode, formatPublicHandle } from "../public-handle";
import {
  PROTOTYPE_ENABLED,
  PROTOTYPE_MODULE_PARAM,
  PROTOTYPE_VARIANT_PARAM,
} from "../prototype/enabled";
import { isPublicUserFollowVariantKey } from "../prototype/PublicUserFollowVariants";

const PublicUserFollowPrototypeLazy = PROTOTYPE_ENABLED
  ? lazy(() =>
      import("../prototype/PublicUserFollowVariants").then((m) => ({
        default: m.PublicUserFollowPrototype,
      })),
    )
  : null;

export function PublicUserPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preview = readDevPreviewOrFilled(searchParams);
  const isMd = useMediaQuery("(min-width: 48rem)");
  const { viewer, ready } = useViewer();
  const [profile, setProfile] = useState<PublicUserProfile | null>(null);
  const [error, setError] = useState("");
  const [followError, setFollowError] = useState("");
  const [loading, setLoading] = useState(true);
  const [followPending, setFollowPending] = useState(false);

  useEffect(() => {
    if (preview === "error") {
      setProfile(null);
      setError("公开主页加载失败");
      setLoading(false);
      return;
    }
    if (preview === "empty") {
      setProfile({
        public_code: 1,
        handle: "#000001",
        avatar_key: 0,
        reserved: false,
        followable: true,
        viewer_followed: false,
        viewer_is_self: false,
        note: null,
        review_count: 0,
        following_count: 0,
        follower_count: 0,
        reviews: [],
      });
      setError("");
      setLoading(false);
      return;
    }
    if (preview === "filled") {
      setProfile(previewFilledPublicUser());
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setFollowError("");
    api<PublicUserProfile>(`/api/u/${code}`)
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch((reason) => {
        if (!cancelled) {
          setProfile(null);
          setError((reason as Error).message || "公开主页加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, preview]);

  const toggleFollow = async () => {
    if (!profile || profile.viewer_is_self) return;
    if (!viewer.authenticated) {
      const from = encodeURIComponent(`/u/${formatPublicCode(profile.public_code)}`);
      navigate(`${viewer.loginPath}?from=${from}`);
      return;
    }
    setFollowPending(true);
    setFollowError("");
    try {
      const path = `/api/u/${formatPublicCode(profile.public_code)}/follow`;
      const result = await api<{ viewer_followed: boolean }>(path, {
        method: profile.viewer_followed ? "DELETE" : "PUT",
      });
      setProfile((current) => {
        if (!current) return current;
        const delta = result.viewer_followed === current.viewer_followed
          ? 0
          : result.viewer_followed
            ? 1
            : -1;
        return {
          ...current,
          viewer_followed: result.viewer_followed,
          follower_count: Math.max(0, current.follower_count + delta),
        };
      });
    } catch (reason) {
      setFollowError((reason as Error).message || "关注失败");
    } finally {
      setFollowPending(false);
    }
  };

  if ((loading || !ready) && !preview) {
    return (
      <section aria-label="公开主页" className="py-8">
        <p className="m-0 flex items-center gap-2 text-sm text-muted">
          <Spinner color="current" size="sm" />
          正在加载公开主页…
        </p>
      </section>
    );
  }

  if (error && !profile) {
    return <DetailErrorAlert title="公开主页加载失败" message={error} />;
  }
  if (!profile) return null;

  const handle = profile.handle || formatPublicHandle(profile.public_code);
  const prototypeModule = searchParams.get(PROTOTYPE_MODULE_PARAM);
  const prototypeVariant = searchParams.get(PROTOTYPE_VARIANT_PARAM);
  const followVariantKey = prototypeVariant?.toUpperCase() ?? "";
  const showFollowPrototype =
    PROTOTYPE_ENABLED &&
    prototypeModule === "public-user-follow" &&
    isPublicUserFollowVariantKey(followVariantKey) &&
    PublicUserFollowPrototypeLazy != null;

  return (
    <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_16rem] md:items-start md:gap-8">
      <header className="max-md:contents">
        <Typography
          className="m-0 break-words text-lg font-bold leading-tight tracking-tight text-foreground max-md:sr-only"
          type="h1"
        >
          {handle}
        </Typography>
        {profile.note ? (
          <p className="mt-0 text-[calc(13/15*1rem)] text-muted md:mt-2 md:text-sm">
            {profile.note}
          </p>
        ) : (
          <p className="mt-1 hidden text-[calc(13/15*1rem)] text-muted md:mt-2 md:block md:text-sm">
            公开点评
          </p>
        )}
      </header>
      <aside className="min-w-0 max-md:order-first md:row-span-2">
        {showFollowPrototype ? (
          <Suspense
            fallback={
              <Card className="gap-6" aria-label="公开编号">
                <Card.Header className="items-center text-center">
                  <AnonymousAvatar avatarKey={profile.avatar_key} size="lg" />
                  <Card.Title className="break-words">{handle}</Card.Title>
                </Card.Header>
              </Card>
            }
          >
            <PublicUserFollowPrototypeLazy variant={followVariantKey} />
          </Suspense>
        ) : (
          <PublicUserIdentityCard
            followError={followError}
            followPending={followPending}
            handle={handle}
            isMd={isMd}
            profile={profile}
            onToggleFollow={() => void toggleFollow()}
          />
        )}
      </aside>
      <div className="min-w-0">
        {profile.reviews.length === 0 ? (
          <p className="text-[calc(13/15*1rem)] text-muted md:text-sm">
            暂时还没有公开点评。
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {profile.reviews.map((review) => (
              <PublicUserReviewItem key={review.id} review={review} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PublicUserFollowControl({
  className,
  followed,
  pending,
  size,
  variant,
  onToggle,
}: {
  className?: string;
  followed: boolean;
  pending: boolean;
  size?: "sm" | "md";
  variant: "primary" | "secondary" | "ghost";
  onToggle: () => void;
}) {
  return (
    <Button
      className={className}
      isPending={pending}
      size={size}
      variant={variant}
      onPress={onToggle}
    >
      {followed ? null : <PersonPlus aria-hidden />}
      {followed ? "取消关注" : "关注"}
    </Button>
  );
}

function PublicUserIdentityCard({
  followError,
  followPending,
  handle,
  isMd,
  profile,
  onToggleFollow,
}: {
  followError: string;
  followPending: boolean;
  handle: string;
  isMd: boolean;
  profile: PublicUserProfile;
  onToggleFollow: () => void;
}) {
  const followed = profile.viewer_followed;
  const followVariant = followed ? "secondary" : "ghost";
  const mobileFollowVariant = followed ? "secondary" : "primary";

  return (
    <Card aria-label="公开编号" className="gap-3 max-md:gap-2">
      {isMd ? (
        <Card.Header className="w-full items-center gap-2 text-center">
          <AnonymousAvatar
            avatarKey={profile.avatar_key}
            className="self-center"
            size="lg"
          />
          <Card.Title className="break-words">{handle}</Card.Title>
          {profile.viewer_is_self ? null : (
            <PublicUserFollowControl
              followed={followed}
              pending={followPending}
              variant={followVariant}
              onToggle={onToggleFollow}
            />
          )}
        </Card.Header>
      ) : (
        <Card.Header className="flex-row items-center gap-3">
          <AnonymousAvatar
            avatarKey={profile.avatar_key}
            className="shrink-0"
            size="sm"
          />
          <Card.Title className="min-w-0 flex-1 truncate">{handle}</Card.Title>
          {profile.viewer_is_self ? null : (
            <PublicUserFollowControl
              className="shrink-0"
              followed={followed}
              pending={followPending}
              size="sm"
              variant={mobileFollowVariant}
              onToggle={onToggleFollow}
            />
          )}
        </Card.Header>
      )}
      {followError ? (
        <DetailErrorAlert title="关注失败" message={followError} />
      ) : null}
      <Separator />
      <Card.Content>
        {isMd ? (
          <dl className="m-0 grid gap-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">关注了</dt>
              <dd className="m-0 tabular">{profile.following_count ?? 0} 人</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">被关注</dt>
              <dd className="m-0 tabular">{profile.follower_count ?? 0} 人</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">点评了</dt>
              <dd className="m-0 tabular">{profile.review_count ?? 0} 门课程</dd>
            </div>
          </dl>
        ) : (
          <dl className="m-0 grid grid-cols-3 text-center">
            <div className="min-w-0">
              <dd className="m-0 font-medium tabular">{profile.following_count ?? 0}</dd>
              <dt className="text-[calc(12/15*1rem)] text-muted">关注</dt>
            </div>
            <div className="min-w-0">
              <dd className="m-0 font-medium tabular">{profile.follower_count ?? 0}</dd>
              <dt className="text-[calc(12/15*1rem)] text-muted">被关注</dt>
            </div>
            <div className="min-w-0">
              <dd className="m-0 font-medium tabular">{profile.review_count ?? 0}</dd>
              <dt className="text-[calc(12/15*1rem)] text-muted">点评</dt>
            </div>
          </dl>
        )}
      </Card.Content>
    </Card>
  );
}

function PublicUserReviewItem({ review }: { review: LatestReview }) {
  const date = formatReviewDate(review.created_at);
  const moreHref = `/courses/${review.course_id}?teacher=${review.teacher_id}#${encodeURIComponent(reviewAnchorId(review.id))}`;
  const moreLink = (
    <RouterAriaLink
      to={moreHref}
      className="inline shrink-0 text-[calc(13/15*1rem)] leading-6 text-accent sm:mt-1 sm:inline-block sm:text-sm"
    >
      查看全文
    </RouterAriaLink>
  );
  return (
    <li className="min-w-0 border-b border-separator py-3 last:border-b-0 sm:py-4">
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="m-0 min-w-0 text-[calc(13/15*1rem)] leading-6 sm:text-sm">
            <RouterAriaLink
              to={`/courses/${review.course_id}?teacher=${review.teacher_id}`}
              className="max-sm:!inline max-w-full break-words [overflow-wrap:anywhere] text-accent sm:inline-block"
            >
              {review.course_name}
              {review.teacher_name ? `（${review.teacher_name}）` : ""}
            </RouterAriaLink>
          </p>
          <ReviewSourceLabel label={review.source_label} />
        </div>
        {date ? (
          <time
            className="shrink-0 text-[calc(12/15*1rem)] text-muted"
            dateTime={date}
          >
            {date}
          </time>
        ) : null}
      </header>
      {review.headline ? (
        <div className="mt-0.5 flex min-w-0 items-baseline justify-between gap-2 sm:mt-1 sm:block">
          <p className="mb-0 min-w-0 flex-1 break-words text-[calc(13/15*1rem)] font-medium leading-6 sm:text-sm">
            {review.headline}
          </p>
          {moreLink}
        </div>
      ) : (
        <div className="mt-0.5 min-w-0 sm:mt-1">
          <ReviewNoteContent
            comment={review.comment}
            commentFormat={review.comment_format}
          />
          {moreLink}
        </div>
      )}
    </li>
  );
}
