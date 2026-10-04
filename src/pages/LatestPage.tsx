/**
 * 最新课评 /latest：全站公开文字评价，按发表时间倒序。
 * 数据走 GET /api/reviews/latest（游标分页）。折叠只出现在课程×教师评价页。
 */
import { Button, Card, Skeleton, Spinner, Typography } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ReviewAuthor } from "../components/ReviewAuthor";
import { ReviewSourceLabel } from "../components/ReviewSourceLabel";
import { DetailErrorAlert } from "../components/DetailErrorAlert";
import { ReviewNoteContent } from "../components/ReviewNoteContent";
import { RouterAriaLink } from "../components/RouterAriaLink";
import { ScrollToTopButton } from "../components/ScrollToTopButton";
import { useLoadMoreOnVisible } from "../hooks/useLoadMoreOnVisible";
import { api } from "../lib/api";
import { previewFilledLatestReviews, readDevPreviewOrFilled } from "../lib/dev-preview";
import { formatReviewDate } from "../lib/review-date";
import { reviewAnchorId } from "../lib/review-dimensions";
import {
  INITIAL_MOBILE_REVIEW_COUNT,
  LATEST_API_PAGE_SIZE,
  LATEST_PAGE_SIZE,
  LATEST_REVIEW_RESERVED_ROW_CLASS,
  LATEST_REVIEW_ROW_CLASS,
  latestFeedColumnClass,
  latestFeedNeedsViewportReserve,
  latestLoadingSkeletonCount,
  latestReservedSpacerCount,
} from "../lib/latest-loading";
import type { LatestReview, PublicReviewPage } from "../lib/types";

declare global {
  interface Window {
    __jufexkLatestPageRequest?: Promise<PublicReviewPage<LatestReview>>;
  }
}

let initialLatestPageRequest = window.__jufexkLatestPageRequest ?? null;

if (
  !initialLatestPageRequest &&
  window.location.pathname === "/latest" &&
  !new URLSearchParams(window.location.search).has("preview")
) {
  const request = api<PublicReviewPage<LatestReview>>(
    `/api/reviews/latest?pageSize=${LATEST_API_PAGE_SIZE}`,
  );
  initialLatestPageRequest = request.catch((reason) => {
    initialLatestPageRequest = null;
    throw reason;
  });
}

export function LatestPage() {
  const [searchParams] = useSearchParams();
  const preview = readDevPreviewOrFilled(searchParams);
  const [items, setItems] = useState<LatestReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [renderedItemCount, setRenderedItemCount] = useState(() =>
    window.matchMedia("(max-width: 639px)").matches
      ? INITIAL_MOBILE_REVIEW_COUNT
      : LATEST_PAGE_SIZE,
  );
  const nextCursorRef = useRef(nextCursor);
  const isLoadingMoreRef = useRef(isLoadingMore);
  nextCursorRef.current = nextCursor;
  isLoadingMoreRef.current = isLoadingMore;

  useEffect(() => {
    if (items.length <= renderedItemCount) return;

    let cancelled = false;
    const reveal = () => {
      if (!cancelled) setRenderedItemCount(items.length);
    };
    const timeoutId = window.setTimeout(reveal, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [items.length, renderedItemCount]);

  useEffect(() => {
    if (preview === "error") {
      setItems([]);
      setNextCursor(null);
      setError("最新课评加载失败");
      setLoading(false);
      return;
    }
    if (preview === "empty") {
      setItems([]);
      setNextCursor(null);
      setError("");
      setLoading(false);
      return;
    }
    if (preview === "filled") {
      setItems(previewFilledLatestReviews());
      setNextCursor(null);
      setError("");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError("");
    (initialLatestPageRequest ??
      api<PublicReviewPage<LatestReview>>(
        `/api/reviews/latest?pageSize=${LATEST_API_PAGE_SIZE}`,
        { signal: controller.signal },
      ))
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message || "最新课评加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [preview]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await api<PublicReviewPage<LatestReview>>(
        `/api/reviews/latest?cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => [...current, ...page.items]);
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setLoadMoreError((reason as Error).message || "继续加载失败");
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, []);

  const loadMoreSentinelRef = useLoadMoreOnVisible({
    enabled: Boolean(nextCursor) && !loadMoreError,
    isLoading: isLoadingMore,
    loadMore,
  });

  return (
    <>
    <section
      aria-label="最新课评"
      className={latestFeedColumnClass(
        latestFeedNeedsViewportReserve(loading, items.length, renderedItemCount),
      )}
    >
      <header aria-label="最新课评标题" className="mb-3 max-sm:sr-only">
        <Typography
          className="m-0 text-lg font-bold leading-tight tracking-tight text-foreground"
          type="h1"
        >
          最新课评
        </Typography>
      </header>
      {error && items.length === 0 ? (
        <DetailErrorAlert title="最新课评加载失败" message={error} />
      ) : loading && items.length === 0 ? (
        <LatestReviewSkeleton />
      ) : items.length === 0 ? (
        <Card role="status">
          <Card.Header>
            <Card.Title>暂时还没有公开课评</Card.Title>
            <Card.Description className="break-words">
              先到
              <RouterAriaLink
                to="/courses"
                className="text-accent max-sm:inline-flex max-sm:min-h-[44px] max-sm:items-center"
              >
                课程列表
              </RouterAriaLink>
              看看，或通过课程页的「写点评」分享第一门课的体验。
            </Card.Description>
          </Card.Header>
        </Card>
      ) : (
        <div>
          {items.slice(0, renderedItemCount).map((review) => (
            <LatestReviewItem key={review.id} review={review} />
          ))}
          {nextCursor ? (
            <div className="flex flex-col items-center pt-4">
              <Button
                className="w-full sm:w-auto"
                variant="secondary"
                isPending={isLoadingMore}
                onPress={loadMore}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {isPending ? "加载中…" : "继续加载"}
                  </>
                )}
              </Button>
              <div
                ref={loadMoreSentinelRef}
                aria-hidden
                className="h-px w-full"
              />
            </div>
          ) : null}
          {Array.from(
            { length: latestReservedSpacerCount(items.length, renderedItemCount) },
            (_, index) => <LatestReviewSpace key={`space-${index}`} />,
          )}
          {loadMoreError ? (
            <p className="mt-3 text-center text-[calc(13/15*1rem)] text-danger" role="alert">
              {loadMoreError}
            </p>
          ) : null}
        </div>
      )}
    </section>
    <ScrollToTopButton />
    </>
  );
}

function LatestReviewSpace() {
  return (
    <article
      aria-hidden="true"
      className={`invisible ${LATEST_REVIEW_RESERVED_ROW_CLASS}`}
    />
  );
}

function LatestReviewItem({ review }: { review: LatestReview }) {
  const date = formatReviewDate(review.created_at);
  const moreHref = `/courses/${review.course_id}?teacher=${review.teacher_id}#${encodeURIComponent(reviewAnchorId(review.id))}`;
  return (
    <article className={LATEST_REVIEW_ROW_CLASS}>
      <header className="flex w-fit max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-nowrap">
        <p className="m-0 min-w-0 text-[calc(13/15*1rem)] leading-6 sm:whitespace-nowrap">
          <ReviewAuthor
            publicCode={review.author_public_code}
            avatarKey={review.author_avatar_key}
            layout="baseline"
            className="leading-6"
          />
          <ReviewSourceLabel label={review.source_label} />
          <span className="text-muted"> 点评了 </span>
          <RouterAriaLink
            to={`/courses/${review.course_id}?teacher=${review.teacher_id}`}
            className="inline break-words [overflow-wrap:anywhere] text-[calc(13/15*1rem)] leading-6 text-accent"
          >
            {review.course_name}
            {review.teacher_name ? `（${review.teacher_name}）` : ""}
          </RouterAriaLink>
        </p>
        {date ? (
          <time
            className="shrink-0 text-[calc(12/15*1rem)] leading-6 text-muted"
            dateTime={date}
          >
            {date}
          </time>
        ) : null}
      </header>
      <div className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] line-clamp-3 sm:mt-2">
        {review.headline ? (
          <p className="m-0 break-words text-sm font-medium leading-relaxed">
            {review.headline}
          </p>
        ) : (
          <ReviewNoteContent
            comment={review.comment}
            commentFormat={review.comment_format}
          />
        )}
      </div>
      <RouterAriaLink
        to={moreHref}
        className="mt-0.5 inline text-[calc(13/15*1rem)] leading-6 text-accent sm:mt-1 sm:inline-block"
      >
        查看全文
      </RouterAriaLink>
    </article>
  );
}

function LatestReviewSkeleton() {
  return (
    <div role="status" aria-label="正在加载最新课评">
      {Array.from({ length: LATEST_PAGE_SIZE }, (_, row) =>
        row < latestLoadingSkeletonCount() ? (
          <article
            className={LATEST_REVIEW_RESERVED_ROW_CLASS}
            data-loading-skeleton="true"
            key={row}
          >
            <header className="flex w-fit max-w-full flex-wrap items-center gap-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </header>
            <Skeleton className="mt-3 h-4 w-3/4 rounded" />
            <Skeleton className="mt-3 h-[4.5rem] w-full rounded" />
            <Skeleton className="mt-3 h-4 w-16 rounded" />
          </article>
        ) : (
          <div
            aria-hidden="true"
            className={`invisible ${LATEST_REVIEW_RESERVED_ROW_CLASS}`}
            key={row}
          />
        ),
      )}
    </div>
  );
}
