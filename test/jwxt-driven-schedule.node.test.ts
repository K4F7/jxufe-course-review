import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isJwxtPlaceholderOption,
  JWXT_MAJOR_REQUIRED_MESSAGE,
  offeringKey,
} from "../src/lib/jwxt-offering";
import {
  jwxtSnapshotBookmarkletSource,
  parseJwxtBookmarkletMeetings,
} from "../src/lib/jwxt-import-bookmarklet";
import {
  planStatusLabel,
  requiredElectiveLabel,
  snapshotSectionsForCourse,
  uniquePlanCourses,
} from "../src/lib/jwxt-course-rows";
import {
  emptyPlan,
  joinOffering,
  mergeEnrolledRefresh,
  offeringToItem,
  parsePlan,
  persistedPlan,
  commitSave,
  includedItems,
  itemsOf,
  stageCourse,
  setIncluded,
} from "../src/lib/jwxt-plan";
import {
  emptySnapshot,
  exportedJsonIsClean,
  importSnapshotText,
  mergeSnapshots,
  serializeSnapshot,
  snapshotFromHtml,
} from "../src/lib/jwxt-snapshot";
import { parseJwxtTableHtml, parsePagination } from "../src/lib/jwxt-table";
import type { JwxtOffering } from "../src/lib/jwxt-offering";
import { defaultWeeks } from "../src/lib/schedule-plan";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/jwxt");

function readFixture(name: string) {
  return readFileSync(join(fixtures, name), "utf8");
}

function offering(partial: Partial<JwxtOffering> & Pick<JwxtOffering, "courseCode" | "courseName" | "section">): JwxtOffering {
  return {
    credits: 3,
    categoryPath: "专业计划内",
    teacherName: "教师甲",
    campus: "校区甲",
    weekText: "1-16",
    timeText: "星期一 第1-2节",
    place: "A101",
    capacityLimit: 80,
    capacitySelected: 10,
    capacityAvailable: 70,
    enrollStatus: "",
    meetings: [
      { weekday: 1, startPeriod: 1, endPeriod: 2, weeks: defaultWeeks(), place: "A101" },
    ],
    catalogCourseId: null,
    catalogTeacherId: null,
    ...partial,
  };
}

describe("jwxt table fixtures", () => {
  it("parses S20301 enrolled rows with dictionaries", () => {
    const parsed = parseJwxtTableHtml(readFixture("s20301-enrolled.html"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.offerings.map((item) => item.courseName)).toEqual(["高等数学", "线性代数"]);
    expect(parsed.offerings[0].section).toBe("01");
    expect(parsed.offerings[0].meetings[0]).toMatchObject({ weekday: 1, startPeriod: 1, endPeriod: 2 });
    expect(parsed.filters.grades.map((item) => item.id)).toContain("2024");
    expect(parsed.filters.majors.map((item) => item.label)).toContain("数学与应用数学");
    expect(parsed.pagination).toMatchObject({ tableId: "S20301", total: 2 });
  });

  it("parses the live S2020302 selected-result shape without filter selects", () => {
    const html = readFixture("s2020302-result.html");
    const parsed = parseJwxtTableHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters).toEqual({
      terms: [],
      educationLevels: [],
      grades: [],
      majors: [],
      categories: [],
    });
    expect(parsed.gradeSelect.present).toBe(false);
    expect(parsed.majorSelect.present).toBe(false);
    expect(parsed.pagination).toMatchObject({ tableId: "S2020302", total: 1 });
    expect(parsed.offerings).toHaveLength(1);
    expect(parsed.offerings[0]).toMatchObject({
      courseCode: "1234567890",
      courseName: "测试课程",
      credits: 2.5,
      section: "2026001-001",
      teacherName: "测试教师",
      campus: "蛟桥园",
      capacitySelected: 12,
      capacityLimit: 60,
      capacityAvailable: 48,
      place: "测试楼A101",
    });
    expect(parsed.offerings[0].meetings[0]).toEqual({
      weekday: 4,
      startPeriod: 6,
      endPeriod: 7,
      weeks: Array.from({ length: 18 }, (_, index) => index + 1),
      place: "测试楼A101",
    });
  });

  it("reads dynamic headers, rowspan, multi-teacher, odd/even weeks, multi-slot and no fixed time", () => {
    const dynamic = parseJwxtTableHtml(readFixture("dynamic-headers.html"));
    expect(dynamic.ok && dynamic.offerings[0]?.courseName).toBe("大学英语");
    expect(dynamic.ok && dynamic.offerings[0]?.timeText).toContain("星期二");

    const rowspan = parseJwxtTableHtml(readFixture("rowspan.html"));
    expect(rowspan.ok).toBe(true);
    if (rowspan.ok) {
      expect(rowspan.offerings).toHaveLength(1);
      expect(rowspan.offerings[0].meetings).toHaveLength(2);
      expect(rowspan.offerings[0].meetings[0].startPeriod).toBe(1);
      expect(rowspan.offerings[0].meetings[1].startPeriod).toBe(3);
    }

    const teachers = parseJwxtTableHtml(readFixture("multi-teacher.html"));
    expect(teachers.ok && teachers.offerings[0]?.teacherName).toContain("教师戊");
    expect(teachers.ok && teachers.offerings[0]?.teacherName).toContain("教师己");

    const weeks = parseJwxtTableHtml(readFixture("odd-even-weeks.html"));
    expect(weeks.ok && weeks.offerings[0]?.meetings[0]?.weeks.every((week) => week % 2 === 1)).toBe(true);
    expect(weeks.ok && weeks.offerings[1]?.meetings[0]?.weeks.every((week) => week % 2 === 0)).toBe(true);

    const multi = parseJwxtTableHtml(readFixture("multi-slot.html"));
    expect(multi.ok && multi.offerings[0]?.meetings).toHaveLength(2);

    const floating = parseJwxtTableHtml(readFixture("no-fixed-time.html"));
    expect(floating.ok && floating.offerings[0]?.courseName).toBe("毕业设计");
    expect(floating.ok && floating.offerings[0]?.meetings).toEqual([]);
  });

  it("covers pagination, login expiry and malformed credential rows", () => {
    expect(parsePagination(readFixture("pagination-page1.html"))).toMatchObject({
      tableId: "S2020103",
      page: 1,
      pages: 2,
      total: 3,
    });
    expect(parsePagination(readFixture("pagination-page2.html"))).toMatchObject({ page: 2, pages: 2 });
    const expired = parseJwxtTableHtml(readFixture("login-expired.html"));
    expect(expired).toMatchObject({ ok: false, kind: "login-expired" });
    const malformed = parseJwxtTableHtml(readFixture("malformed.html"));
    expect(malformed.ok).toBe(false);
    const pageOne = snapshotFromHtml(readFixture("pagination-page1.html"), "planned");
    expect(pageOne.ok).toBe(true);
    if (pageOne.ok) {
      const pageTwo = snapshotFromHtml(readFixture("pagination-page2.html"), "planned", pageOne.snapshot);
      expect(pageTwo.ok && pageTwo.snapshot.planned).toHaveLength(3);
    }
  });

  it("drops 请选择 placeholders and refuses unselected planned HTML", () => {
    expect(isJwxtPlaceholderOption("", "请选择专业")).toBe(true);
    expect(isJwxtPlaceholderOption("MA", "数学与应用数学")).toBe(false);
    const parsed = parseJwxtTableHtml(readFixture("s2020103-unselected.html"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.grades.map((item) => item.id)).toEqual(["2024"]);
    expect(parsed.filters.majors.map((item) => item.id)).toEqual(["MA"]);
    expect(parsed.gradeSelect.selected).toBeNull();
    expect(parsed.majorSelect.selected).toBeNull();
    expect(snapshotFromHtml(readFixture("s2020103-unselected.html"), "planned")).toMatchObject({
      ok: false,
      kind: "malformed",
      message: JWXT_MAJOR_REQUIRED_MESSAGE,
    });
  });

});

describe("snapshot import/export", () => {
  it("builds the same DTO from HTML fixtures and rejects secrets", () => {
    const enrolled = snapshotFromHtml(readFixture("s20301-enrolled.html"), "enrolled");
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    const planned = snapshotFromHtml(readFixture("s2020103-planned.html"), "planned", enrolled.snapshot);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const full = snapshotFromHtml(readFixture("s2020103-public.html"), "public", planned.snapshot);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const json = serializeSnapshot(full.snapshot);
    expect(exportedJsonIsClean(json)).toBe(true);
    expect(json).not.toMatch(/CASTGC|JSESSIONID|cookie|学号|姓名/i);
    const again = importSnapshotText(json);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.snapshot.enrolled.map((item) => item.courseName)).toEqual(["高等数学", "线性代数"]);
    expect(again.snapshot.planned).toHaveLength(2);
    expect(again.snapshot.publicElectives[0]?.courseName).toBe("书法鉴赏");
  });

  it("rejects JSON that smuggles cookies or student identity", () => {
    const dirty = {
      ...emptySnapshot(),
      enrolled: [offering({ courseCode: "1", courseName: "学号1234567890 高等数学", section: "01" })],
    };
    expect(importSnapshotText(JSON.stringify(dirty)).ok).toBe(false);
    expect(importSnapshotText(readFixture("login-expired.html"))).toMatchObject({
      ok: false,
      kind: "login-expired",
    });
  });

  it("fails closed for malformed offerings and forbidden unknown fields", () => {
    const malformed = {
      ...emptySnapshot(),
      captured: ["planned"],
      planned: [{ courseCode: "C1", courseName: "残缺课程", meetings: [] }],
    };
    expect(importSnapshotText(JSON.stringify(malformed))).toMatchObject({ ok: false, kind: "malformed" });
    expect(importSnapshotText(JSON.stringify({
      ...emptySnapshot(),
      debug: { JSESSIONID: "secret" },
    }))).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("merges only the buckets declared by a paged browser capture", () => {
    const base = {
      ...emptySnapshot(),
      term: { id: "T1", label: "学期一" },
      enrolled: [offering({ courseCode: "E1", courseName: "已选", section: "01" })],
      planned: [offering({ courseCode: "P1", courseName: "旧分页", section: "01" })],
    };
    const incoming = {
      ...base,
      captured: ["planned" as const],
      enrolled: [],
      planned: [offering({ courseCode: "P2", courseName: "新分页", section: "02" })],
    };
    const merged = mergeSnapshots(base, incoming);
    expect(merged.enrolled[0]?.courseName).toBe("已选");
    expect(merged.planned.map((item) => item.courseName)).toEqual(["旧分页", "新分页"]);
  });

  it("does not collapse different same-section courses when the source omits course codes", () => {
    const base = {
      ...emptySnapshot(),
      term: { id: "T1", label: "学期一" },
      captured: ["planned" as const],
      planned: [offering({ courseCode: "", courseName: "课程甲", section: "01" })],
    };
    const incoming = {
      ...base,
      planned: [offering({ courseCode: "", courseName: "课程乙", section: "01" })],
    };
    expect(mergeSnapshots(base, incoming).planned.map((item) => item.courseName))
      .toEqual(["课程甲", "课程乙"]);
  });

  it("merges enrolled pagination captures without dropping the previous page", () => {
    const base = {
      ...emptySnapshot(),
      term: { id: "T1", label: "学期一" },
      captured: ["enrolled" as const],
      enrolled: [offering({ courseCode: "E1", courseName: "已选甲", section: "01" })],
    };
    const incoming = {
      ...base,
      enrolled: [offering({ courseCode: "E2", courseName: "已选乙", section: "02" })],
    };
    expect(mergeSnapshots(base, incoming).enrolled.map((item) => item.courseName))
      .toEqual(["已选甲", "已选乙"]);
  });

  it("puts structured odd-week meetings into the real bookmarklet export", () => {
    expect(parseJwxtBookmarkletMeetings("星期二 第3-4节；星期五 第8节", "1-8单周", "A101"))
      .toEqual([
        { weekday: 2, startPeriod: 3, endPeriod: 4, weeks: [1, 3, 5, 7], place: "A101" },
        { weekday: 5, startPeriod: 8, endPeriod: 8, weeks: [1, 3, 5, 7], place: "A101" },
      ]);
    const source = jwxtSnapshotBookmarkletSource();
    expect(source).toContain("meetings: parsedMeetings");
    expect(source).toContain('if (planned.length) captured.push("planned")');
    expect(source).toContain('if (publicElectives.length) captured.push("public")');
    expect(source).toContain("2*1024*1024");
    expect(source).toContain(JWXT_MAJOR_REQUIRED_MESSAGE);
    expect(source).toContain("selectedReal");
  });

  it("recognizes S2020302 bracket schedules in the browser exporter", () => {
    expect(parseJwxtBookmarkletMeetings(
      "1-18周 四[06-07] 测试楼A101",
      "",
      "1-18周 四[06-07] 测试楼A101",
    )).toEqual([{
      weekday: 4,
      startPeriod: 6,
      endPeriod: 7,
      weeks: Array.from({ length: 18 }, (_, index) => index + 1),
      place: "测试楼A101",
    }]);
    const source = jwxtSnapshotBookmarkletSource();
    expect(source).toContain("S2020302");
    expect(source).toContain("上课班级");
    expect(source).toContain('["课程号","课程代码","课程名称","课程名","课程"]');
    expect(source).not.toContain("textOf(doc.body");
    expect(source).not.toContain("textOf(tables[t])");
  });
});

describe("plan v3", () => {
  it("migrates v1 courses to legacy origin", () => {
    const v1 = JSON.stringify({
      version: 1,
      courses: [
        {
          id: "8:9",
          courseId: 8,
          courseCode: "MA101",
          courseName: "高等数学",
          teacherId: 9,
          teacherName: "张三",
          rating: 4,
          reviewCount: 2,
          slots: [{ id: "s", weekday: 1, startPeriod: 1, endPeriod: 2, weeks: defaultWeeks() }],
        },
      ],
    });
    const plan = parsePlan(v1);
    expect(plan.version).toBe(3);
    expect(plan.activeTermId).toBe("legacy");
    expect(plan.terms.legacy[0]).toMatchObject({
      origin: "legacy",
      courseName: "高等数学",
      included: true,
      status: 2,
    });
  });

  it("isolates terms and keeps exclude across enrolled refresh", () => {
    const termA = "2025-2026-2";
    const termB = "2025-2026-1";
    let plan = emptyPlan(termA);
    const joined = joinOffering(plan, offering({ courseCode: "E1", courseName: "选修", section: "01", meetings: [
      { weekday: 5, startPeriod: 8, endPeriod: 9, weeks: defaultWeeks(), place: "" },
    ] }), "public", termA);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    plan = joined.plan;
    const snapshot = {
      ...emptySnapshot(),
      term: { id: termA, label: "2025-2026-2" },
      enrolled: [offering({ courseCode: "10100001", courseName: "高等数学", section: "01" })],
    };
    plan = mergeEnrolledRefresh(plan, snapshot);
    const mathKey = offeringKey(termA, "10100001", "01");
    plan = setIncluded(plan, mathKey, false, termA);
    const refreshed = {
      ...snapshot,
      enrolled: [offering({ courseCode: "10100001", courseName: "高等数学", section: "03", teacherName: "教师卯" })],
    };
    plan = mergeEnrolledRefresh(plan, refreshed);
    const math = plan.terms[termA].find((item) => item.courseCode === "10100001");
    expect(math?.section).toBe("03");
    expect(math?.included).toBe(false);
    expect(plan.terms[termB]).toBeUndefined();
    expect(plan.terms[termA].some((item) => item.courseName === "选修")).toBe(true);
  });

  it("uses a normalized stable key and lets refreshed enrollment replace the same local section", () => {
    const termId = " 2025-2026-2 ";
    expect(offeringKey(termId, " C+1 ", " 01 ")).toBe("2025-2026-2|C%2B1|01");
    const local = joinOffering(
      emptyPlan(termId.trim()),
      offering({ courseCode: "C+1", courseName: "候选课", section: "01" }),
      "planned",
      termId.trim(),
    );
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    const refreshed = mergeEnrolledRefresh(local.plan, {
      ...emptySnapshot(),
      term: { id: termId.trim(), label: "当前学期" },
      enrolled: [offering({ courseCode: "C+1", courseName: "教务已选", section: "01" })],
    });
    expect(refreshed.terms[termId.trim()]).toHaveLength(1);
    expect(refreshed.terms[termId.trim()][0]).toMatchObject({ origin: "enrolled", courseName: "教务已选" });
  });

  it("migrates persisted v2 plus-delimited keys before the next enrolled refresh", () => {
    const joined = joinOffering(
      emptyPlan("T1"),
      offering({ courseCode: "C1", courseName: "旧缓存", section: "01" }),
      "planned",
      "T1",
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const persisted = structuredClone(joined.plan);
    persisted.version = 2;
    persisted.terms.T1[0].key = "T1+C1+01";
    const migrated = parsePlan(JSON.stringify(persisted));
    expect(migrated.terms.T1[0].key).toBe("T1|C1|01");
  });

  it("atomically swaps the same course section and blocks week-intersect conflicts", () => {
    const termId = "2025-2026-2";
    let plan = emptyPlan(termId);
    const first = joinOffering(plan, offering({ courseCode: "C1", courseName: "微观经济学", section: "01" }), "planned", termId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    plan = first.plan;
    const swapped = joinOffering(
      plan,
      offering({
        courseCode: "C1",
        courseName: "微观经济学",
        section: "02",
        teacherName: "教师辰",
        meetings: [{ weekday: 4, startPeriod: 6, endPeriod: 7, weeks: defaultWeeks(), place: "" }],
      }),
      "planned",
      termId,
    );
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.swapped).toBe(true);
    expect(swapped.plan.terms[termId]).toHaveLength(1);
    expect(swapped.plan.terms[termId][0].section).toBe("02");
    const blocked = joinOffering(
      swapped.plan,
      offering({
        courseCode: "C2",
        courseName: "冲突课",
        section: "01",
        meetings: [{ weekday: 4, startPeriod: 6, endPeriod: 7, weeks: defaultWeeks(), place: "" }],
      }),
      "public",
      termId,
    );
    expect(blocked.ok).toBe(false);
  });

  it("stages a course without occupying and persists only selected classes", () => {
    const termId = "2025-2026-2";
    const math = offering({ courseCode: "C1", courseName: "高等数学", section: "01" });
    const staged = stageCourse(emptyPlan(termId), math, "planned", termId);
    expect(itemsOf(staged, termId)[0]).toMatchObject({ status: 0, included: false, section: "" });
    expect(planStatusLabel(itemsOf(staged, termId)[0])).toBe("未选");
    expect(includedItems(staged, termId)).toEqual([]);
    const joined = joinOffering(staged, math, "planned", termId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.swapped).toBe(false);
    expect(itemsOf(joined.plan, termId)[0]?.status).toBe(1);
    expect(includedItems(joined.plan, termId)).toHaveLength(1);
    expect(persistedPlan(joined.plan).terms[termId]).toBeUndefined();
    const committed = commitSave(joined.plan);
    expect(itemsOf(committed, termId)[0]?.status).toBe(2);
    expect(persistedPlan(committed).terms[termId]).toHaveLength(1);
    expect(itemsOf(parsePlan(JSON.stringify(joined.plan)), termId)).toEqual([]);
  });
});

describe("jwxt course rows", () => {
  it("dedupes plan courses and lists snapshot sections", () => {
    const termId = "2025-2026-2";
    const enrolled = offeringToItem(offering({
      courseCode: "10100001",
      courseName: "高等数学",
      section: "01",
      categoryPath: "公共必修/高等数学",
    }), termId, "enrolled", false);
    const planned = offeringToItem(offering({
      courseCode: "10100001",
      courseName: "高等数学",
      section: "03",
    }), termId, "planned", true);
    const publicItem = offeringToItem(offering({
      courseCode: "30100001",
      courseName: "书法鉴赏",
      section: "01",
      categoryPath: "公共选修/艺术",
    }), termId, "public", true);
    expect(requiredElectiveLabel(enrolled.categoryPath, enrolled.origin)).toBe("必");
    expect(requiredElectiveLabel(publicItem.categoryPath, publicItem.origin)).toBe("选");
    expect(planStatusLabel(enrolled)).toBe("已排除");
    expect(planStatusLabel(planned)).toBe("备选");
    expect(uniquePlanCourses([enrolled, planned]).map((item) => item.section)).toEqual(["03"]);
    const snapshot = {
      ...emptySnapshot(),
      enrolled: [offering({ courseCode: "10100001", courseName: "高等数学", section: "01" })],
      planned: [offering({ courseCode: "10100001", courseName: "高等数学", section: "03" })],
    };
    expect(snapshotSectionsForCourse(snapshot, "10100001", false)).toHaveLength(1);
    expect(snapshotSectionsForCourse(snapshot, "10100001", true).map((item) => item.section)).toEqual(["01", "03"]);
  });
});
