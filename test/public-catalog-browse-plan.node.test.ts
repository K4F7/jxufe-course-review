import { describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS } from "../src/lib/public-catalog-list";
import {
  columnRowInsertChunkSize,
  columnRowInsertStatements,
} from "../src/public-catalog-browse-plan";

describe("目录浏览多行插入", () => {
  it("生成的 SQL 不含 UNION ALL，宽度 2 时每块 49 行", () => {
    const columns = ["department", "public_id"] as const;
    const width = columns.length;
    expect(width).toBe(2);
    const chunkSize = columnRowInsertChunkSize(width);
    expect(chunkSize).toBe(
      Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / width),
    );
    expect(chunkSize).toBe(49);

    const rows = Array.from({ length: chunkSize + 1 }, (_, index) => ({
      department: `院系${index}`,
      public_id: `relation:${index}`,
    }));
    const statements = columnRowInsertStatements(
      "public_relation_browse_departments_staging",
      columns,
      rows,
    );

    expect(statements).toHaveLength(2);
    const rowCounts = statements.map((statement) => {
      expect(statement.sql).not.toContain("UNION ALL");
      expect(statement.sql).toContain(
        "SELECT column1,column2 FROM (VALUES ",
      );
      expect(statement.sql).toContain("refresh_token=?");
      const tuples = statement.sql.match(/\(\?,\?\)/g) ?? [];
      expect(tuples).toHaveLength(statement.values.length / width);
      const placeholders = statement.sql.match(/\?/g) ?? [];
      expect(placeholders).toHaveLength(statement.values.length + 2);
      expect(statement.values.length + 2).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      return tuples.length;
    });
    expect(rowCounts).toEqual([chunkSize, 1]);
    expect(statements[0]?.values.slice(0, 2)).toEqual(["院系0", "relation:0"]);
    expect(statements[1]?.values).toEqual([
      `院系${chunkSize}`,
      `relation:${chunkSize}`,
    ]);
  });

  it("键列用 DO NOTHING，其余列只在变化时更新", () => {
    const [keyOnly] = columnRowInsertStatements(
      "public_relation_browse_departments_staging",
      ["department", "public_id"],
      [{ department: "院", public_id: "relation:1" }],
      ["department", "public_id"],
    );
    expect(keyOnly?.sql).toContain(
      "ON CONFLICT(department,public_id) DO NOTHING",
    );
    expect(keyOnly?.sql).not.toContain("DO UPDATE");

    const [wide] = columnRowInsertStatements(
      "public_relation_browse_totals_staging",
      ["category", "n"],
      [{ category: "all", n: 1 }],
      ["category"],
    );
    expect(wide?.sql).toContain("ON CONFLICT(category) DO UPDATE SET");
    expect(wide?.sql).toContain("n=excluded.n");
    expect(wide?.sql).toContain(
      "public_relation_browse_totals_staging.n IS NOT excluded.n",
    );
    const placeholders = wide?.sql.match(/\?/g) ?? [];
    expect(placeholders).toHaveLength((wide?.values.length ?? 0) + 2);
  });
});
