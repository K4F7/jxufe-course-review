import {
  historicalPackageManifestSha256,
  historicalReviewPackage,
  historicalReviewPublicId,
  historicalReviewStableKey,
} from "./historical-review-packages";

const COURSE_CODE_MAX = 40;
const TEACHER_LABEL_MAX = 120;
const COMMENT_MAX = 4000;
const COMMENT_MIN = 10;

export class HistoricalReviewPackageImportError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export const HISTORICAL_PACKAGE_ITEM_STATUSES = [
  "matched",
  "existing",
  "missing_course",
  "missing_teacher",
  "missing_relation",
  "duplicate_in_batch",
  "key_mismatch",
  "conflict",
] as const;

export type HistoricalPackageItemStatus =
  (typeof HISTORICAL_PACKAGE_ITEM_STATUSES)[number];

export type HistoricalPackageImportRecord = {
  key?: string;
  courseCode: string;
  teacherLabel: string;
  comment: string;
};

export type HistoricalPackageImportItem = {
  index: number;
  key: string;
  id: string;
  status: HistoricalPackageItemStatus;
  courseId?: number;
  teacherId?: number;
  sameRelationExistingCount?: number;
};

export type HistoricalPackageImportCounts = Record<
  HistoricalPackageItemStatus,
  number
>;

export type HistoricalPackageImportReport = {
  package: string;
  dryRun: boolean;
  total: number;
  counts: HistoricalPackageImportCounts;
  items: HistoricalPackageImportItem[];
};

export type HistoricalPackageImportSuccess = HistoricalPackageImportReport & {
  created: number;
  existing: number;
};

type IdentityRow = {
  course_id?: unknown;
  teacher_id?: unknown;
  relation_exists?: unknown;
  same_relation_existing_count?: unknown;
};

type ExistingRow = {
  course_id: number;
  teacher_id: number;
  comment: string;
};

type PreparedRecord = {
  index: number;
  key: string;
  id: string;
  courseCode: string;
  teacherLabel: string;
  comment: string;
  providedKey?: string;
  forcedStatus: HistoricalPackageItemStatus | null;
};

const emptyCounts = (): HistoricalPackageImportCounts => ({
  matched: 0,
  existing: 0,
  missing_course: 0,
  missing_teacher: 0,
  missing_relation: 0,
  duplicate_in_batch: 0,
  key_mismatch: 0,
  conflict: 0,
});

const integerId = (value: unknown): number | null => {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : null;
  return number != null && Number.isInteger(number) && number > 0
    ? number
    : null;
};

const countOf = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

const readExisting = (value: unknown): ExistingRow | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const courseId = integerId(row.course_id);
  const teacherId = integerId(row.teacher_id);
  if (courseId == null || teacherId == null || typeof row.comment !== "string")
    return null;
  return { course_id: courseId, teacher_id: teacherId, comment: row.comment };
};

/**
 * Historical comments are stored and rendered as plain text (`comment_format`
 * stays null), so angle brackets are not interpreted as HTML.
 */
function readRecord(
  record: HistoricalPackageImportRecord,
  index: number,
): Omit<PreparedRecord, "key" | "id" | "forcedStatus"> {
  const courseCode = record.courseCode.trim();
  const teacherLabel = record.teacherLabel.trim();
  const comment = record.comment.trim();
  if (!courseCode || courseCode.length > COURSE_CODE_MAX)
    throw new HistoricalReviewPackageImportError(
      `第 ${index + 1} 条历史评价的课程代码无效`,
    );
  if (!teacherLabel || teacherLabel.length > TEACHER_LABEL_MAX)
    throw new HistoricalReviewPackageImportError(
      `第 ${index + 1} 条历史评价的教师称呼无效`,
    );
  const compactLength = comment.replace(/\s+/g, "").length;
  if (
    compactLength < COMMENT_MIN ||
    compactLength > COMMENT_MAX ||
    comment.length > COMMENT_MAX
  )
    throw new HistoricalReviewPackageImportError(
      `第 ${index + 1} 条历史评价的正文长度无效`,
    );
  return {
    index,
    courseCode,
    teacherLabel,
    comment,
    providedKey: record.key,
  };
}

function catalogStatus(input: {
  courseId: number | null;
  teacherId: number | null;
  relationExists: boolean;
  comment: string;
  existing: ExistingRow | null;
}): HistoricalPackageItemStatus {
  if (input.existing) {
    if (
      input.courseId != null &&
      input.teacherId != null &&
      input.existing.course_id === input.courseId &&
      input.existing.teacher_id === input.teacherId &&
      input.existing.comment === input.comment
    )
      return "existing";
    return "conflict";
  }
  if (input.courseId == null) return "missing_course";
  if (input.teacherId == null) return "missing_teacher";
  if (!input.relationExists) return "missing_relation";
  return "matched";
}

/**
 * Separate scalar lookups, not a course×teacher CROSS JOIN, so a missing
 * course stays distinguishable from a missing teacher.
 */
const identitySql = `
  SELECT
    (SELECT c.id FROM courses c WHERE c.code=? LIMIT 1) course_id,
    (SELECT t.id FROM teachers t WHERE t.source_teacher_label=? LIMIT 1) teacher_id,
    EXISTS(
      SELECT 1 FROM course_teachers ct
      JOIN courses c ON c.id=ct.course_id
      JOIN teachers t ON t.id=ct.teacher_id
      WHERE c.code=? AND t.source_teacher_label=?
    ) relation_exists,
    (
      SELECT COUNT(*) FROM public_historical_reviews phr
      WHERE phr.deleted_at IS NULL AND phr.blocked_at IS NULL
        AND phr.course_id=(SELECT c.id FROM courses c WHERE c.code=? LIMIT 1)
        AND phr.teacher_id=(SELECT t.id FROM teachers t WHERE t.source_teacher_label=? LIMIT 1)
    ) same_relation_existing_count`;

const existingSql =
  "SELECT course_id,teacher_id,comment FROM public_historical_reviews WHERE id=?";

export async function importHistoricalReviewPackage(
  db: D1Database,
  packageName: string,
  input: { dryRun: boolean; records: HistoricalPackageImportRecord[] },
): Promise<
  | { outcome: "report"; report: HistoricalPackageImportReport }
  | {
      outcome: "applied";
      created: number;
      body: HistoricalPackageImportSuccess;
      touchedRelations: Array<{ courseId: number; teacherId: number }>;
    }
> {
  const pkg = historicalReviewPackage(packageName);
  if (!pkg)
    throw new HistoricalReviewPackageImportError("未知历史评价导入批次", 404);

  const trimmed = input.records.map(readRecord);
  const seen = new Set<string>();
  const prepared: PreparedRecord[] = [];
  for (const row of trimmed) {
    const key = await historicalReviewStableKey({
      keyPrefix: pkg.keyPrefix,
      courseCode: row.courseCode,
      teacherLabel: row.teacherLabel,
      comment: row.comment,
    });
    const id = await historicalReviewPublicId(pkg.keyPrefix, key);
    let forcedStatus: HistoricalPackageItemStatus | null = null;
    if (row.providedKey !== undefined && row.providedKey !== key)
      forcedStatus = "key_mismatch";
    else if (seen.has(key)) forcedStatus = "duplicate_in_batch";
    seen.add(key);
    prepared.push({ ...row, key, id, forcedStatus });
  }

  const lookedUp = await db.batch(
    prepared.flatMap((row) => [
      db
        .prepare(identitySql)
        .bind(
          row.courseCode,
          row.teacherLabel,
          row.courseCode,
          row.teacherLabel,
          row.courseCode,
          row.teacherLabel,
        ),
      db.prepare(existingSql).bind(row.id),
    ]),
  );

  const counts = emptyCounts();
  const items: HistoricalPackageImportItem[] = prepared.map((row, index) => {
    const identity = lookedUp[index * 2]?.results?.[0] as IdentityRow | undefined;
    const existing = readExisting(lookedUp[index * 2 + 1]?.results?.[0]);
    const courseId = integerId(identity?.course_id);
    const teacherId = integerId(identity?.teacher_id);
    const status =
      row.forcedStatus ??
      catalogStatus({
        courseId,
        teacherId,
        relationExists: Number(identity?.relation_exists) > 0,
        comment: row.comment,
        existing,
      });
    counts[status] += 1;
    const item: HistoricalPackageImportItem = {
      index: row.index,
      key: row.key,
      id: row.id,
      status,
    };
    if (courseId != null) item.courseId = courseId;
    if (teacherId != null) item.teacherId = teacherId;
    if (courseId != null && teacherId != null)
      item.sameRelationExistingCount = countOf(
        identity?.same_relation_existing_count,
      );
    return item;
  });

  const report: HistoricalPackageImportReport = {
    package: packageName,
    dryRun: input.dryRun,
    total: items.length,
    counts,
    items,
  };
  const importable = items.every(
    (item) => item.status === "matched" || item.status === "existing",
  );
  if (input.dryRun || !importable) return { outcome: "report", report };

  const pending = prepared.flatMap((row, index) => {
    const item = items[index];
    if (item.status !== "matched" || item.courseId == null || item.teacherId == null)
      return [];
    return [{ row, courseId: item.courseId, teacherId: item.teacherId }];
  });
  let catalogSha256 = "";
  if (pending.length) {
    const marker = await db
      .prepare(
        `SELECT approved_manifest_content_sha256 hash
         FROM catalog_baseline_marker WHERE singleton=1`,
      )
      .first<{ hash: string }>();
    if (!marker?.hash)
      throw new HistoricalReviewPackageImportError("缺少已批准的目录基线", 422);
    catalogSha256 = marker.hash;
  }
  const manifestSha256 = pending.length
    ? await historicalPackageManifestSha256(
        prepared.map((row) => ({
          comment: row.comment,
          courseCode: row.courseCode,
          key: row.key,
          teacherLabel: row.teacherLabel,
        })),
      )
    : "";

  let created = 0;
  if (pending.length) {
    const inserted = await db.batch(
      pending.map(({ row, courseId, teacherId }) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO public_historical_reviews(
               id,course_id,teacher_id,comment,package_contract,
               approved_package_manifest_sha256,approved_catalog_content_sha256
             ) VALUES(?,?,?,?,?,?,?)
             RETURNING id`,
          )
          .bind(
            row.id,
            courseId,
            teacherId,
            row.comment,
            packageName,
            manifestSha256,
            catalogSha256,
          ),
      ),
    );
    created = inserted.reduce(
      (total, result) => total + result.results.length,
      0,
    );
  }

  const seenPairs = new Set<string>();
  const touchedRelations: Array<{ courseId: number; teacherId: number }> = [];
  if (created > 0) {
    for (const entry of pending) {
      const token = `${entry.courseId}:${entry.teacherId}`;
      if (seenPairs.has(token)) continue;
      seenPairs.add(token);
      touchedRelations.push({
        courseId: entry.courseId,
        teacherId: entry.teacherId,
      });
    }
  }

  return {
    outcome: "applied",
    created,
    touchedRelations,
    body: {
      ...report,
      dryRun: false,
      created,
      existing: counts.existing + (pending.length - created),
    },
  };
}
