import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogScheduleGrades, currentCatalogTermId } from "../../src/lib/catalog-schedule";
import { jwxtSnapshotBookmarkletSource } from "../../src/lib/jwxt-import-bookmarklet";
import { JWXT_MAJOR_REQUIRED_MESSAGE } from "../../src/lib/jwxt-offering";
import { SCHEDULE_MOBILE_NOTICE_KEY } from "../../src/lib/schedule-mobile-notice";

const unselectedHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/jwxt/s2020103-unselected.html"),
  "utf8",
);

const firstGrade = catalogScheduleGrades()[0].label;

const programPlanByMajor: Record<string, Array<{
  courseCode: string;
  courseName: string;
  credits: number;
  categoryPath: string;
  courseStanding: string;
  suggestedTerm: string;
  catalogCourseId: number;
}>> = {
  数学与应用数学: [
    { courseCode: "10100001", courseName: "高等数学", credits: 4, categoryPath: "专业计划内", courseStanding: "", suggestedTerm: "建议学期", catalogCourseId: 8 },
    { courseCode: "10200001", courseName: "微观经济学", credits: 3, categoryPath: "专业计划内", courseStanding: "", suggestedTerm: "建议学期", catalogCourseId: 10 },
    { courseCode: "20100001", courseName: "冲突课", credits: 2, categoryPath: "专业计划内", courseStanding: "", suggestedTerm: "建议学期", catalogCourseId: 14 },
  ],
  信息管理与信息系统: [
    { courseCode: "20200001", courseName: "数据结构", credits: 3, categoryPath: "专业计划内", courseStanding: "", suggestedTerm: "建议学期", catalogCourseId: 16 },
  ],
};

const offeringSchedules: Record<string, Array<{
  key: string;
  courseCode: string;
  courseName: string;
  termId: string;
  campus: string;
  weekText: string;
  timeText: string;
  place: string;
  teacherName: string;
  catalogCourseId: number;
  catalogTeacherId: number;
}>> = {
  "8": [
    { key: "offering-8-a", courseCode: "10100001", courseName: "高等数学", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期一 第1-2节", place: "一教101", teacherName: "教师甲", catalogCourseId: 8, catalogTeacherId: 9 },
    { key: "offering-8-b", courseCode: "10100001", courseName: "高等数学", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期三 第1-2节", place: "一教103", teacherName: "教师乙", catalogCourseId: 8, catalogTeacherId: 12 },
  ],
  "10": [
    { key: "offering-10-a", courseCode: "10200001", courseName: "微观经济学", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期二 第3-4节", place: "二教202", teacherName: "教师辰", catalogCourseId: 10, catalogTeacherId: 11 },
  ],
  "14": [
    { key: "offering-14-a", courseCode: "20100001", courseName: "冲突课", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期一 第1-2节", place: "一教102", teacherName: "教师丁", catalogCourseId: 14, catalogTeacherId: 15 },
  ],
  "16": [
    { key: "offering-16-a", courseCode: "20200001", courseName: "数据结构", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期四 第1-2节", place: "一教104", teacherName: "教师戊", catalogCourseId: 16, catalogTeacherId: 17 },
  ],
  "20": [
    { key: "offering-20-a", courseCode: "30100001", courseName: "羽毛球", termId: currentCatalogTermId(), campus: "麦庐园", weekText: "1-16周", timeText: "星期五 第6-7节", place: "体育馆", teacherName: "教师巳", catalogCourseId: 20, catalogTeacherId: 21 },
  ],
};

async function rememberMobileNotice(page: Page) {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
  }, SCHEDULE_MOBILE_NOTICE_KEY);
}

async function mockScheduleApi(
  page: Page,
  authenticated = true,
) {
  await rememberMobileNotice(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") {
      return route.fulfill({
        json: { siteName: "非官方课评@JUFE", universityName: "江西财经大学", admin: false },
      });
    }
    if (url.pathname === "/api/site/banner") {
      return route.fulfill({
        json: { desktopHtml: "", mobileHtml: "", updatedAt: null },
      });
    }
    if (url.pathname === "/api/user/session") {
      return route.fulfill({
        json: {
          authenticated,
          csrfToken: authenticated ? "csrf-user" : undefined,
          loginPath: "/login",
          logoutPath: "/logout",
        },
      });
    }
    if (url.pathname.startsWith("/api/jwxt") || url.pathname.startsWith("/api/ehall")) {
      return route.fulfill({ status: 404, json: { error: "jwxt proxy disabled" } });
    }
    if (url.pathname === "/api/courses/departments") {
      return route.fulfill({ json: { items: ["数学学院", "信息管理学院", "体育学院"] } });
    }
    if (url.pathname === "/api/program-plan") {
      const major = url.searchParams.get("major") || "";
      expect(url.searchParams.get("grade")).toBeTruthy();
      return route.fulfill({ json: { items: programPlanByMajor[major] ?? [] } });
    }
    if (url.pathname === "/api/courses") {
      const category = url.searchParams.get("category") || "";
      const items = category === "sports"
        ? [{ course_id: 20, code: "30100001", name: "羽毛球", category: "sports", department: "体育学院", teacher_id: 21, teacher_name: "教师巳", rating: 4.5, review_count: 9 }]
        : [];
      return route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 50, pages: 1 } });
    }
    if (url.pathname === "/api/schedule-offerings") {
      const courseId = url.searchParams.get("courseId") || "";
      expect(url.searchParams.get("term")).toBe(currentCatalogTermId());
      return route.fulfill({ json: offeringSchedules[courseId] ?? [] });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
}

async function chooseFilter(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function chooseMajor(page: Page, major: string) {
  const combo = page.getByRole("combobox", { name: "专业" });
  await expect(combo).toBeEnabled();
  await combo.click();
  await combo.fill(major);
  await page.getByRole("option", { name: major, exact: true }).click();
}

async function selectMajor(page: Page, major = "数学与应用数学") {
  await expect(page.getByRole("combobox", { name: "专业" })).toBeVisible();
  await chooseFilter(page, "年级", firstGrade);
  await chooseMajor(page, major);
}

function plannedCourses(page: Page) {
  return page.getByRole("grid", { name: "计划内课程" });
}

function publicCourses(page: Page) {
  return page.getByRole("grid", { name: "公共选修" });
}

function courseList(page: Page) {
  return page.getByRole("grid", { name: "待选课表" });
}

function sectionList(page: Page) {
  return page.getByRole("grid", { name: "开课班" });
}

async function stagePlannedCourse(page: Page, name: string) {
  await page.getByRole("tab", { name: "计划内" }).click();
  await plannedCourses(page).getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "加入待选课表" }).click();
}

test("program-plan courses, two-step pick, place, persist @mobile-smoke", async ({
  page,
}) => {
  const ehallRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/ehall/")) {
      ehallRequests.push(request.url());
    }
  });
  await mockScheduleApi(page);
  await page.goto("/schedule");

  await expect(page.getByText("专业选择", { exact: true })).toBeVisible();
  await expect(page.getByText("待选课表", { exact: true })).toBeVisible();
  await expect(page.getByText("开课班", { exact: true })).toBeVisible();
  await expect(page.getByText("模拟课表", { exact: true })).toBeVisible();
  await expect(page.getByText("暂无数据").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新教务数据" })).toHaveCount(0);
  await expect(page.getByText(/快照|JSON|书签|还没有教务数据/)).toHaveCount(0);
  expect(ehallRequests).toEqual([]);

  await expect(page.getByRole("tab", { name: "计划内" })).toHaveCount(0);
  await selectMajor(page);
  await expect(page.getByText("待选的课", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "计划内" }).click();
  const planned = plannedCourses(page);
  await expect(planned).toContainText("高等数学");
  await expect(planned).toContainText("微观经济学");
  await expect(planned).not.toContainText(/班号|容量|A-01|教师甲|教师乙/);
  await planned.getByRole("row", { name: /高等数学/ }).getByRole("button", { name: "加入待选课表" }).click();
  await expect(courseList(page)).toContainText("高等数学");
  await expect(courseList(page)).toContainText("未选");
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学")).toHaveCount(0);

  await planned.getByRole("row", { name: /微观经济学/ }).getByRole("button", { name: "加入待选课表" }).click();
  await expect(courseList(page)).toContainText("微观经济学");

  await page.getByRole("tab", { name: "公共选修" }).click();
  await publicCourses(page).getByRole("button", { name: "加入待选课表" }).click();
  await expect(courseList(page)).toContainText("羽毛球");

  await courseList(page).getByRole("button", { name: "高等数学" }).click();
  await expect(sectionList(page)).toContainText("教师甲");
  await sectionList(page).getByRole("button", { name: "加入课表" }).first().click();
  await courseList(page).getByRole("button", { name: "微观经济学" }).click();
  await sectionList(page).getByRole("button", { name: "加入课表" }).click();
  await courseList(page).getByRole("button", { name: "羽毛球" }).click();
  await sectionList(page).getByRole("button", { name: "加入课表" }).click();

  const timetable = page.getByRole("grid", { name: "周课表" });
  await expect(timetable.getByText("高等数学（教师甲）").first()).toBeVisible();
  await expect(timetable.getByText("微观经济学（教师辰）").first()).toBeVisible();
  await expect(timetable.getByText("羽毛球（教师巳）").first()).toBeVisible();
  await expect(courseList(page)).toContainText("备选");

  await stagePlannedCourse(page, "冲突课");
  await courseList(page).getByRole("button", { name: "冲突课" }).click();
  await sectionList(page).getByRole("button", { name: "加入课表" }).click();
  await expect(page.getByRole("alert")).toContainText("冲突课");
  await expect(page.getByRole("alert")).toContainText("未加入");

  await page.getByRole("button", { name: "保存课表" }).click();
  await expect(page.getByText("课表已保存到本机")).toBeVisible();
  await expect(courseList(page)).toContainText("已选");

  await page.reload();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
  await expect(courseList(page)).toContainText("微观经济学");
  await expect(courseList(page)).toContainText("羽毛球");
  await expect(courseList(page)).not.toContainText("冲突课");

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
  const direction = await page.getByRole("region", { name: "课程与开课班" }).evaluate((el) => getComputedStyle(el).flexDirection);
  expect(direction).toBe("column");
});

test("unsaved alternate classes disappear after reload", async ({ page }) => {
  await mockScheduleApi(page);
  await page.goto("/schedule");
  await selectMajor(page);
  await stagePlannedCourse(page, "高等数学");
  await courseList(page).getByRole("button", { name: "高等数学" }).click();
  await sectionList(page).getByRole("button", { name: "加入课表" }).first().click();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("grid", { name: "待选课表" })).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学")).toHaveCount(0);
});

test("switches candidate data when the catalog major changes", async ({ page }) => {
  await mockScheduleApi(page);
  await page.goto("/schedule");
  await selectMajor(page, "信息管理与信息系统");

  await page.getByRole("tab", { name: "计划内" }).click();
  await expect(plannedCourses(page)).toContainText("数据结构");
  await expect(plannedCourses(page)).not.toContainText("高等数学");

  await chooseMajor(page, "数学与应用数学");
  await page.getByRole("tab", { name: "计划内" }).click();
  await expect(plannedCourses(page)).toContainText("高等数学");
  await expect(plannedCourses(page)).not.toContainText("数据结构");

  await chooseFilter(page, "年级", catalogScheduleGrades()[1].label);
  await expect(page.getByText("请先选择年级和专业")).toBeVisible();
  await expect(page.getByRole("tab", { name: "计划内" })).toHaveCount(0);
  await chooseMajor(page, "数学与应用数学");
  await page.getByRole("tab", { name: "计划内" }).click();
  await expect(plannedCourses(page)).toContainText("高等数学");
});

test("major combobox searches undergraduate majors instead of teaching units", async ({ page }) => {
  await mockScheduleApi(page);
  await page.goto("/schedule");
  const combo = page.getByRole("combobox", { name: "专业" });
  await expect(combo).toBeDisabled();
  await chooseFilter(page, "年级", firstGrade);
  await expect(combo).toBeEnabled();
  await combo.click();
  await combo.fill("宣传");
  await expect(page.getByRole("option", { name: /宣传部|教务处|保卫处|医院|会计学/ })).toHaveCount(0);
  await combo.fill("会计");
  await expect(page.getByRole("option", { name: "会计学", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /宣传部|教务处|保卫处|医院/ })).toHaveCount(0);
  await page.getByRole("option", { name: "会计学", exact: true }).click();
  await expect(combo).toHaveValue("会计学");
});

test("hides planned and public tables until a major is selected", async ({ page }) => {
  await mockScheduleApi(page);
  await page.goto("/schedule");
  await expect(page.getByText("请先选择年级和专业")).toBeVisible();
  await expect(page.getByText("待选的课", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "计划内" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "公共选修" })).toHaveCount(0);
  await expect(page.getByText("暂无数据").first()).toBeVisible();
});

test("bookmarklet refuses S2020103 until grade and major are selected", async ({ page }) => {
  const resultUrl = "https://jwxt.jxufe.edu.cn/student/wsxk.xskc.html?menucode=S2020103";
  await page.route(resultUrl, (route) => route.fulfill({
    body: unselectedHtml,
    contentType: "text/html; charset=utf-8",
  }));
  const messages: string[] = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await page.goto(resultUrl);
  const downloads: string[] = [];
  page.on("download", (download) => {
    downloads.push(download.suggestedFilename());
  });
  await page.addScriptTag({ content: jwxtSnapshotBookmarkletSource() });
  await expect.poll(() => messages[0] ?? "").toBe(JWXT_MAJOR_REQUIRED_MESSAGE);
  expect(downloads).toEqual([]);
});

test("guest can stage, join, and save without logging in", async ({ page }) => {
  await mockScheduleApi(page, false);
  await page.goto("/schedule");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await selectMajor(page);
  await stagePlannedCourse(page, "高等数学");
  await courseList(page).getByRole("button", { name: "高等数学" }).click();
  await sectionList(page).getByRole("button", { name: "加入课表" }).first().click();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
  await page.getByRole("button", { name: "保存课表" }).click();
  await expect(page.getByText("课表已保存到本机")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
});

test("same-course swap is atomic after selecting a catalog section", async ({ page }) => {
  await mockScheduleApi(page);
  await page.goto("/schedule");
  await selectMajor(page);
  await stagePlannedCourse(page, "高等数学");
  await expect(courseList(page)).toContainText("高等数学");
  await courseList(page).getByRole("button", { name: "高等数学" }).click();
  await expect(sectionList(page)).toContainText("教师乙");
  await sectionList(page).getByRole("button", { name: "加入课表" }).first().click();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）").first()).toBeVisible();
  await sectionList(page).getByRole("button", { name: "换班" }).click();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师乙）").first()).toBeVisible();
  await expect(page.getByRole("grid", { name: "周课表" }).getByText("高等数学（教师甲）")).toHaveCount(0);
  await expect(courseList(page)).not.toContainText(/班03|班01/);
});
