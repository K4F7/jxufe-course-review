import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import {
  applyCoursePlanAttributes,
  CoursePlanAttributeError,
  parseCoursePlanAttributeItems,
} from "../catalog-course-plan-attributes";
import {
  applyRelationAdditions,
  CatalogRelationAdditionError,
  parseOfficialRelationPackage,
  parseRelationPairs,
  previewRelationAdditions,
} from "../catalog-relation-additions";
import {
  BaselineImportError,
  baselineUploadStatus,
  createBaselineUpload,
  finalizeBaselineUpload,
  previewBaselineUpload,
  publishBaselineUpload,
  putBaselineChunk,
  readBoundedJson,
} from "../catalog-baseline-import";
import {
  HistoricalBatchImportError,
  importV5HistoricalBatch,
} from "../historical-batch-imports";
import { historicalReviewPackage } from "../historical-review-packages";
import {
  HistoricalReviewPackageImportError,
  importHistoricalReviewPackage,
} from "../historical-review-package-import";
import {
  applyProgramPlanImport,
  parseProgramPlanImportRecords,
  ProgramPlanImportError,
} from "../program-plan-import";
import { scheduleRelationSummaryRecompute } from "../review-summary";
import { fail, markPublicCatalogCacheChanged } from "./support";
import type { AppContext } from "./types";
import {
  baselineChunkPathSchema,
  baselinePathSchema,
  baselinePreviewQuerySchema,
  historicalReviewPackageImportSchema,
  objectEnvelopeSchema,
  relationImportEnvelopeSchema,
} from "./request-schemas";

const importRoutes = new Hono<AppEnv>();

const relationAdditionFailure = (c: AppContext, error: unknown) => {
  if (error instanceof CatalogRelationAdditionError)
    return fail(c, error.message, error.status);
  throw error;
};
const historicalBatchFailure = (c: AppContext, error: unknown) => {
  if (error instanceof HistoricalBatchImportError)
    return fail(c, error.message, error.status);
  throw error;
};
const readOfficialRelationPackage = async (c: AppContext) => {
  const parsedBody = relationImportEnvelopeSchema.safeParse(
    await c.req.json<unknown>(),
  );
  if (!parsedBody.success)
    throw new CatalogRelationAdditionError("缺少任课关系补充包");
  const body = parsedBody.data;
  if (body.pairs != null)
    throw new CatalogRelationAdditionError(
      "官方任课关系入口只接受候选包，pairs 请走 /api/admin/import/relations",
    );
  if (typeof body.manifest === "string" && typeof body.artifact === "string")
    return parseOfficialRelationPackage(
      body.manifest,
      body.artifact,
      c.env.ISSUE111_RELATION_MANIFEST_SHA256 || "manifest",
    );
  throw new CatalogRelationAdditionError("缺少任课关系补充包");
};
const readRedundantRelationPairs = async (c: AppContext) => {
  const parsedBody = relationImportEnvelopeSchema.safeParse(
    await c.req.json<unknown>(),
  );
  if (!parsedBody.success)
    throw new CatalogRelationAdditionError("缺少任课关系补充包或 pairs 列表");
  const body = parsedBody.data;
  if (Array.isArray(body.pairs)) return parseRelationPairs(body.pairs);
  if (typeof body.manifest === "string" && typeof body.artifact === "string")
    return parseOfficialRelationPackage(
      body.manifest,
      body.artifact,
      c.env.ISSUE111_RELATION_MANIFEST_SHA256 || "manifest",
    );
  throw new CatalogRelationAdditionError("缺少任课关系补充包或 pairs 列表");
};
importRoutes.post(
  "/api/admin/catalog-relation-additions/preview",
  async (c) => {
    try {
      return c.json(
        await previewRelationAdditions(
          c.env.DB,
          await readOfficialRelationPackage(c),
        ),
      );
    } catch (error) {
      return relationAdditionFailure(c, error);
    }
  },
);
importRoutes.post("/api/admin/catalog-relation-additions", async (c) => {
  try {
    const result = await applyRelationAdditions(
      c.env.DB,
      await readOfficialRelationPackage(c),
    );
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    return relationAdditionFailure(c, error);
  }
});
importRoutes.post("/api/admin/import/relations/preview", async (c) => {
  try {
    return c.json(
      await previewRelationAdditions(
        c.env.DB,
        await readRedundantRelationPairs(c),
      ),
    );
  } catch (error) {
    return relationAdditionFailure(c, error);
  }
});
importRoutes.post("/api/admin/import/relations", async (c) => {
  try {
    const result = await applyRelationAdditions(
      c.env.DB,
      await readRedundantRelationPairs(c),
    );
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    return relationAdditionFailure(c, error);
  }
});
importRoutes.post("/api/admin/import/program-plan", async (c) => {
  try {
    const result = await applyProgramPlanImport(
      c.env.DB,
      parseProgramPlanImportRecords(await c.req.json<unknown>()),
    );
    return c.json(result);
  } catch (error) {
    if (error instanceof ProgramPlanImportError)
      return fail(c, error.message, error.status);
    throw error;
  }
});
importRoutes.post("/api/admin/import/course-plan-attributes", async (c) => {
  try {
    const result = await applyCoursePlanAttributes(
      c.env.DB,
      parseCoursePlanAttributeItems(await c.req.json<unknown>()),
    );
    if (result.updated) markPublicCatalogCacheChanged(c);
    return c.json(result);
  } catch (error) {
    if (error instanceof CoursePlanAttributeError)
      return fail(c, error.message, error.status);
    throw error;
  }
});
importRoutes.post("/api/admin/historical-review-v5-imports", async (c) => {
  try {
    const parsedBody = objectEnvelopeSchema.safeParse(
      await c.req.json<unknown>(),
    );
    if (!parsedBody.success)
      throw new HistoricalBatchImportError("历史评价导入请求格式无效", 400);
    const result = await importV5HistoricalBatch(
      c.env.DB,
      parsedBody.data,
      c.env.V5_IMPORT_MANIFEST_SHA256 || "manifest",
      c.env.V5_IMPORT_ARTIFACT_SHA256 || "manifest",
    );
    // 批量引入公开历史评价后，对涉及的任课关系后台去抖重算总结（#401）。
    if (result.created) {
      const { results: pairs } = await c.env.DB.prepare(
        "SELECT DISTINCT course_id,teacher_id FROM public_historical_reviews",
      ).all<{ course_id: number; teacher_id: number }>();
      for (const pair of pairs)
        await scheduleRelationSummaryRecompute(
          c,
          pair.course_id,
          pair.teacher_id,
        );
    }
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    return historicalBatchFailure(c, error);
  }
});
importRoutes.post(
  "/api/admin/historical-review-packages/:package/imports",
  async (c) => {
    const packageName = c.req.param("package");
    if (!historicalReviewPackage(packageName))
      return fail(c, "未知历史评价导入批次", 404);
    try {
      const parsed = historicalReviewPackageImportSchema.safeParse(
        await c.req.json<unknown>(),
      );
      if (!parsed.success)
        throw new HistoricalReviewPackageImportError(
          "历史评价导入请求格式无效",
          422,
        );
      const result = await importHistoricalReviewPackage(
        c.env.DB,
        packageName,
        parsed.data,
      );
      if (result.outcome === "report")
        return c.json(result.report, result.report.dryRun ? 200 : 422);
      if (result.created > 0) {
        markPublicCatalogCacheChanged(c);
        for (const pair of result.touchedRelations)
          await scheduleRelationSummaryRecompute(
            c,
            pair.courseId,
            pair.teacherId,
          );
      }
      return c.json(result.body, result.created > 0 ? 201 : 200);
    } catch (error) {
      if (error instanceof HistoricalReviewPackageImportError)
        return fail(c, error.message, error.status);
      throw error;
    }
  },
);
importRoutes.post("/api/admin/import/preview", (c) =>
  fail(
    c,
    "旧式可合并/跳过导入入口已永久禁用；基线后新增请使用目录补充申请",
    409,
  ),
);
importRoutes.post("/api/admin/import", (c) =>
  fail(
    c,
    "旧式可合并/跳过导入入口已永久禁用；基线后新增请使用目录补充申请",
    409,
  ),
);

const baselineImportFailure = (c: AppContext, error: unknown) => {
  if (error instanceof BaselineImportError)
    return fail(c, error.message, error.status);
  console.error(
    JSON.stringify({
      message: "catalog baseline import failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return fail(c, "目录基线操作失败", 500);
};
importRoutes.post("/api/admin/catalog-baseline/uploads", async (c) => {
  const contentLength = Number(c.req.header("Content-Length") || 0);
  if (contentLength > 100_000) return fail(c, "manifest 请求过大", 413);
  try {
    const parsedBody = objectEnvelopeSchema.safeParse(
      await readBoundedJson(c.req.raw, 100_000),
    );
    if (!parsedBody.success) return fail(c, "manifest 请求格式无效", 400);
    return c.json(await createBaselineUpload(c.env.DB, parsedBody.data));
  } catch (error) {
    return baselineImportFailure(c, error);
  }
});
const readCatalogMarker = (db: D1Database) =>
  db
    .prepare(
      `SELECT batch_id,approved_schema_version,approved_manifest_content_sha256,artifact_sha256,
      courses,teachers,relations FROM catalog_baseline_marker WHERE singleton=1`,
    )
    .first();

importRoutes.get("/api/admin/catalog-baseline/status", async (c) => {
  const marker = await readCatalogMarker(c.env.DB);
  return c.json({ published: !!marker, marker: marker || null });
});

importRoutes.get("/api/admin/historical-review-status", async (c) => {
  const marker = await readCatalogMarker(c.env.DB);
  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM public_historical_reviews",
  ).first<{ count: number }>();
  const byCourse = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT course_id) AS count FROM public_historical_reviews",
  ).first<{ count: number }>();
  const byTeacher = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT teacher_id) AS count FROM public_historical_reviews",
  ).first<{ count: number }>();
  const catalog = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM courses) courses,
       (SELECT COUNT(*) FROM teachers) teachers,
       (SELECT COUNT(*) FROM course_teachers) relations`,
  ).first<{ courses: number; teachers: number; relations: number }>();
  return c.json({
    marker: marker || null,
    catalog: {
      courses: Number(catalog?.courses || 0),
      teachers: Number(catalog?.teachers || 0),
      relations: Number(catalog?.relations || 0),
    },
    historicalReviews: Number(total?.count || 0),
    coursesWithHistoricalReviews: Number(byCourse?.count || 0),
    teachersWithHistoricalReviews: Number(byTeacher?.count || 0),
  });
});
importRoutes.get("/api/admin/catalog-baseline/uploads/:batchId", async (c) => {
  const path = baselinePathSchema.safeParse(c.req.param());
  if (!path.success) return fail(c, "上传批次无效");
  try {
    return c.json(await baselineUploadStatus(c.env.DB, path.data.batchId));
  } catch (error) {
    return baselineImportFailure(c, error);
  }
});
importRoutes.put(
  "/api/admin/catalog-baseline/uploads/:batchId/chunks/:chunkIndex",
  async (c) => {
    const contentLength = Number(c.req.header("Content-Length") || 0);
    if (contentLength > 1_000_000) return fail(c, "分块请求过大", 413);
    const path = baselineChunkPathSchema.safeParse(c.req.param());
    if (!path.success) return fail(c, "上传分块路径无效");
    try {
      const parsedBody = objectEnvelopeSchema.safeParse(
        await readBoundedJson(c.req.raw, 1_000_000),
      );
      if (!parsedBody.success) return fail(c, "分块请求格式无效", 400);
      return c.json(
        await putBaselineChunk(
          c.env.DB,
          path.data.batchId,
          path.data.chunkIndex,
          parsedBody.data,
        ),
      );
    } catch (error) {
      return baselineImportFailure(c, error);
    }
  },
);
importRoutes.post(
  "/api/admin/catalog-baseline/uploads/:batchId/finalize",
  async (c) => {
    const path = baselinePathSchema.safeParse(c.req.param());
    if (!path.success) return fail(c, "上传批次无效");
    try {
      return c.json(await finalizeBaselineUpload(c.env.DB, path.data.batchId));
    } catch (error) {
      return baselineImportFailure(c, error);
    }
  },
);
importRoutes.get(
  "/api/admin/catalog-baseline/uploads/:batchId/preview",
  async (c) => {
    const path = baselinePathSchema.safeParse(c.req.param());
    const query = baselinePreviewQuerySchema.safeParse(c.req.query());
    if (!path.success || !query.success) return fail(c, "预览参数无效");
    try {
      return c.json(
        await previewBaselineUpload(
          c.env.DB,
          path.data.batchId,
          query.data.type,
          query.data.page,
          query.data.pageSize,
        ),
      );
    } catch (error) {
      return baselineImportFailure(c, error);
    }
  },
);
importRoutes.post(
  "/api/admin/catalog-baseline/uploads/:batchId/publish",
  async (c) => {
    const path = baselinePathSchema.safeParse(c.req.param());
    if (!path.success) return fail(c, "上传批次无效");
    try {
      return c.json({
        ok: true,
        marker: await publishBaselineUpload(c.env.DB, path.data.batchId),
      });
    } catch (error) {
      return baselineImportFailure(c, error);
    }
  },
);

export default importRoutes;
