-- Materialize the no-search public course and relation browse lists.
-- Each row is one public list item: an ordinary canonical course or
-- course×teacher, or a PE public extra produced at rebuild time.
-- catalog_browse_ready stays 0 until a rebuild from this build publishes
-- the tables. Deploy can lead migrate, and the previous build can clear
-- dirty without filling the new tables. Reads then keep the old merge.
-- PE extras are not seeded here; the rebuild calls the existing loaders.

ALTER TABLE public_precompute_state
  ADD COLUMN catalog_browse_ready INTEGER NOT NULL DEFAULT 0;

CREATE TABLE public_relation_browse (
  public_id TEXT PRIMARY KEY,
  course_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  teacher_id INTEGER NOT NULL,
  teacher_name TEXT NOT NULL,
  rating REAL,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  source_course_ids TEXT NOT NULL DEFAULT '',
  name_sort_key TEXT NOT NULL,
  rating_missing INTEGER NOT NULL CHECK(rating_missing IN (0,1)),
  in_sports INTEGER NOT NULL DEFAULT 0 CHECK(in_sports IN (0,1)),
  in_mooc INTEGER NOT NULL DEFAULT 0 CHECK(in_mooc IN (0,1)),
  in_general INTEGER NOT NULL DEFAULT 0 CHECK(in_general IN (0,1)),
  in_english INTEGER NOT NULL DEFAULT 0 CHECK(in_english IN (0,1)),
  in_ideology INTEGER NOT NULL DEFAULT 0 CHECK(in_ideology IN (0,1)),
  in_math INTEGER NOT NULL DEFAULT 0 CHECK(in_math IN (0,1))
);
CREATE TABLE public_relation_browse_staging (
  public_id TEXT PRIMARY KEY,
  course_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  teacher_id INTEGER NOT NULL,
  teacher_name TEXT NOT NULL,
  rating REAL,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  source_course_ids TEXT NOT NULL DEFAULT '',
  name_sort_key TEXT NOT NULL,
  rating_missing INTEGER NOT NULL CHECK(rating_missing IN (0,1)),
  in_sports INTEGER NOT NULL DEFAULT 0 CHECK(in_sports IN (0,1)),
  in_mooc INTEGER NOT NULL DEFAULT 0 CHECK(in_mooc IN (0,1)),
  in_general INTEGER NOT NULL DEFAULT 0 CHECK(in_general IN (0,1)),
  in_english INTEGER NOT NULL DEFAULT 0 CHECK(in_english IN (0,1)),
  in_ideology INTEGER NOT NULL DEFAULT 0 CHECK(in_ideology IN (0,1)),
  in_math INTEGER NOT NULL DEFAULT 0 CHECK(in_math IN (0,1))
);

-- One trimmed department per row. PE extras insert every source department
-- so a filter matches any of them without duplicating the browse row.
CREATE TABLE public_relation_browse_departments (
  department TEXT NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (department, public_id)
);
CREATE TABLE public_relation_browse_departments_staging (
  department TEXT NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (department, public_id)
);

CREATE TABLE public_relation_browse_totals (
  category TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK(n >= 0)
);
CREATE TABLE public_relation_browse_totals_staging (
  category TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK(n >= 0)
);

CREATE INDEX idx_rel_browse_name
  ON public_relation_browse(name_sort_key);
CREATE INDEX idx_rel_browse_reviews
  ON public_relation_browse(review_count DESC, name_sort_key);
CREATE INDEX idx_rel_browse_rating
  ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key);
CREATE INDEX idx_rel_browse_teacher_name
  ON public_relation_browse(teacher_id, name_sort_key);
CREATE INDEX idx_rel_browse_teacher_reviews
  ON public_relation_browse(teacher_id, review_count DESC, name_sort_key);
CREATE INDEX idx_rel_browse_teacher_rating
  ON public_relation_browse(teacher_id, rating_missing, rating DESC, review_count DESC, name_sort_key);

CREATE INDEX idx_rel_browse_sports_name ON public_relation_browse(name_sort_key) WHERE in_sports=1;
CREATE INDEX idx_rel_browse_sports_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_sports=1;
CREATE INDEX idx_rel_browse_sports_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_sports=1;
CREATE INDEX idx_rel_browse_mooc_name ON public_relation_browse(name_sort_key) WHERE in_mooc=1;
CREATE INDEX idx_rel_browse_mooc_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_mooc=1;
CREATE INDEX idx_rel_browse_mooc_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_mooc=1;
CREATE INDEX idx_rel_browse_general_name ON public_relation_browse(name_sort_key) WHERE in_general=1;
CREATE INDEX idx_rel_browse_general_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_general=1;
CREATE INDEX idx_rel_browse_general_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_general=1;
CREATE INDEX idx_rel_browse_english_name ON public_relation_browse(name_sort_key) WHERE in_english=1;
CREATE INDEX idx_rel_browse_english_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_english=1;
CREATE INDEX idx_rel_browse_english_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_english=1;
CREATE INDEX idx_rel_browse_ideology_name ON public_relation_browse(name_sort_key) WHERE in_ideology=1;
CREATE INDEX idx_rel_browse_ideology_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_ideology=1;
CREATE INDEX idx_rel_browse_ideology_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_ideology=1;
CREATE INDEX idx_rel_browse_math_name ON public_relation_browse(name_sort_key) WHERE in_math=1;
CREATE INDEX idx_rel_browse_math_reviews ON public_relation_browse(review_count DESC, name_sort_key) WHERE in_math=1;
CREATE INDEX idx_rel_browse_math_rating ON public_relation_browse(rating_missing, rating DESC, review_count DESC, name_sort_key) WHERE in_math=1;

CREATE TABLE public_course_browse (
  public_id TEXT PRIMARY KEY,
  course_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  teachers TEXT,
  teacher_refs TEXT,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  credits REAL,
  description TEXT,
  created_at TEXT,
  scheme_key TEXT,
  enrollment_category TEXT,
  teaching_type TEXT,
  course_level TEXT,
  sort_name TEXT NOT NULL,
  sort_code TEXT NOT NULL,
  sort_id_missing INTEGER NOT NULL CHECK(sort_id_missing IN (0,1)),
  sort_id INTEGER NOT NULL,
  is_extra INTEGER NOT NULL CHECK(is_extra IN (0,1)),
  in_sports INTEGER NOT NULL DEFAULT 0 CHECK(in_sports IN (0,1)),
  in_mooc INTEGER NOT NULL DEFAULT 0 CHECK(in_mooc IN (0,1)),
  in_general INTEGER NOT NULL DEFAULT 0 CHECK(in_general IN (0,1)),
  in_english INTEGER NOT NULL DEFAULT 0 CHECK(in_english IN (0,1)),
  in_ideology INTEGER NOT NULL DEFAULT 0 CHECK(in_ideology IN (0,1)),
  in_math INTEGER NOT NULL DEFAULT 0 CHECK(in_math IN (0,1))
);
CREATE TABLE public_course_browse_staging (
  public_id TEXT PRIMARY KEY,
  course_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  teachers TEXT,
  teacher_refs TEXT,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  credits REAL,
  description TEXT,
  created_at TEXT,
  scheme_key TEXT,
  enrollment_category TEXT,
  teaching_type TEXT,
  course_level TEXT,
  sort_name TEXT NOT NULL,
  sort_code TEXT NOT NULL,
  sort_id_missing INTEGER NOT NULL CHECK(sort_id_missing IN (0,1)),
  sort_id INTEGER NOT NULL,
  is_extra INTEGER NOT NULL CHECK(is_extra IN (0,1)),
  in_sports INTEGER NOT NULL DEFAULT 0 CHECK(in_sports IN (0,1)),
  in_mooc INTEGER NOT NULL DEFAULT 0 CHECK(in_mooc IN (0,1)),
  in_general INTEGER NOT NULL DEFAULT 0 CHECK(in_general IN (0,1)),
  in_english INTEGER NOT NULL DEFAULT 0 CHECK(in_english IN (0,1)),
  in_ideology INTEGER NOT NULL DEFAULT 0 CHECK(in_ideology IN (0,1)),
  in_math INTEGER NOT NULL DEFAULT 0 CHECK(in_math IN (0,1))
);

CREATE TABLE public_course_browse_departments (
  department TEXT NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (department, public_id)
);
CREATE TABLE public_course_browse_departments_staging (
  department TEXT NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (department, public_id)
);

CREATE TABLE public_course_browse_teachers (
  teacher_id INTEGER NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (teacher_id, public_id)
);
CREATE TABLE public_course_browse_teachers_staging (
  teacher_id INTEGER NOT NULL,
  public_id TEXT NOT NULL,
  PRIMARY KEY (teacher_id, public_id)
);

CREATE TABLE public_course_browse_totals (
  category TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK(n >= 0)
);
CREATE TABLE public_course_browse_totals_staging (
  category TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK(n >= 0)
);

CREATE INDEX idx_course_browse_name
  ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id);
CREATE INDEX idx_course_browse_reviews
  ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id);

CREATE INDEX idx_course_browse_sports_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_sports=1;
CREATE INDEX idx_course_browse_sports_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_sports=1;
CREATE INDEX idx_course_browse_mooc_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_mooc=1;
CREATE INDEX idx_course_browse_mooc_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_mooc=1;
CREATE INDEX idx_course_browse_general_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_general=1;
CREATE INDEX idx_course_browse_general_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_general=1;
CREATE INDEX idx_course_browse_english_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_english=1;
CREATE INDEX idx_course_browse_english_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_english=1;
CREATE INDEX idx_course_browse_ideology_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_ideology=1;
CREATE INDEX idx_course_browse_ideology_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_ideology=1;
CREATE INDEX idx_course_browse_math_name ON public_course_browse(sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_math=1;
CREATE INDEX idx_course_browse_math_reviews ON public_course_browse(review_count DESC, sort_name, sort_code, sort_id_missing, sort_id, public_id) WHERE in_math=1;

UPDATE public_precompute_state SET dirty=1 WHERE id=1 AND dirty=0;
