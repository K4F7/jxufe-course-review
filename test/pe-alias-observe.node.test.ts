import { describe, expect, it, vi } from "vitest";
import {
  analyticsDatasetName,
  buildAliasAnalyticsSql,
  queryAnalyticsEngineSql,
  readWranglerOauthToken,
} from "../scripts/pe-alias-observe/analytics";
import {
  ANALYTICS_VS_D1_GAPS,
  PE_ALIAS_OBSERVE_SCHEMA,
  PE_ALIAS_RC_DEPLOY_NOT_BEFORE,
  buildAliasMetrics,
  buildPeAliasObserveReport,
  formatPeAliasObserveMarkdown,
  matchDeploySha,
  resolveObservationWindow,
} from "../scripts/pe-alias-observe/report";
import { reportFromQueryBatches, runPeAliasObserve } from "../scripts/pe-alias-observe/run";
import {
  PE_ALIAS_OBSERVE_WRITE_TABLES,
  VIRTUAL_PE_OBSERVE_IDS,
  assertReadOnlyObserveSql,
  buildPeAliasObserveSql,
  toUtcDateTimeLiteral,
} from "../scripts/pe-alias-observe/sql";
import { parseWorkerDeploymentRecords } from "../scripts/pe-mapping-audit/execute";
import { stripSqlStringsAndComments } from "../scripts/pe-mapping-audit/sql";
import { VIRTUAL_PE_SPORTS } from "../src/lib/public-course-presentation";

const queriedAt = "2026-09-02T12:00:00.000Z";
const windowStart = "2026-09-01T22:15:18.498722Z";
const windowEnd = "2026-09-02T10:16:05.846942Z";

const deploymentsJson = JSON.stringify([
  {
    id: "213123fe-660b-46c9-9382-910f961b0632",
    created_on: "2026-09-01T21:47:47.162366Z",
    versions: [{ version_id: "1a3aa0b1-f945-4457-a77b-20b0466685d9", percentage: 100 }],
  },
  {
    id: "b864f164-8f1e-4e00-84f4-ab47dd39c1dd",
    created_on: windowStart,
    versions: [{ version_id: "005aff8c-c4dd-4127-98b2-297116b6fe68", percentage: 100 }],
  },
  {
    id: "8dbbe9e3-af9d-488a-90f7-2300a4c0d8bc",
    created_on: windowEnd,
    versions: [{ version_id: "d1702327-1481-4f7b-b8bf-ebfc18f0d720", percentage: 100 }],
  },
]);

const fixtureWrites = PE_ALIAS_OBSERVE_WRITE_TABLES.map((spec) => ({
  table_name: spec.table,
  kind: spec.kind,
  id_column: spec.idColumn,
  total_rows: spec.table === "relation_follows" ? 12 : 4,
  count_800001: spec.table === "relation_follows" ? 2 : spec.table === "virtual_pe_notification_courses" ? 1 : 0,
  count_800002: spec.table === "relation_follows" ? 1 : spec.table === "virtual_pe_notification_courses" ? 1 : 0,
  window_virtual: spec.timeColumn ? 0 : null,
  window_800001: spec.timeColumn ? 0 : null,
  window_800002: spec.timeColumn ? 0 : null,
  first_virtual_at:
    spec.table === "relation_follows" ? "2026-08-01 12:00:00" : null,
  last_virtual_at:
    spec.table === "relation_follows" ? "2026-08-20 12:00:00" : null,
}));

const fixtureDiscovery = [
  { table_name: "course_teachers" },
  { table_name: "offerings" },
  { table_name: "relation_follows" },
];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

function sampleReport(overrides?: {
  cycleComplete?: boolean;
  windowVirtual?: number;
  alias?: ReturnType<typeof buildAliasMetrics>;
}) {
  const writeRows = fixtureWrites.map((row) =>
    row.table_name === "relation_follows" && overrides?.windowVirtual
      ? {
          ...row,
          window_virtual: overrides.windowVirtual,
          window_800001: overrides.windowVirtual,
        }
      : row,
  );
  return buildPeAliasObserveReport({
    queriedAt,
    windowStart,
    windowEnd: overrides?.cycleComplete === false ? null : windowEnd,
    cycleComplete: overrides?.cycleComplete ?? true,
    deploySha: "c08ebe05824c1d4dcf03fa061385c6ea4c6657fe",
    workerVersion: "005aff8c-c4dd-4127-98b2-297116b6fe68",
    deployments: {
      start: {
        id: "b864f164-8f1e-4e00-84f4-ab47dd39c1dd",
        versionId: "005aff8c-c4dd-4127-98b2-297116b6fe68",
        createdOn: windowStart,
        sha: "c08ebe05824c1d4dcf03fa061385c6ea4c6657fe",
      },
      end:
        overrides?.cycleComplete === false
          ? null
          : {
              id: "8dbbe9e3-af9d-488a-90f7-2300a4c0d8bc",
              versionId: "d1702327-1481-4f7b-b8bf-ebfc18f0d720",
              createdOn: windowEnd,
              sha: "50397f04a30578cb7ebec3604949d819dae9ba8c",
            },
      latest: {
        id: "8dbbe9e3-af9d-488a-90f7-2300a4c0d8bc",
        versionId: "d1702327-1481-4f7b-b8bf-ebfc18f0d720",
        createdOn: windowEnd,
        sha: "50397f04a30578cb7ebec3604949d819dae9ba8c",
      },
    },
    writeRows,
    discoveredTables: fixtureDiscovery,
    alias:
      overrides?.alias ??
      buildAliasMetrics({
        source: "analytics_engine",
        dataset: "jufexk_events",
        windowStart,
        rows: [
          { event: "review_view", course_id: "800001", n: 4 },
          { event: "review_view", course_id: "800002", n: 1 },
          { event: "review_dwell", course_id: "800001", n: 2 },
        ],
        windowTotals: [{ event: "review_view", n: 9 }],
        freshness: [
          {
            first_ts: "2026-08-31 16:22:46",
            last_ts: "2026-09-02 09:00:00",
            n: 53,
          },
        ],
      }),
  });
}

describe("read-only PE alias observe SQL", () => {
  it("emits SELECT/UNION counts without review bodies or writes", () => {
    const sql = buildPeAliasObserveSql(windowStart, windowEnd);
    expect(() => assertReadOnlyObserveSql(sql)).not.toThrow();
    expect(sql.trim().startsWith("SELECT")).toBe(true);
    expect(VIRTUAL_PE_OBSERVE_IDS).toEqual([800001, 800002]);
    for (const sport of VIRTUAL_PE_SPORTS) {
      expect(sql).toContain(String(sport.id));
    }
    for (const spec of PE_ALIAS_OBSERVE_WRITE_TABLES) {
      expect(sql).toContain(`FROM ${spec.table}`);
      expect(sql).toContain(spec.idColumn);
    }
    expect(sql).toContain("sqlite_master");
    expect(sql).toContain(toUtcDateTimeLiteral(windowStart));
    expect(sql).toContain(toUtcDateTimeLiteral(windowEnd));
    expect(sql).not.toMatch(/\bUNION\b/i);
    expect(sql.split(";").map((part) => part.trim()).filter(Boolean)).toHaveLength(
      PE_ALIAS_OBSERVE_WRITE_TABLES.length + 1,
    );
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bEXPORT\b/i);
    expect(stripSqlStringsAndComments(sql)).not.toMatch(/\bcomment\b/i);
    expect(sql).not.toMatch(/CASTGC|JSESSIONID|student_id/i);
  });

  it("refuses mutating SQL and body/identity columns", () => {
    expect(() => assertReadOnlyObserveSql("SELECT 1; DELETE FROM relation_follows")).toThrow(
      /只读|SELECT/,
    );
    expect(() => assertReadOnlyObserveSql("SELECT comment FROM reviews")).toThrow(/正文|证据/);
    expect(() => assertReadOnlyObserveSql("SELECT * FROM users")).toThrow(/身份|会话/);
    expect(() => assertReadOnlyObserveSql("SELECT evidence_json FROM catalog_requests")).toThrow(
      /正文|证据/,
    );
    expect(stripSqlStringsAndComments("SELECT 'DELETE'")).not.toMatch(/\bDELETE\b/);
    expect(() => assertReadOnlyObserveSql("SELECT 'DELETE'")).not.toThrow();
  });
});

describe("PE alias observation window", () => {
  it("uses the first #841/#842 deploy through the next Worker deploy", () => {
    const deployments = parseWorkerDeploymentRecords(deploymentsJson);
    const window = resolveObservationWindow(deployments, queriedAt);
    expect(window.windowStart).toBe(windowStart);
    expect(window.windowEnd).toBe(windowEnd);
    expect(window.cycleComplete).toBe(true);
    expect(window.start?.id).toBe("b864f164-8f1e-4e00-84f4-ab47dd39c1dd");
    expect(window.start?.versionId).toBe("005aff8c-c4dd-4127-98b2-297116b6fe68");
    expect(window.end?.id).toBe("8dbbe9e3-af9d-488a-90f7-2300a4c0d8bc");
    expect(window.latest?.versionId).toBe("d1702327-1481-4f7b-b8bf-ebfc18f0d720");
    expect(Date.parse(window.windowStart)).toBeGreaterThanOrEqual(
      Date.parse(PE_ALIAS_RC_DEPLOY_NOT_BEFORE),
    );
  });

  it("keeps the window open when no later deploy exists", () => {
    const deployments = parseWorkerDeploymentRecords(
      JSON.stringify([
        {
          id: "b864f164-8f1e-4e00-84f4-ab47dd39c1dd",
          created_on: windowStart,
          versions: [{ version_id: "005aff8c-c4dd-4127-98b2-297116b6fe68", percentage: 100 }],
        },
      ]),
    );
    const window = resolveObservationWindow(deployments, queriedAt);
    expect(window.cycleComplete).toBe(false);
    expect(window.windowEnd).toBeNull();
    expect(window.sqlWindowEnd).toBe(queriedAt);
  });

  it("matches GitHub deploy SHAs within five minutes", () => {
    expect(
      matchDeploySha(windowStart, [
        {
          headSha: "c08ebe05824c1d4dcf03fa061385c6ea4c6657fe",
          updatedAt: "2026-09-01T22:15:26Z",
          conclusion: "success",
        },
      ]),
    ).toBe("c08ebe05824c1d4dcf03fa061385c6ea4c6657fe");
    expect(
      matchDeploySha(windowStart, [
        {
          headSha: "deadbeef",
          updatedAt: "2026-09-01T21:00:00Z",
          conclusion: "success",
        },
      ]),
    ).toBeNull();
  });
});

describe("PE alias observe report shape", () => {
  const report = sampleReport();

  it("locks write counts, alias beacons, and closing flags", () => {
    expect(report.schemaVersion).toBe(PE_ALIAS_OBSERVE_SCHEMA);
    expect(report.readOnly).toBe(true);
    expect(report.cycleComplete).toBe(true);
    expect(report.writes.userWriteVirtualLifetime).toBe(3);
    expect(report.writes.userWriteVirtualInWindow).toBe(0);
    expect(report.writes.noNewVirtualUserWrites).toBe(true);
    expect(report.alias.requests).toBe(5);
    expect(report.alias.successes).toBe(5);
    expect(report.alias.failures).toBeNull();
    expect(report.alias.successRate).toBeNull();
    expect(report.alias.failureRate).toBeNull();
    expect(report.alias.coverage.windowCovered).toBe(true);
    expect(report.status).toEqual({
      cycleComplete: true,
      noNewVirtualUserWrites: true,
      aliasMetricsAvailable: true,
    });
    expect(report.discoveredCourseIdTables).toEqual([
      "course_teachers",
      "offerings",
      "relation_follows",
    ]);
    expect(report.analyticsVsD1.gaps).toEqual([...ANALYTICS_VS_D1_GAPS]);
    expect(sampleReport({ windowVirtual: 1 }).writes.noNewVirtualUserWrites).toBe(false);
  });

  it("locks the JSON shape and omits review bodies, cookies, and student identity", () => {
    expect(Object.keys(report).sort()).toEqual([
      "alias",
      "analyticsVsD1",
      "cycleComplete",
      "dataScope",
      "deploySha",
      "deployments",
      "discoveredCourseIdTables",
      "queriedAt",
      "readOnly",
      "schemaVersion",
      "status",
      "windowEnd",
      "windowStart",
      "workerVersion",
      "workerVersionId",
      "writes",
    ]);
    expect(Object.keys(report.writes).sort()).toEqual([
      "noNewVirtualUserWrites",
      "tables",
      "userWriteVirtualInWindow",
      "userWriteVirtualLifetime",
    ]);
    expect(Object.keys(report.alias).sort()).toEqual([
      "configured",
      "coverage",
      "dataset",
      "definition",
      "error",
      "events",
      "failurePercent",
      "failureRate",
      "failures",
      "requests",
      "source",
      "successPercent",
      "successRate",
      "successes",
    ]);
    const keys = [...collectKeys(report)];
    expect(keys).not.toEqual(
      expect.arrayContaining([
        "comment",
        "cookie",
        "email",
        "evidence_json",
        "html",
        "note",
        "studentId",
        "student_id",
      ]),
    );
    const markdown = formatPeAliasObserveMarkdown(report);
    expect(markdown).toContain("完整发布周期: 是");
    expect(markdown).toContain("访问量（review_view）: 5");
    expect(markdown).toContain("窗口内无新增旧虚拟身份: 是");
    expect(markdown).toContain("c08ebe05824c1d4dcf03fa061385c6ea4c6657fe");
    expect(markdown).toContain("无法从 Analytics Engine 计算");
    expect(markdown).not.toMatch(/CASTGC|JSESSIONID|Set-Cookie/i);
    expect(
      formatPeAliasObserveMarkdown(sampleReport({ cycleComplete: false })),
    ).toContain("完整发布周期: 否");
  });
});

describe("PE alias observe wrangler and analytics", () => {
  it("rebuilds the report from two wrangler result sets", () => {
    const report = reportFromQueryBatches(
      [{ results: fixtureWrites }, { results: fixtureDiscovery }],
      {
        queriedAt,
        windowStart,
        windowEnd,
        cycleComplete: true,
        deploySha: "abc",
        workerVersion: "version-1",
        deployments: {
          start: null,
          end: null,
          latest: null,
        },
        alias: buildAliasMetrics({
          source: "unavailable",
          dataset: "jufexk_events",
          error: "analytics_engine_unauthorized",
        }),
      },
    );
    expect(report.writes.noNewVirtualUserWrites).toBe(true);
    expect(report.status.aliasMetricsAvailable).toBe(false);
    expect(report.alias.error).toBe("analytics_engine_unauthorized");
  });

  it("prints deterministic SQL without calling wrangler", async () => {
    const { printed, report } = await runPeAliasObserve([
      "--print-sql",
      "--queried-at",
      queriedAt,
      "--window-start",
      windowStart,
      "--window-end",
      windowEnd,
    ]);
    expect(report).toBeUndefined();
    expect(printed).toContain("relation_follows");
    expect(printed).toContain(toUtcDateTimeLiteral(windowStart));
    expect(printed).toContain(toUtcDateTimeLiteral(windowEnd));
  });

  it("queries Analytics Engine SQL and records unauthorized as a gap", async () => {
    expect(analyticsDatasetName()).toBe("jufexk_events");
    const sql = buildAliasAnalyticsSql({ windowStart, windowEnd });
    expect(sql).toContain("jufexk_events");
    expect(sql).toContain("'800001'");
    expect(sql).toContain("toDateTime('2026-09-01 22:15:18')");
    const missing = await queryAnalyticsEngineSql({ sql, token: "" });
    expect(missing).toEqual({
      ok: false,
      status: 0,
      error: "analytics_token_missing",
    });
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const unauthorized = await queryAnalyticsEngineSql({
      sql,
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(unauthorized).toEqual({
      ok: false,
      status: 403,
      error: "analytics_engine_unauthorized",
    });
    const okFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ event: "review_view", course_id: "800001", n: 3 }],
          }),
          { status: 200 },
        ),
    );
    const ok = await queryAnalyticsEngineSql({
      sql,
      token: "token",
      fetchImpl: okFetch as unknown as typeof fetch,
    });
    expect(ok).toEqual({
      ok: true,
      rows: [{ event: "review_view", course_id: "800001", n: 3 }],
    });
    expect(
      readWranglerOauthToken({
        homedir: "C:\\unused",
        env: { APPDATA: "C:\\unused-appdata" },
        readFile: (path) =>
          path.replaceAll("\\", "/").endsWith(".wrangler/config/default.toml")
            ? 'oauth_token = "cfoat_test_token"\n'
            : "",
      }),
    ).toBe("cfoat_test_token");
    const stale = buildAliasMetrics({
      source: "analytics_engine",
      dataset: "jufexk_events",
      windowStart,
      rows: [],
      windowTotals: [],
      freshness: [
        {
          first_ts: "2026-08-31 16:22:46",
          last_ts: "2026-09-01 15:49:48",
          n: 53,
        },
      ],
    });
    expect(stale.error).toBe("analytics_engine_window_uncovered");
    expect(stale.coverage.windowCovered).toBe(false);
  });
});
