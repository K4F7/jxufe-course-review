import { describe, expect, it } from "vitest";
import {
  SEARCH_RANK_BUCKETS,
  SEARCH_RANK_WEIGHTS,
  buildCatalogSearchRanking,
} from "../src/lib/catalog-search-ranking";

const fields = {
  exact: ["c.name", "c.code"],
  exactPredicates: [
    "EXISTS (SELECT 1 FROM course_name_variants cnv WHERE cnv.course_id=c.id AND lower(cnv.name)=$TERM)",
  ],
  prefix: ["c.name", "c.code"],
  substring: ["c.name", "c.code"],
  pinyin: "pcc.pinyin_text",
  teacher: ["c.department", "t.name"],
};

describe("catalog search ranking policy", () => {
  it("locks the product bucket order", () => {
    expect(SEARCH_RANK_BUCKETS).toEqual({
      exact: 0,
      exactPinyin: 1,
      prefix: 2,
      pinyinPrefix: 3,
      substringFts: 4,
      teacherDepartment: 5,
      fuzzy: 6,
      miss: 7,
    });
    const order = Object.keys(SEARCH_RANK_BUCKETS) as Array<
      keyof typeof SEARCH_RANK_BUCKETS
    >;
    expect(order.map((key) => SEARCH_RANK_BUCKETS[key])).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    expect(order.map((key) => SEARCH_RANK_WEIGHTS[key])).toEqual(
      [0, 1, 8, 64, 512, 4096, 32768, 262144],
    );
    const weights = order.map((key) => SEARCH_RANK_WEIGHTS[key]);
    for (let index = 2; index < weights.length; index += 1) {
      expect(weights[index]).toBeGreaterThan(6 * weights[index - 1]);
    }
  });

  it("binds each search term once in multi-word queries", () => {
    const ranking = buildCatalogSearchRanking(
      ["高等数学", "张三"],
      fields,
      "course",
    );
    expect(ranking.args).toEqual(["高等数学", "张三"]);
  });

  it("uses token-boundary pinyin and keeps FTS in the substring bucket", () => {
    const ranking = buildCatalogSearchRanking(
      ["gaoshu"],
      { ...fields, fts: "pcc.fts_hit=1" },
      "option",
    );
    expect(ranking.sql).toContain("instr(' ' || COALESCE(pcc.pinyin_text");
    expect(ranking.sql).toContain(
      "(' ' || COALESCE(pcc.pinyin_text,'') || ' ') LIKE '% ' || ",
    );
    expect(ranking.sql.indexOf(`THEN ${SEARCH_RANK_WEIGHTS.prefix}`)).toBeLessThan(
      ranking.sql.indexOf(`THEN ${SEARCH_RANK_WEIGHTS.substringFts}`),
    );
    expect(
      ranking.sql.indexOf(`THEN ${SEARCH_RANK_WEIGHTS.substringFts}`),
    ).toBeLessThan(
      ranking.sql.indexOf(`THEN ${SEARCH_RANK_WEIGHTS.teacherDepartment}`),
    );
    expect(ranking.sql).toContain("(pcc.fts_hit=1)");
    expect(ranking.args).toEqual(["gaoshu"]);
  });

  it("does not invent fuzzy placeholders when fuzzy is unused", () => {
    const ranking = buildCatalogSearchRanking(["高数"], fields, "course", 4);
    expect(ranking.args).toEqual(["高数"]);
    expect(ranking.sql).toContain("?5");
    expect(ranking.sql).not.toContain("?6");
    expect(ranking.sql).toContain(`WHEN 0 THEN ${SEARCH_RANK_WEIGHTS.fuzzy}`);
  });

  it("passes through an optional fuzzy predicate without dummy args", () => {
    const ranking = buildCatalogSearchRanking(
      ["高数"],
      { ...fields, fuzzy: "pcc.fuzzy_hit=1" },
      "course",
    );
    expect(ranking.sql).toContain(
      `WHEN pcc.fuzzy_hit=1 THEN ${SEARCH_RANK_WEIGHTS.fuzzy}`,
    );
    expect(ranking.args).toEqual(["高数"]);
  });

  it("appends an optional FTS score only when the caller supplies one", () => {
    const plain = buildCatalogSearchRanking(["高数"], fields, "course");
    const scored = buildCatalogSearchRanking(
      ["高数"],
      { ...fields, ftsScore: "bm25(course_search_fts)" },
      "course",
    );
    expect(plain.sql).toMatch(/\)\,\(/);
    expect(plain.sql).not.toContain("bm25(");
    expect(scored.sql).toContain("bm25(course_search_fts)");
    expect(scored.sql.endsWith("bm25(course_search_fts)")).toBe(true);
    expect(scored.args).toEqual(["高数"]);
  });

  it("normalizes ASCII case and builds LIKE escapes from the term parameter", () => {
    const ranking = buildCatalogSearchRanking(["GaO%_\\"], fields, "teacher");
    expect(ranking.args).toEqual(["gao%_\\"]);
    expect(ranking.sql).toContain("lower(c.name)=?1");
    expect(ranking.sql).toContain("replace(replace(replace(?1");
    expect(ranking.sql).toContain("ESCAPE '\\'");
  });

  it("returns a neutral ranking for an empty query", () => {
    expect(buildCatalogSearchRanking([], { exact: ["c.name"] }, "course")).toEqual({
      sql: "0.0",
      args: [],
      buckets: SEARCH_RANK_BUCKETS,
    });
  });
});
