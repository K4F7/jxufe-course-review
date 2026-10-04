/**
 * Configurable historical-review import packages.
 * `package_contract` stores the package name. Source labels come only from
 * this table; contracts that are not registered (including the Tencent-sheet
 * freeze `legacy-v5-historical-freeze-v1`) publish no source label.
 */
export const HISTORICAL_REVIEW_PACKAGES = {
  "qq-channel-jufe-v1": {
    keyPrefix: "qq-jufe",
    sourceLabel: "整理自 QQ 频道「江西财经大学」",
  },
} as const;

export type HistoricalReviewPackageName = keyof typeof HISTORICAL_REVIEW_PACKAGES;

export type HistoricalReviewPackage = {
  keyPrefix: string;
  sourceLabel: string;
};

export function historicalReviewPackage(
  name: string,
): HistoricalReviewPackage | null {
  if (!Object.prototype.hasOwnProperty.call(HISTORICAL_REVIEW_PACKAGES, name))
    return null;
  return HISTORICAL_REVIEW_PACKAGES[name as HistoricalReviewPackageName];
}

/** Public label for a stored package contract. Unknown contracts stay unlabeled. */
export function sourceLabelForPackageContract(
  packageContract: unknown,
): string | null {
  if (typeof packageContract !== "string" || !packageContract) return null;
  return historicalReviewPackage(packageContract)?.sourceLabel ?? null;
}

/** Trim and collapse internal whitespace so the stable key ignores spacing. */
export function normalizeHistoricalComment(comment: string): string {
  return comment.trim().replace(/\s+/g, " ");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stable key: `${keyPrefix}:${courseCode}:${teacherLabel}:${sha256(normalizedComment).slice(0, 16)}`.
 * Course code and teacher label are trimmed; the comment is whitespace-normalized.
 * The key may contain non-ASCII teacher labels, so it is not used as the public id.
 */
export async function historicalReviewStableKey(input: {
  keyPrefix: string;
  courseCode: string;
  teacherLabel: string;
  comment: string;
}): Promise<string> {
  const hash = (
    await sha256Hex(normalizeHistoricalComment(input.comment))
  ).slice(0, 16);
  return `${input.keyPrefix}:${input.courseCode.trim()}:${input.teacherLabel.trim()}:${hash}`;
}

/** ASCII public id. `sha256(stableKey)` keeps the id inside `[A-Za-z0-9._-]`. */
export async function historicalReviewPublicId(
  keyPrefix: string,
  stableKey: string,
): Promise<string> {
  const hash = (await sha256Hex(stableKey)).slice(0, 32);
  return `${keyPrefix}-${hash}`;
}

/**
 * `approved_package_manifest_sha256` for one import request.
 * The digest is SHA-256 of `JSON.stringify` over the request records, in
 * request order. Each element is `{comment, courseCode, key, teacherLabel}`
 * (that key order): trimmed course code, trimmed teacher label, trimmed
 * comment as stored, and the server stable key.
 */
export async function historicalPackageManifestSha256(
  records: readonly {
    comment: string;
    courseCode: string;
    key: string;
    teacherLabel: string;
  }[],
): Promise<string> {
  const canonical = JSON.stringify(
    records.map((record) => ({
      comment: record.comment,
      courseCode: record.courseCode,
      key: record.key,
      teacherLabel: record.teacherLabel,
    })),
  );
  return sha256Hex(canonical);
}
