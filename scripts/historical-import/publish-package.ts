import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jsonErrorMessage } from "../json-error";
import { resolveAdminSession } from "../secrets/inventory";
import { historicalReviewPackage } from "../../src/historical-review-packages";
import { createProductionD1ExportCommand } from "./production-wrangler";
import {
  applyFileKeyPolicy,
  chunkRecords,
  historicalPackageBackupPath,
  parseHistoricalPackageJsonl,
  parsePackageImportArguments,
  type HistoricalPackageCliRecord,
} from "./package-import";

const exec = promisify(execFile);
const args = parsePackageImportArguments(process.argv.slice(2));
const packageDef = historicalReviewPackage(args.package);
if (!packageDef) throw new Error(`未知历史评价导入批次: ${args.package}`);

const parsed = parseHistoricalPackageJsonl(
  await readFile(resolve(args.file), "utf8"),
);
const keyed = applyFileKeyPolicy(parsed.lines, packageDef.keyPrefix);
for (const warning of [...parsed.warnings, ...keyed.warnings])
  console.warn(warning);
if (!keyed.lines.length) throw new Error("JSONL 没有可导入的评价");
const records = keyed.lines.map((entry) => entry.record);

const baseUrl = (process.env.JUFEXK_BASE_URL || "https://courses.sein.moe").replace(
  /\/$/,
  "",
);
const adminSession = resolveAdminSession(process.env);
const batches = chunkRecords(keyed.lines);

type ImportReport = {
  package: string;
  dryRun: boolean;
  total: number;
  counts: Record<string, number>;
  items: Array<{
    index: number;
    key: string;
    id: string;
    status: string;
  }>;
  created?: number;
  existing?: number;
};

const cookies = new Map<string, string>();
let csrf = "";
function remember(headers: Headers) {
  const setCookies = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [headers.get("set-cookie") || ""];
  for (const value of setCookies) {
    const match = /^([^=;,]+)=([^;]*)/.exec(value);
    if (match) cookies.set(match[1], match[2]);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Origin", baseUrl);
  if (cookies.size)
    headers.set(
      "Cookie",
      [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    );
  if (csrf && init.method && init.method !== "GET")
    headers.set("X-CSRF-Token", csrf);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  remember(response.headers);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${init.method || "GET"} ${path}: ${jsonErrorMessage(body, response.status)}`,
    );
  return body as T;
}

for (const part of adminSession.cookie.split(";")) {
  const match = /^([^=]+)=(.*)$/.exec(part.trim());
  if (match) cookies.set(match[1], match[2]);
}
csrf = adminSession.csrf;

const importPath = `/api/admin/historical-review-packages/${encodeURIComponent(args.package)}/imports`;

async function postBatch(
  dryRun: boolean,
  lines: Array<{ line: number; record: HistoricalPackageCliRecord }>,
) {
  return api<ImportReport>(importPath, {
    method: "POST",
    body: JSON.stringify({ dryRun, records: lines.map((entry) => entry.record) }),
  });
}

function summarize(reports: ImportReport[]) {
  const counts: Record<string, number> = {};
  const unmatched: Array<
    ImportReport["items"][number] & {
      line: number;
      courseCode: string;
      teacherLabel: string;
    }
  > = [];
  let total = 0;
  for (const [batch, report] of reports.entries()) {
    total += report.total;
    for (const [key, value] of Object.entries(report.counts || {}))
      counts[key] = (counts[key] || 0) + Number(value || 0);
    for (const item of report.items || []) {
      if (item.status !== "matched" && item.status !== "existing") {
        const source = batches[batch]?.[item.index];
        unmatched.push({
          ...item,
          line: source?.line ?? -1,
          courseCode: source?.record.courseCode ?? "",
          teacherLabel: source?.record.teacherLabel ?? "",
        });
      }
    }
  }
  return { total, counts, unmatched };
}

const previews = [];
for (const batch of batches) previews.push(await postBatch(true, batch));
const preview = summarize(previews);
if (preview.unmatched.length) {
  console.log(
    JSON.stringify({
      mode: "dry-run",
      package: args.package,
      ...preview,
      wroteProductionD1: false,
    }),
  );
  process.exit(2);
}
if (!args.apply) {
  console.log(
    JSON.stringify({
      mode: "dry-run",
      package: args.package,
      ...preview,
      wroteProductionD1: false,
    }),
  );
  process.exit(0);
}

const backupPath = resolve(
  process.env.JUFEXK_BACKUP_PATH || historicalPackageBackupPath(args.package),
);
await mkdir(dirname(backupPath), { recursive: true });
let backupExists = false;
try {
  await access(backupPath);
  backupExists = true;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (backupExists)
  throw new Error(`备份路径已存在，拒绝覆盖旧备份: ${backupPath}`);
const command = createProductionD1ExportCommand(backupPath);
await access(command.wranglerCli);
await exec(command.executable, command.args);

let created = 0;
let existing = 0;
for (const batch of batches) {
  const applied = await postBatch(false, batch);
  created += Number(applied.created || 0);
  existing += Number(applied.existing || 0);
}
const replayReports = [];
for (const batch of batches) replayReports.push(await postBatch(true, batch));
const replay = summarize(replayReports);
if (
  replay.unmatched.length ||
  replay.total !== records.length ||
  (replay.counts.existing || 0) !== records.length
)
  throw new Error("重放后仍有未存在的历史评价");

console.log(
  JSON.stringify({
    mode: "apply",
    package: args.package,
    created,
    existing,
    replay,
    backupPath,
    wroteProductionD1: true,
  }),
);
