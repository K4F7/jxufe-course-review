import { Alert, Button, Card, Chip, Separator, Spinner, Typography } from "@heroui/react";
import { useLocation } from "react-router-dom";
import { useViewer } from "../hooks/useViewer";
import {
  isDevAtlasSession,
  previewReviewComments,
  readDevPreviewOrFilled,
} from "../lib/dev-preview";
import { fourDimLineLabels } from "../lib/dimension-labels";
import { formatReviewDate } from "../lib/review-date";
import { isEndorsableReview } from "../lib/recognition";
import type { PublicReview, ReviewComment } from "../lib/types";
import { parseHandlePublicCode } from "../public-handle";
import { FourDimLine } from "./FourDimLine";
import { StarsWithCaption } from "./Stars";
import { ReviewActionBar } from "./ReviewActionBar";
import {
  ReviewFoldedBody,
  reviewCardClassName,
  useReviewPublicFold,
} from "./ReviewFoldedBody";
import { useReviewRecognition } from "./ReviewRecognitionControl";
import { ReviewNoteContent } from "./ReviewNoteContent";
import { ReviewAuthor } from "./ReviewAuthor";
import { ReviewSourceLabel } from "./ReviewSourceLabel";
import { RouterAriaLink } from "./RouterAriaLink";

/**
 * 统一匿名文字流。课程页评价按 课程×教师 收敛（选定教师后整流同属该
 * 教师），条目不再重复对方身份「昵称」；只有跨课程流（教师页）通过
 * counterpart="course" 保留课程身份行。
 */
export function PublicReviews({
  rows,
  counterpart,
  total,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: {
  rows: PublicReview[];
  /** 跨课程流（教师页）展示课程身份行；课程×教师流省略。 */
  counterpart?: "course";
  total: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string;
  onLoadMore: () => void;
}) {
  const { viewer, ready, clear } = useViewer();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const preview = readDevPreviewOrFilled(searchParams);
  const atlas = isDevAtlasSession(searchParams);
  const previewComposer = preview != null || atlas;
  const viewerPublicCode = parseHandlePublicCode(viewer.handle);
  return (
    <section className="mb-2" aria-labelledby="public-reviews-heading">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <Typography
          className="m-0 text-[calc(17/15*1rem)] font-bold leading-snug"
          id="public-reviews-heading"
          type="h2"
        >
          评价
        </Typography>
        {total ? (
          <span className="text-[calc(13/15*1rem)] text-muted">{total} 条</span>
        ) : null}
      </div>
      {rows.length ? (
        <div>
          <div role="list" aria-label="评价列表" aria-busy={isLoadingMore}>
            {rows.map((review, index) => (
              <PublicReviewItem
                key={review.id}
                review={review}
                index={index}
                counterpart={counterpart}
                ready={ready}
                authenticated={viewer.authenticated}
                loginPath={viewer.loginPath}
                onUnauthenticated={clear}
                seedComments={
                  previewReviewComments(preview, atlas, review.id) ?? []
                }
                viewerPublicCode={viewerPublicCode}
                previewComposer={previewComposer}
              />
            ))}
          </div>
          {hasMore ? (
            <div className="flex justify-center border-t border-border pt-4">
              <Button variant="secondary" isPending={isLoadingMore} isDisabled={isLoadingMore} onPress={onLoadMore}>
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {isPending ? "加载中…" : "继续加载"}
                  </>
                )}
              </Button>
            </div>
          ) : null}
          {loadMoreError ? (
            <Alert className="mt-3" role="alert" status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>继续加载失败</Alert.Title>
                <Alert.Description>{loadMoreError}</Alert.Description>
                <Button className="mt-2" size="sm" variant="secondary" isDisabled={isLoadingMore} onPress={onLoadMore}>
                  重试
                </Button>
              </Alert.Content>
            </Alert>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {isLoadingMore ? "正在加载更多评价" : `已显示 ${rows.length} 条评价`}
          </span>
        </div>
      ) : (
        <Card role="status">
          <Card.Header>
            <Card.Title>暂无评价</Card.Title>
          </Card.Header>
        </Card>
      )}
    </section>
  );
}

function PublicReviewItem({
  review,
  index,
  counterpart,
  ready,
  authenticated,
  loginPath,
  onUnauthenticated,
  seedComments,
  viewerPublicCode,
  previewComposer,
}: {
  review: PublicReview;
  index: number;
  counterpart?: "course";
  ready: boolean;
  authenticated: boolean;
  loginPath: string;
  onUnauthenticated: () => void;
  seedComments: ReviewComment[];
  viewerPublicCode: number | null;
  previewComposer: boolean;
}) {
  const recognition = useReviewRecognition({
    review,
    ready,
    authenticated,
    loginPath,
    onUnauthenticated,
  });
  const fold = useReviewPublicFold(
    recognition.state.count,
    recognition.challenge.count,
  );
  return (
    <div role="listitem">
      {index > 0 ? <Separator /> : null}
      <article
        className={reviewCardClassName({ compact: fold.compact, variant: "public" })}
      >
        {counterpart === "course" ? (
          <p className="m-0 min-w-0 text-sm font-semibold">
            <RouterAriaLink
              className="break-words"
              to={`/courses/${review.course_id}`}
            >
              {review.course_name || "课程未标注"}
              {review.course_code ? `（${review.course_code}）` : null}
            </RouterAriaLink>
          </p>
        ) : null}
        <ReviewFoldedBody
          fold={fold}
          date={formatReviewDate(review.created_at)}
          chromeClassName={counterpart === "course" ? "mt-1.5" : undefined}
          leading={
            <span
              aria-hidden
              className="shrink-0 select-none font-serif text-4xl leading-[0.6] text-accent/35"
            >
              “
            </span>
          }
          header={
            <p className="mb-0 flex flex-wrap items-center gap-x-2 leading-none text-[calc(12/15*1rem)] text-muted">
              <ReviewAuthor
                publicCode={review.author_public_code}
                avatarKey={review.author_avatar_key}
              />
              <ReviewSourceLabel label={review.source_label} />
              {review.overall != null ? (
                <StarsWithCaption
                  rating={review.overall}
                  className="text-[calc(13/15*1rem)]"
                />
              ) : null}
            </p>
          }
          footer={
            <ReviewActionBar
              review={review}
              recognition={recognition}
              ready={ready}
              authenticated={authenticated}
              loginPath={loginPath}
              onUnauthenticated={onUnauthenticated}
              endorsable={isEndorsableReview(review)}
              seedComments={seedComments}
              viewerPublicCode={viewerPublicCode}
              previewComposer={previewComposer}
            />
          }
        >
          <ReviewNoteContent
            comment={review.comment}
            commentFormat={review.comment_format}
          />
          {review.grade ? (
            <p className="mb-0 mt-1.5 text-[calc(13/15*1rem)] text-muted">
              成绩：{review.grade}
            </p>
          ) : null}
          {review.dimensionLabels?.length ? (
            <FourDimLine
              className="mt-2"
              labels={fourDimLineLabels(review.dimensionLabels)}
            />
          ) : null}
          {typeof review.dimensionAverage === "number" ? (
            <div className="mt-2">
              <Chip size="sm" variant="soft">
                <Chip.Label>
                  维度均分 {review.dimensionAverage.toFixed(1)}
                </Chip.Label>
              </Chip>
            </div>
          ) : null}
        </ReviewFoldedBody>
      </article>
    </div>
  );
}
