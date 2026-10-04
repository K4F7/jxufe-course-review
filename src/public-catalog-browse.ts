import { isGeneralEducationFilter } from "./lib/public-categories";
import { publicCatalogPageMeta } from "./lib/public-catalog-list";
import type {
  PublicCatalogPage,
  PublicCourseListItem,
  PublicCourseListQuery,
  PublicRelationListQuery,
  PublicRelationListSort,
} from "./public-catalog-query";

const CATEGORY_FLAG: Record<string, string> = {
  sports: "in_sports",
  mooc: "in_mooc",
  general: "in_general",
  major: "in_general",
  public_basic: "in_general",
  english: "in_english",
  ideology: "in_ideology",
  math: "in_math",
};

const CATEGORY_INDEX: Record<string, string> = {
  sports: "sports",
  mooc: "mooc",
  general: "general",
  major: "general",
  public_basic: "general",
  english: "english",
  ideology: "ideology",
  math: "math",
};

const RELATION_ORDER: Record<PublicRelationListSort, string> = {
  name: "name_sort_key",
  reviews: "review_count DESC, name_sort_key",
  rating: "rating_missing, rating DESC, review_count DESC, name_sort_key",
};

const COURSE_NAME_ORDER =
  "sort_name, sort_code, sort_id_missing, sort_id, public_id";

const COURSE_ORDER = {
  name: COURSE_NAME_ORDER,
  reviews: `review_count DESC, ${COURSE_NAME_ORDER}`,
} as const;

export function relationBrowseIndex(
  sort: PublicRelationListSort,
  category: string,
  teacherScoped: boolean,
): string {
  if (teacherScoped) return `idx_rel_browse_teacher_${sort}`;
  if (!category) return `idx_rel_browse_${sort}`;
  return `idx_rel_browse_${CATEGORY_INDEX[category] ?? "name"}_${sort}`;
}

export function courseBrowseIndex(sort: "name" | "reviews", category: string): string {
  if (!category) return `idx_course_browse_${sort}`;
  return `idx_course_browse_${CATEGORY_INDEX[category] ?? "name"}_${sort}`;
}

function totalCategory(category: string): string {
  if (!category) return "all";
  if (isGeneralEducationFilter(category)) return "general";
  return category;
}

function qualifyOrder(order: string, alias: string): string {
  return order.replace(
    /\b(sort_name|sort_code|sort_id_missing|sort_id|public_id|review_count|name_sort_key|rating_missing|rating)\b/g,
    `${alias}.$1`,
  );
}

type RelationBrowseRow = {
  public_id: string;
  course_id: number | null;
  code: string;
  name: string;
  category: string;
  department: string;
  teacher_id: number;
  teacher_name: string;
  rating: number | null;
  review_count: number;
  source_course_ids: string;
};

type CourseBrowseRow = {
  public_id: string;
  course_id: number | null;
  code: string;
  name: string;
  category: string;
  department: string;
  teachers: string | null;
  teacher_refs: string | null;
  review_count: number;
  credits: number | null;
  description: string | null;
  created_at: string | null;
  scheme_key: string | null;
  enrollment_category: string | null;
  teaching_type: string | null;
  course_level: string | null;
  is_extra: number;
  filtered_teacher_name?: string | null;
};

const RELATION_SELECT = `public_id,course_id,code,name,category,department,
  teacher_id,teacher_name,rating,review_count,source_course_ids`;

const COURSE_SELECT = `public_id,course_id,code,name,category,department,
  teachers,teacher_refs,review_count,credits,description,created_at,scheme_key,
  enrollment_category,teaching_type,course_level,is_extra`;

function categoryPredicate(category: string, alias: string): string {
  if (!category) return "";
  const flag = CATEGORY_FLAG[category];
  if (!flag) return "";
  return ` AND ${alias}.${flag}=1`;
}

function relationOrder(sort: PublicRelationListSort, alias = ""): string {
  const order = RELATION_ORDER[sort];
  return alias ? qualifyOrder(order, alias) : order;
}

function courseOrder(sort: "name" | "reviews", alias = ""): string {
  const order = COURSE_ORDER[sort];
  return alias ? qualifyOrder(order, alias) : order;
}

async function storedTotal(
  db: D1Database,
  table: string,
  category: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT n FROM ${table} WHERE category=?`)
    .bind(totalCategory(category))
    .first<{ n: number }>();
  return row ? Number(row.n) || 0 : null;
}

function relationItem(row: RelationBrowseRow) {
  const sources = String(row.source_course_ids || "")
    .split(",")
    .filter(Boolean)
    .map((value) => Number(value));
  return {
    course_id: row.course_id == null ? null : Number(row.course_id),
    public_id: row.public_id,
    code: row.code ?? "",
    name: row.name ?? "",
    category: row.category ?? "",
    department: row.department ?? "",
    teacher_id: Number(row.teacher_id),
    teacher_name: row.teacher_name ?? "",
    rating: row.rating == null ? null : Number(row.rating),
    review_count: Number(row.review_count) || 0,
    ...(sources.length ? { source_course_ids: sources } : {}),
  };
}

/**
 * Virtual PE course rows keep a numeric sport id and, on the live path, narrow
 * `teachers` to the requested teacher. Mapped PE rows keep a null id and the
 * full teacher list. Ordinary rows were grouped before the teacher filter, so
 * the stored list is every teacher and the read narrows it.
 */
function teacherPresentation(
  row: CourseBrowseRow,
  teacherId: number | null,
): { teachers: string | null; teacher_refs: string | null } {
  if (teacherId == null) {
    return { teachers: row.teachers, teacher_refs: row.teacher_refs };
  }
  if (Number(row.is_extra) === 1 && row.course_id == null) {
    return { teachers: row.teachers, teacher_refs: row.teacher_refs };
  }
  if (Number(row.is_extra) === 1) {
    const refs = String(row.teacher_refs ?? "")
      .split(",")
      .filter((ref) => {
        const colon = ref.indexOf(":");
        return colon > 0 && Number(ref.slice(0, colon)) === teacherId;
      });
    return {
      teachers: refs.map((ref) => ref.slice(ref.indexOf(":") + 1)).join(","),
      teacher_refs: refs.join(","),
    };
  }
  if (row.filtered_teacher_name == null) {
    return { teachers: row.teachers, teacher_refs: row.teacher_refs };
  }
  return {
    teachers: row.filtered_teacher_name,
    teacher_refs: `${teacherId}:${row.filtered_teacher_name}`,
  };
}

function courseItem(
  row: CourseBrowseRow,
  teacherId: number | null,
): PublicCourseListItem & {
  credits?: number | null;
  description?: string | null;
  created_at?: string | null;
  scheme_key?: string | null;
  enrollment_category?: string | null;
  teaching_type?: string | null;
  course_level?: string | null;
} {
  const teachers = teacherPresentation(row, teacherId);
  const item = {
    id: row.course_id == null ? null : Number(row.course_id),
    public_id: row.public_id,
    code: row.code ?? "",
    name: row.name ?? "",
    category: row.category ?? "",
    department: row.department ?? "",
    teachers: teachers.teachers,
    teacher_refs: teachers.teacher_refs,
    review_count: Number(row.review_count) || 0,
  };
  if (Number(row.is_extra) === 1) return item;
  return {
    ...item,
    credits: row.credits,
    description: row.description,
    created_at: row.created_at,
    scheme_key: row.scheme_key,
    enrollment_category: row.enrollment_category,
    teaching_type: row.teaching_type,
    course_level: row.course_level,
  };
}

export async function loadPrecomputedRelationPage(
  db: D1Database,
  query: PublicRelationListQuery,
): Promise<
  PublicCatalogPage<{
    course_id: number | null;
    public_id: string;
    code: string;
    name: string;
    category: string;
    department: string;
    teacher_id: number;
    teacher_name: string;
    rating: number | null;
    review_count: number;
    source_course_ids?: number[];
  }>
> {
  const department = query.department.trim();
  const teacherId = query.teacherId;
  const { page, pageSize, sort, category } = query;
  const offset = (page - 1) * pageSize;
  const categorySql = categoryPredicate(category, department ? "b" : "public_relation_browse");
  const args: unknown[] = [];
  let sql: string;
  if (department) {
    args.push(department);
    const teacherSql = teacherId == null ? "" : " AND b.teacher_id=?";
    if (teacherId != null) args.push(teacherId);
    sql = `SELECT ${RELATION_SELECT.split(",").map((column) => `b.${column.trim()}`).join(",")}
      FROM public_relation_browse_departments d
      JOIN public_relation_browse b ON b.public_id=d.public_id
      WHERE d.department=?${categorySql}${teacherSql}
      ORDER BY ${relationOrder(sort, "b")}
      LIMIT ? OFFSET ?`;
  } else {
    const index = relationBrowseIndex(sort, category, teacherId != null);
    const teacherSql = teacherId == null ? "" : "teacher_id=?";
    if (teacherId != null) args.push(teacherId);
    const where = [teacherSql, categorySql.replace(/^ AND /, "")].filter(Boolean).join(" AND ");
    sql = `SELECT ${RELATION_SELECT}
      FROM public_relation_browse INDEXED BY ${index}
      ${where ? `WHERE ${where}` : ""}
      ORDER BY ${relationOrder(sort)}
      LIMIT ? OFFSET ?`;
  }
  const countPromise = (async () => {
    if (!department && teacherId == null) {
      const stored = await storedTotal(db, "public_relation_browse_totals", category);
      if (stored != null) return stored;
    }
    const teacherSql = teacherId == null ? "" : " AND b.teacher_id=?";
    const countArgs: unknown[] = [];
    let countSql: string;
    if (department) {
      countArgs.push(department);
      if (teacherId != null) countArgs.push(teacherId);
      countSql = `SELECT COUNT(*) n
        FROM public_relation_browse_departments d
        JOIN public_relation_browse b ON b.public_id=d.public_id
        WHERE d.department=?${categoryPredicate(category, "b")}${teacherSql}`;
    } else if (teacherId != null) {
      countArgs.push(teacherId);
      countSql = `SELECT COUNT(*) n FROM public_relation_browse b
        WHERE b.teacher_id=?${categoryPredicate(category, "b")}`;
    } else {
      countSql = `SELECT COUNT(*) n FROM public_relation_browse b WHERE 1=1${categoryPredicate(category, "b")}`;
    }
    const row = await db.prepare(countSql).bind(...countArgs).first<{ n: number }>();
    return Number(row?.n) || 0;
  })();
  const [pageResult, total] = await Promise.all([
    db
      .prepare(sql)
      .bind(...args, pageSize, offset)
      .all<RelationBrowseRow>(),
    countPromise,
  ]);
  return {
    items: (pageResult.results ?? []).map(relationItem),
    ...publicCatalogPageMeta(page, pageSize, total),
  };
}

export async function loadPrecomputedCoursePage(
  db: D1Database,
  query: PublicCourseListQuery,
): Promise<PublicCatalogPage<ReturnType<typeof courseItem>>> {
  const department = query.department.trim();
  const teacherId = query.teacherId;
  const { page, pageSize, sort, category } = query;
  const offset = (page - 1) * pageSize;
  const args: unknown[] = [];
  const joins: string[] = [];
  const where: string[] = [];
  if (department) {
    joins.push(
      "JOIN public_course_browse_departments d ON d.public_id=b.public_id AND d.department=?",
    );
    args.push(department);
  }
  if (teacherId != null) {
    joins.push(
      "JOIN public_course_browse_teachers bt ON bt.public_id=b.public_id AND bt.teacher_id=?",
    );
    joins.push("JOIN teachers filter_teacher ON filter_teacher.id=bt.teacher_id");
    args.push(teacherId);
  }
  const flag = category ? CATEGORY_FLAG[category] : "";
  if (flag) where.push(`b.${flag}=1`);
  const indexed =
    !department && teacherId == null ? courseBrowseIndex(sort, category) : "";
  const select = teacherId == null
    ? COURSE_SELECT.split(",").map((column) => `b.${column.trim()}`).join(",")
    : `${COURSE_SELECT.split(",").map((column) => `b.${column.trim()}`).join(",")},
       filter_teacher.name filtered_teacher_name`;
  const sql = `SELECT ${select}
    FROM public_course_browse b${indexed ? ` INDEXED BY ${indexed}` : ""}
    ${joins.join("\n")}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${courseOrder(sort, "b")}
    LIMIT ? OFFSET ?`;
  const countPromise = (async () => {
    if (!department && teacherId == null) {
      const stored = await storedTotal(db, "public_course_browse_totals", category);
      if (stored != null) return stored;
    }
    const countJoins: string[] = [];
    const countWhere: string[] = [];
    const countArgs: unknown[] = [];
    if (department) {
      countJoins.push(
        "JOIN public_course_browse_departments d ON d.public_id=b.public_id AND d.department=?",
      );
      countArgs.push(department);
    }
    if (teacherId != null) {
      countJoins.push(
        "JOIN public_course_browse_teachers bt ON bt.public_id=b.public_id AND bt.teacher_id=?",
      );
      countArgs.push(teacherId);
    }
    if (flag) countWhere.push(`b.${flag}=1`);
    const row = await db
      .prepare(
        `SELECT COUNT(*) n FROM public_course_browse b
         ${countJoins.join("\n")}
         ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}`,
      )
      .bind(...countArgs)
      .first<{ n: number }>();
    return Number(row?.n) || 0;
  })();
  const [pageResult, total] = await Promise.all([
    db
      .prepare(sql)
      .bind(...args, pageSize, offset)
      .all<CourseBrowseRow>(),
    countPromise,
  ]);
  return {
    items: (pageResult.results ?? []).map((row) => courseItem(row, teacherId)),
    ...publicCatalogPageMeta(page, pageSize, total),
  };
}
