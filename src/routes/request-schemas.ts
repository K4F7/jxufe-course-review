import { z } from "zod";
import { SITE_BANNER_RAW_MAX_LENGTH } from "../site-banner";
import { clean, integer, rating } from "./support";

const unknownField = z.unknown().optional();
const cleanedField = (maxLength = 500) =>
  unknownField.transform((value) => clean(value, maxLength));
const integerField = unknownField.transform((value) => integer(value));
const ratingField = unknownField.transform((value) => rating(value));

const positiveIntegerArray = z
  .array(z.unknown())
  .transform((values, context) => {
    const parsed = values.map(integer);
    if (parsed.some((value) => value === null || value < 1)) {
      context.addIssue({
        code: "custom",
        message: "expected positive integer array",
      });
      return [] as number[];
    }
    return [
      ...new Set(parsed.filter((value): value is number => value !== null)),
    ];
  });

export const reviewSubmissionSchema = z
  .object({
    website: cleanedField(),
    courseId: integerField,
    offeringId: unknownField.transform((raw) => ({
      supplied: raw !== undefined && raw !== null && raw !== "",
      value: integer(raw),
    })),
    teacherId: integerField,
    overall: ratingField,
    turnstileToken: cleanedField(2048),
    scores: unknownField,
    comment: unknownField,
    // headline/grade 的必填与长度校验在创建路径内给出具体错误文案（#444）。
    headline: unknownField.transform((value) =>
      typeof value === "string" ? value.trim() : "",
    ),
    grade: unknownField.transform((value) =>
      typeof value === "string" ? value.trim() : "",
    ),
    loginOnly: unknownField.transform(
      (value) => value === true || value === 1 || value === "1",
    ),
    reviewOnly: unknownField.transform(
      (value) => value === true || value === 1 || value === "1",
    ),
  })
  .passthrough();

export const attachedReviewSchema = z
  .object({
    overall: ratingField,
    scores: unknownField,
    comment: unknownField,
  })
  .passthrough();

export const catalogRequestSchema = z
  .object({
    website: cleanedField(),
    kind: cleanedField(20),
    courseCode: cleanedField(40),
    courseName: cleanedField(200),
    category: cleanedField(20),
    teacherSourceLabel: cleanedField(120),
    department: cleanedField(80),
    note: cleanedField(500),
    turnstileToken: cleanedField(2048),
    review: z.unknown().optional().nullable(),
  })
  .passthrough();

export const adminStudentBindingsSchema = z
  .object({
    usernames: z.array(z.unknown()).max(20).optional(),
    text: z.string().max(2000).optional(),
  })
  .passthrough();

export const siteBannerSchema = z
  .object({
    desktopHtml: z.string().max(SITE_BANNER_RAW_MAX_LENGTH),
    mobileHtml: z.string().max(SITE_BANNER_RAW_MAX_LENGTH),
  })
  .passthrough();

export const adminUserBlockSchema = z
  .object({
    days: z.coerce.number().int().min(1).max(3650),
  })
  .passthrough();

export const moderationSchema = z
  .object({
    status: cleanedField(20),
    note: cleanedField(500),
  })
  .passthrough();

export const catalogRequestModerationSchema = z
  .object({
    status: cleanedField(20),
    note: cleanedField(500),
    peSpecialization: cleanedField(80),
  })
  .passthrough();

export const peQueueDispositionSchema = z
  .object({
    courseId: integerField,
    teacherId: integerField,
    disposition: cleanedField(40),
    specialization: cleanedField(80),
    reason: cleanedField(500),
  })
  .passthrough();

export const peQueueDispositionBatchSchema = z
  .object({
    items: z.array(peQueueDispositionSchema).max(400),
  })
  .passthrough();

export const adminOfferingSchema = z
  .object({
    id: integerField,
    courseId: integerField,
    term: cleanedField(30),
    section: cleanedField(80),
    campus: cleanedField(80),
    schedule: cleanedField(160),
    status: cleanedField(20),
    teacherIds: positiveIntegerArray,
  })
  .passthrough();

export const adminCourseSchema = z
  .object({
    id: integerField,
    name: cleanedField(120),
    code: cleanedField(40),
    category: cleanedField(20),
    department: cleanedField(80),
    description: cleanedField(500),
    credits: unknownField,
    enrollmentCategory: unknownField,
    teachingType: unknownField,
    courseLevel: unknownField,
    schemeKey: unknownField,
    tags: unknownField,
    teacherIds: positiveIntegerArray.optional(),
  })
  .passthrough();

export const adminCourseNoticeSchema = z.object({
  content: z.string().trim().max(2000),
});

export const adminTeacherSchema = z
  .object({
    id: integerField,
    sourceTeacherLabel: cleanedField(120),
    name: cleanedField(120),
    department: cleanedField(80),
    title: cleanedField(80),
    bio: cleanedField(1000),
    homepageUrl: unknownField,
    homepageLocked: unknownField,
    imageLocked: unknownField,
  })
  .passthrough();

export const adminCtaSyncSchema = z
  .object({
    teacherId: integerField,
    limit: integerField,
  })
  .passthrough();

export const teacherIdsSchema = z
  .object({ teacherIds: positiveIntegerArray })
  .passthrough();

export const summaryRecomputeSchema = z
  .object({
    courseId: integerField,
    teacherId: integerField,
  })
  .passthrough();

export const relationImportEnvelopeSchema = z
  .object({
    manifest: z.unknown().optional(),
    artifact: z.unknown().optional(),
    pairs: z.unknown().optional(),
  })
  .passthrough();

export const objectEnvelopeSchema = z.object({}).passthrough();

export const historicalReviewPackageImportSchema = z.object({
  dryRun: z.boolean(),
  records: z
    .array(
      z.object({
        key: z.string().optional(),
        courseCode: z.string(),
        teacherLabel: z.string(),
        comment: z.string(),
      }),
    )
    .min(1)
    .max(50),
});

export const baselinePathSchema = z.object({
  batchId: z.string().trim().min(1).max(120),
});

export const baselineChunkPathSchema = baselinePathSchema.extend({
  chunkIndex: z.coerce.number().int().nonnegative(),
});

export const baselinePreviewQuerySchema = z.object({
  type: z.string().trim().max(20).catch(""),
  page: z.preprocess(
    (value) => (value === undefined || value === "" ? 1 : value),
    z.coerce.number().int().positive(),
  ),
  pageSize: z.preprocess(
    (value) => (value === undefined || value === "" ? 50 : value),
    z.coerce.number().int().min(1).max(100),
  ),
});

export type ReviewSubmissionInput = z.output<typeof reviewSubmissionSchema>;
export type CatalogRequestInput = z.output<typeof catalogRequestSchema>;
