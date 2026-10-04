-- Teacher browse reads a stored review total instead of summing
-- public_review_counts on every /api/teachers request. name and department
-- are sort keys so the browse index matches
-- review_count DESC, name, department, teacher_id.
-- teacher_review_counts_ready stays 0 until a rebuild from this build
-- publishes the table. Deploy can lead migrate, and the previous build can
-- clear dirty without filling the new tables.
ALTER TABLE public_precompute_state
  ADD COLUMN teacher_review_counts_ready INTEGER NOT NULL DEFAULT 0;

CREATE TABLE public_teacher_review_counts (
  teacher_id INTEGER PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  name TEXT NOT NULL,
  department TEXT
);
CREATE INDEX idx_public_teacher_review_counts_browse
  ON public_teacher_review_counts(review_count DESC, name, department, teacher_id);

CREATE TABLE public_teacher_review_counts_staging (
  teacher_id INTEGER PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  name TEXT NOT NULL,
  department TEXT
);

CREATE TABLE public_teacher_list_totals (
  id INTEGER PRIMARY KEY CHECK(id=1),
  n INTEGER NOT NULL CHECK(n >= 0)
);
CREATE TABLE public_teacher_list_totals_staging (
  id INTEGER PRIMARY KEY CHECK(id=1),
  n INTEGER NOT NULL CHECK(n >= 0)
);

INSERT INTO public_teacher_review_counts(teacher_id,review_count,name,department)
SELECT t.id,
  COALESCE((
    SELECT SUM(public_review_counts.review_count)
    FROM public_review_counts
    WHERE public_review_counts.teacher_id=t.id
  ), 0),
  t.name,
  t.department
FROM teachers t;

INSERT INTO public_teacher_list_totals(id, n)
SELECT 1, COUNT(*) FROM teachers;

UPDATE public_precompute_state SET dirty=1 WHERE id=1 AND dirty=0;
