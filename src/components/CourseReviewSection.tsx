/**
 * 课程页点评区（Issue #402，对齐 icourse）：标题「点评」+ 计数 + 蓝色「写点评」；
 * 排序三项、评分整星多选（4 星含 4.5）用 secondary Select，由服务端排序/筛选；条目为官方占位
 * 头像 + 匿名用户 + 星级 + 四维档位 + 正文 + 认可（Issue #431）。
 *
 * 四维档位标签由 #373 公开流投影按条目下发（dimensionLabels），有则渲染
 * FourDimLine（与课程页头部同一套「标签：值」）；旧 1–5 规则快照继续显示
 * 维度均分 Chip；两者都没有的历史行不渲染维度行。逐条星级旁侧用投稿页
 * overallCaption；日期与评分筛选依赖 #410 的投影字段
 * （overall/created_at），未下发前不渲染对应控件。
 */
import {
  Alert,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  Separator,
  Spinner,
  Typography,
} from "@heroui/react";
import { memo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAdminSession } from "../hooks/useAdminSession";
import { useReviewAdminChrome } from "../hooks/useReviewAdminChrome";
import { useViewer } from "../hooks/useViewer";
import {
  isDevAtlasSession,
  previewReviewComments,
  readDevPreview,
  readDevPreviewOrFilled,
} from "../lib/dev-preview";
import { fourDimLineLabels } from "../lib/dimension-labels";
import { resolveReviewAdminDockVisible } from "../lib/review-admin-chrome";
import { formatReviewDate } from "../lib/review-date";
import { isEndorsableReview } from "../lib/recognition";
import { reviewAnchorId } from "../lib/review-dimensions";
import { parseHandlePublicCode } from "../public-handle";
import {
  formatReviewRatingFilterLabel,
  nextReviewRatingFilter,
  OVERALL_STAR_FILTERS,
} from "../lib/review-overall";
import type { PublicReview, ReviewComment } from "../lib/types";
import { FourDimLine } from "./FourDimLine";
import { ReviewActionBar } from "./ReviewActionBar";
import {
  ReviewFoldedBody,
  reviewCardClassName,
  useReviewPublicFold,
} from "./ReviewFoldedBody";
import {
  useReviewRecognition,
} from "./ReviewRecognitionControl";
import { ReviewAuthor } from "./ReviewAuthor";
import { ReviewSourceLabel } from "./ReviewSourceLabel";
import { DetailErrorAlert } from "./DetailErrorAlert";
import { DetailLoadingStatus } from "./DetailFeedback";
import { ReviewAdminControls } from "./ReviewAdminControls";
import { ReviewAdminDock } from "./ReviewAdminDock";
import { ReviewNoteContent } from "./ReviewNoteContent";
import { StarsWithCaption } from "./Stars";

export type CourseReviewSort = "recognized" | "latest" | "oldest";

const SORT_ITEMS: Array<{ id: CourseReviewSort; label: string }> = [
  { id: "recognized", label: "认可最多" },
  { id: "latest", label: "从新到旧" },
  { id: "oldest", label: "从旧到新" },
];

const RATING_ITEMS: Array<{ id: string; label: string }> = [
  { id: "all", label: "全部" },
  ...OVERALL_STAR_FILTERS.map((score) => ({
    id: String(score),
    label: `${score} 星`,
  })),
];

function FilterSelect({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select
      fullWidth
      className="min-w-0 sm:w-auto [&_.select__value]:max-sm:text-sm"
      value={value}
      onChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <Label className="sr-only">{label}</Label>
      <Select.Trigger className="max-sm:min-h-8 max-sm:py-1.5">
        <Select.Value>
          {({ defaultChildren }) => (
            <>
              {label}：{defaultChildren}
            </>
          )}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function RatingFilterSelect({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const selectedKeys = value.length ? value.map(String) : ["all"];
  return (
    <Select
      fullWidth
      className="min-w-0 sm:w-auto [&_.select__value]:max-sm:text-sm"
      selectionMode="multiple"
      value={selectedKeys}
      onChange={(next) => {
        const keys = Array.isArray(next) ? next.map(String) : [];
        onChange(nextReviewRatingFilter(value, keys));
      }}
    >
      <Label className="sr-only">评分</Label>
      <Select.Trigger className="max-sm:min-h-8 max-sm:py-1.5">
        <Select.Value>
          {() => <>评分：{formatReviewRatingFilterLabel(value)}</>}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox selectionMode="multiple">
          {RATING_ITEMS.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

const CourseReviewItem = memo(function CourseReviewItem({
  review,
  ready,
  authenticated,
  loginPath,
  onUnauthenticated,
  adminAuthed,
  showAdminControls,
  onReviewChanged,
  seedComments,
  viewerPublicCode,
  previewComposer,
}: {
  review: PublicReview;
  ready: boolean;
  authenticated: boolean;
  loginPath: string;
  onUnauthenticated: () => void;
  /** 管理员会话有效时渲染屏蔽提示。 */
  adminAuthed: boolean;
  /** dock 开关打开后才渲染屏蔽 / 删除 / 查作者。 */
  showAdminControls: boolean;
  onReviewChanged?: () => void;
  seedComments: ReviewComment[];
  viewerPublicCode: number | null;
  previewComposer: boolean;
}) {
  const date = formatReviewDate(review.created_at);
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
    <article
      id={reviewAnchorId(review.id)}
      className={reviewCardClassName({ compact: fold.compact, variant: "course" })}
    >
      <ReviewFoldedBody
        fold={fold}
        date={date}
        header={
          <Typography
            className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[calc(13/15*1rem)]"
            type="body-sm"
            weight="medium"
          >
            <ReviewAuthor
              publicCode={review.author_public_code}
              avatarKey={review.author_avatar_key}
            />
            <ReviewSourceLabel label={review.source_label} />
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {review.overall != null ? (
                <StarsWithCaption
                  rating={review.overall}
                  className="text-[calc(13/15*1rem)]"
                />
              ) : null}
              {review.blocked ? (
                <Chip color="danger" size="sm" variant="soft">
                  <Chip.Label>已屏蔽</Chip.Label>
                </Chip>
              ) : null}
            </span>
          </Typography>
        }
        footer={
          <>
            {review.blocked && adminAuthed ? (
              <p className="mb-0 mt-1 text-[12px] text-danger">
                此评价已被屏蔽，公开列表不再展示，仅管理员可见。
              </p>
            ) : null}
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
              showAdminControls={showAdminControls}
            />
            {showAdminControls && onReviewChanged ? (
              <ReviewAdminControls review={review} onChanged={onReviewChanged} />
            ) : null}
          </>
        }
      >
        {review.dimensionLabels?.length ? (
          <FourDimLine
            className="mt-1 sm:mt-1.5"
            labels={fourDimLineLabels(review.dimensionLabels)}
          />
        ) : typeof review.dimensionAverage === "number" ? (
          <div className="mt-1 sm:mt-1.5">
            <Chip size="sm" variant="soft">
              <Chip.Label>
                维度均分 {review.dimensionAverage.toFixed(1)}
              </Chip.Label>
            </Chip>
          </div>
        ) : null}
        <div className="mt-1.5 sm:mt-2">
          <ReviewNoteContent
            comment={review.comment}
            commentFormat={review.comment_format}
          />
        </div>
        {review.grade ? (
          <Typography
            className="mb-0 mt-1.5 text-[calc(13/15*1rem)]"
            color="muted"
            type="body-sm"
          >
            成绩：{review.grade}
          </Typography>
        ) : null}
      </ReviewFoldedBody>
    </article>
  );
});

export function CourseReviewSection({
  courseId,
  teacherId,
  sort,
  rating,
  onSortChange,
  onRatingChange,
  reviews,
  total,
  loading,
  error,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
  onReviewChanged,
}: {
  courseId: number | null;
  /** 当前选中的任课教师；为空（课程无教师）时隐藏写点评入口。 */
  teacherId: number | null;
  sort: CourseReviewSort;
  /** 已选整星；空数组为全部。 */
  rating: number[];
  onSortChange: (value: CourseReviewSort) => void;
  onRatingChange: (value: number[]) => void;
  reviews: PublicReview[];
  /** 该关系的公开文字评价总数。 */
  total: number;
  loading: boolean;
  error: string;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string;
  onLoadMore: () => void;
  /** 管理动作改变公开集合后触发（清空缓存并重拉第一页）。 */
  onReviewChanged?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { viewer, ready, clear } = useViewer();
  const { authed: adminAuthed } = useAdminSession();
  const searchParams = new URLSearchParams(location.search);
  const preview = readDevPreviewOrFilled(searchParams);
  const rawPreview = readDevPreview(searchParams);
  const atlas = isDevAtlasSession(searchParams);
  const previewComposer = preview != null || atlas;
  const viewerPublicCode = parseHandlePublicCode(viewer.handle);
  const showAdminDock = resolveReviewAdminDockVisible({
    adminAuthed,
    preview: rawPreview,
  });
  const { visible: adminChromeVisible, setVisible: setAdminChromeVisible } =
    useReviewAdminChrome();
  const showAdminControls = showAdminDock && adminChromeVisible;

  const writeHref =
    courseId != null
      ? `/submit?courseId=${courseId}${teacherId ? `&teacherId=${teacherId}` : ""}`
      : teacherId
        ? `/submit?teacherId=${teacherId}`
        : "/submit";

  return (
    <section className="mt-6 min-w-0 sm:mt-10" aria-labelledby="course-reviews-heading">
      <div className="flex items-center justify-between gap-3 max-sm:pr-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Typography
            className="m-0 text-[calc(20/15*1rem)] font-bold leading-snug text-accent"
            id="course-reviews-heading"
            type="h2"
          >
            点评
          </Typography>
          <span className="text-[calc(13/15*1rem)] text-muted">{total} 条点评</span>
        </div>
        {teacherId ? (
          <>
            <Button
              className="shrink-0 sm:hidden"
              size="sm"
              variant="primary"
              onPress={() => navigate(writeHref)}
            >
              写点评
            </Button>
            <Button
              className="hidden shrink-0 sm:inline-flex"
              size="md"
              variant="primary"
              onPress={() => navigate(writeHref)}
            >
              写点评
            </Button>
          </>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="点评筛选"
        className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center"
      >
        <FilterSelect
          label="排序"
          value={sort}
          onChange={(value) => onSortChange(value as CourseReviewSort)}
          items={SORT_ITEMS}
        />
        <RatingFilterSelect value={rating} onChange={onRatingChange} />
      </div>

      {error && reviews.length === 0 ? (
        <div className="mt-4">
          <DetailErrorAlert title="评价加载失败" message={error} />
        </div>
      ) : loading && reviews.length === 0 ? (
        <div className="mt-4">
          <DetailLoadingStatus label="评价加载中…" />
        </div>
      ) : reviews.length === 0 ? (
        <Card className="mt-4" role="status">
          <Card.Header>
            <Card.Title>暂无评价</Card.Title>
            <Card.Description>
              {teacherId && rating.length > 0
                ? "没有符合当前筛选条件的点评。"
                : teacherId
                  ? "成为第一位评价这位老师这门课的同学。"
                  : "这门课还没写上任课老师，补上之后就可以点评。"}
            </Card.Description>
          </Card.Header>
        </Card>
      ) : (
        <div>
          <div className="mt-2" role="list" aria-label="评价列表">
            {reviews.map((review, index) => (
              <div key={review.id} role="listitem">
                {index > 0 ? <Separator /> : null}
                <CourseReviewItem
                  review={review}
                  ready={ready}
                  authenticated={viewer.authenticated}
                  loginPath={viewer.loginPath}
                  onUnauthenticated={clear}
                  adminAuthed={adminAuthed}
                  showAdminControls={showAdminControls}
                  onReviewChanged={onReviewChanged}
                  seedComments={
                    previewReviewComments(preview, atlas, review.id) ?? []
                  }
                  viewerPublicCode={viewerPublicCode}
                  previewComposer={previewComposer}
                />
              </div>
            ))}
          </div>
          {hasMore ? (
            <div className="flex justify-center pt-3 sm:pt-4">
              <Button
                fullWidth
                className="sm:w-auto"
                variant="secondary"
                isPending={isLoadingMore}
                isDisabled={isLoadingMore}
                onPress={onLoadMore}
              >
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
            {isLoadingMore
              ? "正在加载更多评价"
              : `已显示 ${reviews.length} 条评价`}
          </span>
        </div>
      )}
      {showAdminDock ? (
        <ReviewAdminDock
          visible={adminChromeVisible}
          onVisibleChange={setAdminChromeVisible}
        />
      ) : null}
    </section>
  );
}
