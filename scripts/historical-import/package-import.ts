export const HISTORICAL_PACKAGE_IMPORT_BATCH_SIZE = 50;
export const HISTORICAL_PACKAGE_SCORE_WARNING = "历史评价不支持评分，已忽略";

export type HistoricalPackageCliRecord = {
  key?: string;
  courseCode: string;
  teacherLabel: string;
  comment: string;
};

/** Record plus its JSONL line number, for reporting only (not sent). */
export type HistoricalPackageCliLine = {
  line: number;
  record: HistoricalPackageCliRecord;
};

/**
 * A file key is forwarded for strict server comparison only when it already
 * has the canonical shape `${keyPrefix}:<课号>:<教师称呼>:<16 hex>`. Older
 * draft keys (course name instead of code, short hash) are dropped with a
 * warning so the server-computed key wins.
 */
export function canonicalFileKey(
  key: string | undefined,
  keyPrefix: string,
): string | undefined {
  if (key == null) return undefined;
  const parts = key.split(":");
  if (
    parts.length === 4 &&
    parts[0] === keyPrefix &&
    parts[1].trim() !== "" &&
    parts[2].trim() !== "" &&
    /^[0-9a-f]{16}$/.test(parts[3])
  )
    return key;
  return undefined;
}

export function applyFileKeyPolicy(
  lines: readonly HistoricalPackageCliLine[],
  keyPrefix: string,
): { lines: HistoricalPackageCliLine[]; warnings: string[] } {
  const warnings: string[] = [];
  const next = lines.map(({ line, record }) => {
    if (record.key === undefined) return { line, record };
    const key = canonicalFileKey(record.key, keyPrefix);
    if (key) return { line, record };
    warnings.push(
      `第 ${line} 行：key 不是规范格式（${keyPrefix}:课号:教师称呼:16 位哈希），已忽略，以服务端计算为准`,
    );
    const { key: _dropped, ...rest } = record;
    return { line, record: rest };
  });
  return { lines: next, warnings };
}

export type HistoricalPackageCliArguments = {
  package: string;
  file: string;
  apply: boolean;
};

export function parsePackageImportArguments(
  argv: readonly string[],
): HistoricalPackageCliArguments {
  let packageName: string | undefined;
  let file: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--apply") {
      if (apply) throw new Error("不得重复传入 --apply");
      apply = true;
      continue;
    }
    if (argument === "--package" || argument === "--file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`缺少 ${argument} 的值`);
      if (argument === "--package") {
        if (packageName) throw new Error("不得重复传入 --package");
        packageName = value;
      } else {
        if (file) throw new Error("不得重复传入 --file");
        file = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${argument}`);
  }
  if (!packageName) throw new Error("缺少 --package");
  if (!file) throw new Error("缺少 --file");
  return { package: packageName, file, apply };
}

export function historicalPackageBackupPath(
  packageName: string,
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `.local-data/historical-${packageName}-${stamp}.sql`;
}

export function chunkRecords<T>(
  records: readonly T[],
  size = HISTORICAL_PACKAGE_IMPORT_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("批次大小无效");
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size)
    chunks.push(records.slice(index, index + size));
  return chunks;
}

function isFilledScore(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

export function parseHistoricalPackageJsonl(text: string): {
  records: HistoricalPackageCliRecord[];
  lines: HistoricalPackageCliLine[];
  warnings: string[];
} {
  const records: HistoricalPackageCliRecord[] = [];
  const parsedLines: HistoricalPackageCliLine[] = [];
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const lineNo = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`第 ${lineNo} 行不是有效 JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`第 ${lineNo} 行不是 JSON 对象`);
    const row = parsed as Record<string, unknown>;
    if (
      typeof row.course_code !== "string" ||
      typeof row.teacher !== "string" ||
      typeof row.body !== "string"
    )
      throw new Error(`第 ${lineNo} 行缺少 course_code、teacher 或 body`);
    if (isFilledScore(row.overall) || isFilledScore(row.scores))
      warnings.push(`第 ${lineNo} 行：${HISTORICAL_PACKAGE_SCORE_WARNING}`);
    const record: HistoricalPackageCliRecord = {
      courseCode: row.course_code,
      teacherLabel: row.teacher,
      comment: row.body,
    };
    if (row.key != null) {
      if (typeof row.key !== "string")
        throw new Error(`第 ${lineNo} 行的 key 不是字符串`);
      record.key = row.key;
    }
    records.push(record);
    parsedLines.push({ line: lineNo, record });
  }
  return { records, lines: parsedLines, warnings };
}
