import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatPeSkillDisplayName,
  virtualPeSportDisplayName,
  VIRTUAL_PE_SPORTS,
} from "../src/lib/public-course-presentation";

const origin = "https://example.com";
const department = "排序验收学院";
const otherDepartment = "排序验收外院";

const exactMath = "排序验收高等数学";
const prefixMath = "排序验收高等数学基础";
const substringMath = "应用排序验收高等数学课";
const teacherOnlyCourse = "排序验收教师命中课";
const popularUnrelated = "排序验收热门无关课";
const calculus = "排序验收微积分";
const calculusIntro = "排序验收微积分导论";
const shortCalculus = "微积分";
const teacherNamedCourse = "排序验收张三课";
const weijiAscii = "应用weijifen导论";
const variantHost = "排序验收线代本体";
const variantName = "排序验收线代别名";
const percentCourse = "排序验收百分号100%课";
const underscoreCourse = "排序验收A_下划线课";
const backslashCourse = "排序验收反\\斜线课";
const exactTeacher = "排序验收张三";
const sourceTeacherLabel = "排序验收来源张三";
const sourceTeacherDisplay = "排序验收显示张三";
const classmateTeacher = "排序验收李四";
const deptTeacher = "排序验收院系师";
const peTeacher = "黄丽萍";

const mathCode = "RANK667-MATH";
const pageStem = "排序验收分页课";

type ListItem = {
  id?: number;
  course_id?: number;
  name: string;
  code?: string;
  teachers?: string | null;
  teacher_name?: string | null;
  teacher_id?: number | null;
  review_count?: number;
  rating?: number | null;
  department?: string;
};

type ListBody = {
  items: ListItem[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

const search = async (path: string, query: string) => {
  const response = await SELF.fetch(
    `${origin}${path}?${query.replace(/\bq=([^&]*)/, (_, value: string) => `q=${encodeURIComponent(value)}`)}`,
  );
  expect(response.status).toBe(200);
  return response.json<ListBody>();
};

const courseNames = async (query: string) =>
  (await search("/api/courses", `${query}&pageSize=50`)).items.map((item) => item.name);

const namesOf = (body: ListBody) => body.items.map((item) => item.name);

async function insertTeacher(name: string, sourceLabel = name, dept = department) {
  const result = await env.DB.prepare(
    "INSERT INTO teachers(source_teacher_label,name,department) VALUES(?,?,?)",
  )
    .bind(sourceLabel, name, dept)
    .run();
  return Number(result.meta.last_row_id);
}

async function insertCourse(
  code: string,
  name: string,
  dept = department,
  category = "general",
) {
  const result = await env.DB.prepare(
    "INSERT INTO courses(code,name,category,department) VALUES(?,?,?,?)",
  )
    .bind(code, name, category, dept)
    .run();
  return Number(result.meta.last_row_id);
}

async function bindTeacher(courseId: number, teacherId: number) {
  await env.DB.prepare(
    "INSERT INTO course_teachers(course_id,teacher_id) VALUES(?,?)",
  )
    .bind(courseId, teacherId)
    .run();
}

async function insertReviews(courseId: number, teacherId: number, count: number) {
  if (count <= 0) return;
  await env.DB.batch(
    Array.from({ length: count }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO reviews(course_id,teacher_id,category,overall,comment,status,submitter_hash)
         VALUES(?,?,'general',4,?,?,?)`,
      ).bind(
        courseId,
        teacherId,
        `排序验收评价${courseId}-${teacherId}-${index}`,
        "approved",
        `rank667-${courseId}-${teacherId}-${index}`,
      ),
    ),
  );
}

let exactTeacherId = 0;
let sourceTeacherId = 0;
let classmateTeacherId = 0;
let exactMathId = 0;
let prefixMathId = 0;
let calculusId = 0;
let calculusIntroId = 0;
const pageCourseIds: number[] = [];

beforeAll(async () => {
  exactTeacherId = await insertTeacher(exactTeacher);
  sourceTeacherId = await insertTeacher(sourceTeacherDisplay, sourceTeacherLabel);
  classmateTeacherId = await insertTeacher(classmateTeacher);
  const deptTeacherId = await insertTeacher(deptTeacher, deptTeacher, otherDepartment);
  await insertTeacher(peTeacher, peTeacher, department);

  exactMathId = await insertCourse(mathCode, exactMath);
  prefixMathId = await insertCourse("RANK667-PREFIX", prefixMath);
  const substringMathId = await insertCourse("RANK667-SUB", substringMath);
  const teacherOnlyId = await insertCourse("RANK667-TEACH", teacherOnlyCourse);
  const popularId = await insertCourse("RANK667-HOT", popularUnrelated);
  calculusId = await insertCourse("RANK667-CALC", calculus, "导论学院");
  calculusIntroId = await insertCourse("RANK667-INTRO", calculusIntro);
  const asciiId = await insertCourse("RANK667-ASCII", weijiAscii);
  const shortCalcId = await insertCourse("RANK667-WJF", shortCalculus);
  const teacherNamedId = await insertCourse("RANK667-TN", teacherNamedCourse);
  const variantId = await insertCourse("RANK667-VAR", variantHost);
  const percentId = await insertCourse("RANK667-PCT", percentCourse);
  const underscoreId = await insertCourse("RANK667-UND", underscoreCourse);
  const backslashId = await insertCourse("RANK667-BSL", backslashCourse);
  const rollerId = await insertCourse("RANK667-ROLLER", "轮滑", department, "sports");
  const rollerOneId = await insertCourse("RANK667-ROLLER1", "轮滑1", department, "sports");

  for (let index = 1; index <= 5; index += 1) {
    pageCourseIds.push(
      await insertCourse(`RANK667-PAGE${index}`, `${pageStem}${index}`),
    );
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO course_name_variants(course_id,name) VALUES(?,?)",
  )
    .bind(variantId, variantName)
    .run();

  await bindTeacher(exactMathId, exactTeacherId);
  await bindTeacher(exactMathId, classmateTeacherId);
  await bindTeacher(prefixMathId, classmateTeacherId);
  await bindTeacher(substringMathId, classmateTeacherId);
  await bindTeacher(teacherOnlyId, exactTeacherId);
  await bindTeacher(popularId, classmateTeacherId);
  await bindTeacher(calculusId, classmateTeacherId);
  await bindTeacher(calculusIntroId, classmateTeacherId);
  await bindTeacher(asciiId, classmateTeacherId);
  await bindTeacher(shortCalcId, classmateTeacherId);
  await bindTeacher(teacherNamedId, classmateTeacherId);
  await bindTeacher(variantId, sourceTeacherId);
  await bindTeacher(percentId, classmateTeacherId);
  await bindTeacher(underscoreId, classmateTeacherId);
  await bindTeacher(backslashId, classmateTeacherId);
  await bindTeacher(rollerId, deptTeacherId);
  await bindTeacher(rollerOneId, deptTeacherId);
  for (const courseId of pageCourseIds) {
    await bindTeacher(courseId, classmateTeacherId);
  }

  await insertReviews(exactMathId, exactTeacherId, 1);
  await insertReviews(prefixMathId, classmateTeacherId, 8);
  await insertReviews(substringMathId, classmateTeacherId, 12);
  await insertReviews(teacherOnlyId, exactTeacherId, 15);
  await insertReviews(popularId, classmateTeacherId, 20);
  await insertReviews(calculusId, classmateTeacherId, 14);
  await insertReviews(calculusIntroId, classmateTeacherId, 1);
  await insertReviews(asciiId, classmateTeacherId, 10);
  await insertReviews(shortCalcId, classmateTeacherId, 1);
  await insertReviews(teacherNamedId, classmateTeacherId, 1);
  await insertReviews(variantId, sourceTeacherId, 2);
});

describe("统一 relevance bucket 顺序", () => {
  it("exact 课名压过 prefix / substring / teacher，且不被高投稿干扰项抢走", async () => {
    const names = await courseNames(`q=${exactMath}`);
    expect(names[0]).toBe(exactMath);
    expect(names.indexOf(exactMath)).toBeLessThan(names.indexOf(prefixMath));
    expect(names.indexOf(prefixMath)).toBeLessThan(names.indexOf(substringMath));
    expect(names).not.toContain(popularUnrelated);
  });

  it("exact 课号、公开展示名、名称变体都进入 exact bucket", async () => {
    expect(await courseNames(`q=${mathCode}`)).toEqual([exactMath]);
    expect(await courseNames(`q=${variantName}`)).toEqual([variantHost]);
    const pe = await courseNames("q=体育1-4 [轮滑]");
    expect(pe[0]).toBe(formatPeSkillDisplayName("轮滑"));
  });

  it("exact pinyin / pinyin prefix 按 token 边界，且压过 substring 与高投稿", async () => {
    const exactPinyin = await courseNames("q=weijifen");
    expect(exactPinyin[0]).toBe(shortCalculus);
    expect(exactPinyin.indexOf(shortCalculus)).toBeLessThan(exactPinyin.indexOf(weijiAscii));

    const initials = await courseNames("q=wjf");
    expect(initials[0]).toBe(shortCalculus);

    const pair = await courseNames("q=jifen");
    expect(pair).toContain(shortCalculus);
    expect(pair).toContain(calculus);

    const pinyinPrefix = await courseNames("q=weij");
    expect(pinyinPrefix.indexOf(shortCalculus)).toBeGreaterThanOrEqual(0);
    expect(pinyinPrefix.indexOf(shortCalculus)).toBeLessThan(pinyinPrefix.indexOf(weijiAscii));

    const midToken = await courseNames("q=eiji");
    expect(midToken).toContain(shortCalculus);
    expect(midToken).toContain(weijiAscii);
    expect(midToken[0]).not.toBe(shortCalculus);
  });

  it("Hanzi prefix 压过 substring，substring/FTS 压过教师院系", async () => {
    const names = await courseNames("q=排序验收高等数学");
    expect(names[0]).toBe(exactMath);
    const prefixQuery = await courseNames("q=排序验收高等数学基");
    expect(prefixQuery[0]).toBe(prefixMath);

    const teacherHit = await courseNames(`q=${exactTeacher}`);
    expect(teacherHit).toContain(teacherNamedCourse);
    expect(teacherHit).toContain(teacherOnlyCourse);
    expect(teacherHit.indexOf(teacherNamedCourse)).toBeLessThan(
      teacherHit.indexOf(teacherOnlyCourse),
    );
  });

  it("多词按最差词条聚合：一个 exact 不能掩盖弱词条", async () => {
    const names = await courseNames("q=排序验收微积分 导论");
    expect(names[0]).toBe(calculusIntro);
    expect(names.indexOf(calculusIntro)).toBeLessThan(names.indexOf(calculus));
  });

  it("多词仍 AND，并可跨课名、教师、院系命中", async () => {
    expect(await courseNames(`q=${exactMath} ${exactTeacher}`)).toEqual([
      exactMath,
    ]);
    expect(await courseNames(`q=${exactMath} ${classmateTeacher}`)).toContain(
      exactMath,
    );
    expect(await courseNames(`q=${exactMath} ${classmateTeacher}`)).not.toContain(
      popularUnrelated,
    );
    expect(await courseNames(`q=${calculus} 导论学院`)).toEqual([calculus]);
    expect(await courseNames(`q=${exactMath} ${calculus}`)).toEqual([]);
  });
});

describe("四个公开搜索入口与既有排序契约", () => {
  it("空查询保持投稿数浏览序，sort=name 只按名称", async () => {
    const browse = await search(
      "/api/courses",
      `department=${encodeURIComponent(department)}&pageSize=50`,
    );
    const reviewCounts = browse.items.map((item) => Number(item.review_count) || 0);
    expect(reviewCounts).toEqual([...reviewCounts].sort((left, right) => right - left));

    const named = await search(
      "/api/courses",
      `q=${exactMath}&sort=name&pageSize=50`,
    );
    const names = namesOf(named);
    expect(names).toEqual([...names].sort((left, right) => (left < right ? -1 : 1)));
    expect(names).toContain(exactMath);
    expect(names).toContain(prefixMath);
  });

  it("relations 默认相关度后仍用投稿数/名称稳定序，sort=rating 不叠加相关度", async () => {
    const ranked = await search(
      "/api/courses",
      `view=relations&q=${exactMath}&pageSize=50`,
    );
    expect(
      ranked.items
        .filter((item) => item.name === exactMath)
        .map((item) => item.teacher_name)
        .sort(),
    ).toEqual([exactTeacher, classmateTeacher].sort());

    const rated = await search(
      "/api/courses",
      `view=relations&q=${exactTeacher}&sort=rating&pageSize=50`,
    );
    expect(rated.items.every((item) => item.teacher_name === exactTeacher)).toBe(
      true,
    );
    const ratings = rated.items.map((item) => item.rating ?? -1);
    expect(ratings).toEqual([...ratings].sort((left, right) => right - left));
  });

  it("教师入口：显示名 exact，拼音 token，院系落入 teacher/department", async () => {
    const exact = await search("/api/teachers", `q=${exactTeacher}&pageSize=50`);
    expect(exact.items[0]?.name).toBe(exactTeacher);

    const pinyin = await search("/api/teachers", "q=zhangsan&pageSize=50");
    expect(pinyin.items.map((item) => item.name)).toContain(exactTeacher);

    const dept = await search(
      "/api/teachers",
      `q=${otherDepartment}&pageSize=50`,
    );
    expect(dept.items.map((item) => item.name)).toContain(deptTeacher);
    expect(dept.items.map((item) => item.name)).not.toContain(exactTeacher);
  });

  it("options 空查询按名称；有 q 时走统一相关度", async () => {
    const empty = await search(
      "/api/courses/options",
      `pageSize=50`,
    );
    expect(empty.items.length).toBeGreaterThan(1);
    expect(empty.page).toBe(1);

    const ranked = await search(
      "/api/courses/options",
      `q=${exactMath}&pageSize=50`,
    );
    expect(ranked.items[0]?.name).toBe(exactMath);
    expect(namesOf(ranked).indexOf(exactMath)).toBeLessThan(
      namesOf(ranked).indexOf(prefixMath),
    );
  });

  it("分页稳定，page/pageSize/total/pages 语义不变", async () => {
    const first = await search(
      "/api/courses",
      `q=${pageStem}&page=1&pageSize=2`,
    );
    const second = await search(
      "/api/courses",
      `q=${pageStem}&page=2&pageSize=2`,
    );
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(2);
    expect(first.total).toBe(5);
    expect(first.pages).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(namesOf(first)).toEqual([`${pageStem}1`, `${pageStem}2`]);
    expect(namesOf(second)).toEqual([`${pageStem}3`, `${pageStem}4`]);
    const third = await search(
      "/api/courses",
      `q=${pageStem}&page=3&pageSize=2`,
    );
    expect(namesOf(third)).toEqual([`${pageStem}5`]);
    const again = await search(
      "/api/courses",
      `q=${pageStem}&page=1&pageSize=2`,
    );
    expect(namesOf(again)).toEqual(namesOf(first));
  });

  it("% _ \\ 仍按字面量，不提升无关课程", async () => {
    expect(await courseNames("q=%")).toContain(percentCourse);
    expect(await courseNames("q=%")).not.toContain(exactMath);
    expect(await courseNames("q=A_")).toContain(underscoreCourse);
    expect(await courseNames("q=\\")).toContain(backslashCourse);
  });

  it("virtual PE 与 canonical 体育 family 保持合并语义", async () => {
    const yoga = VIRTUAL_PE_SPORTS.find((sport) => sport.label === "瑜伽");
    expect(yoga).toBeTruthy();
    const virtual = await search(
      "/api/courses",
      `q=${yoga ? virtualPeSportDisplayName(yoga) : "体育1-4 [瑜伽]"}&pageSize=50`,
    );
    expect(namesOf(virtual)).toContain(virtualPeSportDisplayName(yoga!));

    const family = await courseNames("q=轮滑");
    const rollerNames = family.filter((name) => name.includes("轮滑"));
    expect(rollerNames).toEqual([formatPeSkillDisplayName("轮滑")]);
  });
});
