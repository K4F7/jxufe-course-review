import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  HISTORICAL_REVIEW_PACKAGES,
  historicalPackageManifestSha256,
  historicalReviewPublicId,
  historicalReviewStableKey,
} from "../src/historical-review-packages";
import { parsePublicReviewTarget } from "../src/lib/public-review-id";
import { RESERVED_PUBLIC_PROFILE_NOTE } from "../src/public-user-profile";
import { adminAuth, adminHeaders } from "./admin-session";
import { WRITE_ORIGIN } from "./ordinary-write-session";

const PACKAGE = "qq-channel-jufe-v1";
const PREFIX = HISTORICAL_REVIEW_PACKAGES[PACKAGE].keyPrefix;
const SOURCE_LABEL = HISTORICAL_REVIEW_PACKAGES[PACKAGE].sourceLabel;
const IMPORT_PATH = `/api/admin/historical-review-packages/${PACKAGE}/imports`;
const NOTE = "来自以前的学长学姐的评价，部分整理自 QQ 频道「江西财经大学」";

type ImportItem = {
  index: number;
  key: string;
  id: string;
  status: string;
  courseId?: number;
  teacherId?: number;
  sameRelationExistingCount?: number;
};

type ImportReport = {
  package: string;
  dryRun: boolean;
  total: number;
  counts: Record<string, number>;
  items: ImportItem[];
  created?: number;
  existing?: number;
  error?: string;
};

type Seeded = {
  courseId: number;
  teacherId: number;
  courseCode: string;
  teacherLabel: string;
  related: boolean;
};

type MarkerRow = {
  singleton: number;
  batch_id: string;
  approved_schema_version: string;
  approved_manifest_content_sha256: string;
  artifact_sha256: string;
  source_capture_manifest_content_sha256: string;
  derivation_content_sha256: string;
  quality_manifest_content_sha256: string;
  decisions_sha256: string;
  boundary_fixture_content_sha256: string;
  courses: number;
  teachers: number;
  relations: number;
  published_at: string;
};

function suffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function postImport(
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  return SELF.fetch(`${WRITE_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function seedPair(code: string, label: string, related: boolean): Promise<Seeded> {
  const course = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department) VALUES(?,?,'general','测试学院')",
  )
    .bind(code, `${code}课`)
    .run();
  const teacher = await env.DB.prepare(
    "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?, '测试学院')",
  )
    .bind(label, label)
    .run();
  const courseId = Number(course.meta.last_row_id);
  const teacherId = Number(teacher.meta.last_row_id);
  if (related) {
    await env.DB.prepare(
      "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
    )
      .bind(courseId, teacherId)
      .run();
  }
  return { courseId, teacherId, courseCode: code, teacherLabel: label, related };
}

async function cleanupSeeds(seeds: Seeded[]) {
  const courseIds = seeds.map((seed) => seed.courseId);
  const teacherIds = seeds.map((seed) => seed.teacherId);
  if (!courseIds.length) return;
  const courseMarks = courseIds.map(() => "?").join(",");
  const teacherMarks = teacherIds.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM public_historical_reviews WHERE course_id IN (${courseMarks})`,
    ).bind(...courseIds),
    env.DB.prepare(
      `DELETE FROM reviews WHERE course_id IN (${courseMarks})`,
    ).bind(...courseIds),
    env.DB.prepare(
      `DELETE FROM course_teachers WHERE course_id IN (${courseMarks})`,
    ).bind(...courseIds),
    env.DB.prepare(`DELETE FROM courses WHERE id IN (${courseMarks})`).bind(
      ...courseIds,
    ),
    env.DB.prepare(`DELETE FROM teachers WHERE id IN (${teacherMarks})`).bind(
      ...teacherIds,
    ),
  ]);
}

async function countHistorical(courseIds: number[]) {
  if (!courseIds.length) return 0;
  const marks = courseIds.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) n FROM public_historical_reviews WHERE course_id IN (${marks})`,
  )
    .bind(...courseIds)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

async function insertHistorical(input: {
  id: string;
  courseId: number;
  teacherId: number;
  comment: string;
  packageContract?: string;
  importedAt?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO public_historical_reviews(
       id,course_id,teacher_id,comment,package_contract,
       approved_package_manifest_sha256,approved_catalog_content_sha256,imported_at
     ) VALUES(?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.id,
      input.courseId,
      input.teacherId,
      input.comment,
      input.packageContract ?? PACKAGE,
      "a".repeat(64),
      "b".repeat(64),
      input.importedAt ?? "2020-01-01 00:00:00",
    )
    .run();
}

async function readMarker() {
  return env.DB.prepare(
    `SELECT singleton,batch_id,approved_schema_version,approved_manifest_content_sha256,artifact_sha256,
            source_capture_manifest_content_sha256,derivation_content_sha256,quality_manifest_content_sha256,
            decisions_sha256,boundary_fixture_content_sha256,courses,teachers,relations,published_at
     FROM catalog_baseline_marker WHERE singleton=1`,
  ).first<MarkerRow>();
}

async function writeMarker(row: MarkerRow) {
  await env.DB.prepare(
    `INSERT INTO catalog_baseline_marker(
       singleton,batch_id,approved_schema_version,approved_manifest_content_sha256,artifact_sha256,
       source_capture_manifest_content_sha256,derivation_content_sha256,quality_manifest_content_sha256,
       decisions_sha256,boundary_fixture_content_sha256,courses,teachers,relations,published_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      row.singleton,
      row.batch_id,
      row.approved_schema_version,
      row.approved_manifest_content_sha256,
      row.artifact_sha256,
      row.source_capture_manifest_content_sha256,
      row.derivation_content_sha256,
      row.quality_manifest_content_sha256,
      row.decisions_sha256,
      row.boundary_fixture_content_sha256,
      row.courses,
      row.teachers,
      row.relations,
      row.published_at,
    )
    .run();
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureMarker() {
  const existing = await readMarker();
  if (existing?.approved_manifest_content_sha256) {
    return {
      hash: existing.approved_manifest_content_sha256,
      batchId: existing.batch_id,
      inserted: false,
    };
  }
  const hashes = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      sha256Hex(`historical-package-marker-${crypto.randomUUID()}-${index}`),
    ),
  );
  const batchId = `pkg-${suffix()}`;
  await env.DB.prepare(
    `INSERT INTO catalog_baseline_marker(
       singleton,batch_id,approved_schema_version,approved_manifest_content_sha256,artifact_sha256,
       source_capture_manifest_content_sha256,derivation_content_sha256,quality_manifest_content_sha256,
       decisions_sha256,boundary_fixture_content_sha256,courses,teachers,relations
     ) VALUES(1,?,?,?,?,?,?,?,?,?,1,1,1)`,
  )
    .bind(
      batchId,
      "catalog-baseline-approved-manifest/v1",
      hashes[0],
      hashes[1],
      hashes[2],
      hashes[3],
      hashes[4],
      hashes[5],
      hashes[6],
    )
    .run();
  return { hash: hashes[0]!, batchId, inserted: true };
}

async function removeInsertedMarker(batchId: string) {
  await env.DB.prepare(
    "DELETE FROM catalog_baseline_marker WHERE singleton=1 AND batch_id=?",
  )
    .bind(batchId)
    .run();
}

describe("historical review package import", () => {
  it("rejects anonymous callers and requests without CSRF", async () => {
    const anonymous = await postImport(
      IMPORT_PATH,
      { dryRun: true, records: [] },
      { "Content-Type": "application/json", Origin: WRITE_ORIGIN },
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "请先用已绑定的学号登录" });

    const auth = await adminAuth();
    const missingCsrf = await postImport(
      IMPORT_PATH,
      {
        dryRun: true,
        records: [
          {
            courseCode: "TEST101",
            teacherLabel: "测试教师",
            comment: "缺少 CSRF 的历史评价正文",
          },
        ],
      },
      {
        "Content-Type": "application/json",
        Cookie: auth.cookie,
        Origin: WRITE_ORIGIN,
      },
    );
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toEqual({
      error: "安全校验失败，请刷新后重试",
    });
  });

  it("returns 404 for an unknown package", async () => {
    const headers = adminHeaders(await adminAuth());
    const response = await postImport(
      "/api/admin/historical-review-packages/not-a-package/imports",
      {
        dryRun: true,
        records: [
          {
            courseCode: "TEST101",
            teacherLabel: "测试教师",
            comment: "未知批次不会写入的评价正文",
          },
        ],
      },
      headers,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "未知历史评价导入批次" });
  });

  it("dry-run reports every status and does not write", async () => {
    const token = suffix();
    const matched = await seedPair(`M${token}`, `师M${token}`, true);
    const unbound = await seedPair(`R${token}`, `师R${token}`, false);
    const seeds = [matched, unbound];
    const matchedComment = "这是一条足够长的匹配评价正文。";
    const existingComment = "这是已经存在的评价正文内容。";
    const conflictComment = "这是冲突用的评价正文内容啊。";
    const mismatchComment = "这是密钥不匹配的评价正文啊。";
    const matchedKey = await historicalReviewStableKey({
      keyPrefix: PREFIX,
      courseCode: matched.courseCode,
      teacherLabel: matched.teacherLabel,
      comment: matchedComment,
    });
    const existingId = await historicalReviewPublicId(
      PREFIX,
      await historicalReviewStableKey({
        keyPrefix: PREFIX,
        courseCode: matched.courseCode,
        teacherLabel: matched.teacherLabel,
        comment: existingComment,
      }),
    );
    const conflictKey = await historicalReviewStableKey({
      keyPrefix: PREFIX,
      courseCode: matched.courseCode,
      teacherLabel: matched.teacherLabel,
      comment: conflictComment,
    });
    const conflictId = await historicalReviewPublicId(PREFIX, conflictKey);
    const mismatchKey = await historicalReviewStableKey({
      keyPrefix: PREFIX,
      courseCode: matched.courseCode,
      teacherLabel: matched.teacherLabel,
      comment: mismatchComment,
    });
    await insertHistorical({
      id: existingId,
      courseId: matched.courseId,
      teacherId: matched.teacherId,
      comment: existingComment,
    });
    await insertHistorical({
      id: conflictId,
      courseId: matched.courseId,
      teacherId: matched.teacherId,
      comment: "这是库里另一条不同的正文啊。",
    });
    const before = await countHistorical(seeds.map((seed) => seed.courseId));
    try {
      const response = await postImport(
        IMPORT_PATH,
        {
          dryRun: true,
          records: [
            {
              key: matchedKey,
              courseCode: matched.courseCode,
              teacherLabel: matched.teacherLabel,
              comment: matchedComment,
            },
            {
              courseCode: `NO${token}`,
              teacherLabel: matched.teacherLabel,
              comment: "课程不存在时的评价正文内容。",
            },
            {
              courseCode: matched.courseCode,
              teacherLabel: `缺师${token}`,
              comment: "教师不存在时的评价正文内容。",
            },
            {
              courseCode: unbound.courseCode,
              teacherLabel: unbound.teacherLabel,
              comment: "任课关系不存在的评价正文。",
            },
            {
              courseCode: matched.courseCode,
              teacherLabel: matched.teacherLabel,
              comment: matchedComment,
            },
            {
              key: "bad-key",
              courseCode: matched.courseCode,
              teacherLabel: matched.teacherLabel,
              comment: mismatchComment,
            },
            {
              courseCode: matched.courseCode,
              teacherLabel: matched.teacherLabel,
              comment: existingComment,
            },
            {
              courseCode: matched.courseCode,
              teacherLabel: matched.teacherLabel,
              comment: conflictComment,
            },
          ],
        },
        adminHeaders(await adminAuth()),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as ImportReport;
      expect(body).toMatchObject({
        package: PACKAGE,
        dryRun: true,
        total: 8,
        counts: {
          matched: 1,
          existing: 1,
          missing_course: 1,
          missing_teacher: 1,
          missing_relation: 1,
          duplicate_in_batch: 1,
          key_mismatch: 1,
          conflict: 1,
        },
      });
      expect(body).not.toHaveProperty("created");
      expect(body.items.map((item) => item.status)).toEqual([
        "matched",
        "missing_course",
        "missing_teacher",
        "missing_relation",
        "duplicate_in_batch",
        "key_mismatch",
        "existing",
        "conflict",
      ]);
      expect(body.items[0]).toMatchObject({
        key: matchedKey,
        id: await historicalReviewPublicId(PREFIX, matchedKey),
        courseId: matched.courseId,
        teacherId: matched.teacherId,
        sameRelationExistingCount: 2,
      });
      expect(body.items[1]).toMatchObject({ teacherId: matched.teacherId });
      expect(body.items[1]?.courseId).toBeUndefined();
      expect(body.items[1]?.sameRelationExistingCount).toBeUndefined();
      expect(body.items[2]).toMatchObject({ courseId: matched.courseId });
      expect(body.items[2]?.teacherId).toBeUndefined();
      expect(body.items[3]).toMatchObject({
        courseId: unbound.courseId,
        teacherId: unbound.teacherId,
        sameRelationExistingCount: 0,
      });
      expect(body.items[5]).toMatchObject({
        key: mismatchKey,
        id: await historicalReviewPublicId(PREFIX, mismatchKey),
        courseId: matched.courseId,
        teacherId: matched.teacherId,
      });
      expect(body.items[5]?.key).not.toBe("bad-key");
      expect(body.items[6]).toMatchObject({ id: existingId, status: "existing" });
      expect(body.items[7]).toMatchObject({ id: conflictId, status: "conflict" });
      expect(await countHistorical(seeds.map((seed) => seed.courseId))).toBe(before);
    } finally {
      await cleanupSeeds(seeds);
    }
  });

  it("accepts angle brackets as plain text during dry-run", async () => {
    const token = suffix();
    const bound = await seedPair(`H${token}`, `师H${token}`, true);
    try {
      const response = await postImport(
        IMPORT_PATH,
        {
          dryRun: true,
          records: [
            {
              courseCode: bound.courseCode,
              teacherLabel: bound.teacherLabel,
              comment: "含有<script>的纯文本评价",
            },
          ],
        },
        adminHeaders(await adminAuth()),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as ImportReport;
      expect(body.items[0]?.status).toBe("matched");
      expect(await countHistorical([bound.courseId])).toBe(0);
    } finally {
      await cleanupSeeds([bound]);
    }
  });

  it("imports a matched batch, stores the package contract, and replays as existing", async () => {
    const marker = await ensureMarker();
    const token = suffix();
    const first = await seedPair(`A${token}`, `师A${token}`, true);
    const second = await seedPair(`B${token}`, `师B${token}`, true);
    const records = [
      {
        courseCode: `  ${first.courseCode}  `,
        teacherLabel: ` ${first.teacherLabel} `,
        comment: "  历史评价正文    保留内部空格。  ",
      },
      {
        courseCode: second.courseCode,
        teacherLabel: second.teacherLabel,
        comment: "第二条可导入的历史评价正文。",
      },
    ];
    try {
      const created = await postImport(
        IMPORT_PATH,
        { dryRun: false, records },
        adminHeaders(await adminAuth()),
      );
      expect(created.status).toBe(201);
      const body = (await created.json()) as ImportReport;
      expect(body.created).toBe(2);
      expect(body.existing).toBe(0);
      expect(body.dryRun).toBe(false);
      expect(body.items.every((item) => item.status === "matched")).toBe(true);
      const storedComment = "历史评价正文    保留内部空格。";
      const firstItem = body.items[0]!;
      expect(firstItem.id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(parsePublicReviewTarget(`historical:${firstItem.id}`)).toEqual({
        kind: "historical",
        id: firstItem.id,
        publicId: `historical:${firstItem.id}`,
      });
      expect(firstItem.key).toBe(
        await historicalReviewStableKey({
          keyPrefix: PREFIX,
          courseCode: first.courseCode,
          teacherLabel: first.teacherLabel,
          comment: storedComment,
        }),
      );
      expect(firstItem.id).toBe(
        await historicalReviewPublicId(PREFIX, firstItem.key),
      );
      const manifest = await historicalPackageManifestSha256([
        {
          comment: storedComment,
          courseCode: first.courseCode,
          key: firstItem.key,
          teacherLabel: first.teacherLabel,
        },
        {
          comment: records[1]!.comment,
          courseCode: second.courseCode,
          key: body.items[1]!.key,
          teacherLabel: second.teacherLabel,
        },
      ]);
      const stored = await env.DB.prepare(
        `SELECT comment,package_contract,approved_package_manifest_sha256,approved_catalog_content_sha256
         FROM public_historical_reviews WHERE id=?`,
      )
        .bind(firstItem.id)
        .first<{
          comment: string;
          package_contract: string;
          approved_package_manifest_sha256: string;
          approved_catalog_content_sha256: string;
        }>();
      expect(stored).toEqual({
        comment: storedComment,
        package_contract: PACKAGE,
        approved_package_manifest_sha256: manifest,
        approved_catalog_content_sha256: marker.hash,
      });

      const replay = await postImport(
        IMPORT_PATH,
        { dryRun: false, records },
        adminHeaders(await adminAuth()),
      );
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as ImportReport;
      expect(replayBody.created).toBe(0);
      expect(replayBody.existing).toBe(2);
      expect(replayBody.items.every((item) => item.status === "existing")).toBe(
        true,
      );
      expect(await countHistorical([first.courseId, second.courseId])).toBe(2);
    } finally {
      await cleanupSeeds([first, second]);
      if (marker.inserted) await removeInsertedMarker(marker.batchId);
    }
  });

  it("rejects the whole batch when any row cannot be imported", async () => {
    const token = suffix();
    const bound = await seedPair(`C${token}`, `师C${token}`, true);
    const before = await countHistorical([bound.courseId]);
    try {
      const response = await postImport(
        IMPORT_PATH,
        {
          dryRun: false,
          records: [
            {
              courseCode: bound.courseCode,
              teacherLabel: bound.teacherLabel,
              comment: "本应匹配但整批被拒绝的评价。",
            },
            {
              courseCode: `NO${token}`,
              teacherLabel: bound.teacherLabel,
              comment: "缺课程所以整批不能写入。",
            },
          ],
        },
        adminHeaders(await adminAuth()),
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as ImportReport;
      expect(body.dryRun).toBe(false);
      expect(body).not.toHaveProperty("created");
      expect(body.counts).toMatchObject({ matched: 1, missing_course: 1 });
      expect(await countHistorical([bound.courseId])).toBe(before);
    } finally {
      await cleanupSeeds([bound]);
    }
  });

  it("rejects a short comment and a batch larger than 50 without writing", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) n FROM public_historical_reviews",
    ).first<{ n: number }>();
    const headers = adminHeaders(await adminAuth());
    const short = await postImport(
      IMPORT_PATH,
      {
        dryRun: false,
        records: [
          {
            courseCode: "TEST101",
            teacherLabel: "测试教师",
            comment: "123456789",
          },
        ],
      },
      headers,
    );
    expect(short.status).toBe(422);
    expect(await short.json()).toEqual({
      error: "第 1 条历史评价的正文长度无效",
    });

    const trimmed = await postImport(
      IMPORT_PATH,
      {
        dryRun: true,
        records: [
          {
            courseCode: "TEST101",
            teacherLabel: "测试教师",
            comment: "  1234567890  ",
          },
        ],
      },
      headers,
    );
    expect(trimmed.status).toBe(200);
    expect(((await trimmed.json()) as ImportReport).items[0]?.status).toBe(
      "matched",
    );

    const tooMany = await postImport(
      IMPORT_PATH,
      {
        dryRun: false,
        records: Array.from({ length: 51 }, () => ({
          courseCode: "TEST101",
          teacherLabel: "测试教师",
          comment: "123456789",
        })),
      },
      headers,
    );
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toEqual({ error: "历史评价导入请求格式无效" });
    const after = await env.DB.prepare(
      "SELECT COUNT(*) n FROM public_historical_reviews",
    ).first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n));
  });

  it("refuses to write when the catalog baseline marker is missing", async () => {
    const token = suffix();
    const bound = await seedPair(`D${token}`, `师D${token}`, true);
    const previous = await readMarker();
    await env.DB.prepare(
      "DELETE FROM catalog_baseline_marker WHERE singleton=1",
    ).run();
    try {
      const response = await postImport(
        IMPORT_PATH,
        {
          dryRun: false,
          records: [
            {
              courseCode: bound.courseCode,
              teacherLabel: bound.teacherLabel,
              comment: "没有目录基线时不能写入的评价。",
            },
          ],
        },
        adminHeaders(await adminAuth()),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "缺少已批准的目录基线" });
      expect(await countHistorical([bound.courseId])).toBe(0);
    } finally {
      await cleanupSeeds([bound]);
      if (previous) await writeMarker(previous);
    }
  });

  it("publishes a source label only for registered packages", async () => {
    expect(RESERVED_PUBLIC_PROFILE_NOTE).toBe(NOTE);
    const token = suffix();
    const bound = await seedPair(`S${token}`, `师S${token}`, true);
    const freshComment = `QQ频道来源标签评价${token}足够长`;
    const legacyComment = `腾讯表格旧批次评价${token}足够长`;
    const ordinaryComment = `普通课评没有来源标签${token}`;
    try {
      await insertHistorical({
        id: `qq-jufe-${token}${"ab".repeat(16)}`.slice(0, 40),
        courseId: bound.courseId,
        teacherId: bound.teacherId,
        comment: freshComment,
        packageContract: PACKAGE,
        importedAt: "2099-12-31 23:59:59",
      });
      await insertHistorical({
        id: `legacy-${token}`,
        courseId: bound.courseId,
        teacherId: bound.teacherId,
        comment: legacyComment,
        packageContract: "legacy-v5-historical-freeze-v1",
        importedAt: "2099-12-31 23:59:58",
      });
      await env.DB.prepare(
        `INSERT INTO reviews(
           course_id,teacher_id,category,overall,comment,status,submitter_hash,created_at
         ) VALUES(?,?,'general',4,?,'approved',?,?)`,
      )
        .bind(
          bound.courseId,
          bound.teacherId,
          ordinaryComment,
          `pkg-${token}`,
          "2099-12-31 23:59:57",
        )
        .run();

      const coursePage = await SELF.fetch(
        `${WRITE_ORIGIN}/api/courses/${bound.courseId}/reviews?teacherId=${bound.teacherId}&pageSize=20`,
      );
      expect(coursePage.status).toBe(200);
      const courseBody = (await coursePage.json()) as {
        items: Array<{ comment: string; source_label?: string | null }>;
      };
      const fresh = courseBody.items.find((item) => item.comment === freshComment);
      const legacy = courseBody.items.find((item) => item.comment === legacyComment);
      const ordinary = courseBody.items.find(
        (item) => item.comment === ordinaryComment,
      );
      expect(fresh?.source_label).toBe(SOURCE_LABEL);
      expect(legacy?.source_label ?? null).toBeNull();
      expect(ordinary?.source_label ?? null).toBeNull();
      for (const item of [fresh, legacy, ordinary]) {
        expect(item).toBeTruthy();
        expect(item).not.toHaveProperty("package_contract");
      }

      const latest = await SELF.fetch(
        `${WRITE_ORIGIN}/api/reviews/latest?pageSize=50`,
      );
      expect(latest.status).toBe(200);
      const latestItems = (
        (await latest.json()) as {
          items: Array<{ comment: string; source_label?: string | null }>;
        }
      ).items;
      expect(
        latestItems.find((item) => item.comment === freshComment)?.source_label,
      ).toBe(SOURCE_LABEL);
      expect(
        latestItems.find((item) => item.comment === legacyComment)?.source_label ??
          null,
      ).toBeNull();
      expect(
        latestItems.find((item) => item.comment === ordinaryComment),
      ).not.toHaveProperty("source_label");

      const profile = await SELF.fetch(`${WRITE_ORIGIN}/api/u/000000`);
      expect(profile.status).toBe(200);
      const profileBody = (await profile.json()) as {
        note: string;
        reviews: Array<{ comment: string; source_label?: string | null }>;
      };
      expect(profileBody.note).toBe(NOTE);
      expect(
        profileBody.reviews.find((item) => item.comment === freshComment)
          ?.source_label,
      ).toBe(SOURCE_LABEL);
      expect(
        profileBody.reviews.find((item) => item.comment === legacyComment)
          ?.source_label ?? null,
      ).toBeNull();
      expect(JSON.stringify(profileBody)).not.toContain("package_contract");
    } finally {
      await cleanupSeeds([bound]);
    }
  });
});
