import { describe, expect, it } from "vitest";
import { parsePublicReviewTarget } from "../src/lib/public-review-id";
import {
  historicalPackageManifestSha256,
  historicalReviewPublicId,
  historicalReviewStableKey,
  normalizeHistoricalComment,
  sha256Hex,
} from "../src/historical-review-packages";
import {
  HISTORICAL_PACKAGE_IMPORT_BATCH_SIZE,
  HISTORICAL_PACKAGE_SCORE_WARNING,
  applyFileKeyPolicy,
  canonicalFileKey,
  chunkRecords,
  historicalPackageBackupPath,
  parseHistoricalPackageJsonl,
  parsePackageImportArguments,
} from "../scripts/historical-import/package-import";

describe("historical review stable key", () => {
  it("normalizes whitespace, keeps the prefix, and uses a 16-char hash", async () => {
    expect(normalizeHistoricalComment("  a \n b\tc  ")).toBe("a b c");
    const spaced = await historicalReviewStableKey({
      keyPrefix: "qq-jufe",
      courseCode: " CS1 ",
      teacherLabel: " 张三 ",
      comment: "  hello \n\t world  ",
    });
    const compact = await historicalReviewStableKey({
      keyPrefix: "qq-jufe",
      courseCode: "CS1",
      teacherLabel: "张三",
      comment: "hello world",
    });
    expect(spaced).toBe(compact);
    const hash = compact.slice(compact.lastIndexOf(":") + 1);
    expect(compact).toBe(`qq-jufe:CS1:张三:${hash}`);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(hash).toBe((await sha256Hex("hello world")).slice(0, 16));

    const other = await historicalReviewStableKey({
      keyPrefix: "qq-jufe",
      courseCode: "CS1",
      teacherLabel: "张三",
      comment: "hello world!",
    });
    expect(other).not.toBe(compact);
    const otherPrefix = await historicalReviewStableKey({
      keyPrefix: "other",
      courseCode: "CS1",
      teacherLabel: "张三",
      comment: "hello world",
    });
    expect(otherPrefix.startsWith("other:CS1:张三:")).toBe(true);

    const id = await historicalReviewPublicId("qq-jufe", compact);
    expect(id).toMatch(/^qq-jufe-[a-f0-9]{32}$/);
    expect(parsePublicReviewTarget(`historical:${id}`)).toEqual({
      kind: "historical",
      id,
      publicId: `historical:${id}`,
    });
  });

  it("hashes the request records in canonical field order", async () => {
    const records = [
      { comment: "正文甲", courseCode: "C1", key: "k1", teacherLabel: "师甲" },
      { comment: "正文乙", courseCode: "C2", key: "k2", teacherLabel: "师乙" },
    ];
    const digest = await historicalPackageManifestSha256(records);
    expect(digest).toBe(
      await sha256Hex(
        JSON.stringify([
          { comment: "正文甲", courseCode: "C1", key: "k1", teacherLabel: "师甲" },
          { comment: "正文乙", courseCode: "C2", key: "k2", teacherLabel: "师乙" },
        ]),
      ),
    );
    expect(digest).toHaveLength(64);
  });
});

describe("historical package import CLI", () => {
  it("parses package, file, and apply", () => {
    expect(
      parsePackageImportArguments([
        "--package",
        "qq-channel-jufe-v1",
        "--file",
        "rows.jsonl",
      ]),
    ).toEqual({
      package: "qq-channel-jufe-v1",
      file: "rows.jsonl",
      apply: false,
    });
    expect(
      parsePackageImportArguments([
        "--",
        "--apply",
        "--file",
        "rows.jsonl",
        "--package",
        "qq-channel-jufe-v1",
      ]),
    ).toEqual({
      package: "qq-channel-jufe-v1",
      file: "rows.jsonl",
      apply: true,
    });
    expect(() => parsePackageImportArguments(["--file", "rows.jsonl"])).toThrow(
      "缺少 --package",
    );
    expect(() =>
      parsePackageImportArguments(["--package", "qq-channel-jufe-v1"]),
    ).toThrow("缺少 --file");
    expect(() =>
      parsePackageImportArguments([
        "--package",
        "a",
        "--package",
        "b",
        "--file",
        "rows.jsonl",
      ]),
    ).toThrow("不得重复传入 --package");
    expect(() =>
      parsePackageImportArguments([
        "--apply",
        "--apply",
        "--package",
        "a",
        "--file",
        "rows.jsonl",
      ]),
    ).toThrow("不得重复传入 --apply");
    expect(() =>
      parsePackageImportArguments(["--package", "a", "--file"]),
    ).toThrow("缺少 --file 的值");
    expect(() =>
      parsePackageImportArguments(["--weird", "--package", "a", "--file", "f"]),
    ).toThrow("未知参数: --weird");
  });

  it("maps JSONL fields and warns when scores are present", () => {
    const text = [
      "\uFEFF" +
        JSON.stringify({
          course_code: "C1",
          teacher: "师甲",
          body: "  正文甲  ",
          course_name: "忽略",
          overall: 0,
          headline: "忽略",
        }),
      "",
      JSON.stringify({
        key: "client-key",
        course_code: "C2",
        teacher: "师乙",
        body: "正文乙",
        scores: { clarity: 5 },
        overall: "",
        source_note: "忽略",
      }),
      JSON.stringify({
        course_code: "C3",
        teacher: "师丙",
        body: "正文丙",
        overall: null,
        scores: {},
        match_status: "忽略",
      }),
      JSON.stringify({
        course_code: "C4",
        teacher: "师丁",
        body: "正文丁",
        scores: [],
      }),
    ].join("\n");
    const parsed = parseHistoricalPackageJsonl(text);
    expect(parsed.records).toEqual([
      { courseCode: "C1", teacherLabel: "师甲", comment: "  正文甲  " },
      {
        key: "client-key",
        courseCode: "C2",
        teacherLabel: "师乙",
        comment: "正文乙",
      },
      { courseCode: "C3", teacherLabel: "师丙", comment: "正文丙" },
      { courseCode: "C4", teacherLabel: "师丁", comment: "正文丁" },
    ]);
    expect(parsed.warnings).toEqual([
      `第 1 行：${HISTORICAL_PACKAGE_SCORE_WARNING}`,
      `第 3 行：${HISTORICAL_PACKAGE_SCORE_WARNING}`,
    ]);
    expect(() => parseHistoricalPackageJsonl("{")).toThrow("第 1 行不是有效 JSON");
    expect(() =>
      parseHistoricalPackageJsonl(
        JSON.stringify({ course_code: "C", teacher: "T" }),
      ),
    ).toThrow("第 1 行缺少 course_code、teacher 或 body");
    expect(() =>
      parseHistoricalPackageJsonl(
        JSON.stringify({
          key: 1,
          course_code: "C",
          teacher: "T",
          body: "正文",
        }),
      ),
    ).toThrow("第 1 行的 key 不是字符串");
  });

  it("chunks records and builds a backup path that does not overwrite punctuation", () => {
    const records = Array.from({ length: 51 }, (_, index) => index);
    const chunks = chunkRecords(records);
    expect(HISTORICAL_PACKAGE_IMPORT_BATCH_SIZE).toBe(50);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 1]);
    expect(
      historicalPackageBackupPath(
        "qq-channel-jufe-v1",
        new Date("2026-10-04T12:00:00.000Z"),
      ),
    ).toBe(
      ".local-data/historical-qq-channel-jufe-v1-2026-10-04T12-00-00-000Z.sql",
    );
  });

  it("forwards only canonical file keys and drops draft keys with a warning", async () => {
    const canonical = await historicalReviewStableKey({
      keyPrefix: "qq-jufe",
      courseCode: "1005402753",
      teacherLabel: "余伟伟",
      comment: "这门课讲得清楚，作业不多，考试按平时讲的来。",
    });
    expect(canonicalFileKey(canonical, "qq-jufe")).toBe(canonical);
    expect(canonicalFileKey("qq-jufe:微观经济学:余红娟:8deee2", "qq-jufe")).toBeUndefined();
    expect(canonicalFileKey(canonical.replace("qq-jufe", "other"), "qq-jufe")).toBeUndefined();
    expect(canonicalFileKey(undefined, "qq-jufe")).toBeUndefined();

    const { records, lines } = parseHistoricalPackageJsonl(
      [
        JSON.stringify({ key: canonical, course_code: "1005402753", teacher: "余伟伟", body: "这门课讲得清楚，作业不多，考试按平时讲的来。" }),
        "",
        JSON.stringify({ key: "qq-jufe:微观经济学:余红娟:8deee2", course_code: "1005101903", teacher: "余红斌", body: "讲课很有高度，整体推荐，难度信息不足。" }),
      ].join("\n"),
    );
    expect(records).toHaveLength(2);
    expect(lines.map((entry) => entry.line)).toEqual([1, 3]);
    const policy = applyFileKeyPolicy(lines, "qq-jufe");
    expect(policy.lines[0].record.key).toBe(canonical);
    expect(policy.lines[1].record).not.toHaveProperty("key");
    expect(policy.warnings).toEqual([
      "第 3 行：key 不是规范格式（qq-jufe:课号:教师称呼:16 位哈希），已忽略，以服务端计算为准",
    ]);
  });
});
